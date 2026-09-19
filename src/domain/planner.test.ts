import { describe, expect, it } from 'bun:test';
import { byOrderHint, parseBucket, parsePlan, parsePlanTask, parseTaskDetails, priorityOf, progressOf, taskFingerprint } from './planner.ts';

const graphTask = {
  '@odata.etag': 'W/"task-etag"',
  planId: 'plan-1',
  bucketId: 'bucket-1',
  title: 'Book the venue',
  orderHint: '8585 2P!',
  percentComplete: 50,
  startDateTime: '2026-09-01T00:00:00Z',
  createdDateTime: '2026-08-20T09:12:00Z',
  dueDateTime: '2026-09-30T10:00:00Z',
  completedDateTime: null,
  priority: 1,
  id: 'task-1',
  completedBy: null,
  createdBy: { user: { displayName: 'Jane Doe', id: 'u-jane' }, application: null },
  appliedCategories: { category3: true },
  assignments: { 'u-jane': { assignedBy: {}, orderHint: '8585 1' }, 'u-sam': { orderHint: '8585 2' } },
};

describe('reading a Planner plan, its buckets and its tasks as Graph answers for them', () => {
  it('a plan carries its id, its title and the group that owns it', () => {
    expect(parsePlan({ id: 'plan-1', title: 'Offsite 2026', owner: 'group-1', container: { containerId: 'group-1', type: 'group' } })).toEqual({
      id: 'plan-1',
      title: 'Offsite 2026',
      groupId: 'group-1',
    });
    expect(parsePlan({ id: 'plan-2' })).toEqual({ id: 'plan-2', title: 'plan-2', groupId: '' });
    expect(parsePlan({ title: 'no id' })).toBeUndefined();
    expect(parsePlan({ id: 5 })).toBeUndefined();
    expect(parsePlan(null)).toBeUndefined();
  });

  it('a bucket is a lane with a name and its place on the board', () => {
    expect(parseBucket({ id: 'bucket-1', name: 'To do', planId: 'plan-1', orderHint: '8585 1P!' })).toEqual({ id: 'bucket-1', name: 'To do', orderHint: '8585 1P!' });
    expect(parseBucket({ id: 'bucket-2' })).toEqual({ id: 'bucket-2', name: 'bucket-2', orderHint: '' });
    expect(parseBucket({ name: 'no id' })).toBeUndefined();
  });

  it('a task carries what names it, where it sits, how far it is, its dates as days, who it is assigned to and who made it', () => {
    expect(parsePlanTask(graphTask)).toEqual({
      id: 'task-1',
      title: 'Book the venue',
      bucketId: 'bucket-1',
      orderHint: '8585 2P!',
      percentComplete: 50,
      priority: 1,
      start: '2026-09-01',
      due: '2026-09-30',
      completed: '',
      created: '2026-08-20T09:12:00Z',
      assigneeIds: ['u-jane', 'u-sam'],
      createdBy: 'Jane Doe',
      etag: 'W/"task-etag"',
    });
    expect(parsePlanTask({ id: 't' })).toEqual({
      id: 't',
      title: '',
      bucketId: '',
      orderHint: '',
      percentComplete: 0,
      priority: 5,
      start: '',
      due: '',
      completed: '',
      created: '',
      assigneeIds: [],
      createdBy: '',
      etag: '',
    });
    expect(parsePlanTask({ title: 'no id' })).toBeUndefined();
    expect(parsePlanTask({ id: 't', percentComplete: '50', completedDateTime: '2026-09-10T08:00:00Z' })).toMatchObject({ percentComplete: 0, completed: '2026-09-10' });
  });

  it('the details carry the description, the checklist in its order and the references by their decoded address', () => {
    expect(
      parseTaskDetails({
        '@odata.etag': 'W/"details-etag"',
        id: 'task-1',
        description: 'Three rooms, one with a projector.',
        previewType: 'description',
        references: {
          'https%3A//contoso%2Esharepoint%2Ecom/sites/x/Shared%20Documents/venues%2Exlsx': { alias: 'venues.xlsx', type: 'Excel', previewPriority: '8585' },
          'https%3A//example%2Ecom/quote': { alias: '', type: 'Other' },
        },
        checklist: {
          'c-2': { isChecked: false, title: 'Sign the contract', orderHint: '8585 2' },
          'c-1': { isChecked: true, title: 'Ask for a quote', orderHint: '8585 1' },
          'c-x': { isChecked: true },
        },
      })
    ).toEqual({
      description: 'Three rooms, one with a projector.',
      checklist: [
        { text: 'Ask for a quote', done: true },
        { text: 'Sign the contract', done: false },
      ],
      references: [
        { url: 'https://contoso.sharepoint.com/sites/x/Shared Documents/venues.xlsx', alias: 'venues.xlsx' },
        { url: 'https://example.com/quote', alias: '' },
      ],
      etag: 'W/"details-etag"',
    });
    expect(parseTaskDetails({ references: { '%E0%A4%A': { alias: 'bad' }, 'https%3A//x': { type: 'Other' } } })).toEqual({
      description: '',
      checklist: [],
      references: [
        { url: '%E0%A4%A', alias: 'bad' },
        { url: 'https://x', alias: '' },
      ],
      etag: '',
    });
    expect(parseTaskDetails({ checklist: { b: { title: 'Later', orderHint: '1' }, a: { title: 'Unplaced' } } })).toMatchObject({
      checklist: [
        { text: 'Unplaced', done: false },
        { text: 'Later', done: false },
      ],
    });
    expect(parseTaskDetails({ checklist: 'nope', references: 'nope' })).toEqual({ description: '', checklist: [], references: [], etag: '' });
    expect(parseTaskDetails('nope')).toEqual({ description: '', checklist: [], references: [], etag: '' });
  });
});

describe('saying where a task stands', () => {
  it('progress in words, from the three values Planner uses', () => {
    expect(progressOf(0)).toBe('not started');
    expect(progressOf(50)).toBe('in progress');
    expect(progressOf(100)).toBe('done');
    expect(progressOf(80)).toBe('in progress');
  });

  it('priority in words, in the bands Planner shows', () => {
    expect([0, 1, 2, 4, 5, 7, 8, 10].map(priorityOf)).toEqual(['urgent', 'urgent', 'important', 'important', 'medium', 'medium', 'low', 'low']);
  });

  it('a task and its details fingerprint together, so a change to either is a change', () => {
    const task = parsePlanTask(graphTask);
    const details = parseTaskDetails({ '@odata.etag': 'W/"d1"' });
    if (task === undefined) throw new Error('task expected');

    expect(taskFingerprint(task, details)).toBe('W/"task-etag" W/"d1"');
    expect(taskFingerprint({ ...task, etag: 'W/"t2"' }, details)).not.toBe(taskFingerprint(task, details));
  });

  it('buckets and tasks sort by their order hint the way the board draws them, character by character', () => {
    const hints = [{ orderHint: '8585B' }, { orderHint: '8585!' }, { orderHint: '8585A' }, { orderHint: '' }];

    expect([...hints].sort(byOrderHint).map((entry) => entry.orderHint)).toEqual(['', '8585!', '8585A', '8585B']);
  });
});
