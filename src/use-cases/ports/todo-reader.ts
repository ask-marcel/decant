import type { Result } from '../../domain/result.ts';
import type { TodoTask } from '../../domain/todo-task.ts';
import type { DriveReaderError } from './drive-reader.ts';

// To Do fails the same ways SharePoint and mail do: the same Graph client is underneath, and a run
// reacts to a throttle or a lapsed sign-in identically whichever side it came from.
export type TodoReaderError = DriveReaderError;

// One of the signed-in user's Microsoft To Do lists. Every account has at least the default one;
// the rest are the lists the person made, plus `Flagged Emails`, which Outlook fills by itself.
export type TodoList = { readonly id: string; readonly name: string };

// Reading the lists, and reading one whole. There is no cursor here on purpose: To Do's delta
// reports which tasks changed but answers with the task's scalar fields alone, leaving out the steps
// and the linked resources, which are navigation properties and have to be expanded. A listing takes
// them in the same request, so one paged read of the list costs less than a delta plus a fetch per
// changed task, and it is also what makes a deleted task visible, by its absence, on every run
// rather than on the one run a delta would report its removal.
export type TodoReader = {
  readonly taskLists: () => Promise<Result<ReadonlyArray<TodoList>, TodoReaderError>>;
  readonly tasks: (listId: string) => Promise<Result<ReadonlyArray<TodoTask>, TodoReaderError>>;
};
