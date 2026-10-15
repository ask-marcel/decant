import type { Clock } from './ports/clock.ts';
import type { Files, FilesError } from './ports/files.ts';

export type PutAsideDeps = { readonly files: Pick<Files, 'exists' | 'move'>; readonly clock: Clock; readonly kbRoot: string };

export type NotPutAside = { readonly path: string; readonly error: FilesError };

const DAY_LENGTH = 10;

// Enough for every edit of one day many times over; past it the last folder is used as it stands.
const MOST_FOLDERS = 100;

const relativeOf = (kbRoot: string, path: string): string => (path.startsWith(`${kbRoot}/`) ? path.slice(kbRoot.length + 1) : path);

const isFree = async (deps: PutAsideDeps, folder: string, outputs: ReadonlyArray<string>): Promise<boolean> => {
  const held = await Promise.all(outputs.map((output) => deps.files.exists(`${folder}/${relativeOf(deps.kbRoot, output)}`)));
  return held.every((answer) => answer.ok && !answer.value);
};

// `<day>`, then `<day>-2`, `<day>-3`: the first day folder that holds none of the set.
const folderFor = async (deps: PutAsideDeps, outputs: ReadonlyArray<string>): Promise<string> => {
  const day = deps.clock.nowIso().slice(0, DAY_LENGTH);
  let folder = `${deps.kbRoot}/_archive/${day}`;
  for (let count = 2; count <= MOST_FOLDERS && !(await isFree(deps, folder, outputs)); count += 1) folder = `${deps.kbRoot}/_archive/${day}-${count}`;
  return folder;
};

export type Move = { readonly from: string; readonly to: string };

// What a set put aside became: where each file went, and the ones that would not move.
export type SetAside = { readonly moved: ReadonlyArray<Move>; readonly failed: ReadonlyArray<NotPutAside> };

// What an item held goes under `_archive/<day of the run>/`, at the path it had in the knowledge
// base: an old copy is found by its own path one level down, and the day says when it stopped being
// current. A day that already holds one of these paths sends the whole set to the next free folder,
// so nothing put aside is ever written over, and a document stays beside its pictures.
export const setAside = async (deps: PutAsideDeps, outputs: ReadonlyArray<string>): Promise<SetAside> => {
  if (outputs.length === 0) return { moved: [], failed: [] };
  const folder = await folderFor(deps, outputs);
  const moved: Move[] = [];
  const failed: NotPutAside[] = [];
  for (const output of outputs) {
    const to = `${folder}/${relativeOf(deps.kbRoot, output)}`;
    const done = await deps.files.move(output, to);
    if (done.ok) moved.push({ from: output, to });
    else failed.push({ path: output, error: done.error });
  }
  return { moved, failed };
};

export const putAside = async (deps: PutAsideDeps, outputs: ReadonlyArray<string>): Promise<ReadonlyArray<NotPutAside>> => (await setAside(deps, outputs)).failed;

// The files a set put aside go back where they were: the edit they made room for did not land, and
// the version before it is still the current one.
export const putBack = async (deps: Pick<PutAsideDeps, 'files'>, aside: SetAside): Promise<ReadonlyArray<NotPutAside>> => {
  const failed: NotPutAside[] = [];
  for (const move of aside.moved) {
    const done = await deps.files.move(move.to, move.from);
    if (!done.ok) failed.push({ path: move.from, error: done.error });
  }
  return failed;
};

// A file of the set that would not move and is still on disk stands in the way of a write to the same
// path: written over, the version before would be lost. The reason says why the write waits.
export const heldInPlace = async (deps: Pick<PutAsideDeps, 'files'>, aside: SetAside): Promise<string | undefined> => {
  for (const missed of aside.failed) {
    const still = await deps.files.exists(missed.path);
    if (still.ok && still.value) return `its earlier version would not move to _archive/: ${missed.error.kind}: ${missed.error.message}`;
  }
  return undefined;
};
