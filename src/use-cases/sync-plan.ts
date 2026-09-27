import { archivePath } from '../domain/output-paths.ts';
import { renderPlanBoard, renderPlanTaskDocument } from '../domain/plan-document.ts';
import type { BoardRow } from '../domain/plan-document.ts';
import { PLAN_STATE_VERSION, emptyPlanState, goneTasks, parsePlanState, planRootName, planTaskFiles, serializePlanState, withTask, withoutTask } from '../domain/plan-state.ts';
import type { PlanState, PlannedTask, TaskRecord } from '../domain/plan-state.ts';
import { byOrderHint, labelsOf, taskFingerprint } from '../domain/planner.ts';
import type { Bucket, LabelNames, Plan, PlanTask, TaskDetails } from '../domain/planner.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { PlanReader } from './ports/plan-reader.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const PLAN_STATE_FILE = '.sync-state.json';

export const BOARD_FILE = '_board.md';

export type SyncPlanDeps = {
  readonly reader: PlanReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncPlanInput = { readonly plan: Plan; readonly dryRun: boolean; readonly concurrency: number };

export type SyncPlan = (input: SyncPlanInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

type Roots = { readonly root: string; readonly archive: string };

const rootsOf = (deps: SyncPlanDeps, plan: Plan): Roots => ({ root: `${deps.kbRoot}/${planRootName(plan.title)}`, archive: `${deps.kbRoot}/_archive/${planRootName(plan.title)}` });

// No state file is the first run; one that will not parse, as JSON or as a state, is started over
// with a warning. The plan travels in from the run, so a renamed plan is recorded under its name.
const loadState = async (deps: SyncPlanDeps, roots: Roots, plan: Plan): Promise<PlanState> => {
  const text = await deps.files.readText(`${roots.root}/${PLAN_STATE_FILE}`);
  if (!text.ok) return emptyPlanState(plan);
  const parsed = parseJson(text.value);
  const state = parsed.ok ? parsePlanState(parsed.value) : parsed;
  if (state.ok) return { ...state.value, plan, source: { kind: 'plan', id: plan.id, name: plan.title } };
  deps.logger.warn('plan-state.unreadable', { plan: plan.id, cause: state.error.message });
  return emptyPlanState(plan);
};

// A task read whole: its card and its details. The details failing costs the task and not the run.
type Read =
  { readonly task: PlanTask; readonly details: TaskDetails; readonly failed?: undefined } | { readonly task: PlanTask; readonly details?: undefined; readonly failed: string };

const readOne = async (deps: SyncPlanDeps, task: PlanTask): Promise<Read> => {
  const details = await deps.reader.details(task.id);
  return details.ok ? { task, details: details.value } : { task, failed: details.error.message };
};

const inWindows = async <T, U>(items: ReadonlyArray<T>, size: number, each: (item: T) => Promise<U>): Promise<ReadonlyArray<U>> => {
  const done: U[] = [];
  for (let at = 0; at < items.length; at += size) done.push(...(await Promise.all(items.slice(at, at + size).map(each))));
  return done;
};

// The names behind the assignee ids, each asked once a run; one that cannot be read is shown by
// its id, which is still true, rather than dropped.
const namesOf = async (deps: SyncPlanDeps, tasks: ReadonlyArray<PlanTask>, concurrency: number): Promise<ReadonlyMap<string, string>> => {
  const ids = [...new Set(tasks.flatMap((task) => task.assigneeIds))];
  const named = await inWindows(ids, concurrency, async (id) => {
    const name = await deps.reader.userName(id);
    if (name.ok) return [id, name.value] as const;
    deps.logger.warn('assignee.unnamed', { user: id, cause: name.error.kind });
    return [id, id] as const;
  });
  return new Map(named);
};

const assigneesOf = (task: PlanTask, names: ReadonlyMap<string, string>): ReadonlyArray<string> => task.assigneeIds.map((id) => names.get(id) ?? id);

// The names a plan gives its labels, read once a run. A plan whose details cannot be read has its
// labels left out, which is what a page said before they could be named, and the log says why.
const labelNamesOf = async (deps: SyncPlanDeps, plan: Plan): Promise<LabelNames> => {
  const named = await deps.reader.labelNames(plan.id);
  if (named.ok) return named.value;
  deps.logger.warn('labels.unnamed', { plan: plan.id, cause: named.error.kind });
  return new Map();
};

// Who a task is assigned to and what its labels are called, both looked up apart from the card.
type Names = { readonly people: ReadonlyMap<string, string>; readonly labels: LabelNames };

type Done = { readonly apply: (state: PlanState) => PlanState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const moveAside = async (deps: SyncPlanDeps, roots: Roots, output: string, what: string): Promise<void> => {
  const moved = await deps.files.move(output, archivePath(roots.archive, roots.root, output));
  if (!moved.ok) deps.logger.warn(`${what}.failed`, { path: output, cause: moved.error.kind });
};

type Writing = { readonly read: Read; readonly planned: PlannedTask };

const writeOne = async (deps: SyncPlanDeps, input: SyncPlanInput, roots: Roots, state: PlanState, names: Names, entry: Writing): Promise<Done> => {
  const { read, planned } = entry;
  if (read.details === undefined) return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: read.task.title, reason: read.failed }] } };
  const labels = labelsOf(read.task, names.labels);
  const page = renderPlanTaskDocument({
    task: read.task,
    details: read.details,
    plan: input.plan,
    bucket: planned.bucket,
    labels,
    assignees: assigneesOf(read.task, names.people),
    syncedAt: deps.clock.nowIso(),
  });
  const written = await deps.files.writeText(planned.file, page);
  if (!written.ok) {
    deps.logger.warn('task.failed', { task: read.task.id, cause: written.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: read.task.title, reason: written.error.message }] } };
  }
  const before = state.tasks[read.task.id];
  if (before !== undefined && before.file !== planned.file) await moveAside(deps, roots, before.file, 'supersede');
  const record: TaskRecord = { file: planned.file, fingerprint: taskFingerprint(read.task, read.details, labels), title: read.task.title };
  return { apply: (carried) => withTask(carried, read.task.id, record), counted: { converted: 1 }, notes: {} };
};

