import type { ReportEntry } from './report.ts';
import { compareText } from './utilities/compare-text.ts';

// A file that would not move under the archive, a file held open on Windows most often. The source
// that put it aside has forgotten it, so it stays where it was with nothing to name it but this, and
// the move is still owed. `since` is when it first would not move.
export type StuckFile = { readonly path: string; readonly cause: string; readonly since: string };

// Keyed by path, the one thing that names such a file.
export type AsideLedger = Readonly<Record<string, StuckFile>>;

export const ASIDE_LEDGER_NAME = '.sync-aside.json';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const entryOf = (path: string, raw: unknown): ReadonlyArray<readonly [string, StuckFile]> =>
  isRecord(raw) && typeof raw['cause'] === 'string' && typeof raw['since'] === 'string' ? [[path, { path, cause: raw['cause'], since: raw['since'] }]] : [];

// A ledger that cannot be read is an empty one: it lists moves a run still owes, and the next move
// that fails writes its file down again.
export const parseAsideLedger = (raw: unknown): AsideLedger => (isRecord(raw) ? Object.fromEntries(Object.entries(raw).flatMap(([path, entry]) => entryOf(path, entry))) : {});

// In the order of the paths, so the file changes only when the files in it do.
export const serializeAsideLedger = (ledger: AsideLedger): string => {
  const sorted = Object.values(ledger).sort((left, right) => compareText(left.path, right.path));
  return `${JSON.stringify(Object.fromEntries(sorted.map((entry) => [entry.path, { cause: entry.cause, since: entry.since }])), undefined, 2)}\n`;
};

// A file that would not move again keeps the day it first would not, and takes the latest cause.
export const stuckAt = (ledger: AsideLedger, path: string, cause: string, at: string): AsideLedger => ({ ...ledger, [path]: { path, cause, since: ledger[path]?.since ?? at } });

export const unstuck = (ledger: AsideLedger, paths: ReadonlyArray<string>): AsideLedger => Object.fromEntries(Object.entries(ledger).filter(([path]) => !paths.includes(path)));

const DAY_LENGTH = 10;

// For the report of the run: each file as the knowledge base names it, with why it would not move
// and since when.
export const stuckNotes = (stuck: ReadonlyArray<StuckFile>, kbRoot: string): ReadonlyArray<ReportEntry> =>
  stuck.map((entry) => ({
    path: entry.path.startsWith(`${kbRoot}/`) ? entry.path.slice(kbRoot.length + 1) : entry.path,
    reason: `${entry.cause} (since ${entry.since.slice(0, DAY_LENGTH)})`,
  }));
