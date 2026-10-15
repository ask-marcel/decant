import { renderEventAttachment, renderEventDocument } from '../domain/calendar-document.ts';
import type { EventAttachmentLink } from '../domain/calendar-document.ts';
import type { CalendarEvent, EventChange } from '../domain/calendar-event.ts';
import {
  CALENDAR_ID,
  CALENDAR_NAME,
  CALENDAR_STATE_VERSION,
  emptyCalendarState,
  eventFileFor,
  parseCalendarState,
  serializeCalendarState,
  withCursor,
  withEvent,
  withoutEvent,
} from '../domain/calendar-state.ts';
import type { CalendarState, EventRecord } from '../domain/calendar-state.ts';
import { fitSegment, freeSegment, holdsIgnoringCase, safeSegment } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { dayIn } from '../domain/zoned-day.ts';
import { widens } from '../domain/sync-window.ts';
import type { CalendarReader, CalendarReaderError, EventAttachment, EventsDelta } from './ports/calendar-reader.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';
import { clearAttempt, forgetAttempts, gaveUpNotes, givenUpNotes, isGivenUp, nextAttempt, recordAttempt, triedReads } from '../domain/retry-ledger.ts';
import { withGaveUp } from '../domain/report.ts';
import { expiredCursor } from './expired-cursor.ts';
import { putAside } from './put-aside.ts';

export const CALENDAR_STATE_FILE = '.sync-state.json';

export type SyncCalendarDeps = {
  readonly reader: CalendarReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
  // The zone the calendar's days are counted in, which is the mailbox's.
  readonly timezone: string;
  // How long a path may be as decant writes it: Windows' limit less what stands in front of the
  // knowledge base on disk. Absent, names are not cut for length.
  readonly pathBudget?: number;
};

// `since` as the mailbox takes it: events starting before that day are listed by the delta and not
// written, and the cursor moves past them, because Outlook's delta cannot narrow by date.
export type SyncCalendarInput = { readonly dryRun: boolean; readonly concurrency: number; readonly since?: string };

