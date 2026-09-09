import { CATEGORY_FOLDER } from './kb-category.ts';
import { disambiguateSegment, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import { datedRoot } from './output-paths.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import type { TodoTask } from './todo-task.ts';

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
// with nothing hanging off it, so there is no attachment store, no linked-file store, and no retry
// ledger, a task that failed being one the next run finds unchanged and writes again.
export type TodoState = {
  readonly version: typeof TODO_STATE_VERSION;
  readonly source: { readonly kind: 'todo'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
};

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
export type TodoWork = { readonly write: ReadonlyArray<TodoTask>; readonly archive: ReadonlyArray<{ readonly id: string; readonly record: TaskRecord }> };

export const todoWorklist = (state: TodoState, tasks: ReadonlyArray<TodoTask>): TodoWork => {
  const listed = new Set(tasks.map((task) => task.id));
  return {
    // Oldest first, so a run that stops leaves a prefix of the list rather than a scattering of it.
    write: [...tasks.filter((task) => state.tasks[task.id]?.lastModified !== task.lastModified)].sort((left, right) => left.lastModified.localeCompare(right.lastModified)),
    archive: Object.entries(state.tasks).flatMap(([id, record]) => (listed.has(id) ? [] : [{ id, record }])),
  };
};

const MARKDOWN = '.md';

const fileAt = (root: string, task: TodoTask, name: string): string => `${datedRoot(root, task.lastModified)}/${name}`;

// One task and the file it is about to be written to. Paired rather than looked up by id later, so
// there is no lookup that could miss and no fallback path for a miss that cannot happen.
export type PlannedTask = { readonly task: TodoTask; readonly file: string };

// Where each task about to be written goes. Two tasks can carry the same title and last change on
// the same day, which would land them on one path and lose one of them silently; the second and any
// after it take a suffix from their own id, the way two documents sharing a name in one library do.
// A path a task NOT being rewritten already occupies counts as taken, since that file is on disk.
export const planTaskFiles = (root: string, tasks: ReadonlyArray<TodoTask>, state: TodoState): ReadonlyArray<PlannedTask> => {
  const rewriting = new Set(tasks.map((task) => task.id));
  const taken = new Set(Object.entries(state.tasks).flatMap(([id, record]) => (rewriting.has(id) ? [] : [record.file])));
  const planned: PlannedTask[] = [];
  for (const task of tasks) {
    const plain = fileAt(root, task, `${safeSegment(task.title)}${MARKDOWN}`);
    const file = taken.has(plain) ? fileAt(root, task, disambiguateSegment(`${safeSegment(task.title)}${MARKDOWN}`, task.id)) : plain;
    taken.add(file);
    planned.push({ task, file });
  }
  return planned;
};
