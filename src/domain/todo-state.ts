import { CATEGORY_FOLDER } from './kb-category.ts';
import { cutToWord, freePath, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import { datedRoot } from './output-paths.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import type { TodoTask } from './todo-task.ts';
import { isGivenUp, parseAttempts } from './retry-ledger.ts';
import type { Attempts } from './retry-ledger.ts';
import { compareText } from './utilities/compare-text.ts';

export const TODO_STATE_VERSION = 1;

// A list's own folder, under the heading the picker offered it under. The name is the list's, so a
// list called `Tasks` sits at `To Do/Tasks` and never collides with a site of the same name.
export const todoRootName = (name: string): SafeRelPath => safeRelPath([CATEGORY_FOLDER.todo, name]);

// One task already written, and where. `lastModified` is what a later run compares against to decide
// whether the task needs writing again; `file` is what it moves aside when the answer files it under
// a different day, or when the list stops holding it. The title is kept because it is the only thing
// left to call a task by once the list no longer has it.
export type TaskRecord = { readonly file: string; readonly lastModified: string; readonly title: string };

// What a To Do list run leaves behind. Smaller than either inbox's state: a task is one document
// with nothing hanging off it, so there is no attachment store and no linked-file store. A task whose
// file could not be written is tried again by the next run, three runs at most on the same version.
export type TodoState = {
  readonly version: typeof TODO_STATE_VERSION;
  readonly source: { readonly kind: 'todo'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
  readonly retry?: Attempts;
  // The layout the tasks on disk were filed in. Absent is the first one, under the day each task last
  // changed; the second files them under the day they are due.
  readonly layout?: number;
};

export const TODO_LAYOUT = 2;

export type TodoStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyTodoState = (id: string, name: string): TodoState => ({
  version: TODO_STATE_VERSION,
  source: { kind: 'todo', id, name },
  lastRun: '',
  tasks: {},
});

export const serializeTodoState = (state: TodoState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const taskOf = (entry: Record<string, unknown>): TaskRecord => ({
  file: readString(entry, 'file') ?? '',
  lastModified: readString(entry, 'lastModified') ?? '',
  title: readString(entry, 'title') ?? '',
});

const tasksOf = (raw: unknown): Readonly<Record<string, TaskRecord>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, taskOf(entry)] as const] : [])));
};

export const parseTodoState = (raw: unknown): Result<TodoState, TodoStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'todo') return err({ kind: 'malformed', message: 'state is not a To Do list' });
  if (raw['version'] !== TODO_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${TODO_STATE_VERSION}` });
  return ok({
    version: TODO_STATE_VERSION,
    source: { kind: 'todo', id: readString(source, 'id') ?? '', name: readString(source, 'name') ?? '' },
    lastRun: readString(raw, 'lastRun') ?? '',
    tasks: tasksOf(raw['tasks']),
    retry: parseAttempts(raw['retry']),
    layout: typeof raw['layout'] === 'number' ? raw['layout'] : undefined,
  });
};

export const withTask = (state: TodoState, taskId: string, record: TaskRecord): TodoState => ({ ...state, tasks: { ...state.tasks, [taskId]: record } });

export const withoutTask = (state: TodoState, taskId: string): TodoState => ({
  ...state,
  tasks: Object.fromEntries(Object.entries(state.tasks).filter(([id]) => id !== taskId)),
});

// What the run owes, from the whole listing rather than from a cursor: To Do's delta reports what
// changed but not what a task now holds (its steps and its links are navigation properties a delta
// leaves out), so the list is read whole every run and the ledger says what is new. Reading it whole
// is also what makes a deleted task visible, which a delta's removals report only once.
// A task is written when it changed at the source, and when the file it belongs in is not the one it
// is in, which a new due day does; one out of tries on this version is left alone.
export type TodoWork = { readonly write: ReadonlyArray<PlannedTask>; readonly archive: ReadonlyArray<{ readonly id: string; readonly record: TaskRecord }> };

// Oldest first, so a run that stops leaves a prefix of the list rather than a scattering of it, and so
// every run plans the same names in the same order.
const oldestFirst = (left: TodoTask, right: TodoTask): number => compareText(left.lastModified, right.lastModified);

export const todoWorklist = (root: string, state: TodoState, tasks: ReadonlyArray<TodoTask>, budget?: number): TodoWork => {
  const listed = new Set(tasks.map((task) => task.id));
  const tried = tasks.filter((task) => !isGivenUp(state.retry?.[task.id], task.lastModified)).toSorted(oldestFirst);
  return {
    write: planTaskFiles(root, tried, state, budget).filter(({ task, file }) => state.tasks[task.id]?.lastModified !== task.lastModified || state.tasks[task.id]?.file !== file),
    archive: Object.entries(state.tasks).flatMap(([id, record]) => (listed.has(id) ? [] : [{ id, record }])),
  };
};

const MARKDOWN = '.md';

// A task's file is named by the first words of its title. A title can be a whole sentence, and at 180
// characters the path grew past what Windows accepts. The note's heading keeps the whole title.
const TITLE_LIMIT = 80;

// One task and the file it is about to be written to. Paired rather than looked up by id later, so
// there is no lookup that could miss and no fallback path for a miss that cannot happen.
export type PlannedTask = { readonly task: TodoTask; readonly file: string };

// Where each task about to be written goes: under the day it is due, or `undated/` when it has none,
// so a list reads in the order its work falls due, and an edit that keeps the due day keeps the path.
// Two tasks can carry the same title and be due the same day, which would land them on one path and
// lose one of them silently; the second and any after it take a suffix from their own id, the way two
// documents sharing a name in one library do.
// A path another task's record holds counts as taken even when that task is rewritten this run too:
// its file stays on disk until its own write lands and puts it aside, which can come after a second
// task's write to the same path and put the second task's fresh file aside instead. A task's own
// copy never stands in its way.
export const planTaskFiles = (root: string, tasks: ReadonlyArray<TodoTask>, state: TodoState, budget?: number): ReadonlyArray<PlannedTask> => {
  const taken = new Set(Object.values(state.tasks).map((record) => record.file));
  const planned: PlannedTask[] = [];
  for (const task of tasks) {
    const name = `${safeSegment(cutToWord(task.title, TITLE_LIMIT, ' '))}${MARKDOWN}`;
    const file = freePath(datedRoot(root, task.due), name, task.id, taken, state.tasks[task.id]?.file, budget);
    taken.add(file);
    planned.push({ task, file });
  }
  return planned;
};

export type RefiledTasks = { readonly state: TodoState; readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string }> };

// A list as the current layout files it, and the files to move to get there: each task from the day
// it last changed to the day it is due, or to `undated/` when it has none, under the name a write
// would give it now, so the run that moves it does not write it again. A task the list no longer
// holds stays where it is, for the run to put aside.
export const refileTasks = (root: string, state: TodoState, tasks: ReadonlyArray<TodoTask>, budget?: number): RefiledTasks => {
  const moves: { from: string; to: string }[] = [];
  const records: Record<string, TaskRecord> = { ...state.tasks };
  for (const { task, file } of planTaskFiles(root, tasks.toSorted(oldestFirst), state, budget)) {
    const record = state.tasks[task.id];
    if (record === undefined || record.file === file) continue;
    moves.push({ from: record.file, to: file });
    records[task.id] = { ...record, file };
  }
  return { state: { ...state, tasks: records, layout: TODO_LAYOUT }, moves };
};
