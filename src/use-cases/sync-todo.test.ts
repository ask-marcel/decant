import { describe, expect, it } from 'bun:test';
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
  seeds: { reader?: TodoReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number } = {}
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
    expect(done.logger.calls.map((entry) => entry.event)).toContain('todo-state.unreadable');
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
});
