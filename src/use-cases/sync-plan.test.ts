import { describe, expect, it } from 'bun:test';
import { emptyPlanState, serializePlanState, withTask } from '../domain/plan-state.ts';
import type { Bucket, PlanTask, TaskDetails } from '../domain/planner.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createPlanReaderFake } from '../test-helpers/plan-reader-fake.ts';
import type { PlanReaderFake, PlanReaderSeed } from '../test-helpers/plan-reader-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { StepError } from './ports/step-error.ts';
import { createSyncPlan } from './sync-plan.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const PLAN = { id: 'plan-1', title: 'Offsite 2026', groupId: 'group-1' };
const ROOT = 'kb/Planner/Offsite 2026';
const STATE_PATH = `${ROOT}/.sync-state.json`;
const BOARD_PATH = `${ROOT}/_board.md`;

const bucket = (id: string, name: string, orderHint: string): Bucket => ({ id, name, orderHint });
const task = (id: string, title: string, over: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title,
  bucketId: 'b-todo',
  orderHint: '8585 1',
  percentComplete: 0,
  priority: 5,
  start: '',
  due: '',
  completed: '',
  created: '2026-08-20T09:12:00Z',
  assigneeIds: [],
  labels: [],
  createdBy: 'Jane Doe',
  etag: `W/"${id}-1"`,
  ...over,
});
const details = (description: string, etag = 'W/"d-1"'): TaskDetails => ({ description, checklist: [], references: [], etag });

const BUCKETS = { 'plan-1': [bucket('b-done', 'Done', '8585 2'), bucket('b-todo', 'To do', '8585 1')] };
// Listed with the done task first and placed earlier on its lane, so a board drawn in the listing's
// order, or in the cards' order alone, would read the wrong way round.
const TASKS = {
  'plan-1': [
    task('t-date', 'Pick a date', { bucketId: 'b-done', orderHint: '8585 0', percentComplete: 100, completed: '2026-09-01', assigneeIds: ['u-jane'] }),
    task('t-venue', 'Book the venue', { assigneeIds: ['u-jane', 'u-sam'], due: '2026-09-30', priority: 1, percentComplete: 50 }),
  ],
};
const DETAILS = { 't-venue': details('Three rooms.'), 't-date': details('') };
const NAMES = { 'u-jane': 'Jane Doe', 'u-sam': 'Sam Lee' };

const fingerprintOf = (taskId: string, taskEtag = `W/"${taskId}-1"`, detailsEtag = 'W/"d-1"'): string => `${taskEtag} ${detailsEtag}`;

const run = async (
  seeds: { reader?: PlanReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number } = {}
): Promise<{
  id: string;
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  reader: PlanReaderFake;
  progress: ProgressFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const reader = createPlanReaderFake({ plans: [PLAN], buckets: BUCKETS, tasks: TASKS, details: DETAILS, names: NAMES, ...seeds.reader });
  const progress = createProgressFake();
  const syncPlan = createSyncPlan({ reader, files, clock: createClockFake('2026-09-12T14:00:00Z'), logger, progress, kbRoot: 'kb' });
  const outcome = await syncPlan({ plan: PLAN, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4 });
  const empty = {
    id: '',
    summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
    source: PLAN.title,
    notes: { skipped: [], failed: [], givenUp: [], archived: [] },
  };
  return outcome.ok ? { ...outcome.value, files, logger, reader, progress, ok: true } : { ...empty, files, logger, reader, progress, ok: false, error: outcome.error };
};

const stateOf = (
  files: FilesFake
): {
  lastRun: string;
  source: { kind: string; id: string; name: string };
  plan: { id: string; title: string };
  tasks: Record<string, { file: string; fingerprint: string; title: string }>;
} => JSON.parse(files.written.get(STATE_PATH) ?? '{}');

// A state a run already stamped, so the board is not owed for being new.
const settled = (): ReturnType<typeof emptyPlanState> =>
  withTask(
    withTask({ ...emptyPlanState(PLAN), lastRun: '2026-09-11T09:00:00Z' }, 't-venue', {
      file: `${ROOT}/To do/Book the venue.md`,
      fingerprint: fingerprintOf('t-venue'),
      title: 'Book the venue',
    }),
    't-date',
    {
      file: `${ROOT}/Done/Pick a date.md`,
      fingerprint: fingerprintOf('t-date'),
      title: 'Pick a date',
    }
  );

