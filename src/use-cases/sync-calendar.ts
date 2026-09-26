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
import { disambiguateSegment, safeSegment } from '../domain/kb-path.ts';
import { archivePath } from '../domain/output-paths.ts';
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
};

// `since` as the mailbox takes it: events starting before that day are listed by the delta and not
// written, and the cursor moves past them, because Outlook's delta cannot narrow by date.
export type SyncCalendarInput = { readonly dryRun: boolean; readonly concurrency: number; readonly since?: string };

export type SyncCalendar = (input: SyncCalendarInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const calendarRoot = (kbRoot: string): string => `${kbRoot}/${CALENDAR_NAME}`;

const archiveRootOf = (kbRoot: string): string => `${kbRoot}/_archive/${CALENDAR_NAME}`;

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
  const moved = await deps.files.move(output, archivePath(archiveRootOf(deps.kbRoot), calendarRoot(deps.kbRoot), output));
  if (!moved.ok) deps.logger.warn(`${what}.failed`, { path: output, cause: moved.error.kind });
};

// A deleted event: what it wrote goes to the archive, and it is named in the report by its
// subject, the only thing left to call it by. A removal the ledger never held is nothing.
const archiveGone = async (deps: SyncCalendarDeps, state: CalendarState, id: string): Promise<Done> => {
  const record = state.events[id];
  if (record === undefined) return NOTHING;
  for (const output of record.outputs) await moveAside(deps, output, 'archive');
  return { apply: (carried) => withoutEvent(carried, id), counted: { archived: 1 }, notes: { archived: [{ path: record.subject, reason: 'deleted from the calendar' }] } };
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

const attachmentName = (attachment: EventAttachment, taken: Set<string>): string => {
  const plain = `${safeSegment(attachment.name)}${MARKDOWN}`;
  const name = taken.has(plain) ? disambiguateSegment(plain, attachment.id) : plain;
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
    const name = attachmentName(attachment, taken);
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
    return {
      apply: (carried) => carried,
      counted: { failed: 1 + attached.failed.length },
      notes: { failed: [...attached.failed, { path: event.id, reason: written.error.message }] },
    };
  }
  const outputs = [file, ...attached.outputs];
  await archiveSuperseded(deps, state.events[event.id], outputs);
  const record: EventRecord = { file, lastModified: event.lastModified, subject: event.subject, outputs };
  return {
    apply: (carried) => withEvent(carried, event.id, record),
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
  inReach(deps, input, event) && state.events[event.id]?.lastModified !== event.lastModified;

// A recurring series is kept whatever day it began: Outlook holds it as one event starting on its
// first occurrence, and a meeting that began before the day may be running still.
const inReach = (deps: SyncCalendarDeps, input: SyncCalendarInput, event: CalendarEvent): boolean =>
  input.since === undefined || event.kind === 'seriesMaster' || dayIn(event.start, deps.timezone) >= input.since;

// Paths settled one event at a time, in order, before the window's writes run side by side: two
// events sharing a subject and a day must not both be handed the same file.
const planWindow = (deps: SyncCalendarDeps, input: SyncCalendarInput, state: CalendarState, fetched: ReadonlyArray<Fetched>): ReadonlyArray<Planned> => {
  const taken = new Set(Object.entries(state.events).flatMap(([id, record]) => (fetched.some((entry) => entry.id === id) ? [] : [record.file])));
  const planned: Planned[] = [];
  for (const entry of fetched) {
    if (entry.event === undefined || !wanted(deps, input, state, entry.event)) continue;
    const file = eventFileFor(calendarRoot(deps.kbRoot), entry.event, deps.timezone, taken);
    taken.add(file);
    planned.push({ event: entry.event, file });
  }
  return planned;
};

const unread = (fetched: ReadonlyArray<Fetched>): Done => {
  const failures = fetched.flatMap((entry) => (entry.failed === undefined ? [] : [{ path: entry.id, reason: entry.failed }]));
  return { apply: (carried) => carried, counted: { failed: failures.length }, notes: { failed: failures } };
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

const writeWindow = async (deps: SyncCalendarDeps, input: SyncCalendarInput, carried: Progressing, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Done>> => {
  const fetched = await Promise.all(ids.map((id) => fetchOne(deps, id)));
  const planned = planWindow(deps, input, carried.state, fetched);
  const written = await Promise.all(planned.map((entry) => writeOne(deps, carried.state, entry)));
  for (const id of ids) deps.progress.step(id);
  return [unread(fetched), ...written];
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

const finish = async (deps: SyncCalendarDeps, input: SyncCalendarInput, done: Progressing, deltaLink: string | undefined): Promise<Result<SourceRun, StepError>> => {
  const saved = await save(deps, cursorAfter(done, deltaLink, input.since));
  if (!saved.ok) return saved;
  await writeReport(deps, input, calendarRoot(deps.kbRoot), CALENDAR_NAME, done.summary, done.notes);
  return ok({ id: CALENDAR_ID, source: CALENDAR_NAME, summary: done.summary, notes: done.notes });
};

// A day earlier than the one the cursor was taken under: what the cursor passed over never comes back
// through it. It is read out first all the same, so what was removed since the last run is still put
// aside, then the delta is read whole for what the narrower reach passed over; an event already filed
// is fetched and left be.
const deltaFor = async (deps: SyncCalendarDeps, state: CalendarState, since: string | undefined): Promise<Result<EventsDelta, CalendarReaderError>> => {
  const drained = await deps.reader.eventsDelta(state.deltaLink);
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
    return finish(deps, input, written.value, delta.value.deltaLink);
  };
