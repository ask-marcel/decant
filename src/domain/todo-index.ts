import { relativeTo, renderIndexPage } from './index-page.ts';
import type { IndexRow } from './index-page.ts';
import type { TodoState } from './todo-state.ts';
import type { TodoTask } from './todo-task.ts';
import { compareText } from './utilities/compare-text.ts';

const COMPLETED = 'completed';

// `notStarted` as a reader says it: `not started`.
const statusWords = (status: string): string => status.replaceAll(/([A-Z])/g, ' $1').toLowerCase();

type Listed = { readonly task: TodoTask; readonly file: string };

const openRow = (entry: Listed, day: string): IndexRow => ({ day, title: entry.task.title, file: entry.file, note: statusWords(entry.task.status) });

const byTitle = (left: Listed, right: Listed): number => compareText(left.task.title, right.task.title) || compareText(left.task.id, right.task.id);

const byDue = (left: Listed, right: Listed): number => compareText(left.task.due, right.task.due) || byTitle(left, right);

const latestDone = (left: Listed, right: Listed): number => compareText(right.task.completed, left.task.completed) || byTitle(left, right);

// A list as a reader works through it: what is open, by the day it is due, soonest first; what is open
// with no due day; then what is done, the latest first. A task is listed once it is on disk, so a task
// that could not be written has no line to lead nowhere.
export const todoIndexPage = (listName: string, root: string, tasks: ReadonlyArray<TodoTask>, state: TodoState): string => {
  const listed = tasks.flatMap((task) => {
    const record = state.tasks[task.id];
    return record === undefined ? [] : [{ task, file: relativeTo(root, record.file) }];
  });
  const open = listed.filter((entry) => entry.task.status !== COMPLETED);
  return renderIndexPage(listName, [
    {
      heading: 'Open, by due day',
      rows: open
        .filter((entry) => entry.task.due.length > 0)
        .toSorted(byDue)
        .map((entry) => openRow(entry, entry.task.due)),
    },
    {
      heading: 'Open, with no due day',
      rows: open
        .filter((entry) => entry.task.due.length === 0)
        .toSorted(byTitle)
        .map((entry) => openRow(entry, '')),
    },
    {
      heading: 'Completed, the latest first',
      rows: listed
        .filter((entry) => entry.task.status === COMPLETED)
        .toSorted(latestDone)
        .map((entry) => ({ day: entry.task.completed, title: entry.task.title, file: entry.file, note: '' })),
    },
  ]);
};
