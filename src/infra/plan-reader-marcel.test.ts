import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createPlanReaderFromCall } from './plan-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createPlanReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createPlanReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0];
    if (answer === undefined) return err({ kind: 'permanent', message: `unknown command: ${name}` });
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const PLAN = { id: 'plan-1', title: 'Offsite 2026', owner: 'group-1', container: { containerId: 'group-1', type: 'group' } };

describe('reading Planner through the ask-marcel library', () => {
  it('the plans are the user`s own listing and every group`s, each group asked in turn; a group that refuses, or a command the library lacks, costs that group`s plans and not the listing', async () => {
    const { reader, recorded } = readerFor({
      'list-planner-plans': [ok({ value: [{ id: 'plan-0', title: 'Mine' }] })],
      'list-group-planner-plans': [ok({ value: [PLAN] }), err({ type: 'api_error', status: 403, message: 'Forbidden' })],
    });

    const listed = await reader.listPlans([
      { id: 'group-1', name: 'Events' },
      { id: 'group-2', name: 'Blocked' },
    ]);

    expect(listed).toEqual({
      ok: true,
      value: [
        { id: 'plan-0', title: 'Mine', groupId: '' },
        { id: 'plan-1', title: 'Offsite 2026', groupId: 'group-1' },
      ],
    });
    expect(recorded.map((entry) => [entry.name, entry.params['groupId']])).toEqual([
      ['list-planner-plans', undefined],
      ['list-group-planner-plans', 'group-1'],
      ['list-group-planner-plans', 'group-2'],
    ]);

    const lacking = readerFor({ 'list-planner-plans': [ok({ value: [] })] });
    expect(await lacking.reader.listPlans([{ id: 'group-1', name: 'Events' }])).toEqual({ ok: true, value: [] });
  });

  it('a plan listed twice, by the user and by its group, is listed once', async () => {
    const { reader } = readerFor({ 'list-planner-plans': [ok({ value: [PLAN] })], 'list-group-planner-plans': [ok({ value: [PLAN] })] });

    const listed = await reader.listPlans([{ id: 'group-1', name: 'Events' }]);

    expect(listed.ok && listed.value.map((plan) => plan.id)).toEqual(['plan-1']);
  });

  it('the user`s own listing failing fails the read, since that one is not one group among many', async () => {
    const { reader } = readerFor({ 'list-planner-plans': [err({ type: 'auth_failed', message: 'sign-in has lapsed' })] });

    expect(await reader.listPlans([])).toEqual({ ok: false, error: { kind: 'permanent', message: 'sign-in has lapsed' } });
  });

  it('one plan by id, its buckets, its tasks followed to the end, and a task`s details, each through its own command', async () => {
    const { reader, recorded } = readerFor({
      'get-planner-plan': [ok(PLAN)],
      'list-plan-buckets': [ok({ value: [{ id: 'b-1', name: 'To do', orderHint: '8585 1' }, { name: 'no id' }] })],
      'list-plan-tasks': [ok({ value: [{ id: 't-1', title: 'Book the venue' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?%24skiptoken=s' })],
      'next-page': [ok({ value: [{ id: 't-2', title: 'Pick a date' }, { noId: true }] })],
      'get-planner-task-details': [ok({ '@odata.etag': 'W/"d"', description: 'Three rooms.', checklist: {}, references: {} })],
    });

    const plan = await reader.plan('plan-1');
    const buckets = await reader.buckets('plan-1');
    const tasks = await reader.tasks('plan-1');
    const details = await reader.details('t-1');

    expect(plan).toEqual({ ok: true, value: { id: 'plan-1', title: 'Offsite 2026', groupId: 'group-1' } });
    expect(buckets.ok && buckets.value).toEqual([{ id: 'b-1', name: 'To do', orderHint: '8585 1' }]);
    expect(tasks.ok && tasks.value.map((task) => task.id)).toEqual(['t-1', 't-2']);
    expect(details).toEqual({ ok: true, value: { description: 'Three rooms.', checklist: [], references: [], etag: 'W/"d"' } });
    expect(recorded.map((entry) => entry.name)).toEqual(['get-planner-plan', 'list-plan-buckets', 'list-plan-tasks', 'next-page', 'get-planner-task-details']);
    expect(recorded[0]?.params).toEqual({ plannerPlanId: 'plan-1' });
    expect(recorded[3]?.params).toEqual({ url: 'https://graph.microsoft.com/v1.0/x?$skiptoken=s' });
    expect(recorded[4]?.params).toEqual({ plannerTaskId: 't-1' });
  });

  it('a plan answered without an id is refused, a cursor pointing at itself ends the paging, and a page that fails fails the read', async () => {
    const noId = readerFor({ 'get-planner-plan': [ok({ title: 'no id' })] });
    expect(await noId.reader.plan('x')).toEqual({ ok: false, error: { kind: 'permanent', message: 'plan x answered without an id' } });

    const looping = ok({ value: [{ id: 't-1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop' });
    const loop = readerFor({ 'list-plan-tasks': [looping], 'next-page': [looping] });
    expect((await loop.reader.tasks('plan-1')).ok).toBe(true);
    expect(loop.recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);

    const failing = readerFor({
      'list-plan-tasks': [ok({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
      'next-page': [err({ type: 'api_error', status: 503, message: 'Graph is busy' })],
    });
    expect(await failing.reader.tasks('plan-1')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph is busy' } });
  });

  it('a user`s name is one read with nothing but the name asked for; a user without one is named by id', async () => {
    const { reader, recorded } = readerFor({ 'get-user': [ok({ id: 'u-jane', displayName: 'Jane Doe' }), ok({ id: 'u-x' })] });

    expect(await reader.userName('u-jane')).toEqual({ ok: true, value: 'Jane Doe' });
    expect(await reader.userName('u-x')).toEqual({ ok: true, value: 'u-x' });
    expect(recorded[0]).toEqual({ name: 'get-user', params: { userId: 'u-jane', select: 'displayName' } });
  });
});
