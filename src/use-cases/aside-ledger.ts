import { ASIDE_LEDGER_NAME, causeOf, digestOf, parseAsideLedger, replacedNotes, serializeAsideLedger, stuckAt, stuckNotes, unstuck } from '../domain/aside-ledger.ts';
import type { AsideLedger, StuckFile } from '../domain/aside-ledger.ts';
import type { ReportEntry } from '../domain/report.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import { setAside } from './put-aside.ts';
import type { WriteDown } from './put-aside.ts';

// `timezone` is the zone the knowledge base counts its days in, which the report gives the days in.
export type AsideLedgerDeps = { readonly clock: Clock; readonly kbRoot: string; readonly logger: Logger; readonly timezone: string };

export type RetryAside = () => Promise<void>;

// The files the ledger holds that are still on disk, and why the ledger would not read, when it would
// not: then the files are only those this run let go.
export type StuckReport = { readonly files: ReadonlyArray<ReportEntry>; readonly unreadable?: string };

export type StuckFiles = () => Promise<StuckReport>;

// What a run gets from the ledger: the files it writes through, which keep the ledger in step with
// what lands on disk, where its sources write down the files they let go that would not move under the
// archive, the retry at the start of the run, and what the report of the run names.
export type AsideLedgerRun = { readonly files: Files; readonly writeDown: WriteDown; readonly retry: RetryAside; readonly stuck: StuckFiles };

const ledgerPath = (kbRoot: string): string => `${kbRoot}/${ASIDE_LEDGER_NAME}`;

// No ledger yet is an empty one. One that does not read answers with why: the disk would not read it,
// it is not JSON, or it is not a ledger.
const readLedger = async (files: Files, kbRoot: string): Promise<Result<AsideLedger, { readonly kind: string }>> => {
  const text = await files.readText(ledgerPath(kbRoot));
  if (!text.ok) return text.error.kind === 'not-found' ? ok({}) : text;
  const parsed = parseJson(text.value);
  return parsed.ok ? parseAsideLedger(parsed.value) : parsed;
};

// A ledger that will not save costs the record of the moves owed, not the run.
const writeLedger = async (files: Files, deps: AsideLedgerDeps, ledger: AsideLedger): Promise<void> => {
  const written = await files.writeText(ledgerPath(deps.kbRoot), serializeAsideLedger(ledger));
  if (!written.ok) deps.logger.warn('aside-ledger.unsaved', { cause: written.error.kind });
};

// Read as text, which serves every file. That tells the file written down from another at its path,
// though not to the byte: a text read drops a byte order mark and turns bytes that are not UTF-8 into
// one sign, so two binary files that differ only there read alike, which is rare enough to accept.
const digestAt = async (files: Files, path: string): Promise<string | undefined> => {
  const text = await files.readText(path);
  return text.ok ? digestOf(text.value) : undefined;
};

// Where a listed file stands at the start of a run: gone, still the file written down, another file
// that took its path, or one that cannot be told, because it would not read then or now.
type Standing = 'gone' | 'same' | 'other' | 'untold';

const standingOf = async (files: Files, entry: StuckFile): Promise<Standing> => {
  const held = await files.exists(entry.path);
  if (held.ok && !held.value) return 'gone';
  const now = held.ok && entry.digest !== undefined ? await digestAt(files, entry.path) : undefined;
  if (now === undefined) return 'untold';
  return now === entry.digest ? 'same' : 'other';
};

const onDisk = async <T extends { readonly path: string }>(files: Files, entries: ReadonlyArray<T>): Promise<ReadonlyArray<T>> => {
  const present: T[] = [];
  for (const entry of entries) {
    const held = await files.exists(entry.path);
    if (held.ok && held.value) present.push(entry);
  }
  return present;
};