export type SyncCalendar = (input: SyncCalendarInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const calendarRoot = (kbRoot: string): string => `${kbRoot}/${CALENDAR_NAME}`;

const loadState = async (deps: SyncCalendarDeps, path: string): Promise<CalendarState> => {
  const text = await deps.files.readText(path);
  if (!text.ok) return emptyCalendarState();
  const parsed = parseJson(text.value);
  if (!parsed.ok) return emptyCalendarState();
  const state = parseCalendarState(parsed.value);
  if (state.ok) return state.value;
  deps.logger.warn('calendar-state.unreadable', { cause: state.error.message });
  return emptyCalendarState();
};

type Done = { readonly apply: (state: CalendarState) => CalendarState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const NOTHING: Done = { apply: (carried) => carried, counted: {}, notes: {} };

const moveAside = async (deps: SyncCalendarDeps, output: string, what: string): Promise<void> => {
  for (const missed of await putAside(deps, [output])) deps.logger.warn(`${what}.failed`, { path: missed.path, cause: missed.error.kind });
};

// A deleted event: what it wrote goes to the archive, and it is named in the report by its
// subject, the only thing left to call it by. Its tries go with it, written or not: one given up on
// would otherwise be named as failed in every report for good. A removal neither ledger held is
// nothing.
const archiveGone = async (deps: SyncCalendarDeps, state: CalendarState, id: string): Promise<Done> => {
  const record = state.events[id];
  const forget = (carried: CalendarState): CalendarState => ({ ...carried, retry: forgetAttempts(carried.retry, [id]) });
  if (record === undefined) return state.retry?.[id] === undefined ? NOTHING : { apply: forget, counted: {}, notes: {} };
  for (const output of record.outputs) await moveAside(deps, output, 'archive');
  return { apply: (carried) => forget(withoutEvent(carried, id)), counted: { archived: 1 }, notes: { archived: [{ path: record.subject, reason: 'deleted from the calendar' }] } };
};

// The files an earlier version of the event wrote that this version did not write again: the copy
// under the day it used to start, an attachment it no longer carries. Put aside, never deleted.
const archiveSuperseded = async (deps: SyncCalendarDeps, before: EventRecord | undefined, after: ReadonlyArray<string>): Promise<void> => {
  for (const output of (before?.outputs ?? []).filter((path) => !after.includes(path))) await moveAside(deps, output, 'supersede');
};

const MARKDOWN = '.md';

// Beside the event, in a folder named after it, the way a thread keeps its `_attachments`.
const attachmentFolder = (file: string): string => `${file.slice(0, -MARKDOWN.length)}.attachments`;

type Attached = {
  readonly links: ReadonlyArray<EventAttachmentLink>;
  readonly outputs: ReadonlyArray<string>;
  readonly failed: RunNotes['failed'];
  readonly skipped: RunNotes['skipped'];
};

const attachmentName = (attachment: EventAttachment, taken: Set<string>, folder: string, budget: number | undefined): string => {
  const fitted = fitSegment(folder, `${safeSegment(attachment.name)}${MARKDOWN}`, budget);
  const name = freeSegment(fitted, attachment.id, (candidate) => holdsIgnoringCase(taken, candidate));
  taken.add(name);
  return name;
};

const NONE: Attached = { links: [], outputs: [], failed: [], skipped: [] };

// Markdown only: the library converts an event's attachment and nothing fetches its bytes, so there
// is no PDF and no original the way a mail attachment has. One the library will not render, which
// is a picture, is left out and said to be, with the library's reason; one that fails for any other
// reason is a failure to try again. The event lands either way, without it.
const attachmentsOf = async (deps: SyncCalendarDeps, event: CalendarEvent, file: string): Promise<Attached> => {
  if (!event.hasAttachments) return NONE;
  const listed = await deps.reader.attachments(event.id);
  if (!listed.ok) return { ...NONE, failed: [{ path: `${event.subject}/attachments`, reason: listed.error.message }] };
  const folder = attachmentFolder(file);
  const taken = new Set<string>();
  const links: EventAttachmentLink[] = [];
  const outputs: string[] = [];
  const failures: RunNotes['failed'][number][] = [];
  const leftOut: RunNotes['skipped'][number][] = [];
  for (const attachment of listed.value) {
    const name = attachmentName(attachment, taken, folder, deps.pathBudget);
    const text = await deps.reader.attachmentMarkdown(event.id, attachment.id);
    const written = text.ok
      ? await deps.files.writeText(
          `${folder}/${name}`,
          renderEventAttachment({ event, name: attachment.name, contentType: attachment.contentType, size: attachment.size, text: text.value, syncedAt: deps.clock.nowIso() })
        )
      : text;
    if (!written.ok) {
      const note = { path: `${event.subject}/${attachment.name}`, reason: written.error.message };
      if (written.error.kind === 'unrenderable') leftOut.push(note);
      else failures.push(note);
      continue;
    }
    links.push({ name: attachment.name, file: `${folder.slice(folder.lastIndexOf('/') + 1)}/${name}` });
    outputs.push(`${folder}/${name}`);
  }
  return { links, outputs, failed: failures, skipped: leftOut };
};

type Planned = { readonly event: CalendarEvent; readonly file: string };

const writeOne = async (deps: SyncCalendarDeps, state: CalendarState, planned: Planned): Promise<Done> => {
  const { event, file } = planned;
  const attached = await attachmentsOf(deps, event, file);
  const written = await deps.files.writeText(file, renderEventDocument({ event, zone: deps.timezone, attachments: attached.links, syncedAt: deps.clock.nowIso() }));
  if (!written.ok) {
    deps.logger.warn('event.failed', { event: event.id, cause: written.error.kind });
    const attempt = nextAttempt(state.retry?.[event.id], event.lastModified, event.id, written.error.message);
    // Out of tries now: named under its own heading, not as a failure the next run will try again.
    const own = isGivenUp(attempt, event.lastModified) ? [] : [{ path: event.id, reason: written.error.message }];
    return {
      apply: (carried) => ({ ...carried, retry: recordAttempt(carried.retry, event.id, attempt) }),
      counted: { failed: 1 + attached.failed.length },
      notes: { failed: [...attached.failed, ...own] },
    };
  }
  const outputs = [file, ...attached.outputs];
  await archiveSuperseded(deps, state.events[event.id], outputs);
  const record: EventRecord = { file, lastModified: event.lastModified, subject: event.subject, outputs };
  return {
    apply: (carried) => ({ ...withEvent(carried, event.id, record), retry: clearAttempt(carried.retry, event.id) }),
    counted: { converted: 1, failed: attached.failed.length, skipped: attached.skipped.length },
    notes: { failed: attached.failed, skipped: attached.skipped },
  };
};

type Fetched = { readonly id: string; readonly event?: CalendarEvent; readonly failed?: string };

const fetchOne = async (deps: SyncCalendarDeps, id: string): Promise<Fetched> => {
  const answer = await deps.reader.event(id);
  if (answer.ok) return { id, event: answer.value };
  deps.logger.warn('event.unread', { event: id, cause: answer.error.kind });
  return { id, failed: answer.error.message };
};

// Whether a fetched event is written this run: not when it starts before `since`, not when the
// ledger already holds it at the same `lastModifiedDateTime`, which is what a delta re-read after
// a stopped run answers for everything that already landed.
const wanted = (deps: SyncCalendarDeps, input: SyncCalendarInput, state: CalendarState, event: CalendarEvent): boolean =>
  inReach(deps, input, event) && state.events[event.id]?.lastModified !== event.lastModified && !isGivenUp(state.retry?.[event.id], event.lastModified);

// A recurring series is kept whatever day it began: Outlook holds it as one event starting on its
// first occurrence, and a meeting that began before the day may be running still.
const inReach = (deps: SyncCalendarDeps, input: SyncCalendarInput, event: CalendarEvent): boolean =>
  input.since === undefined || event.kind === 'seriesMaster' || dayIn(event.start, deps.timezone) >= input.since;

// Every path an event other than this one holds, rewritten in this window or not. A rewritten event
// still holds its old file until its own write lands and puts it aside; handed to a namesake, that
// file would be put aside after the namesake's write, taking the namesake's fresh document with it.
const heldByOthers = (state: CalendarState, id: string): ReadonlyArray<string> =>
  Object.entries(state.events)
    .filter(([held]) => held !== id)
    .map(([, record]) => record.file);

// Paths settled one event at a time, in order, before the window's writes run side by side: two
// events sharing a subject and a day must not both be handed the same file.
const planWindow = (deps: SyncCalendarDeps, input: SyncCalendarInput, state: CalendarState, fetched: ReadonlyArray<Fetched>): ReadonlyArray<Planned> => {
  const handedOut = new Set<string>();
  const planned: Planned[] = [];
  for (const entry of fetched) {
    if (entry.event === undefined || !wanted(deps, input, state, entry.event)) continue;
    const taken = new Set([...heldByOthers(state, entry.event.id), ...handedOut]);
    const file = eventFileFor(calendarRoot(deps.kbRoot), entry.event, deps.timezone, taken, state.events[entry.event.id]?.file, deps.pathBudget);
    handedOut.add(file);
    planned.push({ event: entry.event, file });
  }
  return planned;
};

// The cursor holds while an event fails, so the delta names it again on every run, and it is fetched
// again, nothing else saying whether it changed. It is named as a failure for three runs, then
// given up on, and then it no longer holds the cursor.
const unread = (state: CalendarState, fetched: ReadonlyArray<Fetched>): Done => {
  const failures = fetched.flatMap((entry) => (entry.failed === undefined ? [] : [{ id: entry.id, name: entry.id, reason: entry.failed }]));
  const tried = triedReads(
    state.retry,
    fetched.filter((entry) => entry.failed === undefined).map((entry) => entry.id),
    failures
  );
  // The ledger as it was when nothing moved in it, so a window with nothing to write saves nothing.
  const apply = tried.retry === state.retry ? (carried: CalendarState): CalendarState => carried : (carried: CalendarState): CalendarState => ({ ...carried, retry: tried.retry });
  return { apply, counted: { failed: tried.tried }, notes: { failed: tried.failed } };
};

const counted = (summary: RunSummary, results: ReadonlyArray<Done>): RunSummary =>
  results.reduce(
    (carried, done) => ({
      ...carried,
      converted: carried.converted + (done.counted.converted ?? 0),
      archived: carried.archived + (done.counted.archived ?? 0),
      skipped: carried.skipped + (done.counted.skipped ?? 0),
      failed: carried.failed + (done.counted.failed ?? 0),
    }),
    summary
  );

const noted = (notes: RunNotes, results: ReadonlyArray<Done>): RunNotes => ({
  ...notes,
  skipped: [...notes.skipped, ...results.flatMap((done) => done.notes.skipped ?? [])],
  failed: [...notes.failed, ...results.flatMap((done) => done.notes.failed ?? [])],
  archived: [...notes.archived, ...results.flatMap((done) => done.notes.archived ?? [])],
});

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: CalendarState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

const save = async (deps: SyncCalendarDeps, state: CalendarState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${calendarRoot(deps.kbRoot)}/${CALENDAR_STATE_FILE}`, serializeCalendarState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

// An event named for the reader: by its subject, or as what it is when it has none or never arrived.
const shownAs = (entry: Fetched): string => {
  if (entry.event === undefined) return 'an event that could not be read';
  return entry.event.subject.length > 0 ? entry.event.subject : '(no subject)';
};

const writeWindow = async (deps: SyncCalendarDeps, input: SyncCalendarInput, carried: Progressing, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Done>> => {
  const fetched = await Promise.all(ids.map((id) => fetchOne(deps, id)));
  const planned = planWindow(deps, input, carried.state, fetched);
  const written = await Promise.all(planned.map((entry) => writeOne(deps, carried.state, entry)));
  for (const entry of fetched) deps.progress.step(shownAs(entry));
  return [unread(carried.state, fetched), ...written];
};

// Saved once per window that changed the ledger, so a stopped run resumes without rewriting what
// landed; a window that fetched and found nothing to write leaves the file alone.
const writeChanged = async (deps: SyncCalendarDeps, input: SyncCalendarInput, carried: Progressing, ids: ReadonlyArray<string>): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  for (let at = 0; at < ids.length; at += input.concurrency) {
    const next = fold(progressing, await writeWindow(deps, input, progressing, ids.slice(at, at + input.concurrency)));
    const saved = next.state === progressing.state ? ok(undefined) : await save(deps, next.state);
    if (!saved.ok) return saved;
    progressing = next;
  }
  return ok(progressing);
};

// The cursor moves only once everything the delta reported has landed: an event that could not be
// fetched or written is not in the ledger, and a cursor past it would never ask for it again. The day
// it was taken reaching back to moves with it, and stays behind with it.
const cursorAfter = (done: Progressing, deltaLink: string | undefined, since: string | undefined): CalendarState =>
  done.summary.failed > 0 ? done.state : withCursor({ ...done.state, since }, deltaLink);

const finish = async (
  deps: SyncCalendarDeps,
  input: SyncCalendarInput,
  before: CalendarState,
  done: Progressing,
  deltaLink: string | undefined
): Promise<Result<SourceRun, StepError>> => {
  const saved = await save(deps, cursorAfter(done, deltaLink, input.since));
  if (!saved.ok) return saved;
  const notes = withGaveUp({ ...done.notes, givenUp: givenUpNotes(done.state.retry) }, gaveUpNotes(before.retry, done.state.retry));
  await writeReport(deps, input, calendarRoot(deps.kbRoot), CALENDAR_NAME, done.summary, notes);
  return ok({ id: CALENDAR_ID, source: CALENDAR_NAME, summary: done.summary, notes });
};

// A day earlier than the one the cursor was taken under: what the cursor passed over never comes back
// through it. It is read out first all the same, so what was removed since the last run is still put
// aside, then the delta is read whole for what the narrower reach passed over; an event already filed
// is fetched and left be.
// Graph answers 410 to a cursor whose sync state it no longer keeps: the calendar is read from the
// start, which reaches as far back as a wider day would. Nothing is compared with the ledger, since
// that read reaches only as far back as the day, and an event before it is not gone for that.
const deltaFor = async (deps: SyncCalendarDeps, state: CalendarState, since: string | undefined): Promise<Result<EventsDelta, CalendarReaderError>> => {
  const drained = await deps.reader.eventsDelta(state.deltaLink);
  if (!drained.ok && expiredCursor(drained.error)) {
    deps.logger.warn('calendar.cursor-expired', {});
    return deps.reader.eventsDelta(undefined);
  }
  if (!drained.ok || !widens(state.since, since)) return drained;
  const whole = await deps.reader.eventsDelta(undefined);
  return whole.ok ? ok({ ...whole.value, changes: [...drained.value.changes, ...whole.value.changes] }) : whole;
};

// Once each: a delta can name an event twice when it changed twice while the pages were read, and
// a second fetch of the same event would only find it unchanged.
const changedIds = (changes: ReadonlyArray<EventChange>): ReadonlyArray<string> => [...new Set(changes.filter((change) => !change.removed).map((change) => change.id))];

export const createSyncCalendar =
  (deps: SyncCalendarDeps): SyncCalendar =>
  async (input) => {
    const state: CalendarState = { ...(await loadState(deps, `${calendarRoot(deps.kbRoot)}/${CALENDAR_STATE_FILE}`)), version: CALENDAR_STATE_VERSION };
    const delta = await deltaFor(deps, state, input.since);
    if (!delta.ok) return failed('eventsDelta', delta.error.kind, delta.error.message);
    const ids = changedIds(delta.value.changes);
    if (input.dryRun) return ok({ id: CALENDAR_ID, source: CALENDAR_NAME, summary: { ...EMPTY, queued: ids.length }, notes: NO_NOTES });
    deps.logger.info('calendar.delta', { changed: ids.length, removed: delta.value.changes.length - ids.length });
    const gone = await Promise.all(delta.value.changes.filter((change) => change.removed).map((change) => archiveGone(deps, state, change.id)));
    deps.progress.start(ids.length, CALENDAR_NAME);
    const written = await writeChanged(deps, input, fold({ summary: EMPTY, notes: NO_NOTES, state }, gone), ids);
    deps.progress.done();
    if (!written.ok) return written;
    return finish(deps, input, state, written.value, delta.value.deltaLink);
  };
