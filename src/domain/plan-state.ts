import { CATEGORY_FOLDER } from './kb-category.ts';
import { disambiguateSegment, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import type { Bucket, Plan, PlanTask } from './planner.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export const PLAN_STATE_VERSION = 1;

// A plan's own folder, under the heading the picker offered it under.
export const planRootName = (title: string): SafeRelPath => safeRelPath([CATEGORY_FOLDER.plan, title]);

// One task already written: the file, the fingerprint of the card and its details it was made
// from, and the title left to call it by once the plan no longer has it.
export type TaskRecord = { readonly file: string; readonly fingerprint: string; readonly title: string };

// The plan travels whole in its own state, so `update` can reach it without listing every plan
// again, the way a notebook does.
export type PlanState = {
  readonly version: typeof PLAN_STATE_VERSION;
  readonly source: { readonly kind: 'plan'; readonly id: string; readonly name: string };
  readonly plan: Plan;
  readonly lastRun: string;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
};

export type PlanStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyPlanState = (plan: Plan): PlanState => ({
  version: PLAN_STATE_VERSION,
  source: { kind: 'plan', id: plan.id, name: plan.title },
  plan,
  lastRun: '',
  tasks: {},
});

export const serializePlanState = (state: PlanState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const recordOf = (entry: Record<string, unknown>): TaskRecord => ({
  file: readString(entry, 'file') ?? '',
  fingerprint: readString(entry, 'fingerprint') ?? '',
  title: readString(entry, 'title') ?? '',
});

const tasksOf = (raw: unknown): Readonly<Record<string, TaskRecord>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, recordOf(entry)] as const] : [])));
};

// The plan as it was recorded, falling back to the source line for what the record leaves out.
const planOf = (raw: Record<string, unknown>, source: Record<string, unknown>): Plan => {
  const held = isRecord(raw['plan']) ? raw['plan'] : {};
  const id = readString(held, 'id') ?? readString(source, 'id') ?? '';
  return { id, title: readString(held, 'title') ?? readString(source, 'name') ?? id, groupId: readString(held, 'groupId') ?? '' };
};

export const parsePlanState = (raw: unknown): Result<PlanState, PlanStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'plan') return err({ kind: 'malformed', message: 'state is not a plan' });
  if (raw['version'] !== PLAN_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${PLAN_STATE_VERSION}` });
  const plan = planOf(raw, source);
  return ok({
    version: PLAN_STATE_VERSION,
    source: { kind: 'plan', id: plan.id, name: plan.title },
    plan,
    lastRun: readString(raw, 'lastRun') ?? '',
    tasks: tasksOf(raw['tasks']),
  });
};

export const withTask = (state: PlanState, id: string, record: TaskRecord): PlanState => ({ ...state, tasks: { ...state.tasks, [id]: record } });

export const withoutTask = (state: PlanState, id: string): PlanState => ({ ...state, tasks: Object.fromEntries(Object.entries(state.tasks).filter(([held]) => held !== id)) });

// Whatever the ledger holds that the plan no longer lists, which is put aside.
export const goneTasks = (state: PlanState, present: ReadonlyArray<PlanTask>): ReadonlyArray<{ readonly id: string; readonly record: TaskRecord }> => {
  const listed = new Set(present.map((task) => task.id));
  return Object.entries(state.tasks).flatMap(([id, record]) => (listed.has(id) ? [] : [{ id, record }]));
};

export type PlannedTask = { readonly task: PlanTask; readonly bucket: string; readonly file: string };

const MARKDOWN = '.md';

// A task whose bucket the plan no longer lists, which Planner does not normally leave behind but
// a listing read a moment apart from the buckets can.
const NO_BUCKET = '_no bucket';

// Where each task about to be written goes: under its bucket, named by its title. Two tasks can
// share a title in one bucket; the second takes a suffix from its own id. A file another task's
// record holds is taken even when that task is placed in this run too: its old page is put aside
// only once its own write lands, which can come after a namesake's write to the same path. A task's
// own page never stands in its way.
export const planTaskFiles = (root: string, tasks: ReadonlyArray<PlanTask>, buckets: ReadonlyArray<Bucket>, state: PlanState): ReadonlyArray<PlannedTask> => {
  const names = new Map(buckets.map((bucket) => [bucket.id, bucket.name] as const));
  const taken = new Set(Object.values(state.tasks).map((record) => record.file));
  const planned: PlannedTask[] = [];
  for (const task of tasks) {
    const bucket = names.get(task.bucketId) ?? '';
    const folder = `${root}/${safeSegment(bucket.length === 0 ? NO_BUCKET : bucket)}`;
    const name = `${safeSegment(task.title)}${MARKDOWN}`;
    const plain = `${folder}/${name}`;
    const file = taken.has(plain) && plain !== state.tasks[task.id]?.file ? `${folder}/${disambiguateSegment(name, task.id)}` : plain;
    taken.add(file);
    planned.push({ task, bucket, file });
  }
  return planned;
};
