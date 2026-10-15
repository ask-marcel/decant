import { ASIDE_LEDGER_NAME, parseAsideLedger, serializeAsideLedger, stuckAt, stuckNotes, unstuck } from '../domain/aside-ledger.ts';
import type { AsideLedger, StuckFile } from '../domain/aside-ledger.ts';
import type { ReportEntry } from '../domain/report.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import { setAside } from './put-aside.ts';

export type AsideLedgerDeps = { readonly clock: Clock; readonly kbRoot: string; readonly logger: Logger };

const ledgerPath = (kbRoot: string): string => `${kbRoot}/${ASIDE_LEDGER_NAME}`;

const readLedger = async (files: Files, kbRoot: string): Promise<AsideLedger> => {
  const text = await files.readText(ledgerPath(kbRoot));
  const parsed = text.ok ? parseJson(text.value) : undefined;
  return parsed?.ok ? parseAsideLedger(parsed.value) : {};
};

// A ledger that will not save costs the record of the moves owed, not the run: the next move that
// fails writes its file down again.
const writeLedger = async (files: Files, deps: AsideLedgerDeps, ledger: AsideLedger): Promise<void> => {
  const written = await files.writeText(ledgerPath(deps.kbRoot), serializeAsideLedger(ledger));
  if (!written.ok) deps.logger.warn('aside-ledger.unsaved', { cause: written.error.kind });
};

// Every source puts what it no longer holds under the archive through this, so a move that fails is
// caught in one place. The source has already let the file go, so the file is written down here, as
// long as it is still on disk: the next run moves it again, and the report of the run names it. One
// at a time, since two moves of one window can fail together, and each would read the ledger before
// the other wrote it.
export const withAsideLedger = (files: Files, deps: AsideLedgerDeps): Files => {
  let writing: Promise<void> = Promise.resolve();
  const note = async (path: string, cause: string): Promise<void> => writeLedger(files, deps, stuckAt(await readLedger(files, deps.kbRoot), path, cause, deps.clock.nowIso()));
  const stuck = async (path: string, error: FilesError): Promise<void> => {
    const still = await files.exists(path);
    if (!still.ok || !still.value) return;
    writing = writing.then(async () => note(path, `${error.kind}: ${error.message}`));
    await writing;
  };
  return {
    ...files,
    move: async (from, to) => {
      const moved = await files.move(from, to);
      if (!moved.ok && to.startsWith(`${deps.kbRoot}/_archive/`)) await stuck(from, moved.error);
      return moved;
    },
  };
};

const onDisk = async (files: Files, entries: ReadonlyArray<StuckFile>): Promise<ReadonlyArray<StuckFile>> => {
  const present: StuckFile[] = [];
  for (const entry of entries) {
    const held = await files.exists(entry.path);
    if (held.ok && held.value) present.push(entry);
  }
  return present;
};

export type RetryAside = () => Promise<void>;

// At the start of a run, before any source writes: each file the ledger holds that is still on disk
// goes under the archive again. One that moves, and one that is gone, leave the ledger. One that
// still will not move is written down again, through the files this runs on.
export const createRetryAside =
  (deps: AsideLedgerDeps & { readonly files: Files }): RetryAside =>
  async () => {
    const ledger = await readLedger(deps.files, deps.kbRoot);
    if (Object.keys(ledger).length === 0) return;
    const present = await onDisk(deps.files, Object.values(ledger));
    const aside = await setAside(
      deps,
      present.map((entry) => entry.path)
    );
    const settled = Object.keys(ledger).filter((path) => !aside.failed.some((missed) => missed.path === path));
    await writeLedger(deps.files, deps, unstuck(await readLedger(deps.files, deps.kbRoot), settled));
    deps.logger.info('aside.retried', { moved: aside.moved.length, stuck: aside.failed.length });
  };

export type StuckFiles = () => Promise<ReadonlyArray<ReportEntry>>;

// What the report of the run names: each file the ledger holds that is still on disk.
export const createStuckFiles =
  (deps: { readonly files: Files; readonly kbRoot: string }): StuckFiles =>
  async () =>
    stuckNotes(await onDisk(deps.files, Object.values(await readLedger(deps.files, deps.kbRoot))), deps.kbRoot);
