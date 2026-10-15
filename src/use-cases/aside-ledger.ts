import { ASIDE_LEDGER_NAME, parseAsideLedger, serializeAsideLedger, stuckAt, stuckNotes, unreadableNote, unstuck } from '../domain/aside-ledger.ts';
import type { AsideLedger, StuckFile } from '../domain/aside-ledger.ts';
import type { ReportEntry } from '../domain/report.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import { setAside } from './put-aside.ts';
import type { NotPutAside, WriteDown } from './put-aside.ts';

// `timezone` is the zone the knowledge base counts its days in, which the report gives the days in.
export type AsideLedgerDeps = { readonly clock: Clock; readonly kbRoot: string; readonly logger: Logger; readonly timezone: string };

export type RetryAside = () => Promise<void>;

export type StuckFiles = () => Promise<ReadonlyArray<ReportEntry>>;

// What a run gets from the ledger: the files it writes through, which keep the ledger in step with
// what lands on disk, where its sources write down the files they let go that would not move under the
// archive, the retry at the start of the run, and what the report of the run names.
export type AsideLedgerRun = { readonly files: Files; readonly writeDown: WriteDown; readonly retry: RetryAside; readonly stuck: StuckFiles };

const ledgerPath = (kbRoot: string): string => `${kbRoot}/${ASIDE_LEDGER_NAME}`;

// No ledger yet is an empty one. One that does not read answers with why.
const readLedger = async (files: Files, kbRoot: string): Promise<Result<AsideLedger, string>> => {
  const text = await files.readText(ledgerPath(kbRoot));
  if (!text.ok) return text.error.kind === 'not-found' ? ok({}) : err(text.error.kind);
  const parsed = parseJson(text.value);
  return parsed.ok ? parseAsideLedger(parsed.value) : err(parsed.error.kind);
};

// A ledger that will not save costs the record of the moves owed, not the run.
const writeLedger = async (files: Files, deps: AsideLedgerDeps, ledger: AsideLedger): Promise<void> => {
  const written = await files.writeText(ledgerPath(deps.kbRoot), serializeAsideLedger(ledger));
  if (!written.ok) deps.logger.warn('aside-ledger.unsaved', { cause: written.error.kind });
};

const causeOf = (missed: NotPutAside): string => `${missed.error.kind}: ${missed.error.message}`;

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
// written over, since what it lists is named nowhere else; the report of the run says so.
export const createAsideLedger = (files: Files, deps: AsideLedgerDeps): AsideLedgerRun => {
  let held: AsideLedger = {};
  let unreadable: string | undefined;
  let reading: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();
  const loaded = async (): Promise<void> => {
    reading ??= readLedger(files, deps.kbRoot).then((read) => {
      if (read.ok) held = read.value;
      else {
        unreadable = read.error;
        deps.logger.warn('aside-ledger.unreadable', { cause: read.error });
      }
    });
    await reading;
  };
  const change = async (edit: (ledger: AsideLedger) => AsideLedger): Promise<void> => {
    await loaded();
    if (unreadable !== undefined) return;
    const next = edit(held);
    held = next;
    saving = saving.then(async () => writeLedger(files, deps, next));
    await saving;
  };

  // A path a write or a move lands at holds a file of this run: the file the ledger meant there is
  // gone, written over, and the next run must not move the new one away. Kept for the whole run, so a
  // file let go after another landed at its path is not written down either.
  const landedAt = new Set<string>();
  const landed = async (path: string): Promise<void> => {
    landedAt.add(path);
    await loaded();
    if (held[path] !== undefined) await change((ledger) => unstuck(ledger, [path]));
  };
  const after = async <T>(result: Result<T, FilesError>, path: string): Promise<Result<T, FilesError>> => {
    if (result.ok) await landed(path);
    return result;
  };
  const through: Files = {
    ...files,
    writeText: async (path, content) => after(await files.writeText(path, content), path),
    writeBytes: async (path, bytes) => after(await files.writeBytes(path, bytes), path),
    move: async (from, to) => after(await files.move(from, to), to),
  };

  // A file handed on that is gone already owes nothing.
  const writeDown: WriteDown = async (missed) => {
    const present = (await onDisk(files, missed)).filter((entry) => !landedAt.has(entry.path));
    if (present.length === 0) return;
    const at = deps.clock.nowIso();
    await change((ledger) => present.reduce((carried, entry) => stuckAt(carried, entry.path, causeOf(entry), at), ledger));
  };

  // At the start of a run, before any source writes: each file still on disk goes under the archive
  // again. One that moves, and one that is gone, leave the ledger; one that still will not move stays,
  // with the day it first would not and the latest cause.
  const retry: RetryAside = async () => {
    await loaded();
    const listed = Object.values(held);
    if (listed.length === 0) return;
    const present = await onDisk(files, listed);
    const aside = await setAside(
      { files, clock: deps.clock, kbRoot: deps.kbRoot },
      present.map((entry) => entry.path)
    );
    const settled = listed.map((entry) => entry.path).filter((path) => !aside.failed.some((missed) => missed.path === path));
    const at = deps.clock.nowIso();
    await change((ledger) => aside.failed.reduce((carried, missed) => stuckAt(carried, missed.path, causeOf(missed), at), unstuck(ledger, settled)));
    deps.logger.info('aside.retried', { moved: aside.moved.length, stuck: aside.failed.length });
  };

  // What the report of the run names: each file the ledger holds that is still on disk, or the ledger
  // itself when it does not read.
  const stuck: StuckFiles = async () => {
    await loaded();
    if (unreadable !== undefined) return [unreadableNote(unreadable)];
    return stuckNotes(await onDisk<StuckFile>(files, Object.values(held)), deps.kbRoot, deps.timezone);
  };

  return { files: through, writeDown, retry, stuck };
};