describe('syncing a Planner plan', () => {
  it('a first run reads the buckets, every task and its details, names the assignees once each, and writes one page per task under its bucket and the board', async () => {
    const done = await run();

    expect(done.summary).toMatchObject({ converted: 2, failed: 0, archived: 0 });
    expect({ id: done.id, source: done.source }).toEqual({ id: 'plan-1', source: 'Offsite 2026' });
    expect(done.reader.calls.filter((call) => call.startsWith('name:')).toSorted((left, right) => left.localeCompare(right))).toEqual(['name:u-jane', 'name:u-sam']);
    expect(new Set(done.files.written.keys())).toEqual(new Set([STATE_PATH, BOARD_PATH, `${ROOT}/To do/Book the venue.md`, `${ROOT}/Done/Pick a date.md`]));
    expect(done.files.written.get(`${ROOT}/To do/Book the venue.md`)).toContain('assigned_to:\n  - Jane Doe\n  - Sam Lee\n');
    expect(done.files.written.get(`${ROOT}/To do/Book the venue.md`)).toContain('# Book the venue\n\nThree rooms.\n');
    expect(done.files.written.get(BOARD_PATH)).toContain(
      '| To do | [Book the venue](<To do/Book the venue.md>) | in progress | Jane Doe, Sam Lee | 2026-09-30 | urgent |  |\n| Done | [Pick a date](<Done/Pick a date.md>) | done | Jane Doe |  | medium |  |'
    );
    expect(stateOf(done.files)).toMatchObject({
      plan: PLAN,
      tasks: { 't-venue': { file: `${ROOT}/To do/Book the venue.md`, fingerprint: fingerprintOf('t-venue'), title: 'Book the venue' } },
    });
    expect(done.logger.calls).toContainEqual({ level: 'info', event: 'plan.listed', meta: { plan: 'plan-1', buckets: 2, tasks: 2 } });
    expect(done.logger.calls.every((entry) => entry.event !== 'plan-state.unreadable')).toBe(true);
  });

  it('a task`s labels are named on its page and on the board from the plan`s own names, one nobody named left out, the names read once a run', async () => {
    const labelled = { 'plan-1': [task('t-venue', 'Book the venue', { labels: ['category1', 'category4'] })] };
    const done = await run({ reader: { tasks: labelled, labelNames: { 'plan-1': new Map([['category1', 'Urgent']]) } } });

    expect(done.files.written.get(`${ROOT}/To do/Book the venue.md`)).toContain('labels:\n  - Urgent\n');
    expect(done.files.written.get(BOARD_PATH)).toContain('| To do | [Book the venue](<To do/Book the venue.md>) | not started |  |  | medium | Urgent |');
    expect(done.reader.calls.filter((call) => call.startsWith('labels:'))).toEqual(['labels:plan-1']);
  });

  it('renaming a label rewrites the pages that carry it and no other', async () => {
    const tasks = { 'plan-1': [task('t-venue', 'Book the venue', { labels: ['category1'] }), task('t-date', 'Pick a date', { bucketId: 'b-done', orderHint: '8585 0' })] };
    const first = await run({ reader: { tasks, labelNames: { 'plan-1': new Map([['category1', 'Urgent']]) } } });
    const renamed = await run({
      reader: { tasks, labelNames: { 'plan-1': new Map([['category1', 'Critical']]) } },
      files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } },
    });

    expect(renamed.summary.converted).toBe(1);
    expect(renamed.files.written.get(`${ROOT}/To do/Book the venue.md`)).toContain('labels:\n  - Critical\n');
    expect(renamed.files.written.has(`${ROOT}/Done/Pick a date.md`)).toBe(false);
  });

  it('a plan whose label names cannot be read is synced without its labels, and the log says why', async () => {
    const labelled = { 'plan-1': [task('t-venue', 'Book the venue', { labels: ['category1'] })] };
    const done = await run({ reader: { tasks: labelled, failLabelNames: { kind: 'permanent', message: 'unknown command: get-planner-plan-details' } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.written.get(`${ROOT}/To do/Book the venue.md`)).not.toContain('labels:');
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'labels.unnamed', meta: { plan: 'plan-1', cause: 'permanent' } });
  });

  it('the pages are written a window at a time, each stepped once, the state saved after every window', async () => {
    const done = await run({ concurrency: 1 });

    expect(done.progress.started).toEqual([{ total: 2, what: 'Offsite 2026' }]);
    expect(done.progress.steps).toEqual(['Pick a date', 'Book the venue']);
    expect(done.files.writeLog.filter((path) => path === STATE_PATH)).toHaveLength(3);
  });

  it('a second run reads every detail again and rewrites only the tasks whose card or details changed, leaving the board alone when nothing did', async () => {
    const untouched = await run({ files: { texts: { [STATE_PATH]: serializePlanState(settled()) } } });
    expect(untouched.summary.converted).toBe(0);
    expect(untouched.files.writeLog).toEqual([STATE_PATH]);
    expect(stateOf(untouched.files).lastRun).toBe('2026-09-12T14:00:00Z');
    expect(stateOf(untouched.files).source).toEqual({ kind: 'plan', id: 'plan-1', name: 'Offsite 2026' });

    const edited = await run({
      reader: { details: { ...DETAILS, 't-venue': details('Three rooms, one with a projector.', 'W/"d-2"') } },
      files: { texts: { [STATE_PATH]: serializePlanState(settled()) } },
    });
    expect(edited.summary.converted).toBe(1);
    expect(edited.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/To do/Book the venue.md`, BOARD_PATH]);
    expect(edited.files.moves).toStrictEqual([]);
  });

  it('a task moved to another bucket or a bucket renamed is written afresh with the old page put aside, and a task gone from the plan is put aside and named in the report', async () => {
    const moved = [task('t-venue', 'Book the venue', { bucketId: 'b-done', etag: 'W/"t-venue-2"' })];
    const done = await run({ reader: { tasks: { 'plan-1': moved } }, files: { texts: { [STATE_PATH]: serializePlanState(settled()) } } });

    expect(done.summary).toMatchObject({ converted: 1, archived: 1 });
    expect(done.files.moves.map((move) => move.to)).toEqual(['kb/_archive/Planner/Offsite 2026/To do/Book the venue.md', 'kb/_archive/Planner/Offsite 2026/Done/Pick a date.md']);
    expect(done.notes.archived).toEqual([{ path: 'Pick a date', reason: 'no longer in the plan' }]);
    expect(done.files.written.get(`${ROOT}/_sync-report.md`)).toContain('Pick a date');
    expect(Object.keys(stateOf(done.files).tasks)).toEqual(['t-venue']);
    expect(done.files.writeLog).toContain(BOARD_PATH);

    const renamedBuckets = { 'plan-1': [bucket('b-done', 'Done', '8585 2'), bucket('b-todo', 'Next', '8585 1')] };
    const stuck = await run({
      reader: { buckets: renamedBuckets },
      files: { texts: { [STATE_PATH]: serializePlanState(settled()) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } },
    });
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: `${ROOT}/To do/Book the venue.md`, cause: 'write-failed' } });

    const renamed = await run({
      reader: { buckets: { 'plan-1': [bucket('b-done', 'Done', '8585 2'), bucket('b-todo', 'Next', '8585 1')] } },
      files: { texts: { [STATE_PATH]: serializePlanState(settled()) } },
    });
    expect(renamed.summary.converted).toBe(1);
    expect(stateOf(renamed.files).tasks['t-venue']?.file).toBe(`${ROOT}/Next/Book the venue.md`);
    expect(renamed.files.moves.map((move) => move.from)).toEqual([`${ROOT}/To do/Book the venue.md`]);
  });

  it('a new task sharing a title and a bucket with one already written takes a file of its own even when listed first, and the page already there stays put', async () => {
    const tasks = { 'plan-1': [task('t-twin', 'Book the venue'), ...TASKS['plan-1']] };
    const done = await run({
      reader: { tasks, details: { ...DETAILS, 't-twin': details('A second venue.') } },
      files: { texts: { [STATE_PATH]: serializePlanState(settled()), [`${ROOT}/To do/Book the venue.md`]: 'the venue page as it was' } },
    });

    const recorded = stateOf(done.files).tasks['t-twin']?.file ?? '';
    expect(done.files.written.get(recorded)).toContain('A second venue.');
    expect(done.files.written.get(`${ROOT}/To do/Book the venue.md`)).toBe('the venue page as it was');
    expect(done.files.moves).toHaveLength(0);
  });

  it('a task whose details cannot be read is reported as failed and kept as it was, still on the board; an assignee who cannot be named is shown by id', async () => {
    const done = await run({ reader: { failDetailsOf: ['t-venue'], failNamesOf: ['u-sam'] }, files: { texts: { [STATE_PATH]: serializePlanState(settled()) } } });

    expect(done.summary).toMatchObject({ converted: 0, failed: 1, archived: 0 });
    expect(done.notes.failed).toEqual([{ path: 'Book the venue', reason: 'Graph is busy' }]);
    expect(stateOf(done.files).tasks['t-venue']).toBeDefined();
    expect(done.files.written.get(BOARD_PATH)).toContain('| To do | [Book the venue](<To do/Book the venue.md>) | in progress | Jane Doe, u-sam |');
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'assignee.unnamed', meta: { user: 'u-sam', cause: 'permanent' } });
  });

  it('a plan whose buckets or tasks cannot be listed ends the run naming the step', async () => {
    const buckets = await run({ reader: { failBuckets: { kind: 'auth', message: 'sign-in has lapsed' } } });
    const tasks = await run({ reader: { failTasks: { kind: 'transient', message: 'Graph is busy' } } });

    expect(buckets.error).toEqual({ step: 'listBuckets', cause: 'auth', message: 'sign-in has lapsed' });
    expect(tasks.error).toEqual({ step: 'listTasks', cause: 'transient', message: 'Graph is busy' });
  });

  it('a dry run lists the plan, reads every detail, says how many pages it would write, and writes nothing, asking no names', async () => {
    const done = await run({ dryRun: true });
    const oneUnreadable = await run({ dryRun: true, reader: { failDetailsOf: ['t-date'] } });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 2 });
    expect(done.files.writeLog).toHaveLength(0);
    expect(done.reader.calls.some((call) => call.startsWith('name:'))).toBe(false);
    expect(oneUnreadable.summary.queued).toBe(1);
  });

  it('a state file this version cannot read is started over with a warning, one that cannot be saved stops the run, and a page that will not write is reported', async () => {
    const restarted = await run({ files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"plan","id":"plan-1","name":"S"}}' } } });
    expect(restarted.summary.converted).toBe(2);
    expect(restarted.logger.calls).toContainEqual({ level: 'warn', event: 'plan-state.unreadable', meta: { plan: 'plan-1', cause: 'state is version 99, not 1' } });

    const garbled = await run({ files: { texts: { [STATE_PATH]: '{not json' } } });
    expect(garbled.logger.calls.filter((entry) => entry.event === 'plan-state.unreadable')).toHaveLength(1);

    const unsaved = await run({ concurrency: 1, files: { failWritesMatching: '.sync-state.json' } });
    expect(unsaved.error?.step).toBe('saveState');
    expect(unsaved.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Done/Pick a date.md`]);

    const unstamped = await run({ files: { texts: { [STATE_PATH]: serializePlanState(settled()) }, failWritesMatching: '.sync-state.json' } });
    expect(unstamped.error?.step).toBe('saveState');
    expect(unstamped.files.written.has(`${ROOT}/_sync-report.md`)).toBe(false);

    const unwritten = await run({ files: { failWritesMatching: 'Pick a date' } });
    expect(unwritten.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(unwritten.notes.failed).toEqual([{ path: 'Pick a date', reason: `cannot write ${ROOT}/Done/Pick a date.md` }]);
    expect(unwritten.logger.calls).toContainEqual({ level: 'warn', event: 'task.failed', meta: { task: 't-date', cause: 'write-failed' } });
    expect(Object.keys(stateOf(unwritten.files).tasks)).toEqual(['t-venue']);
  });

  it('two tasks sharing a title in one bucket take different files, a board that will not write is logged, and an empty plan gets a board saying so', async () => {
    const twins = { 'plan-1': [task('one', 'Call the caterer'), task('two', 'Call the caterer')] };
    const done = await run({ reader: { tasks: twins } });
    expect(new Set(Object.values(stateOf(done.files).tasks).map((record) => record.file)).size).toBe(2);

    const stuck = await run({ files: { failWritesMatching: '_board' } });
    expect(stuck.summary.converted).toBe(2);
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'board.failed', meta: { cause: 'write-failed' } });

    const empty = await run({ reader: { tasks: {} } });
    expect(empty.files.written.get(BOARD_PATH)).toContain('_No tasks._');

    const state = withTask(emptyPlanState(PLAN), 'gone', { file: `${ROOT}/Done/Retired.md`, fingerprint: 'x', title: 'Retired' });
    const unmoved = await run({ files: { texts: { [STATE_PATH]: serializePlanState(state) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } } });
    expect(unmoved.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: `${ROOT}/Done/Retired.md`, cause: 'write-failed' } });
  });
});
