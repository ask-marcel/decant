import type { Result } from '../domain/result.ts';
import { err } from '../domain/result.ts';
import type { Files, FilesError } from './ports/files.ts';

// A path names a place inside the knowledge base when it is the folder itself or starts with it and a
// slash, and when no segment of it climbs back out: `kb-old/` sits beside `kb/`, and `..` leaves it.
const inside = (kbRoot: string, path: string): boolean => (path === kbRoot || path.startsWith(`${kbRoot}/`)) && !path.split('/').includes('..');

const refused = (kbRoot: string, path: string): string => `outside the knowledge base ${kbRoot}: ${path}`;

const unreadable = (kbRoot: string, path: string): Result<never, FilesError> => err({ kind: 'read-failed', path, message: refused(kbRoot, path) });

const unwritable = (kbRoot: string, path: string): Result<never, FilesError> => err({ kind: 'write-failed', path, message: refused(kbRoot, path) });

// Every file a run reads, writes or moves sits in the knowledge base. A state copied with it still
// names the folder it was written in, and a path followed from it reached into that folder: a run on
// the copy moved the original's files away. Refused here, such a path costs one item, never a file
// outside. A read is refused as unreadable, never as absent, since a one-time move takes a file gone
// from its old place as moved already, and would then record the move as done.
export const withinKb = (files: Files, kbRoot: string): Files => ({
  readText: async (path) => (inside(kbRoot, path) ? files.readText(path) : unreadable(kbRoot, path)),
  readBytes: async (path) => (inside(kbRoot, path) ? files.readBytes(path) : unreadable(kbRoot, path)),
  listDirectoryNames: async (path) => (inside(kbRoot, path) ? files.listDirectoryNames(path) : unreadable(kbRoot, path)),
  exists: async (path) => (inside(kbRoot, path) ? files.exists(path) : unreadable(kbRoot, path)),
  writeText: async (path, content) => (inside(kbRoot, path) ? files.writeText(path, content) : unwritable(kbRoot, path)),
  writeBytes: async (path, bytes) => (inside(kbRoot, path) ? files.writeBytes(path, bytes) : unwritable(kbRoot, path)),
  move: async (from, to) => {
    const stray = [from, to].find((path) => !inside(kbRoot, path));
    return stray === undefined ? files.move(from, to) : unwritable(kbRoot, stray);
  },
});
