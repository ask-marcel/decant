import { filesOf, storesWithout } from '../domain/mail-state.ts';
import type { FileStores, ThreadRecord } from '../domain/mail-state.ts';
import type { ReportEntry } from '../domain/report.ts';
import type { Logger } from './ports/logger.ts';
import { setAside } from './put-aside.ts';
import type { PutAsideDeps } from './put-aside.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

export type ThreadAsideDeps = PutAsideDeps & { readonly logger: Logger };

// Why a file of a thread went under the archive while the thread stayed.
export const NO_LONGER_HELD = 'no longer in the thread';

// Why a whole thread went under the archive: its messages are gone, or the thread itself is.
export const NO_MESSAGE_LEFT = 'no message left at the source';
export const NO_LONGER_LISTED = 'no longer at the source';

const relativeTo = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

// The files of a thread go under `_archive/` together, those still on disk: a file listed and never
// written, or gone already, has nothing to keep. A file that would not move is logged by its thread,
// whose id says nothing of what the mail is about. Each file moved is named for the report, from the
// folder of its source, the way the report names everything else.
export const threadFilesAside = async (
  deps: ThreadAsideDeps,
  root: string,
  threadId: string,
  paths: ReadonlyArray<string>,
  reason: string
): Promise<ReadonlyArray<ReportEntry>> => {
  const present: string[] = [];
  for (const path of paths) {
    const held = await deps.files.exists(path);
    if (held.ok && held.value) present.push(path);
  }
  const aside = await setAside(deps, present);
  for (const missed of aside.failed) deps.logger.warn('archive.failed', { threadId, cause: missed.error.kind });
  return aside.moved.map((move) => ({ path: relativeTo(root, move.from), reason }));
};

// A thread put aside whole: its note and every file its folder held, as one set, named once in the
// report by its note.
export const threadAside = async (deps: ThreadAsideDeps, root: string, threadId: string, record: ThreadRecord, reason: string): Promise<ReportEntry> => {
  await threadFilesAside(deps, root, threadId, [`${root}/${record.file}`, ...filesOf(record)], reason);
  return { path: record.file, reason };
};

// What one thread's write adds to a run, folded onto the state after the window's writes.
export type ThreadOutcome<S> = { readonly apply: (state: S) => S; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

// A thread written again, with what it no longer holds put aside: the files counted and named, and
// their stored records taken out of the state after the thread's own are folded in.
export const withFilesAside = <S extends FileStores>(done: ThreadOutcome<S>, left: ReadonlyArray<string>, aside: ReadonlyArray<ReportEntry>): ThreadOutcome<S> => ({
  apply: (state) => {
    const applied = done.apply(state);
    return { ...applied, ...storesWithout(applied, left) };
  },
  counted: { ...done.counted, archived: aside.length },
  notes: { ...done.notes, archived: aside },
});
