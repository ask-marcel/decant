import { ASIDE_LEDGER_NAME, parseAsideLedger, serializeAsideLedger, stuckAt, stuckNotes, unstuck } from '../domain/aside-ledger.ts';
import type { AsideLedger, StuckFile } from '../domain/aside-ledger.ts';
import type { ReportEntry } from '../domain/report.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import { setAside } from './put-aside.ts';
import type { NotPutAside, WriteDown } from './put-aside.ts';

export type AsideLedgerDeps = { readonly clock: Clock; readonly kbRoot: string; readonly logger: Logger };

export type RetryAside = () => Promise<void>;

export type StuckFiles = () => Promise<ReadonlyArray<ReportEntry>>;

// What a run gets from the ledger: where its sources write down the files they let go that would not
// move under the archive, the retry at the start of the run, and what the report of the run names.
export type AsideLedgerRun = { readonly writeDown: WriteDown; readonly retry: RetryAside; readonly stuck: StuckFiles };

const ledgerPath = (kbRoot: string): string => `${kbRoot}/${ASIDE_LEDGER_NAME}`;

const readLedger = async (files: Files, kbRoot: string): Promise<AsideLedger> => {
  const text = await files.readText(ledgerPath(kbRoot));
  const parsed = text.ok ? parseJson(text.value) : undefined;
  return parsed?.ok ? parseAsideLedger(parsed.value) : {};
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
// them can let a file go together.
export const createAsideLedger = (files: Files, deps: AsideLedgerDeps): AsideLedgerRun => {
  let held: AsideLedger = {};
  let reading: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();
  const loaded = async (): Promise<void> => {
    reading ??= readLedger(files, deps.kbRoot).then((ledger) => {
      held = ledger;
    });
    await reading;
  };
  const change = async (edit: (ledger: AsideLedger) => AsideLedger): Promise<void> => {
    await loaded();
    const next = edit(held);
    held = next;
    saving = saving.then(async () => writeLedger(files, deps, next));
    await saving;
  };

  // A file handed on that is gone already owes nothing.
  const writeDown: WriteDown = async (missed) => {
    const present = await onDisk(files, missed);
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

  // What the report of the run names: each file the ledger holds that is still on disk.
  const stuck: StuckFiles = async () => {
    await loaded();
    return stuckNotes(await onDisk<StuckFile>(files, Object.values(held)), deps.kbRoot);
  };

  return { writeDown, retry, stuck };
};