const archiveGone = async (deps: SyncPlanDeps, roots: Roots, gone: { readonly id: string; readonly record: TaskRecord }): Promise<Done> => {
  await moveAside(deps, roots, gone.record.file, 'archive');
  return { apply: (carried) => withoutTask(carried, gone.id), counted: { archived: 1 }, notes: { archived: [{ path: gone.record.title, reason: 'no longer in the plan' }] } };
};

const counted = (summary: RunSummary, results: ReadonlyArray<Done>): RunSummary =>
  results.reduce(
    (carried, done) => ({
      ...carried,
      converted: carried.converted + (done.counted.converted ?? 0),
      archived: carried.archived + (done.counted.archived ?? 0),
      failed: carried.failed + (done.counted.failed ?? 0),
    }),
    summary
  );

const noted = (notes: RunNotes, results: ReadonlyArray<Done>): RunNotes => ({
  ...notes,
  failed: [...notes.failed, ...results.flatMap((done) => done.notes.failed ?? [])],
  archived: [...notes.archived, ...results.flatMap((done) => done.notes.archived ?? [])],
});

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: PlanState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

const save = async (deps: SyncPlanDeps, roots: Roots, state: PlanState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${roots.root}/${PLAN_STATE_FILE}`, serializePlanState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

// A task is owed when its details could not be read (so it is reported), when the card or the
// details moved, or when its page belongs somewhere else now, which a bucket renamed does without
// touching the card.
const owed = (state: PlanState, entries: ReadonlyArray<Writing>, labels: LabelNames): ReadonlyArray<Writing> =>
  entries.filter(({ read, planned }) => {
    const record = state.tasks[read.task.id];
    return (
      read.details === undefined ||
      record === undefined ||
      record.fingerprint !== taskFingerprint(read.task, read.details, labelsOf(read.task, labels)) ||
      record.file !== planned.file
    );
  });

const writePages = async (
  deps: SyncPlanDeps,
  input: SyncPlanInput,
  roots: Roots,
  carried: Progressing,
  work: ReadonlyArray<Writing>,
  names: Names
): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  for (let at = 0; at < work.length; at += input.concurrency) {
    const window = work.slice(at, at + input.concurrency);
    const results = await Promise.all(window.map((entry) => writeOne(deps, input, roots, progressing.state, names, entry)));
    for (const entry of window) deps.progress.step(entry.read.task.title);
    progressing = fold(progressing, results);
    const saved = await save(deps, roots, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

// The board is drawn from the whole plan in the board's own order, lanes then cards, and written
// again whenever any page was owed or put aside, and on the first run.
const writeBoard = async (deps: SyncPlanDeps, input: SyncPlanInput, roots: Roots, entries: ReadonlyArray<Writing>, buckets: ReadonlyArray<Bucket>, names: Names): Promise<void> => {
  const rank = new Map([...buckets].sort(byOrderHint).map((bucket, index) => [bucket.id, index] as const));
  const rows: ReadonlyArray<BoardRow> = [...entries]
    .sort(
      (left, right) =>
        (rank.get(left.read.task.bucketId) ?? buckets.length) - (rank.get(right.read.task.bucketId) ?? buckets.length) || byOrderHint(left.read.task, right.read.task)
    )
    .map(({ read, planned }) => ({
      bucket: planned.bucket,
      task: read.task,
      labels: labelsOf(read.task, names.labels),
      assignees: assigneesOf(read.task, names.people),
      link: planned.file.slice(roots.root.length + 1),
    }));
  const written = await deps.files.writeText(`${roots.root}/${BOARD_FILE}`, renderPlanBoard({ plan: input.plan, rows, syncedAt: deps.clock.nowIso() }));
  if (!written.ok) deps.logger.warn('board.failed', { cause: written.error.kind });
};

type Listed = { readonly buckets: ReadonlyArray<Bucket>; readonly tasks: ReadonlyArray<PlanTask> };

const listed = async (deps: SyncPlanDeps, plan: Plan): Promise<Result<Listed, StepError>> => {
  const buckets = await deps.reader.buckets(plan.id);
  if (!buckets.ok) return failed('listBuckets', buckets.error.kind, buckets.error.message);
  const tasks = await deps.reader.tasks(plan.id);
  if (!tasks.ok) return failed('listTasks', tasks.error.kind, tasks.error.message);
  deps.logger.info('plan.listed', { plan: plan.id, buckets: buckets.value.length, tasks: tasks.value.length });
  return ok({ buckets: buckets.value, tasks: tasks.value });
};

const finish = async (deps: SyncPlanDeps, input: SyncPlanInput, roots: Roots, done: Progressing): Promise<Result<SourceRun, StepError>> => {
  const saved = await save(deps, roots, done.state);
  if (!saved.ok) return saved;
  await writeReport(deps, input, roots.root, input.plan.title, done.summary, done.notes);
  return ok({ id: input.plan.id, source: input.plan.title, summary: done.summary, notes: done.notes });
};

export const createSyncPlan =
  (deps: SyncPlanDeps): SyncPlan =>
  async (input) => {
    const roots = rootsOf(deps, input.plan);
    const state: PlanState = { ...(await loadState(deps, roots, input.plan)), version: PLAN_STATE_VERSION };
    const plan = await listed(deps, input.plan);
    if (!plan.ok) return plan;
    const labels = await labelNamesOf(deps, input.plan);
    // Every task is placed, so the board can link each page and a bucket renamed is noticed.
    const placed = planTaskFiles(roots.root, plan.value.tasks, plan.value.buckets, state);
    const entries = await inWindows(placed, input.concurrency, async (planned): Promise<Writing> => ({ read: await readOne(deps, planned.task), planned }));
    const work = owed(state, entries, labels);
    if (input.dryRun)
      return ok({ id: input.plan.id, source: input.plan.title, summary: { ...EMPTY, queued: work.filter((entry) => entry.read.details !== undefined).length }, notes: NO_NOTES });
    const names: Names = { people: await namesOf(deps, plan.value.tasks, input.concurrency), labels };
    deps.progress.start(work.length, input.plan.title);
    const written = await writePages(deps, input, roots, { summary: EMPTY, notes: NO_NOTES, state }, work, names);
    deps.progress.done();
    if (!written.ok) return written;
    const gone = goneTasks(state, plan.value.tasks);
    const done = fold(written.value, await Promise.all(gone.map((entry) => archiveGone(deps, roots, entry))));
    if (work.length + gone.length > 0 || state.lastRun.length === 0) await writeBoard(deps, input, roots, entries, plan.value.buckets, names);
    return finish(deps, input, roots, done);
  };
