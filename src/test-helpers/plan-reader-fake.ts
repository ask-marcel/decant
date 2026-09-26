import type { Bucket, LabelNames, Plan, PlanTask, TaskDetails } from '../domain/planner.ts';
import { err, ok } from '../domain/result.ts';
import type { PlanReader, PlanReaderError } from '../use-cases/ports/plan-reader.ts';

export type PlanReaderSeed = {
  // The plans the user's own listing answers, and those of each group by group id.
  readonly plans?: ReadonlyArray<Plan>;
  readonly groupPlans?: Readonly<Record<string, ReadonlyArray<Plan>>>;
  // Buckets and tasks keyed by plan id; details keyed by task id; names keyed by user id.
  readonly buckets?: Readonly<Record<string, ReadonlyArray<Bucket>>>;
  readonly tasks?: Readonly<Record<string, ReadonlyArray<PlanTask>>>;
  readonly details?: Readonly<Record<string, TaskDetails>>;
  readonly names?: Readonly<Record<string, string>>;
  // The names each plan gives its labels, by plan id.
  readonly labelNames?: Readonly<Record<string, LabelNames>>;
  readonly failPlans?: PlanReaderError;
  readonly failBuckets?: PlanReaderError;
  readonly failTasks?: PlanReaderError;
  readonly failDetailsOf?: ReadonlyArray<string>;
  readonly failNamesOf?: ReadonlyArray<string>;
  readonly failLabelNames?: PlanReaderError;
};

export type PlanReaderFake = PlanReader & { readonly calls: Array<string> };

const BUSY: PlanReaderError = { kind: 'transient', message: 'Graph is busy' };

export const createPlanReaderFake = (seed: PlanReaderSeed = {}): PlanReaderFake => {
  const calls: string[] = [];
  const known = (): ReadonlyArray<Plan> => [...(seed.plans ?? []), ...Object.values(seed.groupPlans ?? {}).flat()];
  return {
    calls,
    listPlans: async (groups) => {
      calls.push(`plans:${groups.map((group) => group.id).join(',')}`);
      if (seed.failPlans !== undefined) return err(seed.failPlans);
      return ok([...(seed.plans ?? []), ...groups.flatMap((group) => seed.groupPlans?.[group.id] ?? [])]);
    },
    plan: async (planId) => {
      calls.push(`plan:${planId}`);
      const found = known().find((plan) => plan.id === planId);
      return found === undefined ? err({ kind: 'permanent', status: 404, message: 'The requested item is not found.' }) : ok(found);
    },
    buckets: async (planId) => {
      calls.push(`buckets:${planId}`);
      return seed.failBuckets === undefined ? ok(seed.buckets?.[planId] ?? []) : err(seed.failBuckets);
    },
    tasks: async (planId) => {
      calls.push(`tasks:${planId}`);
      return seed.failTasks === undefined ? ok(seed.tasks?.[planId] ?? []) : err(seed.failTasks);
    },
    details: async (taskId) => {
      calls.push(`details:${taskId}`);
      if ((seed.failDetailsOf ?? []).includes(taskId)) return err(BUSY);
      return ok(seed.details?.[taskId] ?? { description: '', checklist: [], references: [], etag: '' });
    },
    userName: async (userId) => {
      calls.push(`name:${userId}`);
      if ((seed.failNamesOf ?? []).includes(userId)) return err({ kind: 'permanent', status: 404, message: 'Resource does not exist' });
      const name = seed.names?.[userId];
      return name === undefined ? err({ kind: 'permanent', status: 404, message: 'Resource does not exist' }) : ok(name);
    },
    labelNames: async (planId) => {
      calls.push(`labels:${planId}`);
      return seed.failLabelNames === undefined ? ok(seed.labelNames?.[planId] ?? new Map()) : err(seed.failLabelNames);
    },
  };
};
