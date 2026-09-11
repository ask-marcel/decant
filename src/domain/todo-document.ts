import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import type { TodoLink, TodoStep, TodoTask } from './todo-task.ts';

// A task has no address of its own: Graph hands out no web link for one, and To Do's app opens by
// id rather than by URL. So `source` says where the task came from in words, the way a mail thread
// does, rather than pretending to a link a reader could follow.
const sourceOf = (list: string): string => `To Do - ${list}`;

const NORMAL = 'normal';

// Every task is normal until someone says otherwise, so stating it would put a line saying nothing
// on every document in the vault. Stated only where it means something.
const importanceOf = (task: TodoTask): string | undefined => (task.importance === NORMAL ? undefined : task.importance);

// The front matter writes an empty string as `""`, a field deliberately left blank, where a task
// with no due date has no due line at all.
const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

const fieldsOf = (input: RenderTaskInput): ReadonlyArray<FrontMatterField> => [
  ['source', sourceOf(input.list)],
  ['list', input.list],
  ['status', input.task.status],
  ['importance', importanceOf(input.task)],
  ['due', stated(input.task.due)],
  ['completed', stated(input.task.completed)],
  ['created', stated(input.task.created)],
  ['last_modified', stated(input.task.lastModified)],
  ['categories', input.task.categories],
  ['synced_at', input.syncedAt],
];

const stepLine = (step: TodoStep): string => `- [${step.done ? 'x' : ' '}] ${step.text}`;

// A resource To Do wrote from an application it names, but never got a label for, is named by that
// application: an empty label reads as a broken link rather than as a link to something unnamed.
const linkLine = (link: TodoLink): string => `- [${link.name.length > 0 ? link.name : link.application}](${link.url})`;

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => (lines.length === 0 ? [] : ['', `## ${heading}`, '', ...lines]);

const bodyOf = (task: TodoTask): string =>
  [`# ${task.title}`, ...(task.notes.length === 0 ? [] : ['', task.notes]), ...section('Steps', task.steps.map(stepLine)), ...section('Links', task.links.map(linkLine))].join(
    '\n'
  );

export type RenderTaskInput = { readonly task: TodoTask; readonly list: string; readonly syncedAt: string };

export const renderTaskDocument = (input: RenderTaskInput): string => withFrontMatter(renderFrontMatter(fieldsOf(input)), bodyOf(input.task));
