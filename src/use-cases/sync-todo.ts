import { INDEX_FILE } from '../domain/index-page.ts';
import { sameIgnoringCase } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { renderTaskDocument } from '../domain/todo-document.ts';
import { todoIndexPage } from '../domain/todo-index.ts';
import {
  TODO_LAYOUT,
  TODO_STATE_VERSION,
  emptyTodoState,
  parseTodoState,
  refileTasks,
  serializeTodoState,
  todoRootName,
  todoWorklist,
  withTask,
  withoutTask,
} from '../domain/todo-state.ts';
import type { PlannedTask, TaskRecord, TodoState } from '../domain/todo-state.ts';
import type { TodoTask } from '../domain/todo-task.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { TodoList, TodoReader } from './ports/todo-reader.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';
import { clearAttempt, gaveUpNotes, givenUpNotes, heldAttempts, isGivenUp, nextAttempt, recordAttempt } from '../domain/retry-ledger.ts';
import { withGaveUp } from '../domain/report.ts';
import { heldInPlace, letGo, putAside, putBack, setAside } from './put-aside.ts';
import type { SetAside, WriteDown } from './put-aside.ts';
import { refileAll } from './refile.ts';

export const TODO_STATE_FILE = '.sync-state.json';

export type SyncTodoDeps = {
  readonly reader: TodoReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
  // How long a path may be as decant writes it: Windows' limit less what stands in front of the
  // knowledge base on disk. Absent, names are not cut for length.
  readonly pathBudget?: number;
  // Where the files this sync lets go that would not move under the archive are written down, so a
  // later run moves them. Absent, such a file is only logged.
  readonly writeDown?: WriteDown;
};

// No size cap and no concurrency question worth asking about the bytes: a task is a few hundred
// characters of text with no attachment hanging off it. The window is still honoured, because it is
// the operator's one lever over how hard a run leans on the machine.
export type SyncTodoInput = { readonly list: TodoList; readonly dryRun: boolean; readonly concurrency: number };

