// One task in a Microsoft To Do list, as the task listing answers for it with its steps and its
// linked resources expanded. Graph pairs a due date and a completion date with the zone they were
// entered in; To Do has no time of day for either, so what survives is the day and the pair goes.
export type TodoStep = { readonly text: string; readonly done: boolean };

// A file, a page or a message the task points at. To Do writes one whenever a task is made from a
// mail, which is what the whole of the Flagged Emails list is.
export type TodoLink = { readonly name: string; readonly url: string; readonly application: string };

export type TodoTask = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly importance: string;
  readonly notes: string;
  readonly created: string;
  // What the task is filed under, and what says whether a run has anything to write for it.
  readonly lastModified: string;
  readonly due: string;
  readonly completed: string;
  readonly categories: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<TodoStep>;
  readonly links: ReadonlyArray<TodoLink>;
};

const DAY_LENGTH = 10;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

const dayOf = (pair: unknown): string => (readString(pair, 'dateTime') ?? '').slice(0, DAY_LENGTH);

const listOf = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const stepsOf = (raw: unknown): ReadonlyArray<TodoStep> =>
  listOf(raw).flatMap((entry) => {
    const text = readString(entry, 'displayName');
    return text === undefined ? [] : [{ text, done: isRecord(entry) && entry['isChecked'] === true }];
  });

// A resource with no address is one nothing can be pointed at, so it is dropped rather than written
// as a label linking nowhere.
const linksOf = (raw: unknown): ReadonlyArray<TodoLink> =>
  listOf(raw).flatMap((entry) => {
    const url = readString(entry, 'webUrl');
    return url === undefined ? [] : [{ name: readString(entry, 'displayName') ?? '', url, application: readString(entry, 'applicationName') ?? '' }];
  });

// Graph's own default, which it omits from the payload as often as it states it. Reading the absence
// as `normal` is what lets the document say nothing about an ordinary task's importance.
const NORMAL = 'normal';

export const parseTodoTask = (raw: unknown): TodoTask | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  return {
    id,
    title: readString(raw, 'title') ?? '',
    status: readString(raw, 'status') ?? '',
    importance: readString(raw, 'importance') ?? NORMAL,
    notes: readString(raw['body'], 'content') ?? '',
    created: readString(raw, 'createdDateTime') ?? '',
    lastModified: readString(raw, 'lastModifiedDateTime') ?? '',
    due: dayOf(raw['dueDateTime']),
    completed: dayOf(raw['completedDateTime']),
    categories: listOf(raw['categories']).filter((entry): entry is string => typeof entry === 'string'),
    steps: stepsOf(raw['checklistItems']),
    links: linksOf(raw['linkedResources']),
  };
};
