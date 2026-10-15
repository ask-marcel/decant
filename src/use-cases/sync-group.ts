import {
  GROUP_STATE_VERSION,
  emptyGroupState,
  groupRootName,
  parseGroupState,
  serializeGroupState,
  watermarkOf,
  withGroupRetry,
  withGroupThread,
  withoutGroupRetry,
  unlistedThreads,
  withoutGroupThread,
} from '../domain/group-state.ts';
import type { GroupState } from '../domain/group-state.ts';
import { threadRef } from '../domain/group-thread.ts';
import type { GroupThread } from '../domain/group-thread.ts';
import { abandonedThreads, filesOf, storesWithout } from '../domain/mail-state.ts';
import { withGaveUp } from '../domain/report.ts';
import type { AttachmentRecord, LinkedRecord, RetryRecord, ThreadRecord } from '../domain/mail-state.ts';
import { MAX_CONVERSION_ATTEMPTS } from '../domain/retry-policy.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { sourceLabel } from '../domain/sync-state.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { isBefore, widens } from '../domain/sync-window.ts';
import type { GroupReader, GroupSummary } from './ports/group-reader.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RenderThread, RenderedThread } from './render-thread.ts';
import { folderFor, threadFoldersOn } from './thread-folders.ts';
import { NO_LONGER_LISTED, NO_MESSAGE_LEFT, threadAside, writtenAgain } from './thread-aside.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const GROUP_STATE_FILE = '.sync-state.json';

