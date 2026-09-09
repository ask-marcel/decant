import { err, ok } from '../domain/result.ts';
import type { TodoTask } from '../domain/todo-task.ts';
import type { TodoList, TodoReader, TodoReaderError } from '../use-cases/ports/todo-reader.ts';

export type TodoReaderSeed = {
  readonly lists?: ReadonlyArray<TodoList>;
  // Tasks answered per list id, in the order Graph would hand them over.
  readonly tasks?: Readonly<Record<string, ReadonlyArray<TodoTask>>>;
  readonly failLists?: TodoReaderError;
  readonly failTasks?: TodoReaderError;
};

export type TodoReaderFake = TodoReader & { readonly calls: Array<string> };

export const createTodoReaderFake = (seed: TodoReaderSeed = {}): TodoReaderFake => {
  const calls: string[] = [];
  return {
    calls,
    taskLists: async () => {
      calls.push('taskLists');
      return seed.failLists === undefined ? ok(seed.lists ?? []) : err(seed.failLists);
    },
    tasks: async (listId) => {
      calls.push(`tasks:${listId}`);
      return seed.failTasks === undefined ? ok(seed.tasks?.[listId] ?? []) : err(seed.failTasks);
    },
  };
};
