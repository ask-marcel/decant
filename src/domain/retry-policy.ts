import type { DriveItem } from './drive-item.ts';

// One document the source handed over and this tool could not turn into anything, kept whole so the
// next run can convert it without asking Graph for it again. The version it failed at is the item's
// own `cTag`: a document edited since is a different thing to have failed on, and starts its count
// over. Without this record a failure disappears, because the cursor moved on when it was swept and
// a delta only ever reports what changed since.
export type RetryEntry = {
  readonly item: DriveItem;
  readonly attempts: number;
  readonly reason: string;
};

export type RetryLedger = Readonly<Record<string, RetryEntry>>;

// Three runs, then the document is left alone rather than costing a call a night for good. It stays
// in the ledger so the report can keep naming it: a file given up on quietly is the thing this whole
// mechanism exists to prevent. Shared with the mailbox, whose threads are tried the same number of
// times, and with the report heading that names the number, so the three cannot drift apart.
export const MAX_CONVERSION_ATTEMPTS = 3;

export const givenUp = (entry: RetryEntry): boolean => entry.attempts >= MAX_CONVERSION_ATTEMPTS;

export const nextFailure = (known: RetryEntry | undefined, item: DriveItem, reason: string): RetryEntry => ({
  item,
  attempts: known === undefined || known.item.cTag !== item.cTag ? 1 : known.attempts + 1,
  reason,
});

// The sweep's word is the current one. Whatever it returned is being decided now, from the version
// the source holds today, so what the ledger remembers about an earlier attempt on it is stale: a
// document converted again, renamed, or deleted at the source has no older failure left to answer
// for. The cost is narrow and deliberate: renaming a document whose conversion failed drops its
// pending retry, and the rename alone does not queue a fresh one.
export const forgetSwept = (retry: RetryLedger, items: ReadonlyArray<DriveItem>): RetryLedger => {
  const swept = new Set(items.map((item) => item.id));
  return Object.fromEntries(Object.entries(retry).filter(([id]) => !swept.has(id)));
};
