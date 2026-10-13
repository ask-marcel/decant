import { describe, expect, it } from 'bun:test';
import { emptyTodoState, parseTodoState, planTaskFiles, refileTasks, serializeTodoState, todoRootName, todoWorklist, withTask, withoutTask } from './todo-state.ts';
import type { TodoTask } from './todo-task.ts';

const task = (id: string, lastModified: string): TodoTask => ({
  id,
  title: id,
  status: 'notStarted',
  importance: 'normal',
  notes: '',
  created: '',
  lastModified,
  due: '',
  completed: '',
  categories: [],
  steps: [],
  links: [],
});

const ROOT = 'kb/To Do/Tasks';

// Two tasks with no due day, each written where this layout files it.
const seeded = (): ReturnType<typeof emptyTodoState> =>
  withTask(withTask(emptyTodoState('list-1', 'Tasks'), 'a', { file: 'kb/To Do/Tasks/undated/a.md', lastModified: '2026-09-01T09:00:00Z', title: 'a' }), 'b', {
    file: 'kb/To Do/Tasks/undated/b.md',
    lastModified: '2026-09-02T09:00:00Z',
    title: 'b',
  });

describe('what a To Do list run remembers between runs', () => {
  it('a list is shelved under the same heading the picker offered it under', () => {
    expect(String(todoRootName('Flagged Emails'))).toBe('To Do/Flagged Emails');
  });

  it('an empty state names the list it belongs to and holds no tasks yet', () => {
    expect(emptyTodoState('list-1', 'Tasks')).toEqual({ version: 1, source: { kind: 'todo', id: 'list-1', name: 'Tasks' }, lastRun: '', tasks: {} });
  });

  it('a task recorded once is found again by its id, with the file it wrote', () => {
    expect(seeded().tasks['a']).toEqual({ file: 'kb/To Do/Tasks/undated/a.md', lastModified: '2026-09-01T09:00:00Z', title: 'a' });
  });

  it('a task forgotten leaves the rest of the ledger where it was', () => {
    expect(Object.keys(withoutTask(seeded(), 'a').tasks)).toEqual(['b']);
  });

  it('a state written and read back is the state that was written', () => {
    const written = serializeTodoState(seeded());

    expect(parseTodoState(JSON.parse(written))).toEqual({ ok: true, value: seeded() });
  });

  it('a state written by another version is refused rather than half understood', () => {
    expect(parseTodoState({ version: 99, source: { kind: 'todo', id: 'list-1', name: 'Tasks' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is version 99, not 1' },
    });
  });

  it('a state that names the list but nothing else reads back as blanks, never as holes something later reads', () => {
    const parsed = parseTodoState({ version: 1, source: { kind: 'todo' }, tasks: { a: { file: 'kb/To Do/Tasks/2026-09-01/a.md' }, b: 'not a record' } });

    expect(parsed).toEqual({
      ok: true,
      value: {
        version: 1,
        source: { kind: 'todo', id: '', name: '' },
        lastRun: '',
        tasks: { a: { file: 'kb/To Do/Tasks/2026-09-01/a.md', lastModified: '', title: '' } },
      },
    });
  });

  it('a tasks block that is not an object at all reads as no tasks, rather than ending the run', () => {
    const parsed = parseTodoState({ version: 1, source: { kind: 'todo', id: 'list-1', name: 'Tasks' }, tasks: 'not an object' });

    expect(parsed.ok && Object.keys(parsed.value.tasks)).toHaveLength(0);
  });

  it('a state belonging to another kind of source is refused, so a mailbox is never read as a task list', () => {
    expect(parseTodoState({ version: 1, source: { kind: 'mailbox', id: 'me', name: 'Mailbox' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not a To Do list' },
    });
    expect(parseTodoState('not an object')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });
});

describe('deciding what a To Do run owes', () => {
  it('a task the ledger has never seen is written, and one whose source has not changed since is left alone', () => {
    const work = todoWorklist(ROOT, seeded(), [task('a', '2026-09-01T09:00:00Z'), task('c', '2026-09-03T09:00:00Z'), task('b', '2026-09-02T09:00:00Z')]);

    expect(work.write.map((entry) => entry.task.id)).toEqual(['c']);
    expect(work.archive).toHaveLength(0);
  });

  it('a task edited since it was written is written again', () => {
    const work = todoWorklist(ROOT, seeded(), [task('a', '2026-09-05T11:00:00Z'), task('b', '2026-09-02T09:00:00Z')]);

    expect(work.write.map((entry) => entry.task.id)).toEqual(['a']);
  });

  it('a task whose file is not where it belongs is written again where it belongs, though it did not change', () => {
    const work = todoWorklist(ROOT, seeded(), [{ ...task('a', '2026-09-01T09:00:00Z'), due: '2026-10-15' }, task('b', '2026-09-02T09:00:00Z')]);

    expect(work.write).toEqual([{ task: { ...task('a', '2026-09-01T09:00:00Z'), due: '2026-10-15' }, file: 'kb/To Do/Tasks/2026-10-15/a.md' }]);
  });

  it('what is written goes oldest first, so a run that stops leaves a prefix of the list rather than a scattering of it', () => {
    const work = todoWorklist(ROOT, emptyTodoState('list-1', 'Tasks'), [task('c', '2026-09-03T09:00:00Z'), task('a', '2026-09-01T09:00:00Z'), task('b', '2026-09-02T09:00:00Z')]);

    expect(work.write.map((entry) => entry.task.id)).toEqual(['a', 'b', 'c']);
  });

  it('a task the list no longer holds is put aside, named by the file it left behind', () => {
    const work = todoWorklist(ROOT, seeded(), [task('a', '2026-09-01T09:00:00Z')]);

    expect(work.archive).toEqual([{ id: 'b', record: { file: 'kb/To Do/Tasks/undated/b.md', lastModified: '2026-09-02T09:00:00Z', title: 'b' } }]);
  });
});

describe('deciding where each task about to be written goes', () => {
  it('a task is filed under the day it is due, not the day it last changed, under a name a filesystem accepts', () => {
    const due = { ...task('a', '2026-09-08T16:20:11Z'), due: '2026-10-15' };

    expect(planTaskFiles('kb/To Do/Tasks', [due], emptyTodoState('list-1', 'Tasks'))).toEqual([{ task: due, file: 'kb/To Do/Tasks/2026-10-15/a.md' }]);
  });

  it('a task with no due day is filed under undated/, rather than at the list root', () => {
    expect(planTaskFiles('kb/To Do/Tasks', [task('a', '2026-09-08T16:20:11Z')], emptyTodoState('list-1', 'Tasks'))[0]?.file).toBe('kb/To Do/Tasks/undated/a.md');
  });

  // A title can be a whole sentence of 200 characters. Three such tasks were never written, because
  // their paths grew past what Windows accepts. The heading inside the note keeps the whole title.
  it('a task with a long title is filed under its first words, at most 80 characters, ending on a whole word', () => {
    const story = {
      ...task('a', '2026-09-08T16:20:11Z'),
      title: 'Write the note about the team in Lyon that does something by hand that can be automated and fixed, and put it in the decision for the board',
    };
    const oneWord = { ...task('b', '2026-09-08T16:20:11Z'), title: 'x'.repeat(100) };

    const files = planTaskFiles('kb/To Do/Tasks', [story, oneWord], emptyTodoState('list-1', 'Tasks')).map((planned) => planned.file);

    expect(files).toEqual([
      'kb/To Do/Tasks/undated/Write the note about the team in Lyon that does something by hand that can be.md',
      `kb/To Do/Tasks/undated/${'x'.repeat(80)}.md`,
    ]);
  });

  it('two tasks sharing a title and a due day take different files, so neither is written over the other', () => {
    const twins = [
      { ...task('one', '2026-09-08T16:20:11Z'), title: 'Follow up', due: '2026-09-08' },
      { ...task('two', '2026-09-08T16:20:11Z'), title: 'Follow up', due: '2026-09-08' },
    ];

    const files = planTaskFiles('kb/To Do/Tasks', twins, emptyTodoState('list-1', 'Tasks')).map((planned) => planned.file);

    expect(files[0]).toBe('kb/To Do/Tasks/2026-09-08/Follow up.md');
    expect(files[1]).not.toBe(files[0]);
    expect(files[1]).toContain('Follow up-');
  });

  it('a path a task nobody is rewriting already holds on disk is not handed to a second task', () => {
    const held = withTask(emptyTodoState('list-1', 'Tasks'), 'sitting-there', {
      file: 'kb/To Do/Tasks/2026-09-08/Follow up.md',
      lastModified: '2026-09-08T16:20:11Z',
      title: 'Follow up',
    });
    const arriving = [{ ...task('newcomer', '2026-09-08T16:20:11Z'), title: 'Follow up', due: '2026-09-08' }];

    expect(planTaskFiles('kb/To Do/Tasks', arriving, held)[0]?.file).not.toBe('kb/To Do/Tasks/2026-09-08/Follow up.md');
  });

  it('a task keeps its own plain path when the only thing holding it is the copy this run is replacing', () => {
    const held = withTask(emptyTodoState('list-1', 'Tasks'), 'a', { file: 'kb/To Do/Tasks/2026-09-08/a.md', lastModified: '2026-09-01T09:00:00Z', title: 'a' });

    expect(planTaskFiles('kb/To Do/Tasks', [{ ...task('a', '2026-09-08T16:20:11Z'), due: '2026-09-08' }], held)[0]?.file).toBe('kb/To Do/Tasks/2026-09-08/a.md');
  });
});

// The first layout filed a task under the day it last changed. The listing says the day each task is
// due, so a list is filed again from it, without writing a task.
describe('filing a list again under the day each task is due', () => {
  const byChange = (): ReturnType<typeof emptyTodoState> =>
    withTask(withTask(emptyTodoState('list-1', 'Tasks'), 'a', { file: 'kb/To Do/Tasks/2026-09-01/a.md', lastModified: '2026-09-01T09:00:00Z', title: 'a' }), 'b', {
      file: 'kb/To Do/Tasks/2026-09-02/b.md',
      lastModified: '2026-09-02T09:00:00Z',
      title: 'b',
    });

  it('each task moves from the day it last changed to the day it is due, or to undated/, and the list says it is filed so', () => {
    const refiled = refileTasks(ROOT, byChange(), [task('b', '2026-09-02T09:00:00Z'), { ...task('a', '2026-09-01T09:00:00Z'), due: '2026-10-15' }]);

    expect(refiled.moves).toEqual([
      { from: 'kb/To Do/Tasks/2026-09-01/a.md', to: 'kb/To Do/Tasks/2026-10-15/a.md' },
      { from: 'kb/To Do/Tasks/2026-09-02/b.md', to: 'kb/To Do/Tasks/undated/b.md' },
    ]);
    expect(refiled.state.tasks['b']).toEqual({ file: 'kb/To Do/Tasks/undated/b.md', lastModified: '2026-09-02T09:00:00Z', title: 'b' });
    expect(refiled.state.layout).toBe(2);
  });

  it('a task keeps the name it has, though its title changed since it was written, which its next write takes care of', () => {
    const refiled = refileTasks(ROOT, byChange(), [{ ...task('a', '2026-09-05T09:00:00Z'), title: 'Renamed' }]);

    expect(refiled.moves).toEqual([{ from: 'kb/To Do/Tasks/2026-09-01/a.md', to: 'kb/To Do/Tasks/undated/a.md' }]);
  });

  it('a task already under its due day stays, and one the list no longer holds or the state never recorded moves nowhere', () => {
    const state = withTask(byChange(), 'a', { file: 'kb/To Do/Tasks/undated/a.md', lastModified: '2026-09-01T09:00:00Z', title: 'a' });
    const refiled = refileTasks(ROOT, state, [task('a', '2026-09-01T09:00:00Z'), task('new', '2026-09-03T09:00:00Z')]);

    expect(refiled.moves).toHaveLength(0);
    expect(refiled.state.tasks['b']?.file).toBe('kb/To Do/Tasks/2026-09-02/b.md');
    expect(refiled.state.tasks['new']).toBeUndefined();
  });

  it('two tasks landing on one name under one day are kept apart, the one that changed first keeping the plain name', () => {
    const state = withTask(
      withTask(emptyTodoState('list-1', 'Tasks'), 'late', { file: 'kb/To Do/Tasks/2026-09-05/Call.md', lastModified: '2026-09-05T09:00:00Z', title: 'Call' }),
      'early',
      {
        file: 'kb/To Do/Tasks/2026-09-01/Call.md',
        lastModified: '2026-09-01T09:00:00Z',
        title: 'Call',
      }
    );
    const refiled = refileTasks(ROOT, state, [
      { ...task('late', '2026-09-05T09:00:00Z'), title: 'Call', due: '2026-10-01' },
      { ...task('early', '2026-09-01T09:00:00Z'), title: 'Call', due: '2026-10-01' },
    ]);

    expect(refiled.state.tasks['early']?.file).toBe('kb/To Do/Tasks/2026-10-01/Call.md');
    expect(refiled.state.tasks['late']?.file).toStartWith('kb/To Do/Tasks/2026-10-01/Call-');
  });

  it('a state written by the layout that files tasks by their due day says so when read back, and a layout that is not a number is no layout', () => {
    const written = JSON.parse(serializeTodoState({ ...emptyTodoState('list-1', 'Tasks'), layout: 2 }));

    expect(parseTodoState(written)).toMatchObject({ ok: true, value: { layout: 2 } });
    expect(parseTodoState({ ...written, layout: '2' })).toMatchObject({ ok: true, value: { layout: undefined } });
  });
});
