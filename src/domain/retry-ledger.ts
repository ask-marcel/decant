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
