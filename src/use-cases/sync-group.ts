import { GROUP_STATE_VERSION, emptyGroupState, groupRootName, parseGroupState, serializeGroupState, watermarkOf, withGroupThread } from '../domain/group-state.ts';
import type { GroupState } from '../domain/group-state.ts';
import { threadRef } from '../domain/group-thread.ts';
import type { GroupThread } from '../domain/group-thread.ts';
import type { AttachmentRecord, LinkedRecord, ThreadRecord } from '../domain/mail-state.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { GroupReader, GroupSummary } from './ports/group-reader.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RenderThread } from './render-thread.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const GROUP_STATE_FILE = '.sync-state.json';

export type SyncGroupDeps = {
  readonly reader: GroupReader;
  readonly files: Files;
  readonly renderThread: RenderThread;
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
};

export type SyncGroup = (input: SyncGroupInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], archived: [] };

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
  deps.logger.warn('group-state.unreadable', { group: group.name, cause: state.error.message });
  return emptyGroupState(group.id, group.name);
};

// Newest first is how Graph answers, so everything above the watermark is what this run has not
// filed. Rendered oldest first, so a stopped run leaves a prefix of the history rather than a
// scattering of it, and the next run picks up where the dates say it should.
const freshThreads = (threads: ReadonlyArray<GroupThread>, watermark: string): ReadonlyArray<GroupThread> =>
  [...threads.filter((thread) => thread.lastDelivered > watermark)].reverse();

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

const renderOne = async (deps: SyncGroupDeps, input: SyncGroupInput, state: GroupState, thread: GroupThread): Promise<Rendered> => {
  const rendered = await deps.renderThread({
    threadId: threadIdOf(thread.id),
    conversationIds: [threadRef(input.group.id, thread.id)],
    root: thread.id,
    folder: state.threads[thread.id]?.folder ?? '',
    maxBytes: input.maxBytes,
    linked: state.linked,
    attachments: state.attachments,
  });
  if (!rendered.ok) {
    deps.logger.warn('group-thread.failed', { thread: thread.id, cause: rendered.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: `thread ${thread.topic}`, reason: rendered.error.message }] } };
  }
  if (rendered.value.kind === 'empty') return { apply: (carried) => carried, counted: { skipped: 1 }, notes: {} };
  const done = rendered.value.thread;
  return {
    apply: (carried) => recordThread(carried, thread.id, done),
    counted: { converted: 1, skipped: done.filesSkipped.length, failed: done.filesFailed.length },
    notes: { skipped: done.filesSkipped, failed: done.filesFailed },
  };
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
      skipped: carried.skipped + (done.counted.skipped ?? 0),
      failed: carried.failed + (done.counted.failed ?? 0),
    }),
    summary
  );

const noted = (notes: RunNotes, results: ReadonlyArray<Rendered>): RunNotes =>
  results.reduce(
    (carried, done) => ({ skipped: [...carried.skipped, ...(done.notes.skipped ?? [])], failed: [...carried.failed, ...(done.notes.failed ?? [])], archived: carried.archived }),
    notes
  );

const render = async (deps: SyncGroupDeps, input: SyncGroupInput, state: GroupState, root: string, threads: ReadonlyArray<GroupThread>): Promise<Result<SourceRun, StepError>> => {
  let current = state;
  let summary = EMPTY;
  let notes = NO_NOTES;
  deps.progress.start(threads.length, `${input.group.name} (group inbox)`);
  for (let at = 0; at < threads.length; at += input.concurrency) {
    const window = threads.slice(at, at + input.concurrency);
    const results = await Promise.all(
      window.map((thread) => {
        deps.progress.begin(thread.topic);
        return renderOne(deps, input, current, thread).then((outcome) => {
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
  await writeReport(deps, input, root, input.group.name, summary, notes);
  return ok({ id: input.group.id, source: input.group.name, summary, notes });
};

export const createSyncGroup =
  (deps: SyncGroupDeps): SyncGroup =>
  async (input) => {
    const root = groupRoot(deps.kbRoot, input.group.name);
    const state = await loadState(deps, `${root}/${GROUP_STATE_FILE}`, input.group);
    const listed = await deps.reader.threads(input.group.id);
    if (!listed.ok) return failed('listThreads', listed.error.kind, listed.error.message);
    const fresh = freshThreads(listed.value, watermarkOf(state));
    if (input.dryRun) return ok({ id: input.group.id, source: input.group.name, summary: { ...EMPTY, queued: fresh.length }, notes: NO_NOTES });
    return render(deps, input, { ...state, version: GROUP_STATE_VERSION }, root, fresh);
  };
