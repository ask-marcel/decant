import type { ReportEntry } from './report.ts';
import { MAX_CONVERSION_ATTEMPTS } from './retry-policy.ts';

// One item a sync could not finish: how many runs have tried it, the version of the item those runs
// tried, what the report calls it, and why the last try failed. A version the source has moved past
// is a different thing to fail on, so its count starts over. The libraries and the inboxes keep
// ledgers of their own, shaped by what they hold; this one serves the sources whose items are whole
// documents written from one read.
export type Attempt = { readonly attempts: number; readonly version: string; readonly name: string; readonly reason: string };

// Absent when nothing failed, so a state that never failed reads as it did before the ledger.
export type Attempts = Readonly<Record<string, Attempt>>;

export const nextAttempt = (known: Attempt | undefined, version: string, name: string, reason: string): Attempt => ({
  attempts: known === undefined || known.version !== version ? 1 : known.attempts + 1,
  version,
  name,
  reason,
});

const outOfTries = (attempt: Attempt): boolean => attempt.attempts >= MAX_CONVERSION_ATTEMPTS;

// Out of tries at this version: left alone until the source changes the item.
export const isGivenUp = (attempt: Attempt | undefined, version: string): boolean => attempt !== undefined && attempt.version === version && outOfTries(attempt);

export const recordAttempt = (ledger: Attempts | undefined, id: string, attempt: Attempt): Attempts => ({ ...ledger, [id]: attempt });

export const clearAttempt = (ledger: Attempts | undefined, id: string): Attempts | undefined => {
  const kept = Object.entries(ledger ?? {}).filter(([key]) => key !== id);
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

// The ledger as it was when nothing in it goes, so a run that forgot nothing changes nothing.
const keptWhere = (ledger: Attempts | undefined, keep: (id: string) => boolean): Attempts | undefined => {
  const kept = Object.entries(ledger ?? {}).filter(([id]) => keep(id));
  if (kept.length === Object.keys(ledger ?? {}).length) return ledger;
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

// An item the source no longer holds has nothing left to try. Kept, one given up on would be named in
// every report for good, as failed on an item nobody can fix. A source read whole keeps the entries of
// what it holds; one read as changes forgets what the changes say is gone.
export const heldAttempts = (ledger: Attempts | undefined, held: ReadonlySet<string>): Attempts | undefined => keptWhere(ledger, (id) => held.has(id));

export const forgetAttempts = (ledger: Attempts | undefined, gone: ReadonlyArray<string>): Attempts | undefined => keptWhere(ledger, (id) => !gone.includes(id));

const noteOf = (attempt: Attempt): ReportEntry => ({ path: attempt.name, reason: attempt.reason });

// Every item out of tries, for the report of the whole run, which names them on every run.
export const givenUpNotes = (ledger: Attempts | undefined): ReadonlyArray<ReportEntry> =>
  Object.values(ledger ?? {})
    .filter(outOfTries)
    .map(noteOf);

// The items this run gave up on, for the source's own report, which names an item once.
export const gaveUpNotes = (before: Attempts | undefined, after: Attempts | undefined): ReadonlyArray<ReportEntry> =>
  Object.entries(after ?? {})
    .filter(([id, attempt]) => outOfTries(attempt) && !isGivenUp(before?.[id], attempt.version))
    .map(([, attempt]) => noteOf(attempt));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const attemptOf = (raw: unknown): Attempt | undefined => {
  if (!isRecord(raw)) return undefined;
  const { attempts, version, name, reason } = raw;
  return typeof attempts === 'number' && typeof version === 'string' && typeof name === 'string' && typeof reason === 'string' ? { attempts, version, name, reason } : undefined;
};

// Read back trusting only what is whole: an entry missing a field is dropped, and the item is tried
// again as though it had never failed.
export const parseAttempts = (raw: unknown): Attempts | undefined => {
  if (!isRecord(raw)) return undefined;
  const kept = Object.entries(raw).flatMap(([id, entry]) => {
    const attempt = attemptOf(entry);
    return attempt === undefined ? [] : [[id, attempt] as const];
  });
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

// Something read on every run whatever the ledger says, a profile or a section listing, has no
// version to tell an edit by, so its runs are counted under this one.
export const UNREAD = 'unread';

export type Unread = { readonly id: string; readonly name: string; readonly reason: string };

// `tried` counts the reads this run made and lost, the one that gives up included, as a library
// counts the conversion that gives up; `failed` names those still worth another run.
export type TriedReads = { readonly retry: Attempts | undefined; readonly tried: number; readonly failed: ReadonlyArray<ReportEntry> };

// What a run that reads these things whole does with the ledger: what it read again leaves the
// ledger, and what it could not read is counted. After three runs an item is given up on, and its
// count stays where it is, so the state does not change from run to run.
export const triedReads = (retry: Attempts | undefined, readAgain: ReadonlyArray<string>, unread: ReadonlyArray<Unread>): TriedReads => {
  const cleared = readAgain.filter((id) => retry?.[id]?.version === UNREAD).reduce(clearAttempt, retry);
  const fresh = unread
    .filter((entry) => !isGivenUp(cleared?.[entry.id], UNREAD))
    .map((entry) => ({ entry, attempt: nextAttempt(cleared?.[entry.id], UNREAD, entry.name, entry.reason) }));
  return {
    retry: fresh.reduce<Attempts | undefined>((ledger, { entry, attempt }) => recordAttempt(ledger, entry.id, attempt), cleared),
    tried: fresh.length,
    failed: fresh.filter(({ attempt }) => !isGivenUp(attempt, UNREAD)).map(({ entry }) => ({ path: entry.name, reason: entry.reason })),
  };
};
