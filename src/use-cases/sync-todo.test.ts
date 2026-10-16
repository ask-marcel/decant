import { describe, expect, it } from 'bun:test';
import { freeSegment } from '../domain/kb-path.ts';
import { emptyTodoState, serializeTodoState, withTask } from '../domain/todo-state.ts';
import type { TodoTask } from '../domain/todo-task.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import { createTodoReaderFake } from '../test-helpers/todo-reader-fake.ts';
import type { TodoReaderSeed } from '../test-helpers/todo-reader-fake.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';
import { createSyncTodo } from './sync-todo.ts';

const LIST = { id: 'list-1', name: 'Tasks' };

const STATE_PATH = 'kb/To Do/Tasks/.sync-state.json';

const INDEX_PATH = 'kb/To Do/Tasks/_index.md';

const task = (over: Partial<TodoTask> = {}): TodoTask => ({
  id: 'AAMkAGI-task',
  title: 'Book the venue',
  status: 'notStarted',
  importance: 'normal',
  notes: '',
  created: '2026-08-01T09:00:00Z',
  lastModified: '2026-09-08T16:20:11Z',
  due: '',
  completed: '',
  categories: [],
  steps: [],
  links: [],
  ...over,
});

const run = async (
  seeds: { reader?: TodoReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number; pathBudget?: number } = {}
): Promise<{
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  progress: ProgressFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const syncTodo = createSyncTodo({
    reader: createTodoReaderFake(seeds.reader),
    files,
    clock: createClockFake('2026-09-09T14:00:00Z'),
    logger,
    progress,
    kbRoot: 'kb',
    pathBudget: seeds.pathBudget,
  });
  const outcome = await syncTodo({ list: LIST, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4 });
  if (!outcome.ok) {
    return {
      summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
      source: LIST.name,
      notes: { skipped: [], failed: [], givenUp: [], archived: [] },
      files,
      logger,
      progress,
      ok: false,
      error: outcome.error,
    };
  }
  return { ...outcome.value, files, logger, progress, ok: true };
};

