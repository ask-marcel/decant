import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseTodoTask } from '../domain/todo-task.ts';
import type { TodoTask } from '../domain/todo-task.ts';
import { canonicalCursor } from '../domain/utilities/graph-cursor.ts';
import type { TodoList, TodoReader, TodoReaderError } from '../use-cases/ports/todo-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// The steps and the linked resources are navigation properties, so a listing that does not ask for
// them answers with a task carrying neither. Asked for here, in the one request that fetches the
// task, rather than in a second request per task.
const EXPANDED = 'checklistItems,linkedResources';

// An ordinary collection rather than a delta, so a page hint is safe: a page smaller than asked for
// still answers with a cursor, and the loop below follows it. A hundred keeps each response small
// while cutting the round trips a long list would otherwise cost.
const PAGE_SIZE = '100';

// One request, the way the mail folders are listed. A person has a handful of lists, not a page of
// them, and a cursor nobody will ever be handed is a loop nothing would ever exercise.
const LISTS_PAGE_SIZE = '200';

const listsOf = (raw: unknown): ReadonlyArray<TodoList> =>
  listOf(raw).flatMap((entry: unknown) => {
    const id = readString(entry, 'id');
    // A list Graph named with nothing is still a list worth offering, so it goes under its own id
    // rather than under a blank the operator could not tell from another blank.
    return id === undefined ? [] : [{ id, name: readString(entry, 'displayName') ?? id }];
  });

type TaskPage = { readonly tasks: ReadonlyArray<TodoTask>; readonly next?: string };

export const createTodoReaderFromCall = (call: MarcelCall): TodoReader => {
  const page = async (name: string, params: Record<string, string>): Promise<Result<TaskPage, TodoReaderError>> => {
    const raw = await call(name, params);
    if (!raw.ok) return raw;
    const tasks = listOf(raw.value).flatMap((entry: unknown) => {
      const task = parseTodoTask(entry);
      return task === undefined ? [] : [task];
    });
    const next = canonicalCursor(readString(raw.value, '@odata.nextLink'));
    return ok(next === undefined ? { tasks } : { tasks, next });
  };

  return {
    taskLists: async () => {
      const raw = await call('list-todo-task-lists', { top: LISTS_PAGE_SIZE });
      return raw.ok ? ok(listsOf(raw.value)) : raw;
    },
    // Read whole every run, and only once it is whole is it handed back: half a list looks exactly
    // like a list whose other half was deleted, and the sweep would put those tasks aside.
    // The `seen` set is the guard the mail sweep keeps for the same reason: a cursor that points at
    // itself would otherwise page forever.
    tasks: async (listId) => {
      const found: TodoTask[] = [];
      const seen = new Set<string>();
      let params: Record<string, string> | undefined = { todoTaskListId: listId, top: PAGE_SIZE, expand: EXPANDED };
      let name = 'list-todo-tasks';
      while (params !== undefined) {
        const answered: Result<TaskPage, TodoReaderError> = await page(name, params);
        if (!answered.ok) return answered;
        found.push(...answered.value.tasks);
        const next = answered.value.next;
        params = next === undefined || seen.has(next) ? undefined : { url: next };
        if (next !== undefined) seen.add(next);
        name = 'next-page';
      }
      return ok(found);
    },
  };
};