// The ledger lists the files no source records any more that would not move under the archive, so
// the move is still owed. It is read once, on first need, and every change after is made to the copy
// in hand and then saved, one save at a time: a window converts several items at once, and two of
// them can let a file go together. A ledger that does not read is logged and kept as it is, never
// written over, since what it lists is named nowhere else. The run still keeps what it lets go in
// hand, so the report of the run names those files, and says why the ledger would not read.
export const createAsideLedger = (files: Files, deps: AsideLedgerDeps): AsideLedgerRun => {
  let held: AsideLedger = {};
  let unreadable: string | undefined;
  let reading: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();
  // The entries the retry of this run found holding another file, named once in its report.
  let replaced: ReadonlyArray<StuckFile> = [];
  const loaded = async (): Promise<void> => {
    reading ??= readLedger(files, deps.kbRoot).then((read) => {
      if (read.ok) held = read.value;
      else {
        unreadable = read.error.kind;
        deps.logger.warn('aside-ledger.unreadable', { cause: read.error.kind });
      }
    });
    await reading;
  };
  const change = async (edit: (ledger: AsideLedger) => AsideLedger): Promise<void> => {
    await loaded();
    const next = edit(held);
    held = next;
    if (unreadable !== undefined) return;
    saving = saving.then(async () => writeLedger(files, deps, next));
    await saving;
  };

  // A path a file lands at holds a new file: the file the ledger meant there is gone, and the next run
  // must not move the new one away. A path a write lands at is also kept for the whole run, in lower
  // case as Windows and macOS read it, so a file let go after another was written at its path is not
  // written down. A moved file is not: it is still its own source's file, which can let it go later
  // in the same run.
  const writtenAt = new Set<string>();
  const forget = async (path: string): Promise<void> => {
    await loaded();
    if (held[path] !== undefined) await change((ledger) => unstuck(ledger, [path]));
  };
  const written = async <T>(result: Result<T, FilesError>, path: string): Promise<Result<T, FilesError>> => {
    if (result.ok) {
      writtenAt.add(path.toLowerCase());
      await forget(path);
    }
    return result;
  };
  const moved = async <T>(result: Result<T, FilesError>, path: string): Promise<Result<T, FilesError>> => {
    if (result.ok) await forget(path);
    return result;
  };
  const through: Files = {
    ...files,
    writeText: async (path, content) => written(await files.writeText(path, content), path),
    writeBytes: async (path, bytes) => written(await files.writeBytes(path, bytes), path),
    move: async (from, to) => moved(await files.move(from, to), to),
  };

  // A file handed on that is gone already owes nothing. One still there is written down with what it
  // holds, so a later run can tell it from a file that takes its path.
  const writeDown: WriteDown = async (missed) => {
    const present = (await onDisk(files, missed)).filter((entry) => !writtenAt.has(entry.path.toLowerCase()));
    if (present.length === 0) return;
    const digests = await Promise.all(present.map(async (entry) => digestAt(files, entry.path)));
    const at = deps.clock.nowIso();
    await change((ledger) => present.reduce((carried, entry, index) => stuckAt(carried, entry.path, causeOf(entry.error), at, digests[index]), ledger));
  };

  // At the start of a run, before any source writes: each file that is still the one written down
  // goes under the archive again. One that moves, one that is gone, and another file that took the
  // path leave the ledger: a removal a run could not save, or a path that differs only in letter case,
  // must never send a live file away. One that will not move stays, with the day it first would not
  // and the latest cause, and so does one that cannot be told.
  const retry: RetryAside = async () => {
    await loaded();
    const listed = Object.values(held);
    if (listed.length === 0) return;
    const standings = await Promise.all(listed.map(async (entry) => ({ entry, standing: await standingOf(files, entry) })));
    const same = standings.filter((one) => one.standing === 'same').map((one) => one.entry);
    const aside = await setAside(
      { files, clock: deps.clock, kbRoot: deps.kbRoot },
      same.map((entry) => entry.path)
    );
    replaced = standings.filter((one) => one.standing === 'other').map((one) => one.entry);
    const settled = [...standings.filter((one) => one.standing === 'gone').map((one) => one.entry.path), ...replaced.map((entry) => entry.path)];
    const moved = aside.moved.map((move) => move.from);
    const at = deps.clock.nowIso();
    await change((ledger) =>
      aside.failed.reduce((carried, missed) => stuckAt(carried, missed.path, causeOf(missed.error), at, held[missed.path]?.digest), unstuck(ledger, [...settled, ...moved]))
    );
    deps.logger.info('aside.retried', {
      moved: moved.length,
      stuck: listed.length - settled.length - moved.length,
      replaced: replaced.length,
    });
  };

  // What the report of the run names: each file the ledger holds that is still on disk, each one the
  // retry of this run took off the list for another file at its path, and why the ledger would not
  // read, when it would not.
  const stuck: StuckFiles = async () => {
    await loaded();
    const listed = stuckNotes(await onDisk<StuckFile>(files, Object.values(held)), deps.kbRoot, deps.timezone);
    const named = [...listed, ...replacedNotes(replaced, deps.kbRoot, deps.timezone)];
    return unreadable === undefined ? { files: named } : { files: named, unreadable };
  };

  return { files: through, writeDown, retry, stuck };
};