describe('syncing a Microsoft To Do list', () => {
  // A knowledge base that sits deep on a Windows disk leaves fewer characters for each path: what
  // stands in front of it is taken off the budget before any name is planned.
  it('a task in a knowledge base deep on the disk is filed under a name cut to what Windows accepts', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task({ title: 'Book the venue for the offsite in Rotterdam', due: '2026-09-08' })] } }, pathBudget: 100 });

    expect([...done.files.written.keys()].filter((path) => path !== STATE_PATH && path !== INDEX_PATH)).toEqual([
      expect.stringMatching(/^kb\/To Do\/Tasks\/2026-09-08\/Book th-[0-9a-f]{8}\.md$/),
    ]);
  });

  it('a first run writes every task under the day it is due, or under undated/ when it has none, and remembers what it wrote', async () => {
    const done = await run({
      reader: { tasks: { 'list-1': [task({ due: '2026-09-20' }), task({ id: 'AAMkAGI-other', title: 'Water the plants', lastModified: '2026-09-01T08:00:00Z' })] } },
    });

    expect(done.summary.converted).toBe(2);
    expect(new Set(done.files.written.keys())).toEqual(
      new Set([STATE_PATH, INDEX_PATH, 'kb/To Do/Tasks/undated/Water the plants.md', 'kb/To Do/Tasks/2026-09-20/Book the venue.md'])
    );
    expect(done.files.written.get('kb/To Do/Tasks/2026-09-20/Book the venue.md')).toContain('# Book the venue');
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks['AAMkAGI-task']).toEqual({
      file: 'kb/To Do/Tasks/2026-09-20/Book the venue.md',
      lastModified: '2026-09-08T16:20:11Z',
      title: 'Book the venue',
    });
  });

  it('a task that has not changed since it was written is left exactly where it is', async () => {
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', {
      file: 'kb/To Do/Tasks/2026-09-08/Book the venue.md',
      lastModified: '2026-09-08T16:20:11Z',
      title: 'Book the venue',
    });
    const done = await run({ reader: { tasks: { 'list-1': [task({ due: '2026-09-08' })] } }, files: { texts: { [STATE_PATH]: serializeTodoState(state) } } });

    expect(done.summary.converted).toBe(0);
    expect(done.files.writeLog).toEqual([STATE_PATH, INDEX_PATH]);
    expect(done.files.moves).toHaveLength(0);
  });

  it('a task whose due day moved is written under the new day, and the copy under the old one is put aside', async () => {
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', {
      file: 'kb/To Do/Tasks/2026-09-01/Book the venue.md',
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Book the venue',
    });
    const done = await run({ reader: { tasks: { 'list-1': [task({ due: '2026-09-08' })] } }, files: { texts: { [STATE_PATH]: serializeTodoState({ ...state, layout: 2 }) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.written.has('kb/To Do/Tasks/2026-09-08/Book the venue.md')).toBe(true);
    expect(done.files.moves).toEqual([{ from: 'kb/To Do/Tasks/2026-09-01/Book the venue.md', to: 'kb/_archive/2026-09-09/To Do/Tasks/2026-09-01/Book the venue.md' }]);
  });

  // The knowledge base keeps each version a task had, without git: the one an edit replaces goes under
  // the day of the run that replaced it.
  it('an edit that keeps the due day writes the task where it was, and puts the version before it aside', async () => {
    const FILE = 'kb/To Do/Tasks/2026-09-08/Book the venue.md';
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', { file: FILE, lastModified: '2026-09-01T09:00:00Z', title: 'Book the venue' });
    const done = await run({
      reader: { tasks: { 'list-1': [task({ due: '2026-09-08', notes: 'Ask about parking' })] } },
      files: { texts: { [STATE_PATH]: serializeTodoState({ ...state, layout: 2 }), [FILE]: 'the task as it was' } },
    });

    expect(done.files.written.get(FILE)).toContain('Ask about parking');
    expect(done.files.written.get('kb/_archive/2026-09-09/To Do/Tasks/2026-09-08/Book the venue.md')).toBe('the task as it was');
  });

  // Written over, the version before would be lost: the task waits for a run that can move it.
  it('an edit whose version before will not move aside is not written over, and is tried again on the next run', async () => {
    const FILE = 'kb/To Do/Tasks/2026-09-08/Book the venue.md';
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', { file: FILE, lastModified: '2026-09-01T09:00:00Z', title: 'Book the venue' });
    const done = await run({
      reader: { tasks: { 'list-1': [task({ due: '2026-09-08', notes: 'Ask about parking' })] } },
      files: {
        texts: { [STATE_PATH]: serializeTodoState({ ...state, layout: 2 }), [FILE]: 'the task as it was' },
        failMoveWith: { kind: 'write-failed', path: FILE, message: 'held open' },
      },
    });
    const kept = JSON.parse(done.files.written.get(STATE_PATH) ?? '{}');

    expect(done.summary).toMatchObject({ converted: 0, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'Book the venue', reason: 'its earlier version would not move to _archive/: write-failed' }]);
    expect(done.files.written.get(FILE)).toBe('the task as it was');
    expect(kept.tasks['AAMkAGI-task'].lastModified).toBe('2026-09-01T09:00:00Z');
    expect(kept.retry['AAMkAGI-task']).toBeDefined();
  });

  it('a write that fails puts the version before it back, so the list still holds it', async () => {
    const FILE = 'kb/To Do/Tasks/2026-09-08/Book the venue.md';
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', { file: FILE, lastModified: '2026-09-01T09:00:00Z', title: 'Book the venue' });
    const done = await run({
      reader: { tasks: { 'list-1': [task({ due: '2026-09-08' })] } },
      files: { texts: { [STATE_PATH]: serializeTodoState({ ...state, layout: 2 }), [FILE]: 'the task as it was' }, failWritesMatching: 'Book the venue' },
    });

    expect(done.summary.failed).toBe(1);
    expect(done.files.written.get(FILE)).toBe('the task as it was');
    expect(done.files.written.has('kb/_archive/2026-09-09/To Do/Tasks/2026-09-08/Book the venue.md')).toBe(false);
  });

  // The first layout filed a task under the day it last changed.
  it('the first run of this layout moves each task to the day it is due, once, and puts nothing aside', async () => {
    const OLD = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', { file: OLD, lastModified: '2026-09-08T16:20:11Z', title: 'Book the venue' });
    const listing = { tasks: { 'list-1': [task({ due: '2026-09-20' })] } };
    const first = await run({ reader: listing, files: { texts: { [STATE_PATH]: serializeTodoState(state), [OLD]: 'the task' } } });

    expect(first.summary.converted).toBe(0);
    expect(first.files.moves).toEqual([{ from: OLD, to: 'kb/To Do/Tasks/2026-09-20/Book the venue.md' }]);
    expect(JSON.parse(first.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);

    const second = await run({ reader: listing, files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } } });

    expect(second.files.moves).toHaveLength(0);
    expect(second.summary.converted).toBe(0);
  });

  // Its file is not where it belongs, so the task is written under its due day all the same, and the
  // copy left behind goes aside, or into the log when it will not move either.
  it('a task that will not move is written under its due day all the same, and the next run finds nothing left to move', async () => {
    const OLD = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';
    const NEW = 'kb/To Do/Tasks/2026-09-20/Book the venue.md';
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', { file: OLD, lastModified: '2026-09-08T16:20:11Z', title: 'Book the venue' });
    const listing = { tasks: { 'list-1': [task({ due: '2026-09-20' })] } };
    const stuck = await run({
      reader: listing,
      files: { texts: { [STATE_PATH]: serializeTodoState(state), [OLD]: 'the task' }, failMoveWith: { kind: 'write-failed', path: OLD, message: 'locked' } },
    });
    const kept = JSON.parse(stuck.files.written.get(STATE_PATH) ?? '{}');

    expect(stuck.files.written.get(NEW)).toContain('# Book the venue');
    expect(kept.tasks['AAMkAGI-task'].file).toBe(NEW);
    expect(kept.layout).toBeUndefined();
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'refile.failed', meta: { path: OLD, cause: 'write-failed' } });
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: OLD, cause: 'write-failed' } });

    const next = await run({ reader: listing, files: { texts: { [STATE_PATH]: stuck.files.written.get(STATE_PATH) ?? '', [NEW]: 'the task' } } });

    expect(next.files.moves).toHaveLength(0);
    expect(JSON.parse(next.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);
  });

  it('a dry run counts the tasks the run would write once the list is filed by due day, and moves nothing', async () => {
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', {
      file: 'kb/To Do/Tasks/2026-09-01/Book the venue.md',
      lastModified: '2026-09-08T16:20:11Z',
      title: 'Book the venue',
    });
    const listing = { tasks: { 'list-1': [task({ due: '2026-09-20' }), task({ id: 'AAMkAGI-new', title: 'Water the plants' })] } };
    const done = await run({ reader: listing, files: { texts: { [STATE_PATH]: serializeTodoState(state) } }, dryRun: true });

    expect(done.summary.queued).toBe(1);
    expect(done.files.moves).toHaveLength(0);
  });

  it('a task the list no longer holds is put aside in the archive and named in the report', async () => {
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-gone', {
      file: 'kb/To Do/Tasks/2026-09-01/Cancel the order.md',
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Cancel the order',
    });
    const done = await run({ reader: { tasks: { 'list-1': [] } }, files: { texts: { [STATE_PATH]: serializeTodoState(state) } } });

    expect(done.summary.archived).toBe(1);
    expect(done.notes.archived).toEqual([{ path: 'Cancel the order', reason: 'no longer in the list' }]);
    expect(done.files.moves).toEqual([{ from: 'kb/To Do/Tasks/2026-09-01/Cancel the order.md', to: 'kb/_archive/2026-09-09/To Do/Tasks/2026-09-01/Cancel the order.md' }]);
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks).toEqual({});
    expect(done.files.written.get('kb/To Do/Tasks/_sync-report.md')).toContain('Cancel the order');
  });

  it('two tasks sharing a title on one day are kept apart, rather than one overwriting the other', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task(), task({ id: 'AAMkAGI-twin' })] } } });

    expect(done.summary.converted).toBe(2);
    expect([...done.files.written.keys()].filter((path) => path.endsWith('.md') && path !== INDEX_PATH)).toHaveLength(2);
  });

  it('a task renamed in the same window as its namesake sets aside only the version each had, and the namesake is rewritten in the file its record names', async () => {
    const renamed = { file: 'kb/To Do/Tasks/2026-09-08/Call the venue.md', lastModified: '2026-09-08T09:00:00Z', title: 'Call the venue' };
    // Where the namesake was put while the renamed task held the plain name.
    const namesakeFile = `kb/To Do/Tasks/2026-09-08/${freeSegment('Call the venue.md', 'namesake', (name) => name === 'Call the venue.md')}`;
    const namesake = { file: namesakeFile, lastModified: '2026-09-08T10:00:00Z', title: 'Call the venue' };
    const state = withTask(withTask(emptyTodoState('list-1', 'Tasks'), 'renamed', renamed), 'namesake', namesake);
    const tasks = [
      task({ id: 'renamed', title: 'Book the venue', lastModified: '2026-09-08T16:00:00Z', due: '2026-09-08' }),
      task({ id: 'namesake', title: 'Call the venue', lastModified: '2026-09-08T17:00:00Z', due: '2026-09-08', notes: 'Ask about parking' }),
    ];
    const done = await run({
      reader: { tasks: { 'list-1': tasks } },
      files: { texts: { [STATE_PATH]: serializeTodoState({ ...state, layout: 2 }), [renamed.file]: 'the task as it was', [namesake.file]: 'the namesake as it was' } },
    });

    const recorded = JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks['namesake'].file;
    expect(done.files.written.get(recorded)).toContain('Ask about parking');
    expect(done.files.moves).toHaveLength(2);
    expect(done.files.moves).toContainEqual({ from: renamed.file, to: 'kb/_archive/2026-09-09/To Do/Tasks/2026-09-08/Call the venue.md' });
    expect(done.files.written.get('kb/_archive/2026-09-09/To Do/Tasks/2026-09-08/Call the venue.md')).toBe('the task as it was');
    expect(done.files.written.get(namesakeFile.replace('kb/To Do/', 'kb/_archive/2026-09-09/To Do/'))).toBe('the namesake as it was');
  });

  it('three tasks sharing a title and a day land in three files, though Graph opens all their ids alike', async () => {
    const done = await run({ reader: { tasks: { 'list-1': ['AAMkADU3-one', 'AAMkADU3-two', 'AAMkADU3-three'].map((id) => task({ id, title: 'Follow up' })) } } });

    expect([...done.files.written.keys()].filter((path) => path.endsWith('.md') && path !== INDEX_PATH)).toHaveLength(3);
  });

  // The page a reader opens the list by: what is open by the day it is due, then what has no due day,
  // then what is done, the latest first.
  it('the list page names open tasks by due day, then those with no due day, then completed ones, the latest first', async () => {
    const tasks = [
      task({ id: 'venue', due: '2026-09-20' }),
      task({ id: 'caterer', title: 'Call the caterer', status: 'inProgress', due: '2026-09-10' }),
      task({ id: 'plants', title: 'Water the plants' }),
      task({ id: 'invites', title: 'Send the invites', status: 'completed', completed: '2026-09-05' }),
      task({ id: 'badges', title: 'Print the badges', status: 'completed', completed: '2026-09-07' }),
    ];
    const done = await run({ reader: { tasks: { 'list-1': tasks } } });

    expect(done.files.written.get(INDEX_PATH)).toBe(
      [
        '# Tasks',
        '',
        '## Open, by due day',
        '',
        '- 2026-09-10 · [Call the caterer](<2026-09-10/Call the caterer.md>) · in progress',
        '- 2026-09-20 · [Book the venue](<2026-09-20/Book the venue.md>) · not started',
        '',
        '## Open, with no due day',
        '',
        '- [Water the plants](<undated/Water the plants.md>) · not started',
        '',
        '## Completed, the latest first',
        '',
        '- 2026-09-07 · [Print the badges](<undated/Print the badges.md>)',
        '- 2026-09-05 · [Send the invites](<undated/Send the invites.md>)',
        '',
      ].join('\n')
    );
  });

  // A task that could not be written has no file, so the page has no line that would lead nowhere.
  it('a task that could not be written is left off the list page, and a page that will not write leaves the run standing', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task(), task({ id: 'plants', title: 'Water the plants' })] } }, files: { failWritesMatching: 'Book the venue' } });

    expect(done.files.written.get(INDEX_PATH)).not.toContain('Book the venue');
    expect(done.files.written.get(INDEX_PATH)).toContain('Water the plants');

    const refused = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { failWritesMatching: '_index.md' } });

    expect(refused.ok).toBe(true);
    expect(refused.logger.calls).toContainEqual({ level: 'warn', event: 'index.failed', meta: { path: INDEX_PATH, cause: 'write-failed' } });
  });

  it('a dry run says how much it would write and writes nothing at all', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, dryRun: true });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 1 });
    expect(done.files.writeLog).toHaveLength(0);
  });

  it('a list that cannot be read ends the run naming the step that failed', async () => {
    const done = await run({ reader: { failTasks: { kind: 'auth', message: 'sign-in has lapsed' } } });

    expect(done.ok).toBe(false);
    expect(done.error).toEqual({ step: 'listTasks', cause: 'auth', message: 'sign-in has lapsed' });
  });

  it('a state file this version cannot read is started over rather than written back over', async () => {
    const done = await run({
      reader: { tasks: { 'list-1': [task()] } },
      files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"todo","id":"list-1","name":"Tasks"}}' } },
    });

    expect(done.summary.converted).toBe(1);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'todo-state.unreadable', meta: { list: 'list-1', cause: 'state is version 99, not 1' } });
  });

  it('a run that found nothing to write still stamps its own state file, so the picker does not call it stale forever', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [] } } });

    expect(done.summary.converted).toBe(0);
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').lastRun).toBe('2026-09-09T14:00:00Z');
  });

  it('a state file that cannot be saved stops the run, rather than letting the next one skip what this one wrote', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { failWritesMatching: '.sync-state.json' } });

    expect(done.ok).toBe(false);
    expect(done.error?.step).toBe('saveState');
  });

  it('a run with nothing to write still stops when its own state file will not save', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [] } }, files: { failWritesMatching: '.sync-state.json' } });

    expect(done.ok).toBe(false);
    expect(done.error?.step).toBe('saveState');
  });

  it('every task is written before the next window starts, and the state is saved once a window rather than once a task', async () => {
    const tasks = [task(), task({ id: 'b', title: 'Second' }), task({ id: 'c', title: 'Third' })];
    const done = await run({ reader: { tasks: { 'list-1': tasks } }, concurrency: 2 });

    expect(done.summary.converted).toBe(3);
    expect(done.files.writeLog.filter((path) => path.endsWith('.sync-state.json'))).toHaveLength(3);
  });

  it('a task whose file will not write is reported as failed rather than recorded as written', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { failWritesMatching: 'Book the venue' } });

    expect(done.summary.failed).toBe(1);
    expect(done.notes.failed).toEqual([{ path: 'Book the venue', reason: 'cannot write kb/To Do/Tasks/undated/Book the venue.md' }]);
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks).toEqual({});
  });

  it('a task whose file will not write is logged by its id and the kind of failure', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { failWritesMatching: 'Book the venue' } });

    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'todo-task.failed', meta: { task: 'AAMkAGI-task', cause: 'write-failed' } });
  });

  // A copy that will not move stays where it was, and the run goes on: the log says which one.
  it('a copy that cannot be put aside is logged with its path, whether the task moved to another day or left the list', async () => {
    const moved = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', {
      file: 'kb/To Do/Tasks/2026-09-01/Book the venue.md',
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Book the venue',
    });
    const state = withTask(moved, 'AAMkAGI-gone', { file: 'kb/To Do/Tasks/2026-09-01/Cancel the order.md', lastModified: '2026-09-01T09:00:00Z', title: 'Cancel the order' });
    const refused = { kind: 'write-failed' as const, path: 'kb/_archive', message: 'locked' };
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { texts: { [STATE_PATH]: serializeTodoState(state) }, failMoveWith: refused } });

    expect(done.summary).toMatchObject({ converted: 1, archived: 1 });
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: 'kb/To Do/Tasks/2026-09-01/Book the venue.md', cause: 'write-failed' } });
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: 'kb/To Do/Tasks/2026-09-01/Cancel the order.md', cause: 'write-failed' } });
  });

  it('the counter is told how many tasks the run writes, and which one it is on', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task(), task({ id: 'b', title: 'Second' })] } } });

    expect(done.progress.started).toEqual([{ total: 2, what: 'Tasks' }]);
    expect(new Set(done.progress.begins)).toEqual(new Set(['Book the venue', 'Second']));
    expect(new Set(done.progress.steps)).toEqual(new Set(['Book the venue', 'Second']));
    expect(done.progress.steps).toHaveLength(2);
    expect(done.progress.dones).toHaveLength(1);
  });

  // Three runs on the same version of a task, then the task is left alone until it changes, so a file
  // that cannot be written does not cost a try and a report section on every run for good.
  it('a task whose file fails to write three runs running is left alone by the fourth, and named once in the list report', async () => {
    const listing = { tasks: { 'list-1': [task()] } };
    const failing = (carried?: Awaited<ReturnType<typeof run>>): ReturnType<typeof run> =>
      run({ reader: listing, files: { texts: carried === undefined ? {} : { [STATE_PATH]: carried.files.written.get(STATE_PATH) ?? '' }, failWritesMatching: 'Book the venue' } });
    const third = await failing(await failing(await failing()));
    const fourth = await failing(third);
    const venue = [{ path: 'Book the venue', reason: 'cannot write kb/To Do/Tasks/undated/Book the venue.md' }];

    expect(third.notes.gaveUp).toEqual(venue);
    expect(third.notes.failed).toHaveLength(0);
    expect(third.files.written.get('kb/To Do/Tasks/_sync-report.md')).toContain('Failed 3 times');
    expect(fourth.summary.failed).toBe(0);
    expect(fourth.progress.started).toEqual([{ total: 0, what: 'Tasks' }]);
    expect(fourth.notes.givenUp).toEqual(venue);
    expect(fourth.notes.gaveUp).toBeUndefined();
    expect(fourth.files.written.has('kb/To Do/Tasks/_sync-report.md')).toBe(false);
  });

  it('a task given up on is written again once it changes, and leaves nothing behind to try again', async () => {
    const listing = { tasks: { 'list-1': [task()] } };
    const failing = (carried?: Awaited<ReturnType<typeof run>>): ReturnType<typeof run> =>
      run({ reader: listing, files: { texts: carried === undefined ? {} : { [STATE_PATH]: carried.files.written.get(STATE_PATH) ?? '' }, failWritesMatching: 'Book the venue' } });
    const third = await failing(await failing(await failing()));

    const edited = await run({
      reader: { tasks: { 'list-1': [task({ lastModified: '2026-09-10T08:00:00Z' })] } },
      files: { texts: { [STATE_PATH]: third.files.written.get(STATE_PATH) ?? '' } },
    });

    expect(edited.summary.converted).toBe(1);
    expect(JSON.parse(edited.files.written.get(STATE_PATH) ?? '{}').retry).toBeUndefined();
  });

  // Given up on, then deleted: nobody can fix it now, and named as failed it would stay in every report.
  it('a task given up on and then deleted from the list is no longer named as given up', async () => {
    const tries = { attempts: 3, version: '2026-09-08T16:20:11Z', name: 'Book the venue', reason: 'cannot write' };
    const state = { ...emptyTodoState('list-1', 'Tasks'), retry: { 'AAMkAGI-task': tries, 'AAMkAGI-gone': { ...tries, name: 'Cancel the order' } } };
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { texts: { [STATE_PATH]: serializeTodoState(state) } } });

    expect(done.notes.givenUp).toEqual([{ path: 'Book the venue', reason: 'cannot write' }]);
    expect(Object.keys(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').retry)).toEqual(['AAMkAGI-task']);
  });
});

