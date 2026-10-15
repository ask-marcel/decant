import { filesLeft, filesOf, stillHolding, storesWithout, underName } from '../domain/mail-state.ts';
import type { FileStores, ThreadRecord } from '../domain/mail-state.ts';
import type { ReportEntry } from '../domain/report.ts';
import type { Logger } from './ports/logger.ts';
import { setAside } from './put-aside.ts';
import type { PutAsideDeps, SetAside } from './put-aside.ts';
import type { RenderedThread } from './render-thread.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

export type ThreadAsideDeps = PutAsideDeps & { readonly logger: Logger };

// Why a file of a thread went under the archive while the thread stayed.
const NO_LONGER_HELD = 'no longer in the thread';

// Why a whole thread went under the archive: its messages are gone, or the thread itself is.
export const NO_MESSAGE_LEFT = 'no message left at the source';
export const NO_LONGER_LISTED = 'no longer at the source';

// Why a thread put aside whole is still there: its note would not move.
export const NOT_MOVED = 'could not be moved aside';

const relativeTo = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

// The files of a thread go under `_archive/` together, those still on disk: a file listed and never
// written, or gone already, has nothing to keep. A file that would not move is logged by its thread,
// whose id says nothing of what the mail is about, and handed back with why.
const filesAside = async (deps: ThreadAsideDeps, threadId: string, paths: ReadonlyArray<string>): Promise<SetAside> => {
  const present: string[] = [];
  for (const path of paths) {
    const held = await deps.files.exists(path);
    if (held.ok && held.value) present.push(path);
  }
  const aside = await setAside(deps, present);
  for (const missed of aside.failed) deps.logger.warn('archive.failed', { threadId, cause: missed.error.kind });
  return aside;
};

// What a thread put aside whole came to: named once in the report by its note, or, when the note
// would not move, why. Left where it is, the note still reads as current, so the thread is kept.
export type ThreadAside = { readonly moved: true; readonly entry: ReportEntry } | { readonly moved: false; readonly reason: string };

// A thread put aside whole: its note and every file its folder held, as one set.
export const threadAside = async (deps: ThreadAsideDeps, root: string, threadId: string, record: ThreadRecord, reason: string): Promise<ThreadAside> => {
  const note = `${root}/${record.file}`;
  const aside = await filesAside(deps, threadId, [note, ...filesOf(record)]);
  const stuck = aside.failed.find((missed) => missed.path === note);
  return stuck === undefined ? { moved: true, entry: { path: record.file, reason } } : { moved: false, reason: `${NOT_MOVED}: ${stuck.error.kind}` };
};

// What one thread's write adds to a run, folded onto the state after the window's writes.
export type ThreadOutcome<S> = { readonly apply: (state: S) => S; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

// A thread written again, with what it no longer holds put aside: the files moved counted and named,
// and the stored records of the files gone taken out of the state after the thread's own are folded
// in.
const withFilesAside = <S extends FileStores>(done: ThreadOutcome<S>, gone: ReadonlyArray<string>, aside: ReadonlyArray<ReportEntry>): ThreadOutcome<S> => ({
  apply: (state) => {
    const applied = done.apply(state);
    return { ...applied, ...storesWithout(applied, gone) };
  },
  counted: { ...done.counted, archived: aside.length },
  notes: { ...done.notes, archived: aside },
});

// A thread written again, and what it no longer holds put aside. Only a file in the thread's own
// folder, as this write names it, is moved: the same file spelled under another root, as a run from
// another folder spells it, can be one this write just made, so such a path only leaves the record.
// What this write could not read stays as it was, with its name, since it may be a file the thread
// still holds: a throttled download looks the same as a file of a message gone. A failure on anything
// else keeps nothing back, so a document nobody can open does not stop the rest for good.
export const writtenAgain = async <S extends FileStores>(
  deps: ThreadAsideDeps,
  where: { readonly root: string; readonly threadId: string },
  before: ThreadRecord | undefined,
  thread: RenderedThread,
  owing: (thread: RenderedThread) => ThreadOutcome<S>
): Promise<ThreadOutcome<S>> => {
  const here = `${where.root}/threads/${thread.record.folder}/`;
  const left = filesLeft(before, thread.record);
  const unread = left.filter((path) => (thread.unread ?? []).some((name) => underName(path, name)));
  const aside = await filesAside(
    deps,
    where.threadId,
    left.filter((path) => path.startsWith(here) && !unread.includes(path))
  );
  // A file that would not move is still on disk, so still the thread's: listed, its stored record kept,
  // and its name held, so no later file of that name writes over it.
  const stuck = aside.failed.map((missed) => missed.path);
  const gone = left.filter((path) => !unread.includes(path) && !stuck.includes(path));
  const moved = aside.moved.map((move) => ({ path: relativeTo(where.root, move.from), reason: NO_LONGER_HELD }));
  return withFilesAside(owing({ ...thread, record: stillHolding(thread.record, [...unread, ...stuck]) }), gone, moved);
};
