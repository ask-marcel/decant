import { archivePath } from '../domain/output-paths.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { renderTaskDocument } from '../domain/todo-document.ts';
import { TODO_STATE_VERSION, emptyTodoState, parseTodoState, planTaskFiles, serializeTodoState, todoRootName, todoWorklist, withTask, withoutTask } from '../domain/todo-state.ts';
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

export const TODO_STATE_FILE = '.sync-state.json';

export type SyncTodoDeps = {
  readonly reader: TodoReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
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

const archiveRootOf = (kbRoot: string, name: string): string => `${kbRoot}/_archive/${todoRootName(name)}`;

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
  deps.logger.warn('todo-state.unreadable', { list: list.name, cause: state.error.message });
  return emptyTodoState(list.id, list.name);
};

type Done = { readonly apply: (state: TodoState) => TodoState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

// The copy under the day the task used to carry, which the fresh one does not overwrite because it
// sits under a different day. Put aside rather than deleted, where everything the source no longer
// has already goes.
const archiveSuperseded = async (deps: SyncTodoDeps, roots: Roots, before: TaskRecord | undefined, after: string): Promise<void> => {
  if (before === undefined || before.file === after) return;
  const moved = await deps.files.move(before.file, archivePath(roots.archive, roots.root, before.file));
  if (!moved.ok) deps.logger.warn('supersede.failed', { path: before.file, cause: moved.error.kind });
};

type Roots = { readonly root: string; readonly archive: string };

const writeOne = async (deps: SyncTodoDeps, input: SyncTodoInput, roots: Roots, state: TodoState, planned: PlannedTask): Promise<Done> => {
  const { task, file } = planned;
  const document = renderTaskDocument({ task, list: input.list.name, syncedAt: deps.clock.nowIso() });
  const written = await deps.files.writeText(file, document);
  if (!written.ok) {
    deps.logger.warn('todo-task.failed', { task: task.id, cause: written.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: task.title, reason: written.error.message }] } };
  }
  await archiveSuperseded(deps, roots, state.tasks[task.id], file);
  const record: TaskRecord = { file, lastModified: task.lastModified, title: task.title };
  return { apply: (carried) => withTask(carried, task.id, record), counted: { converted: 1 }, notes: {} };
};

// A task the list no longer holds. Named in the report by its title, which is the only thing left to
// call it once the source has stopped answering for its id.
const archiveGone = async (deps: SyncTodoDeps, roots: Roots, gone: { readonly id: string; readonly record: TaskRecord }): Promise<Done> => {
  const moved = await deps.files.move(gone.record.file, archivePath(roots.archive, roots.root, gone.record.file));
  if (!moved.ok) deps.logger.warn('archive.failed', { path: gone.record.file, cause: moved.error.kind });
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

const writeWindow = async (deps: SyncTodoDeps, input: SyncTodoInput, roots: Roots, state: TodoState, window: ReadonlyArray<PlannedTask>): Promise<ReadonlyArray<Done>> =>
  Promise.all(
    window.map((planned) => {
      deps.progress.begin(planned.task.title);
      return writeOne(deps, input, roots, state, planned).then((done) => {
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
    const results = await writeWindow(deps, input, roots, progressing.state, planned.slice(at, at + input.concurrency));
    progressing = fold(progressing, results);
    const saved = await save(deps, `${roots.root}/${TODO_STATE_FILE}`, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

const sweep = async (deps: SyncTodoDeps, input: SyncTodoInput, roots: Roots, state: TodoState, tasks: ReadonlyArray<TodoTask>): Promise<Result<SourceRun, StepError>> => {
  const work = todoWorklist(state, tasks);
  deps.progress.start(work.write.length, input.list.name);
  const planned = planTaskFiles(roots.root, work.write, state);
  const written = await write(deps, input, roots, { summary: EMPTY, notes: NO_NOTES, state }, planned);
  deps.progress.done();
  if (!written.ok) return written;
  const gone = await Promise.all(work.archive.map((entry) => archiveGone(deps, roots, entry)));
  const done = fold(written.value, gone);
  // Saved once at the end as well as per window, so a run that found nothing to write still stamps
  // its own file: without it the state carried the date of the last run that happened to find work,
  // and the run report called the list stale on the strength of that.
  const saved = await save(deps, `${roots.root}/${TODO_STATE_FILE}`, done.state);
  if (!saved.ok) return saved;
  await writeReport(deps, input, roots.root, input.list.name, done.summary, done.notes);
  return ok({ id: input.list.id, source: input.list.name, summary: done.summary, notes: done.notes });
};

export const createSyncTodo =
  (deps: SyncTodoDeps): SyncTodo =>
  async (input) => {
    const roots: Roots = { root: todoRoot(deps.kbRoot, input.list.name), archive: archiveRootOf(deps.kbRoot, input.list.name) };
    const state = await loadState(deps, `${roots.root}/${TODO_STATE_FILE}`, input.list);
    const listed = await deps.reader.tasks(input.list.id);
    if (!listed.ok) return failed('listTasks', listed.error.kind, listed.error.message);
    if (input.dryRun) {
      const work = todoWorklist(state, listed.value);
      return ok({ id: input.list.id, source: input.list.name, summary: { ...EMPTY, queued: work.write.length }, notes: NO_NOTES });
    }
    return sweep(deps, input, roots, { ...state, version: TODO_STATE_VERSION }, listed.value);
  };
