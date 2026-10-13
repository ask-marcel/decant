// Bun has no primitive for directories: `Bun.file(dir).exists()` answers "is a file", and there is
// no rename. `node:fs/promises` takes those calls and the removal of a file a failed write left,
// the boundary carve-out in rule 20. Every file read and write below stays on the Bun file API.
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { WINDOWS_PATH_LIMIT } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { Files, FilesError } from '../use-cases/ports/files.ts';

// Windows answers a path that is too long with `ENOENT: no such file or directory`, which sends the
// reader looking for a folder that was never missing, so the length is said beside it.
const lengthNote = (path: string, platform: string): string => {
  const length = resolve(path).length;
  return platform === 'win32' && length > WINDOWS_PATH_LIMIT ? ` (the path has ${length} characters, and Windows accepts at most ${WINDOWS_PATH_LIMIT})` : '';
};

const writeFailed = (path: string, error: unknown, platform: string): Result<never, FilesError> =>
  err({ kind: 'write-failed', path, message: `${formatError(error)}${lengthNote(path, platform)}` });

const readTextAt = async (path: string): Promise<Result<string, FilesError>> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return err({ kind: 'not-found', path, message: `no such file: ${path}` });
  try {
    return ok(await file.text());
  } catch (error) {
    return err({ kind: 'read-failed', path, message: formatError(error) });
  }
};

const readBytesAt = async (path: string): Promise<Result<Uint8Array, FilesError>> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return err({ kind: 'not-found', path, message: `no such file: ${path}` });
  try {
    return ok(await file.bytes());
  } catch (error) {
    return err({ kind: 'read-failed', path, message: formatError(error) });
  }
};

const listDirectoryNamesAt = async (path: string): Promise<Result<ReadonlyArray<string>, FilesError>> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return ok(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    return err({ kind: 'not-found', path, message: formatError(error) });
  }
};

// Beside the file, under a name nothing else takes: eight characters, inside the room the names are
// planned with for what decant adds after them.
const besideOf = (path: string): string => `${path}.~${crypto.randomUUID().slice(0, 6)}`;

// A file another program holds open for a moment (OneDrive uploading it, a virus scanner reading it)
// refuses the rename on Windows, so a refused rename is tried again a few times before it counts.
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 5;

const codeOf = (error: unknown): string => (typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '');

const renameOver = async (from: string, to: string, tries: number): Promise<void> => {
  try {
    await rename(from, to);
  } catch (error) {
    if (tries <= 1 || !HELD.has(codeOf(error))) throw error;
    await Bun.sleep(50 * 2 ** (RENAME_TRIES - tries));
    await renameOver(from, to, tries - 1);
  }
};

// Written beside its place, then renamed over it, so a run stopped halfway leaves the old file or the
// new one, never half of one. Bun.write creates the parent folders on its own, so only a move needs
// one made first.
const write = async (path: string, contents: string | Uint8Array, platform: string): Promise<Result<void, FilesError>> => {
  const beside = besideOf(path);
  try {
    await Bun.write(beside, contents);
    await renameOver(beside, path, RENAME_TRIES);
    return ok(undefined);
  } catch (error) {
    // What the failed write left beside the file goes, if it was made at all. A folder that is not
    // one refuses even that, and the failure to report is the write's.
    await rm(beside, { force: true }).catch(() => undefined);
    return writeFailed(path, error, platform);
  }
};

const moveTo = async (from: string, to: string, platform: string): Promise<Result<void, FilesError>> => {
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return ok(undefined);
  } catch (error) {
    return writeFailed(to, error, platform);
  }
};

// The platform is the one a failed write is explained for; a test names it, a run takes this one's.
export const createBunFiles = (platform: string = process.platform): Files => ({
  readText: readTextAt,
  readBytes: readBytesAt,
  listDirectoryNames: listDirectoryNamesAt,
  writeText: async (path, content) => write(path, content, platform),
  writeBytes: async (path, bytes) => write(path, bytes, platform),
  move: async (from, to) => moveTo(from, to, platform),
  exists: async (path) => ok(await Bun.file(path).exists()),
});
