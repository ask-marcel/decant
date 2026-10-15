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

const sameVersion = (entry: RetryEntry, item: DriveItem): boolean => item.kind !== 'deleted' && item.cTag === entry.item.cTag && item.path === entry.item.path;

// The sweep's word is the current one for what it changed: a document it returned edited, renamed or
// deleted is decided now, from the version the source holds today, and has no older failure left to
// answer for. One it returned at the version that failed keeps its entry: a whole read lists every
// document, changed or not, and a document that failed, or landed without a part of it, is still
// owed what the entry stands for, its tries counted on.
export const forgetSwept = (retry: RetryLedger, items: ReadonlyArray<DriveItem>): RetryLedger => {
  const swept = new Map(items.map((item) => [item.id, item]));
  return Object.fromEntries(
    Object.entries(retry).filter(([id, entry]) => {
      const item = swept.get(id);
      return item === undefined || sameVersion(entry, item);
    })
  );
};
