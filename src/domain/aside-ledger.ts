import type { ReportEntry } from './report.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { compareText } from './utilities/compare-text.ts';
import { dayIn } from './zoned-day.ts';

// A file that would not move under the archive, a file held open on Windows most often. The source
// that put it aside has forgotten it, so it stays where it was with nothing to name it but this, and
// the move is still owed. `since` is when it first would not move.
export type StuckFile = { readonly path: string; readonly cause: string; readonly since: string };

// Keyed by path, the one thing that names such a file.
export type AsideLedger = Readonly<Record<string, StuckFile>>;

export const ASIDE_LEDGER_NAME = '.sync-aside.json';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntry = (raw: unknown): raw is { readonly cause: string; readonly since: string } => isRecord(raw) && typeof raw['cause'] === 'string' && typeof raw['since'] === 'string';

// Whole or not at all: no source records these files any more, so a ledger read in part would let the
// rest go for good. The caller keeps one that does not read as it is.
export const parseAsideLedger = (raw: unknown): Result<AsideLedger, string> => {
  if (!isRecord(raw)) return err('not a ledger');
  const entries = Object.entries(raw);
  const stuck = entries.flatMap(([path, entry]) => (isEntry(entry) ? [{ path, cause: entry.cause, since: entry.since }] : []));
  return stuck.length === entries.length ? ok(Object.fromEntries(stuck.map((entry) => [entry.path, entry]))) : err('an entry is not one');
};

// What the report names in place of the files when the ledger does not read.
export const unreadableNote = (cause: string): ReportEntry => ({
  path: ASIDE_LEDGER_NAME,
  reason: `could not be read (${cause}): no run moves the files it lists, or adds to it, until it is repaired or deleted`,
});

// In the order of the paths, so the file changes only when the files in it do.
export const serializeAsideLedger = (ledger: AsideLedger): string => {
  const sorted = Object.values(ledger).sort((left, right) => compareText(left.path, right.path));
  return `${JSON.stringify(Object.fromEntries(sorted.map((entry) => [entry.path, { cause: entry.cause, since: entry.since }])), undefined, 2)}\n`;
};

// Why a move failed: the kind of failure, and the system code when the message starts with one
// (EBUSY, EPERM). The rest of the message names both paths, the day of the run among them, so kept
// whole it would change on each day a file stays stuck, and the ledger and the report with it.
const CODE = /^E[A-Z0-9]+(?=:|$)/;

export const causeOf = (failure: { readonly kind: string; readonly message: string }): string => {
  const code = CODE.exec(failure.message)?.[0];
  return code === undefined ? failure.kind : `${failure.kind}: ${code}`;
};

// A file that would not move again keeps the day it first would not, and takes the latest cause.
export const stuckAt = (ledger: AsideLedger, path: string, cause: string, at: string): AsideLedger => ({ ...ledger, [path]: { path, cause, since: ledger[path]?.since ?? at } });

export const unstuck = (ledger: AsideLedger, paths: ReadonlyArray<string>): AsideLedger => Object.fromEntries(Object.entries(ledger).filter(([path]) => !paths.includes(path)));

// For the report of the run: each file as the knowledge base names it, with why it would not move
// and since when, the day told in the zone the knowledge base counts its days in.
export const stuckNotes = (stuck: ReadonlyArray<StuckFile>, kbRoot: string, zone: string): ReadonlyArray<ReportEntry> =>
  stuck.map((entry) => ({
    path: entry.path.startsWith(`${kbRoot}/`) ? entry.path.slice(kbRoot.length + 1) : entry.path,
    reason: `${entry.cause} (since ${dayIn(entry.since, zone)})`,
  }));