export type SyncGroupDeps = {
  readonly reader: GroupReader;
  readonly files: Files;
  // Built per group rather than once, because the renderer is given the folder it writes into when
  // it is constructed, and every group writes into its own.
  readonly renderThreadFor: (root: string, name: string) => RenderThread;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncGroupInput = {
  readonly group: GroupSummary;
  readonly maxBytes: number;
  readonly dryRun: boolean;
  readonly concurrency: number;
  // Only threads last written to on or after this day are filed; absent, every thread is.
  readonly since?: string;
};

export type SyncGroup = (input: SyncGroupInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const groupRoot = (kbRoot: string, name: string): string => `${kbRoot}/${groupRootName(name)}`;

const loadState = async (deps: SyncGroupDeps, path: string, group: GroupSummary): Promise<GroupState> => {
  const text = await deps.files.readText(path);
  if (!text.ok) return emptyGroupState(group.id, group.name);
  const parsed = parseJson(text.value);
  if (!parsed.ok) return emptyGroupState(group.id, group.name);
  const state = parseGroupState(parsed.value);
  if (state.ok) return state.value;
  // A state this code cannot read is left where it is and started over in memory, never written
  // back over: the documents on disk are the valuable half, and a run that cannot read its own
  // notes should re-file them rather than delete what it cannot account for.
  deps.logger.warn('group-state.unreadable', { group: group.id, cause: state.error.message });
  return emptyGroupState(group.id, group.name);
};

// Newest first is how Graph answers, so everything above the watermark is what this run has not
// filed. Rendered oldest first, so a stopped run leaves a prefix of the history rather than a
// scattering of it, and the next run picks up where the dates say it should.
//
// What an earlier run could not write comes back alongside, whatever its date. It has to: a thread
// that failed recorded nothing, so the watermark climbed past it on the strength of a newer thread
// that did land, and no reading of the dates alone would ever reach it again. The listing is whole
// every run, there being no cursor, so the thread itself is already in hand.
//
// A day moved earlier than the one the threads were filed under reaches below the watermark, which
// no reading of the dates would: every thread in reach that was neither filed nor given up on.
const freshThreads = (threads: ReadonlyArray<GroupThread>, state: GroupState, since: string | undefined): ReadonlyArray<GroupThread> => {
  const watermark = watermarkOf(state);
  const widened = widens(state.since, since);
  const inReach = (thread: GroupThread): boolean => !isBefore(thread.lastDelivered, since) && (thread.lastDelivered > watermark || (widened && unfiled(state, thread.id)));
  return [...threads.filter((thread) => stillOwed(state.retry[thread.id]) || inReach(thread))].reverse();
};

const unfiled = (state: GroupState, threadId: string): boolean => state.threads[threadId] === undefined && state.retry[threadId] === undefined;

const stillOwed = (record: RetryRecord | undefined): boolean => record !== undefined && record.attempts < MAX_CONVERSION_ATTEMPTS;

// The renderer is handed the two stores and hands them back with whatever it added, so folding a
// rendered thread in is the record plus those two, not an entry-by-entry merge.
const recordThread = (
  state: GroupState,
  threadId: string,
  thread: { readonly record: ThreadRecord; readonly linked: Readonly<Record<string, LinkedRecord>>; readonly attachments: Readonly<Record<string, AttachmentRecord>> }
): GroupState => ({
  ...withGroupThread(state, threadId, thread.record),
  linked: { ...state.linked, ...thread.linked },
  attachments: { ...state.attachments, ...thread.attachments },
});

type Rendered = { readonly apply: (state: GroupState) => GroupState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

// Where the group's own folder is, and the thread folders already on disk under it.
type GroupPlace = { readonly root: string; readonly onDisk: ReadonlyArray<string> };

const renderOne = async (deps: SyncGroupDeps, input: SyncGroupInput, state: GroupState, place: GroupPlace, thread: GroupThread): Promise<Rendered> => {
  const threadId = threadIdOf(thread.id);
  const rendered = await deps.renderThreadFor(
    place.root,
    input.group.name
  )({
    threadId,
    label: thread.topic,
    conversationIds: [threadRef(input.group.id, thread.id)],
    root: thread.id,
    folder: folderFor(state.threads[thread.id], place.onDisk, threadId),
    file: state.threads[thread.id]?.file,
    maxBytes: input.maxBytes,
    linked: state.linked,
    attachments: state.attachments,
  });
  if (!rendered.ok) {
    deps.logger.warn('group-thread.failed', { thread: thread.id, cause: rendered.error.kind });
    const attempts = attemptsFor(state, thread.id);
    // The ledger's own list names a thread that has run out of tries, so reporting it here as well
    // would print it twice under headings promising opposite things.
    const notes = attempts >= MAX_CONVERSION_ATTEMPTS ? {} : { failed: [{ path: `thread ${thread.topic}`, reason: rendered.error.message }] };
    return { apply: (carried) => withGroupRetry(carried, thread.id, { attempts, reason: rendered.error.message }), counted: { failed: 1 }, notes };
  }
  if (rendered.value.kind === 'empty') return emptied(deps, state, place, thread.id, NO_MESSAGE_LEFT);
  // What the write before held and this one did not write again, put aside as the mailbox does.
  return writtenAgain(deps, { root: place.root, threadId }, state.threads[thread.id], rendered.value.thread, (done) => owing(state, thread.id, done));
};

const attemptsFor = (state: GroupState, threadId: string): number => (state.retry[threadId]?.attempts ?? 0) + 1;

// A thread written before and holding no post now, or gone from the group, goes under the archive
// whole and leaves the state. One never written left nothing to put aside.
const emptied = async (deps: SyncGroupDeps, state: GroupState, place: GroupPlace, threadId: string, reason: string): Promise<Rendered> => {
  const known = state.threads[threadId];
  if (known === undefined) return { apply: (carried) => withoutGroupRetry(carried, threadId), counted: { skipped: 1 }, notes: {} };
  const aside = await threadAside(deps, place.root, threadIdOf(threadId), known, reason);
  if (!aside.moved) return stuckAside(state, threadId, known.file, aside.reason);
  const apply = (carried: GroupState): GroupState => {
    const gone = withoutGroupThread(carried, threadId);
    return { ...gone, ...storesWithout(gone, filesOf(known)) };
  };
  return { apply, counted: { archived: 1 }, notes: { archived: [aside.entry] } };
};

// A thread whose note would not move keeps its record and is tried again on the next run, three times
// in all, the way a thread that could not be written is.
const stuckAside = (state: GroupState, threadId: string, file: string, reason: string): Rendered => {
  const attempts = attemptsFor(state, threadId);
  const notes = attempts >= MAX_CONVERSION_ATTEMPTS ? {} : { failed: [{ path: file, reason }] };
  return { apply: (carried) => withGroupRetry(carried, threadId, { attempts, reason }), counted: { failed: 1 }, notes };
};

// The thread landed; one of the files it carried did not. The whole thread is written again next run
// to fetch that one file, exactly as the mailbox does, because nothing narrower can be asked for.
// At the cap the record goes and the files are named once as files: the thread is on disk with a
// card in its own folder saying what happened, which is not true of a thread that never rendered.
const owing = (state: GroupState, threadId: string, done: RenderedThread): Rendered => {
  const counted = { converted: 1, skipped: done.filesSkipped.length, failed: done.filesFailed.length };
  const attempts = attemptsFor(state, threadId);
  const owed = attempts < MAX_CONVERSION_ATTEMPTS ? done.filesFailed[0] : undefined;
  const apply = (carried: GroupState): GroupState => {
    const recorded = recordThread(carried, threadId, done);
    if (owed === undefined) return withoutGroupRetry(recorded, threadId);
    return withGroupRetry(recorded, threadId, { attempts, reason: `${owed.path}: ${owed.reason}` });
  };
  const failed = owed === undefined ? { givenUp: done.filesFailed } : { failed: done.filesFailed };
  return { apply, counted, notes: { skipped: done.filesSkipped, ...failed } };
};

const save = async (deps: SyncGroupDeps, path: string, state: GroupState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(path, serializeGroupState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

const counted = (summary: RunSummary, results: ReadonlyArray<Rendered>): RunSummary =>
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

const noted = (notes: RunNotes, results: ReadonlyArray<Rendered>): RunNotes =>
  results.reduce(
    (carried, done) => ({
      skipped: [...carried.skipped, ...(done.notes.skipped ?? [])],
      failed: [...carried.failed, ...(done.notes.failed ?? [])],
      givenUp: [...carried.givenUp, ...(done.notes.givenUp ?? [])],
      archived: [...carried.archived, ...(done.notes.archived ?? [])],
    }),
    notes
  );

// Named by topic where the listing still has one, since a report is read by a person and a Graph
// thread id tells them nothing. A thread the group has since dropped keeps its id, which is all
// there is left to call it.
const named = (entries: ReadonlyArray<{ readonly threadId: string; readonly reason: string }>, listing: ReadonlyArray<GroupThread>): RunNotes['givenUp'] =>
  entries.map((entry) => ({
    path: `thread ${listing.find((thread) => thread.id === entry.threadId)?.topic ?? entry.threadId}`,
    reason: entry.reason,
  }));

// Added to, never replacing: a run reports the files a rendered thread has stopped owing as well
// as the threads the ledger still holds, and the two lists are filled from different places. The
// files stopped owing in this run, and a thread joins the list in the run that gave up on it: those
// two are what the group's own report names.
const abandonedNotes = (notes: RunNotes, before: GroupState, after: GroupState, listing: ReadonlyArray<GroupThread>): RunNotes => {
  const already = new Set(abandonedThreads(before.retry).map((entry) => entry.threadId));
  const abandoned = abandonedThreads(after.retry);
  const gaveUp = named(
    abandoned.filter((entry) => !already.has(entry.threadId)),
    listing
  );
  return withGaveUp({ ...notes, givenUp: [...notes.givenUp, ...named(abandoned, listing)] }, [...notes.givenUp, ...gaveUp]);
};

const labelOf = (input: SyncGroupInput): string => sourceLabel({ name: input.group.name, kind: 'group' });

// The threads on record that the group no longer lists, each put aside whole. An empty listing while
// threads are on record moves nothing: it is most often a fault, and taken at its word it would move
// the whole inbox aside.
const unlisted = async (
  deps: SyncGroupDeps,
  input: SyncGroupInput,
  state: GroupState,
  place: GroupPlace,
  listing: ReadonlyArray<GroupThread>
): Promise<ReadonlyArray<Rendered>> => {
  // A thread out of tries stays where it is, named as given up, as one that could not be written does.
  const gone = unlistedThreads(
    state,
    listing.map((thread) => thread.id)
  ).filter((threadId) => (state.retry[threadId]?.attempts ?? 0) < MAX_CONVERSION_ATTEMPTS);
  if (gone.length > 0 && listing.length === 0) {
    deps.logger.warn('group.listing-empty', { group: input.group.id, threads: gone.length });
    return [];
  }
  const results: Rendered[] = [];
  for (const threadId of gone) results.push(await emptied(deps, state, place, threadId, NO_LONGER_LISTED));
  return results;
};

const render = async (
  deps: SyncGroupDeps,
  input: SyncGroupInput,
  state: GroupState,
  root: string,
  threads: ReadonlyArray<GroupThread>,
  listing: ReadonlyArray<GroupThread>
): Promise<Result<SourceRun, StepError>> => {
  let current = state;
  let summary = EMPTY;
  let notes = NO_NOTES;
  const place = { root, onDisk: await threadFoldersOn(deps.files, root) };
  const gone = await unlisted(deps, input, current, place, listing);
  current = gone.reduce((carried, done) => done.apply(carried), current);
  summary = counted(summary, gone);
  notes = noted(notes, gone);
  deps.progress.start(threads.length, `${input.group.name} (group inbox)`);
  for (let at = 0; at < threads.length; at += input.concurrency) {
    const window = threads.slice(at, at + input.concurrency);
    const results = await Promise.all(
      window.map((thread) => {
        deps.progress.begin(thread.topic);
        return renderOne(deps, input, current, place, thread).then((outcome) => {
          deps.progress.step(thread.topic);
          return outcome;
        });
      })
    );
    current = results.reduce((carried, done) => done.apply(carried), current);
    const saved = await save(deps, `${root}/${GROUP_STATE_FILE}`, current);
    if (!saved.ok) {
      deps.progress.done();
      return saved;
    }
    summary = counted(summary, results);
    notes = noted(notes, results);
  }
  deps.progress.done();
  // Saved once at the end as well as per window, which is what the other two sources do. A group
  // that gained nothing renders nothing, so the window loop never runs and never saved: its state
  // then carried the date of the last run that happened to find work, and the run report called it
  // stale on the strength of that.
  // The day is kept only here, once every thread in reach has been tried: kept any earlier, a run
  // stopped halfway would leave the rest of a widened reach below the watermark for good.
  const finished = await save(deps, `${root}/${GROUP_STATE_FILE}`, { ...current, since: input.since });
  if (!finished.ok) return finished;
  const reported = abandonedNotes(notes, state, current, listing);
  await writeReport(deps, input, root, labelOf(input), summary, reported);
  return ok({ id: input.group.id, source: labelOf(input), summary, notes: reported });
};

export const createSyncGroup =
  (deps: SyncGroupDeps): SyncGroup =>
  async (input) => {
    const root = groupRoot(deps.kbRoot, input.group.name);
    const state = await loadState(deps, `${root}/${GROUP_STATE_FILE}`, input.group);
    const listed = await deps.reader.threads(input.group.id);
    if (!listed.ok) return failed('listThreads', listed.error.kind, listed.error.message);
    const fresh = freshThreads(listed.value, state, input.since);
    if (input.dryRun) return ok({ id: input.group.id, source: labelOf(input), summary: { ...EMPTY, queued: fresh.length }, notes: NO_NOTES });
    return render(deps, input, { ...state, version: GROUP_STATE_VERSION }, root, fresh, listed.value);
  };
