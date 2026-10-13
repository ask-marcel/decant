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

// What an item held goes under `_archive/<day of the run>/`, at the path it had in the knowledge
// base: an old copy is found by its own path one level down, and the day says when it stopped being
// current. A day that already holds one of these paths sends the whole set to the next free folder,
// so nothing put aside is ever written over, and a document stays beside its pictures.
export const putAside = async (deps: PutAsideDeps, outputs: ReadonlyArray<string>): Promise<ReadonlyArray<NotPutAside>> => {
  if (outputs.length === 0) return [];
  const folder = await folderFor(deps, outputs);
  const failed: NotPutAside[] = [];
  for (const output of outputs) {
    const moved = await deps.files.move(output, `${folder}/${relativeOf(deps.kbRoot, output)}`);
    if (!moved.ok) failed.push({ path: output, error: moved.error });
  }
  return failed;
};
