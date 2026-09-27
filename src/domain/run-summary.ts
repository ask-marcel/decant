// What one source's run did, counted: the numbers a summary line prints and a report adds up.
export type RunSummary = {
  readonly converted: number;
  readonly moved: number;
  readonly archived: number;
  readonly skipped: number;
  readonly failed: number;
  readonly queued: number;
};
