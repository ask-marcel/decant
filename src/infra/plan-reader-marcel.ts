import { parseBucket, parseLabelNames, parsePlan, parsePlanTask, parseTaskDetails } from '../domain/planner.ts';
import type { Bucket, Plan, PlanTask } from '../domain/planner.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { canonicalCursor } from '../domain/utilities/graph-cursor.ts';
import type { PlanGroup, PlanReader, PlanReaderError } from '../use-cases/ports/plan-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// Planner through the shared call. The plans a person can read are found two ways: the user's own
// listing, and each group's, through a command the library is asked for in
// `docs/request-group-planner-plans.md`; while the library lacks it, every group answers "unknown
// command" and costs nothing but its own plans. Graph ignores paging on the plan endpoints, so
// the tasks follow `@odata.nextLink` only for the day it starts honouring it.

const NAME_ONLY = 'displayName';

const asBucket = (entry: unknown): Bucket[] => {
  const bucket = parseBucket(entry);
  return bucket === undefined ? [] : [bucket];
};

const asPlan = (entry: unknown): Plan[] => {
  const plan = parsePlan(entry);
  return plan === undefined ? [] : [plan];
};

// A plan the user was added to is also its group's, so it can be listed twice; once is enough.
const distinct = (plans: ReadonlyArray<Plan>): ReadonlyArray<Plan> => {
  const seen = new Set<string>();
  const kept: Plan[] = [];
  for (const plan of plans) {
    if (seen.has(plan.id)) continue;
    seen.add(plan.id);
    kept.push(plan);
  }
  return kept;
};

export const createPlanReaderFromCall = (call: MarcelCall): PlanReader => {
  const tasksOf = async (planId: string): Promise<Result<ReadonlyArray<PlanTask>, PlanReaderError>> => {
    const found: PlanTask[] = [];
    const seen = new Set<string>();
    let next: { readonly name: string; readonly params: Record<string, string> } | undefined = { name: 'list-plan-tasks', params: { plannerPlanId: planId } };
    while (next !== undefined) {
      const raw = await call(next.name, next.params);
      if (!raw.ok) return raw;
      found.push(
        ...listOf(raw.value).flatMap((entry: unknown) => {
          const task = parsePlanTask(entry);
          return task === undefined ? [] : [task];
        })
      );
      const link = canonicalCursor(readString(raw.value, '@odata.nextLink'));
      next = link === undefined || seen.has(link) ? undefined : { name: 'next-page', params: { url: link } };
      if (link !== undefined) seen.add(link);
    }
    return ok(found);
  };

  const groupPlans = async (group: PlanGroup): Promise<ReadonlyArray<Plan>> => {
    const raw = await call('list-group-planner-plans', { groupId: group.id });
    return raw.ok ? listOf(raw.value).flatMap(asPlan) : [];
  };

  return {
    listPlans: async (groups) => {
      const mine = await call('list-planner-plans', {});
      if (!mine.ok) return mine;
      const theirs = await Promise.all(groups.map(groupPlans));
      return ok(distinct([...listOf(mine.value).flatMap(asPlan), ...theirs.flat()]));
    },
    plan: async (planId) => {
      const raw = await call('get-planner-plan', { plannerPlanId: planId });
      if (!raw.ok) return raw;
      const plan = parsePlan(raw.value);
      return plan === undefined ? err({ kind: 'permanent', message: `plan ${planId} answered without an id` }) : ok(plan);
    },
    buckets: async (planId) => {
      const raw = await call('list-plan-buckets', { plannerPlanId: planId });
      return raw.ok ? ok(listOf(raw.value).flatMap(asBucket)) : raw;
    },
    tasks: tasksOf,
    details: async (taskId) => {
      const raw = await call('get-planner-task-details', { plannerTaskId: taskId });
      return raw.ok ? ok(parseTaskDetails(raw.value)) : raw;
    },
    userName: async (userId) => {
      const raw = await call('get-user', { userId, select: NAME_ONLY });
      return raw.ok ? ok(readString(raw.value, NAME_ONLY) ?? userId) : raw;
    },
    // A refused read is not fatal: the plan is synced without its labels.
    labelNames: async (planId) => {
      const raw = await call('get-planner-plan-details', { plannerPlanId: planId });
      return raw.ok ? ok(parseLabelNames(raw.value)) : raw;
    },
  };
};
