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
    const done = await run({ reader: { tasks: { 'list-1': [task({ title: 'Book the venue for the offsite in Rotterdam' })] } }, pathBudget: 100 });

    expect([...done.files.written.keys()].filter((path) => path !== STATE_PATH)).toEqual([expect.stringMatching(/^kb\/To Do\/Tasks\/2026-09-08\/Book th-[0-9a-f]{8}\.md$/)]);
  });

  it('a first run writes every task under the day it last changed, and remembers what it wrote', async () => {
    const done = await run({
      reader: { tasks: { 'list-1': [task(), task({ id: 'AAMkAGI-other', title: 'Water the plants', lastModified: '2026-09-01T08:00:00Z' })] } },
    });

    expect(done.summary.converted).toBe(2);
    expect([...done.files.written.keys()].toSorted((left, right) => left.localeCompare(right))).toEqual([
      STATE_PATH,
      'kb/To Do/Tasks/2026-09-01/Water the plants.md',
      'kb/To Do/Tasks/2026-09-08/Book the venue.md',
    ]);
    expect(done.files.written.get('kb/To Do/Tasks/2026-09-08/Book the venue.md')).toContain('# Book the venue');
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks['AAMkAGI-task']).toEqual({
      file: 'kb/To Do/Tasks/2026-09-08/Book the venue.md',
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
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { texts: { [STATE_PATH]: serializeTodoState(state) } } });

    expect(done.summary.converted).toBe(0);
    expect(done.files.writeLog).toEqual([STATE_PATH]);
  });

  it('a task edited onto a later day is written under the new day, and the copy under the old one is put aside', async () => {
    const state = withTask(emptyTodoState('list-1', 'Tasks'), 'AAMkAGI-task', {
      file: 'kb/To Do/Tasks/2026-09-01/Book the venue.md',
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Book the venue',
    });
    const done = await run({ reader: { tasks: { 'list-1': [task()] } }, files: { texts: { [STATE_PATH]: serializeTodoState(state) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.written.has('kb/To Do/Tasks/2026-09-08/Book the venue.md')).toBe(true);
    expect(done.files.moves).toEqual([{ from: 'kb/To Do/Tasks/2026-09-01/Book the venue.md', to: 'kb/_archive/To Do/Tasks/2026-09-01/Book the venue.md' }]);
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
    expect(done.files.moves).toEqual([{ from: 'kb/To Do/Tasks/2026-09-01/Cancel the order.md', to: 'kb/_archive/To Do/Tasks/2026-09-01/Cancel the order.md' }]);
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks).toEqual({});
    expect(done.files.written.get('kb/To Do/Tasks/_sync-report.md')).toContain('Cancel the order');
  });

  it('two tasks sharing a title on one day are kept apart, rather than one overwriting the other', async () => {
    const done = await run({ reader: { tasks: { 'list-1': [task(), task({ id: 'AAMkAGI-twin' })] } } });

    expect(done.summary.converted).toBe(2);
    expect([...done.files.written.keys()].filter((path) => path.endsWith('.md'))).toHaveLength(2);
  });

  it('a task renamed in the same window as its namesake puts only its own old document aside, and the namesake is rewritten in the file its record names', async () => {
    const renamed = { file: 'kb/To Do/Tasks/2026-09-08/Call the venue.md', lastModified: '2026-09-08T09:00:00Z', title: 'Call the venue' };
    // Where the namesake was put while the renamed task held the plain name.
    const namesakeFile = `kb/To Do/Tasks/2026-09-08/${freeSegment('Call the venue.md', 'namesake', (name) => name === 'Call the venue.md')}`;
    const namesake = { file: namesakeFile, lastModified: '2026-09-08T10:00:00Z', title: 'Call the venue' };
    const state = withTask(withTask(emptyTodoState('list-1', 'Tasks'), 'renamed', renamed), 'namesake', namesake);
    const tasks = [
      task({ id: 'renamed', title: 'Book the venue', lastModified: '2026-09-08T16:00:00Z' }),
      task({ id: 'namesake', title: 'Call the venue', lastModified: '2026-09-08T17:00:00Z', notes: 'Ask about parking' }),
    ];
    const done = await run({
      reader: { tasks: { 'list-1': tasks } },
      files: { texts: { [STATE_PATH]: serializeTodoState(state), [renamed.file]: 'the task as it was', [namesake.file]: 'the namesake as it was' } },
    });

    const recorded = JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').tasks['namesake'].file;
    expect(done.files.written.get(recorded)).toContain('Ask about parking');
    expect(done.files.moves).toEqual([{ from: renamed.file, to: 'kb/_archive/To Do/Tasks/2026-09-08/Call the venue.md' }]);
    expect(done.files.written.get('kb/_archive/To Do/Tasks/2026-09-08/Call the venue.md')).toBe('the task as it was');
  });

  it('three tasks sharing a title and a day land in three files, though Graph opens all their ids alike', async () => {
    const done = await run({ reader: { tasks: { 'list-1': ['AAMkADU3-one', 'AAMkADU3-two', 'AAMkADU3-three'].map((id) => task({ id, title: 'Follow up' })) } } });

    expect([...done.files.written.keys()].filter((path) => path.endsWith('.md'))).toHaveLength(3);
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
    expect(done.notes.failed).toEqual([{ path: 'Book the venue', reason: 'cannot write kb/To Do/Tasks/2026-09-08/Book the venue.md' }]);
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
    const venue = [{ path: 'Book the venue', reason: 'cannot write kb/To Do/Tasks/2026-09-08/Book the venue.md' }];

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
});
