import { describe, expect, it } from 'bun:test';
import { planUrl, renderPlanBoard, renderPlanTaskDocument, taskUrl } from './plan-document.ts';
import type { PlanTask, TaskDetails } from './planner.ts';

const PLAN = { id: 'plan-1', title: 'Offsite 2026', groupId: 'group-1' };

const task = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: 'task-1',
  title: 'Book the venue',
  bucketId: 'bucket-1',
  orderHint: '',
  percentComplete: 50,
  priority: 1,
  start: '2026-09-01',
  due: '2026-09-30',
  completed: '',
  created: '2026-08-20T09:12:00Z',
  assigneeIds: ['u-jane', 'u-sam'],
  labels: [],
  createdBy: 'Jane Doe',
  etag: 'W/"t"',
  ...over,
});

const details: TaskDetails = {
  description: 'Three rooms, one with a projector.',
  checklist: [
    { text: 'Ask for a quote', done: true },
    { text: 'Sign the contract', done: false },
  ],
  references: [
    { url: 'https://contoso.sharepoint.com/sites/x/Shared Documents/venues.xlsx', alias: 'venues.xlsx' },
    { url: 'https://example.com/quote', alias: '' },
  ],
  etag: 'W/"d"',
};

describe('writing a Planner task as a document', () => {
  it('a task opens with where it is, how far it is, who has it and when, then its description, its checklist and its references', () => {
    const written = renderPlanTaskDocument({
      task: task(),
      details,
      plan: PLAN,
      bucket: 'To do',
      labels: ['Urgent', 'Waiting on client'],
      assignees: ['Jane Doe', 'Sam Lee'],
      syncedAt: '2026-09-12T14:00:00Z',
    });

    expect(written).toBe(
      [
        '---',
        'source: https://planner.cloud.microsoft/webui/plan/plan-1/view/board/task/task-1',
        'plan: Offsite 2026',
        'bucket: To do',
        'progress: in progress',
        'priority: urgent',
        'labels:',
        '  - Urgent',
        '  - Waiting on client',
        'assigned_to:',
        '  - Jane Doe',
        '  - Sam Lee',
        'start: "2026-09-01"',
        'due: "2026-09-30"',
        'created: "2026-08-20T09:12:00Z"',
        'created_by: Jane Doe',
        'synced_at: "2026-09-12T14:00:00Z"',
        '---',
        '',
        '# Book the venue',
        '',
        'Three rooms, one with a projector.',
        '',
        '## Checklist',
        '',
        '- [x] Ask for a quote',
        '- [ ] Sign the contract',
        '',
        '## References',
        '',
        '- [venues.xlsx](<https://contoso.sharepoint.com/sites/x/Shared Documents/venues.xlsx>)',
        '- [https://example.com/quote](https://example.com/quote)',
        '',
      ].join('\n')
    );
  });

  it('a bare task states only what it has: no priority line for a medium one, no dates it lacks, no empty sections; a done task says when', () => {
    const bare = renderPlanTaskDocument({
      task: task({ percentComplete: 100, priority: 5, start: '', due: '', completed: '2026-09-10', assigneeIds: [], createdBy: '', created: '' }),
      details: { description: '', checklist: [], references: [], etag: '' },
      plan: PLAN,
      bucket: '',
      labels: [],
      assignees: [],
      syncedAt: 'now',
    });

    expect(bare).toContain('progress: done\n');
    expect(bare).toContain('completed: "2026-09-10"\n');
    expect(bare).not.toContain('priority:');
    expect(bare).not.toContain('bucket:');
    expect(bare).not.toContain('start:');
    expect(bare).not.toContain('due:');
    expect(bare).not.toContain('created');
    expect(bare).not.toContain('assigned_to');
    expect(bare).not.toContain('labels');
    expect(bare).not.toContain('##');
    expect(bare.endsWith('---\n\n# Book the venue\n')).toBe(true);
  });

  it('a plan and a task each have an address in Planner', () => {
    expect(planUrl('plan-1')).toBe('https://planner.cloud.microsoft/webui/plan/plan-1/view/board');
    expect(taskUrl('plan-1', 'task-1')).toBe('https://planner.cloud.microsoft/webui/plan/plan-1/view/board/task/task-1');
  });
});

describe('writing a plan as a board', () => {
  it('one row per task under its bucket, in the board`s order, linking each task to its page', () => {
    const written = renderPlanBoard({
      plan: PLAN,
      rows: [
        { bucket: 'To do', task: task(), labels: ['Urgent', 'Waiting | client'], assignees: ['Jane Doe', 'Sam Lee'], link: 'To do/Book the venue.md' },
        {
          bucket: 'Done',
          task: task({ id: 'task-2', title: 'Pick a | date', percentComplete: 100, priority: 5, due: '', assigneeIds: [] }),
          labels: [],
          assignees: [],
          link: 'Done/Pick a - date.md',
        },
      ],
      syncedAt: '2026-09-12T14:00:00Z',
    });

    expect(written).toBe(
      [
        '---',
        'source: https://planner.cloud.microsoft/webui/plan/plan-1/view/board',
        'plan: Offsite 2026',
        'tasks: 2',
        'synced_at: "2026-09-12T14:00:00Z"',
        '---',
        '',
        '# Offsite 2026',
        '',
        '| Bucket | Task | Progress | Assigned to | Due | Priority | Labels |',
        '|---|---|---|---|---|---|---|',
        '| To do | [Book the venue](<To do/Book the venue.md>) | in progress | Jane Doe, Sam Lee | 2026-09-30 | urgent | Urgent, Waiting \\| client |',
        '| Done | [Pick a \\| date](<Done/Pick a - date.md>) | done |  |  | medium |  |',
        '',
      ].join('\n')
    );
  });

  it('an empty plan is a board with nothing on it, said so', () => {
    expect(renderPlanBoard({ plan: PLAN, rows: [], syncedAt: 'now' })).toContain('_No tasks._');
  });
});