export type SyncTodo = (input: SyncTodoInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const todoRoot = (kbRoot: string, name: string): string => `${kbRoot}/${todoRootName(name)}`;

const loadState = async (deps: SyncTodoDeps, path: string, list: TodoList): Promise<TodoState> => {
  const text = await deps.files.readText(path);
  if (!text.ok) return emptyTodoState(list.id, list.name);
  const parsed = parseJson(text.value);
  if (!parsed.ok) return emptyTodoState(list.id, list.name);
  const state = parseTodoState(parsed.value);
  if (state.ok) return state.value;
  // A state this code cannot read is left where it is and started over in memory, never written back
  // over: the documents on disk are the valuable half, and a run that cannot read its own notes
  // should re-file them rather than delete what it cannot account for.
  deps.logger.warn('todo-state.unreadable', { list: list.id, cause: state.error.message });
  return emptyTodoState(list.id, list.name);
};

type Done = { readonly apply: (state: TodoState) => TodoState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

// The version a task had before this write, set aside under the day of the run so the knowledge base
// keeps it, whether the task stays at its path or a new due day moved it. Put back when the write fails.
const setAsideBefore = async (deps: SyncTodoDeps, before: TaskRecord | undefined): Promise<SetAside> => {
  const aside = await setAside(deps, before === undefined ? [] : [before.file]);
  for (const missed of aside.failed) deps.logger.warn('supersede.failed', { path: missed.path, cause: missed.error.kind });
  return aside;
};

type Roots = { readonly root: string };

// A write that did not happen: the version before goes back where it was, and the task is tried
// again on the next run, three runs in all.
const notWritten = async (deps: SyncTodoDeps, state: TodoState, task: TodoTask, aside: SetAside, reason: string): Promise<Done> => {
  for (const missed of await putBack(deps, aside)) deps.logger.warn('restore.failed', { path: missed.path, cause: missed.error.kind });
  const attempt = nextAttempt(state.retry?.[task.id], task.lastModified, task.title, reason);
  // Out of tries now: named under its own heading, not as a failure the next run will try again.
  const notes = isGivenUp(attempt, task.lastModified) ? {} : { failed: [{ path: task.title, reason }] };
  return { apply: (carried) => ({ ...carried, retry: recordAttempt(carried.retry, task.id, attempt) }), counted: { failed: 1 }, notes };
};

// A version before that would not move aside, held open most often, would be lost to a write at its
// own path, so the task waits for a run that can move it.
const writeOne = async (deps: SyncTodoDeps, input: SyncTodoInput, state: TodoState, planned: PlannedTask): Promise<Done> => {
  const { task, file } = planned;
  const before = state.tasks[task.id];
  const aside = await setAsideBefore(deps, before);
  const held = sameIgnoringCase(before?.file ?? '', file) ? await heldInPlace(deps, aside) : undefined;
  if (held !== undefined) return notWritten(deps, state, task, aside, held);
  const written = await deps.files.writeText(file, renderTaskDocument({ task, list: input.list.name, syncedAt: deps.clock.nowIso() }));
  if (!written.ok) {
    deps.logger.warn('todo-task.failed', { task: task.id, cause: written.error.kind });
    return notWritten(deps, state, task, aside, written.error.message);
  }
  // Landed: a file of the version before that would not move is no longer the task's.
  await letGo(deps, aside);
  const record: TaskRecord = { file, lastModified: task.lastModified, title: task.title };
  return { apply: (carried) => ({ ...withTask(carried, task.id, record), retry: clearAttempt(carried.retry, task.id) }), counted: { converted: 1 }, notes: {} };
};

// A task the list no longer holds. Named in the report by its title, which is the only thing left to
// call it once the source has stopped answering for its id.
const archiveGone = async (deps: SyncTodoDeps, roots: Roots, gone: { readonly id: string; readonly record: TaskRecord }): Promise<Done> => {
  for (const missed of await putAside(deps, [gone.record.file])) deps.logger.warn('archive.failed', { path: missed.path, cause: missed.error.kind });
  return {
    apply: (carried) => withoutTask(carried, gone.id),
    counted: { archived: 1 },
    notes: { archived: [{ path: gone.record.title, reason: 'no longer in the list' }] },
  };
};

// Only the three a task run can produce. Nothing here converts a file, skips one for its size, or
// gives up on one after three tries, so the other counters are carried rather than added to.
const counted = (summary: RunSummary, results: ReadonlyArray<Done>): RunSummary =>
  results.reduce(
    (carried, done) => ({
      ...carried,
      converted: carried.converted + (done.counted.converted ?? 0),
      archived: carried.archived + (done.counted.archived ?? 0),
      failed: carried.failed + (done.counted.failed ?? 0),
    }),
    summary
  );

const noted = (notes: RunNotes, results: ReadonlyArray<Done>): RunNotes => ({
  ...notes,
  failed: [...notes.failed, ...results.flatMap((done) => done.notes.failed ?? [])],
  archived: [...notes.archived, ...results.flatMap((done) => done.notes.archived ?? [])],
});

const save = async (deps: SyncTodoDeps, path: string, state: TodoState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(path, serializeTodoState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: TodoState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

// What the list no longer holds leaves the ledger as it leaves the disk: a task deleted after it was
// given up on would otherwise be named as failed in every report for good.
const holding = (progressing: Progressing, tasks: ReadonlyArray<TodoTask>): Progressing => ({
  ...progressing,
  state: { ...progressing.state, retry: heldAttempts(progressing.state.retry, new Set(tasks.map((task) => task.id))) },
});

const writeWindow = async (deps: SyncTodoDeps, input: SyncTodoInput, state: TodoState, window: ReadonlyArray<PlannedTask>): Promise<ReadonlyArray<Done>> =>
  Promise.all(
    window.map((planned) => {
      deps.progress.begin(planned.task.title);
      return writeOne(deps, input, state, planned).then((done) => {
        deps.progress.step(planned.task.title);
        return done;
      });
    })
  );

const write = async (
  deps: SyncTodoDeps,
  input: SyncTodoInput,
  roots: Roots,
  carried: Progressing,
  planned: ReadonlyArray<PlannedTask>
): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  for (let at = 0; at < planned.length; at += input.concurrency) {
    const results = await writeWindow(deps, input, progressing.state, planned.slice(at, at + input.concurrency));
    progressing = fold(progressing, results);
    const saved = await save(deps, `${roots.root}/${TODO_STATE_FILE}`, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

// The list as a reader works through it, made from what the run holds. A page that will not write is
// logged and leaves the run standing: the tasks themselves already landed.
const writeIndex = async (deps: SyncTodoDeps, input: SyncTodoInput, roots: Roots, tasks: ReadonlyArray<TodoTask>, state: TodoState): Promise<void> => {
  const path = `${roots.root}/${INDEX_FILE}`;
  const written = await deps.files.writeText(path, todoIndexPage(input.list.name, roots.root, tasks, state));
  if (!written.ok) deps.logger.warn('index.failed', { path, cause: written.error.kind });
};

const sweep = async (deps: SyncTodoDeps, input: SyncTodoInput, roots: Roots, state: TodoState, tasks: ReadonlyArray<TodoTask>): Promise<Result<SourceRun, StepError>> => {
  const work = todoWorklist(roots.root, state, tasks, deps.pathBudget);
  deps.progress.start(work.write.length, input.list.name);
  const written = await write(deps, input, roots, { summary: EMPTY, notes: NO_NOTES, state }, work.write);
  deps.progress.done();
  if (!written.ok) return written;
  const gone = await Promise.all(work.archive.map((entry) => archiveGone(deps, roots, entry)));
  const done = holding(fold(written.value, gone), tasks);
  // Saved once at the end as well as per window, so a run that found nothing to write still stamps
  // its own file: without it the state carried the date of the last run that happened to find work,
  // and the run report called the list stale on the strength of that.
  const saved = await save(deps, `${roots.root}/${TODO_STATE_FILE}`, done.state);
  if (!saved.ok) return saved;
  await writeIndex(deps, input, roots, tasks, done.state);
  const notes = withGaveUp({ ...done.notes, givenUp: givenUpNotes(done.state.retry) }, gaveUpNotes(state.retry, done.state.retry));
  await writeReport(deps, input, roots.root, input.list.name, done.summary, notes);
  return ok({ id: input.list.id, source: input.list.name, summary: done.summary, notes });
};

// The first run of this layout moves every task from the day it last changed to the day it is due,
// once. The moves are not put aside: nothing is superseded, only filed again. A task that will not
// move stays recorded where it is and keeps the list in the earlier layout, so the next run moves it.
const refile = async (deps: SyncTodoDeps, roots: Roots, state: TodoState, tasks: ReadonlyArray<TodoTask>): Promise<TodoState> => {
  const refiled = refileTasks(roots.root, state, tasks, deps.pathBudget);
  const stuck = await refileAll(deps, refiled.moves);
  if (stuck.size === 0) return refiled.state;
  const records = Object.entries(refiled.state.tasks).map(([id, record]) => [id, { ...record, file: stuck.get(record.file) ?? record.file }] as const);
  return { ...refiled.state, tasks: Object.fromEntries(records), layout: state.layout };
};

export const createSyncTodo =
  (deps: SyncTodoDeps): SyncTodo =>
  async (input) => {
    const roots: Roots = { root: todoRoot(deps.kbRoot, input.list.name) };
    const loaded = await loadState(deps, `${roots.root}/${TODO_STATE_FILE}`, input.list);
    const listed = await deps.reader.tasks(input.list.id);
    if (!listed.ok) return failed('listTasks', listed.error.kind, listed.error.message);
    if (input.dryRun) {
      // Counted on the list as this layout files it, where the first run moves its tasks rather than
      // writing them again.
      const filed = loaded.layout === TODO_LAYOUT ? loaded : refileTasks(roots.root, loaded, listed.value, deps.pathBudget).state;
      const work = todoWorklist(roots.root, filed, listed.value, deps.pathBudget);
      return ok({ id: input.list.id, source: input.list.name, summary: { ...EMPTY, queued: work.write.length }, notes: NO_NOTES });
    }
    const state = loaded.layout === TODO_LAYOUT ? loaded : await refile(deps, roots, loaded, listed.value);
    return sweep(deps, input, roots, { ...state, version: TODO_STATE_VERSION }, listed.value);
  };
