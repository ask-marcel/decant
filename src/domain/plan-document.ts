import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { linkDestination } from './markdown-link.ts';
import type { ChecklistItem, Plan, PlanTask, Reference, TaskDetails } from './planner.ts';
import { priorityOf, progressOf } from './planner.ts';

// Planner's web app opens a plan and a task by id, tenant-agnostic once signed in.
const PLANNER = 'https://planner.cloud.microsoft/webui/plan';

export const planUrl = (planId: string): string => `${PLANNER}/${planId}/view/board`;

export const taskUrl = (planId: string, taskId: string): string => `${planUrl(planId)}/task/${taskId}`;

const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

const MEDIUM = 'medium';

// Every task is medium until someone says otherwise, so stating it would put a line saying
// nothing on most documents. Stated only where it means something.
const priorityLine = (task: PlanTask): string | undefined => {
  const priority = priorityOf(task.priority);
  return priority === MEDIUM ? undefined : priority;
};

export type RenderPlanTaskInput = {
  readonly task: PlanTask;
  readonly details: TaskDetails;
  readonly plan: Plan;
  readonly bucket: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly syncedAt: string;
};

const fieldsOf = (input: RenderPlanTaskInput): ReadonlyArray<FrontMatterField> => [
  ['source', taskUrl(input.plan.id, input.task.id)],
  ['plan', input.plan.title],
  ['bucket', stated(input.bucket)],
  ['progress', progressOf(input.task.percentComplete)],
  ['priority', priorityLine(input.task)],
  ['labels', input.labels],
  ['assigned_to', input.assignees],
  ['start', stated(input.task.start)],
  ['due', stated(input.task.due)],
  ['completed', stated(input.task.completed)],
  ['created', stated(input.task.created)],
  ['created_by', stated(input.task.createdBy)],
  ['synced_at', input.syncedAt],
];

const checkLine = (item: ChecklistItem): string => `- [${item.done ? 'x' : ' '}] ${item.text}`;

// A reference with no alias is named by its address, so it reads as a link to somewhere rather
// than a link to nothing.
const referenceLine = (reference: Reference): string => `- [${reference.alias.length > 0 ? reference.alias : reference.url}](${linkDestination(reference.url)})`;

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => (lines.length === 0 ? [] : ['', `## ${heading}`, '', ...lines]);

const bodyOf = (input: RenderPlanTaskInput): string =>
  [
    `# ${input.task.title}`,
    ...(input.details.description.length === 0 ? [] : ['', input.details.description]),
    ...section('Checklist', input.details.checklist.map(checkLine)),
    ...section('References', input.details.references.map(referenceLine)),
  ].join('\n');

export const renderPlanTaskDocument = (input: RenderPlanTaskInput): string => withFrontMatter(renderFrontMatter(fieldsOf(input)), bodyOf(input));

// One task as the board shows it: in its lane, linked to its page by a path relative to the board.
export type BoardRow = {
  readonly bucket: string;
  readonly task: PlanTask;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly link: string;
};

export type RenderPlanBoardInput = { readonly plan: Plan; readonly rows: ReadonlyArray<BoardRow>; readonly syncedAt: string };

const BAR = /\|/g;

const cell = (text: string): string => text.replace(BAR, '\\|');

const rowLine = (row: BoardRow): string =>
  `| ${cell(row.bucket)} | [${cell(row.task.title)}](${linkDestination(row.link)}) | ${progressOf(row.task.percentComplete)} | ${row.assignees.map(cell).join(', ')} | ${row.task.due} | ${priorityOf(row.task.priority)} | ${row.labels.map(cell).join(', ')} |`;

const HEADER = ['| Bucket | Task | Progress | Assigned to | Due | Priority | Labels |', '|---|---|---|---|---|---|---|'];

const NO_TASKS = '_No tasks._';

// The whole plan as one table, the lanes in the board's order and the cards in each lane's, which
// is what a reader wants before opening any one task.
export const renderPlanBoard = (input: RenderPlanBoardInput): string => {
  const fields: ReadonlyArray<FrontMatterField> = [
    ['source', planUrl(input.plan.id)],
    ['plan', input.plan.title],
    ['tasks', input.rows.length],
    ['synced_at', input.syncedAt],
  ];
  const table = input.rows.length === 0 ? [NO_TASKS] : [...HEADER, ...input.rows.map(rowLine)];
  return withFrontMatter(renderFrontMatter(fields), [`# ${input.plan.title}`, '', ...table].join('\n'));
};
