import { describe, expect, it } from 'bun:test';
import { todoIndexPage } from './todo-index.ts';
import { emptyTodoState, withTask } from './todo-state.ts';
import type { TodoState } from './todo-state.ts';
import type { TodoTask } from './todo-task.ts';

const task = (id: string, over: Partial<TodoTask> = {}): TodoTask => ({
  id,
  title: id,
  status: 'notStarted',
  importance: 'normal',
  notes: '',
  created: '',
  lastModified: '2026-09-01T09:00:00Z',
  due: '',
  completed: '',
  categories: [],
  steps: [],
  links: [],
  ...over,
});

const filed = (tasks: ReadonlyArray<TodoTask>): TodoState =>
  tasks.reduce(
    (state, entry) => withTask(state, entry.id, { file: `kb/To Do/Tasks/undated/${entry.id}.md`, lastModified: entry.lastModified, title: entry.title }),
    emptyTodoState('list-1', 'Tasks')
  );

const lines = (page: string): ReadonlyArray<string> => page.split('\n').filter((line) => line.startsWith('- '));

describe('the page a reader works through a list by', () => {
  // A tie keeps the order of the titles, so the page reads the same on every run.
  it('tasks due the same day, or done the same day, are listed by their titles', () => {
    const tasks = [
      task('b', { due: '2026-09-10' }),
      task('a', { due: '2026-09-10' }),
      task('d', { status: 'completed', completed: '2026-09-05' }),
      task('c', { status: 'completed', completed: '2026-09-05' }),
      task('e', { status: 'completed' }),
    ];

    expect(lines(todoIndexPage('Tasks', 'kb/To Do/Tasks', tasks, filed(tasks)))).toEqual([
      '- 2026-09-10 · [a](undated/a.md) · not started',
      '- 2026-09-10 · [b](undated/b.md) · not started',
      '- 2026-09-05 · [c](undated/c.md)',
      '- 2026-09-05 · [d](undated/d.md)',
      '- [e](undated/e.md)',
    ]);
  });

  it('a status reads as words, and a task the list holds that is not on disk has no line', () => {
    const waiting = task('w', { status: 'waitingOnOthers' });

    expect(lines(todoIndexPage('Tasks', 'kb/To Do/Tasks', [waiting, task('missing')], filed([waiting])))).toEqual(['- [w](undated/w.md) · waiting on others']);
  });
});
