import type { DriveItem } from './drive-item.ts';
import { compareText } from './utilities/compare-text.ts';

// Each folder of a library, by id, at the path it had when a sweep last reported it. Graph reports a
// renamed or moved folder alone, without anything under it, and says to follow items by id: this is
// what tells which documents moved with a folder.
export type Folders = Readonly<Record<string, string>>;

// A folder a sweep reports at another path than the one recorded: renamed, or moved with all it holds.
export type FolderMove = { readonly from: string; readonly to: string };

export type SweptFolders = { readonly folders: Folders; readonly moves: ReadonlyArray<FolderMove> };

const within = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);

// The deepest moved folder that holds a path gives it its new place: a folder moved inside a folder
// that moved too was reported at the path it has now.
const movedPath = (path: string, moves: ReadonlyArray<FolderMove>): string => {
  const holding = moves.filter((move) => within(path, move.from)).sort((left, right) => right.from.length - left.from.length)[0];
  return holding === undefined ? path : `${holding.to}${path.slice(holding.from.length)}`;
};

// The folders as a sweep leaves them: one it reports is recorded where it is now, one it reports
// deleted goes, and one it says nothing of keeps its path, unless a folder it sits in moved. Kept in
// the order of their ids, so a sweep that reports a folder only because something in it changed
// leaves the state as it was.
export const sweptFolders = (known: Folders, items: ReadonlyArray<DriveItem>): SweptFolders => {
  const reported = new Map(items.map((item) => [item.id, item]));
  const moves = [...reported.values()].flatMap((item) => {
    const was = known[item.id];
    return item.kind === 'folder' && was !== undefined && was !== item.path ? [{ from: was, to: item.path }] : [];
  });
  const kept = Object.entries(known)
    .filter(([id]) => !reported.has(id))
    .map(([id, path]) => [id, movedPath(path, moves)] as const);
  const now = [...reported.values()].filter((item) => item.kind === 'folder').map((item) => [item.id, item.path] as const);
  return { folders: Object.fromEntries([...kept, ...now].sort(([left], [right]) => compareText(left, right))), moves };
};

// The documents a moved folder took with it, as ids: each one recorded under a path a folder left,
// that the sweep did not report itself. Graph moved them with the folder and said nothing of them.
export const underMoved = (paths: Readonly<Record<string, string>>, reported: ReadonlyArray<DriveItem>, moves: ReadonlyArray<FolderMove>): ReadonlyArray<string> => {
  const seen = new Set(reported.map((item) => item.id));
  return Object.entries(paths)
    .filter(([id, path]) => !seen.has(id) && moves.some((move) => within(path, move.from)))
    .map(([id]) => id);
};