// A task that lands under another day no longer holds its earlier file, so a file that would not move
// is handed on to be written down. A task that waits for its earlier file keeps it, and hands on nothing.
describe('handing on the earlier file of a task', () => {
  const OLD = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';

  const handing = async (due: string): Promise<{ handed: ReadonlyArray<string>; files: FilesFake }> => {
    const handed: string[] = [];
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', { file: OLD, lastModified: '2026-09-01T09:00:00Z', title: 'Book the venue' });
    const files = createFilesFake({
      texts: { [STATE_PATH]: serializeTodoState({ ...state, layout: 2 }), [OLD]: 'the task as it was' },
      failMoveWith: { kind: 'write-failed', path: OLD, message: 'held open' },
    });
    const writeDown = async (missed: ReadonlyArray<{ readonly path: string }>): Promise<void> => {
      handed.push(...missed.map((entry) => entry.path));
    };
    const reader = createTodoReaderFake({ tasks: { 'list-1': [task({ due, notes: 'Ask about parking' })] } });
    const syncTodo = createSyncTodo({
      reader,
      files,
      clock: createClockFake('2026-09-09T14:00:00Z'),
      logger: createLoggerFake(),
      progress: createProgressFake(),
      kbRoot: 'kb',
      writeDown,
    });
    await syncTodo({ list: LIST, dryRun: false, concurrency: 4 });
    return { handed, files };
  };

  it('a task that lands under another day hands on its earlier file, and one that waits for it hands on nothing', async () => {
    const moved = await handing('2026-09-20');
    const waiting = await handing('2026-09-01');

    expect(moved.files.written.get('kb/To Do/Tasks/2026-09-20/Book the venue.md')).toContain('# Book the venue');
    expect(moved.handed).toEqual([OLD]);
    expect(waiting.handed).toStrictEqual([]);
  });
});
