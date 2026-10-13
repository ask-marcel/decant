import type { Result } from '../domain/result.ts';
import type { SourceRun } from '../use-cases/sync-site.ts';

// What a script that runs decant reads back. A backup, or a commit of the knowledge base, goes on
// after a run that finished, with failed items or without, and stops after one that did not.
export const EXIT_DONE = 0;
export const EXIT_STOPPED = 1;
export const EXIT_BAD_OPTIONS = 2;
export const EXIT_DONE_WITH_FAILURES = 3;

export const exitCodeOf = (outcome: Result<ReadonlyArray<SourceRun>, unknown>): number => {
  if (!outcome.ok) return EXIT_STOPPED;
  return outcome.value.some((source) => source.summary.failed > 0) ? EXIT_DONE_WITH_FAILURES : EXIT_DONE;
};
