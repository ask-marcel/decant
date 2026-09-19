import { describe, expect, it } from 'bun:test';
import { emptyPlanState, goneTasks, parsePlanState, planTaskFiles, serializePlanState, withTask, withoutTask } from './plan-state.ts';
import type { PlanState } from './plan-state.ts';
import type { Bucket, PlanTask } from './planner.ts';

const PLAN = { id: 'plan-1', title: 'Offsite 2026', groupId: 'group-1' };
const ROOT = 'kb/Planner/Offsite 2026';

const task = (id: string, title: string, bucketId = 'bucket-1'): PlanTask => ({
  id,
  title,
  bucketId,
  orderHint: '',
  percentComplete: 0,
  priority: 5,
  start: '',
  due: '',
  completed: '',
  created: '',
  assigneeIds: [],
  createdBy: '',
  etag: 'W/"t"',
});
const bucket = (id: string, name: string): Bucket => ({ id, name, orderHint: '' });

const seeded = (): PlanState =>
  withTask(withTask(emptyPlanState(PLAN), 'a', { file: `${ROOT}/To do/Book the venue.md`, fingerprint: 'f-a', title: 'Book the venue' }), 'b', {
    file: `${ROOT}/Done/Pick a date.md`,
    fingerprint: 'f-b',
    title: 'Pick a date',
  });

describe('what a plan run remembers between runs', () => {
  it('a state carries the plan whole, records each task with its file and fingerprint, and can forget one', () => {
    expect(emptyPlanState(PLAN)).toEqual({ version: 1, source: { kind: 'plan', id: 'plan-1', name: 'Offsite 2026' }, plan: PLAN, lastRun: '', tasks: {} });
    expect(seeded().tasks['a']).toEqual({ file: `${ROOT}/To do/Book the venue.md`, fingerprint: 'f-a', title: 'Book the venue' });
    expect(Object.keys(withoutTask(seeded(), 'a').tasks)).toEqual(['b']);
  });

  it('a state written and read back is the state that was written; one of another version or kind is refused; missing fields read as blanks', () => {
    expect(parsePlanState(JSON.parse(serializePlanState(seeded())))).toEqual({ ok: true, value: seeded() });
    expect(parsePlanState({ version: 5, source: { kind: 'plan', id: 'x', name: 'y' } })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is version 5, not 1' } });
    expect(parsePlanState({ version: 1, source: { kind: 'todo', id: 'x', name: 'y' } })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not a plan' } });
    expect(parsePlanState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
    expect(parsePlanState(null)).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
    expect(
      parsePlanState({ version: 1, source: { kind: 'plan', id: 'plan-1', name: 'Offsite' }, lastRun: 3, tasks: { a: { file: 'f' }, b: { fingerprint: 'g' }, bad: 1 }, plan: null })
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        source: { kind: 'plan', id: 'plan-1', name: 'Offsite' },
        plan: { id: 'plan-1', title: 'Offsite', groupId: '' },
        lastRun: '',
        tasks: { a: { file: 'f', fingerprint: '', title: '' }, b: { file: '', fingerprint: 'g', title: '' } },
      },
    });
    expect(parsePlanState({ version: 1, source: { kind: 'plan' }, plan: { id: 'p', title: 'T', groupId: 'g' }, lastRun: '2026-09-11T09:00:00Z', tasks: null })).toMatchObject({
      ok: true,
      value: { source: { id: 'p', name: 'T' }, plan: { id: 'p', title: 'T', groupId: 'g' }, lastRun: '2026-09-11T09:00:00Z', tasks: {} },
    });
    expect(parsePlanState({ version: 1, source: { kind: 'plan' } })).toMatchObject({
      ok: true,
      value: { source: { kind: 'plan', id: '', name: '' }, plan: { id: '', title: '', groupId: '' } },
    });
  });

  it('a task the plan no longer has is what gets put aside', () => {
    expect(goneTasks(seeded(), [task('a', 'Book the venue')])).toEqual([{ id: 'b', record: { file: `${ROOT}/Done/Pick a date.md`, fingerprint: 'f-b', title: 'Pick a date' } }]);
  });

  it('a task is filed under its bucket by its title, a namesake in the same bucket takes a suffix from its id, and a file held by a task not being rewritten is taken', () => {
    const buckets = [bucket('bucket-1', 'To do'), bucket('bucket-2', 'Done')];
    const planned = planTaskFiles(
      ROOT,
      [task('c', 'Pick a date', 'bucket-2'), task('d', 'Book the venue'), task('e', 'Book the venue'), task('f', 'Lost', 'bucket-9')],
      buckets,
      seeded()
    );

    expect(planned.map((entry) => entry.task.id)).toEqual(['c', 'd', 'e', 'f']);
    expect(planned[0]?.file).toContain(`${ROOT}/Done/Pick a date-`);
    expect(planned[1]?.file).toContain(`${ROOT}/To do/Book the venue-`);
    expect(planned[2]?.file).toContain(`${ROOT}/To do/Book the venue-`);
    expect(planned[1]?.file).not.toBe(planned[2]?.file);
    expect(planned[3]?.file).toBe(`${ROOT}/_no bucket/Lost.md`);
    expect(planned.map((entry) => entry.bucket)).toEqual(['Done', 'To do', 'To do', '']);

    const own = planTaskFiles(ROOT, [task('a', 'Book the venue')], buckets, seeded());
    expect(own[0]?.file).toBe(`${ROOT}/To do/Book the venue.md`);
  });
});
