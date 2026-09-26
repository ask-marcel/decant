// A Planner plan, its buckets and its tasks, as Graph answers for them. A plan belongs to a group
// and is read as a board: the buckets are its lanes, and a task sits in one lane at a time. What
// a task says beyond its card (the description, the checklist, the references) is a second
// resource with its own etag, read separately.
export type Plan = { readonly id: string; readonly title: string; readonly groupId: string };

export type Bucket = { readonly id: string; readonly name: string; readonly orderHint: string };

export type PlanTask = {
  readonly id: string;
  readonly title: string;
  readonly bucketId: string;
  readonly orderHint: string;
  readonly percentComplete: number;
  readonly priority: number;
  readonly start: string;
  readonly due: string;
  readonly completed: string;
  readonly created: string;
  // Graph names the assignees by user id alone; the names are looked up afterwards.
  readonly assigneeIds: ReadonlyArray<string>;
  // The labels by key (`category3`), in the order Planner numbers them; their names live in the plan.
  readonly labels: ReadonlyArray<string>;
  readonly createdBy: string;
  readonly etag: string;
};

export type ChecklistItem = { readonly text: string; readonly done: boolean };

export type Reference = { readonly url: string; readonly alias: string };

export type TaskDetails = {
  readonly description: string;
  readonly checklist: ReadonlyArray<ChecklistItem>;
  readonly references: ReadonlyArray<Reference>;
  readonly etag: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

const readNumber = (value: Record<string, unknown>, key: string): number | undefined => {
  const found = value[key];
  return typeof found === 'number' ? found : undefined;
};

const ETAG = '@odata.etag';

export const parsePlan = (raw: unknown): Plan | undefined => {
  const id = readString(raw, 'id');
  if (id === undefined) return undefined;
  return { id, title: readString(raw, 'title') ?? id, groupId: readString(raw, 'owner') ?? '' };
};

export const parseBucket = (raw: unknown): Bucket | undefined => {
  const id = readString(raw, 'id');
  if (id === undefined) return undefined;
  return { id, name: readString(raw, 'name') ?? id, orderHint: readString(raw, 'orderHint') ?? '' };
};

const DAY = 10;

// Planner keeps a moment for a start, a due and a completion, but shows a day; the day is what
// a reader wants and what survives.
const dayOf = (value: unknown): string => (typeof value === 'string' ? value.slice(0, DAY) : '');

// Graph's own default for a task nobody prioritised.
const MEDIUM = 5;

const CATEGORY = 'category';

const categoryNumber = (key: string): number => Number(key.slice(CATEGORY.length));

// A task's labels are the categories set true on it; one set false was taken off.
const labelKeysOf = (raw: unknown): ReadonlyArray<string> =>
  isRecord(raw)
    ? Object.keys(raw)
        .filter((key) => raw[key] === true)
        .toSorted((left, right) => categoryNumber(left) - categoryNumber(right))
    : [];

export const parsePlanTask = (raw: unknown): PlanTask | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  const assignments = raw['assignments'];
  return {
    id,
    title: readString(raw, 'title') ?? '',
    bucketId: readString(raw, 'bucketId') ?? '',
    orderHint: readString(raw, 'orderHint') ?? '',
    percentComplete: readNumber(raw, 'percentComplete') ?? 0,
    priority: readNumber(raw, 'priority') ?? MEDIUM,
    start: dayOf(raw['startDateTime']),
    due: dayOf(raw['dueDateTime']),
    completed: dayOf(raw['completedDateTime']),
    created: readString(raw, 'createdDateTime') ?? '',
    assigneeIds: isRecord(assignments) ? Object.keys(assignments) : [],
    labels: labelKeysOf(raw['appliedCategories']),
    createdBy: readString(isRecord(raw['createdBy']) ? raw['createdBy']['user'] : undefined, 'displayName') ?? '',
    etag: readString(raw, ETAG) ?? '',
  };
};

// Planner's order hints are strings made to be sorted character by character, which is how the
// board orders its lanes and the cards in each.
export const byOrderHint = (left: { readonly orderHint: string }, right: { readonly orderHint: string }): number => {
  if (left.orderHint < right.orderHint) return -1;
  return left.orderHint > right.orderHint ? 1 : 0;
};

const checklistOf = (raw: unknown): ReadonlyArray<ChecklistItem> => {
  if (!isRecord(raw)) return [];
  return Object.values(raw)
    .flatMap((entry) => {
      const text = readString(entry, 'title');
      return text === undefined || !isRecord(entry) ? [] : [{ text, done: entry['isChecked'] === true, orderHint: readString(entry, 'orderHint') ?? '' }];
    })
    .sort(byOrderHint)
    .map((item) => ({ text: item.text, done: item.done }));
};

// A reference is keyed by its address with the dots and slashes escaped, Graph's way of making an
// address a property name; one that will not decode is kept as it came rather than dropped, since
// a strange address is still an address. `decodeURIComponent` throws on a malformed escape, which
// is the one native thrower a pure function may catch.
const decodedAddress = (key: string): string => {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
};

const referencesOf = (raw: unknown): ReadonlyArray<Reference> => {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).map(([key, entry]) => ({ url: decodedAddress(key), alias: readString(entry, 'alias') ?? '' }));
};

export const parseTaskDetails = (raw: unknown): TaskDetails => {
  const held = isRecord(raw) ? raw : {};
  return {
    description: readString(held, 'description') ?? '',
    checklist: checklistOf(held['checklist']),
    references: referencesOf(held['references']),
    etag: readString(held, ETAG) ?? '',
  };
};

const DONE = 100;

// Planner sets a task's completion to nought, fifty or a hundred and shows a word for each.
export const progressOf = (percentComplete: number): string => {
  if (percentComplete === 0) return 'not started';
  return percentComplete === DONE ? 'done' : 'in progress';
};

// Planner's own bands over its 0-10 scale: urgent, important, medium, low.
const IMPORTANT_FROM = 2;
const MEDIUM_FROM = 5;
const LOW_FROM = 8;

export const priorityOf = (priority: number): string => {
  if (priority < IMPORTANT_FROM) return 'urgent';
  if (priority < MEDIUM_FROM) return 'important';
  return priority < LOW_FROM ? 'medium' : 'low';
};

// The card and its details each carry an etag Graph moves on any change to that resource; the two
// together say whether the page on disk is behind.
// The names a plan gives its labels, by key. A Map, because the keys come from Graph.
export type LabelNames = ReadonlyMap<string, string>;

// A label nobody named is a colour in Planner and nothing in words, so it has no entry.
export const parseLabelNames = (raw: unknown): LabelNames => {
  const described = isRecord(raw) ? raw['categoryDescriptions'] : undefined;
  if (!isRecord(described)) return new Map();
  return new Map(Object.entries(described).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
};

// A label is shown by its name or not at all: `category3` would say nothing to a reader.
export const labelsOf = (task: PlanTask, names: LabelNames): ReadonlyArray<string> =>
  task.labels.flatMap((key) => {
    const name = names.get(key);
    return name === undefined ? [] : [name];
  });

// The labels count by name, so renaming one rewrites the pages that carry it; a task that carries
// none keeps the fingerprint it always had.
export const taskFingerprint = (task: PlanTask, details: TaskDetails, labels: ReadonlyArray<string>): string =>
  labels.length === 0 ? `${task.etag} ${details.etag}` : `${task.etag} ${details.etag} ${labels.join(', ')}`;
