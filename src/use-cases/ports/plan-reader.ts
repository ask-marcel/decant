import type { Bucket, LabelNames, Plan, PlanTask, TaskDetails } from '../../domain/planner.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError } from './drive-reader.ts';

export type PlanReaderError = DriveReaderError;

export type PlanGroup = { readonly id: string; readonly name: string };

// The plans a person can read, one plan by id, and what a plan is made of: its buckets, its
// tasks, and for each task the details that travel apart from the card. The assignees are named
// by user id alone on the card, so a name is one more read; the labels by key, whose names are
// the plan's and one read a plan.
export type PlanReader = {
  readonly listPlans: (groups: ReadonlyArray<PlanGroup>) => Promise<Result<ReadonlyArray<Plan>, PlanReaderError>>;
  readonly plan: (planId: string) => Promise<Result<Plan, PlanReaderError>>;
  readonly buckets: (planId: string) => Promise<Result<ReadonlyArray<Bucket>, PlanReaderError>>;
  readonly tasks: (planId: string) => Promise<Result<ReadonlyArray<PlanTask>, PlanReaderError>>;
  readonly details: (taskId: string) => Promise<Result<TaskDetails, PlanReaderError>>;
  readonly userName: (userId: string) => Promise<Result<string, PlanReaderError>>;
  readonly labelNames: (planId: string) => Promise<Result<LabelNames, PlanReaderError>>;
};
