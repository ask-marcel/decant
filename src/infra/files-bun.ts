// Bun has no primitive for directories: `Bun.file(dir).exists()` answers "is a file", and there is
// no rename. `node:fs/promises` takes those two calls, the boundary carve-out in rule 20. Every
// file read and write below stays on the Bun file API.
import { mkdir, readdir, rename } from 'node:fs/promises';
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

const listDirectoryNamesAt = async (path: string): Promise<Result<ReadonlyArray<string>, FilesError>> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return ok(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    return err({ kind: 'not-found', path, message: formatError(error) });
  }
};

// Bun.write creates the parent folders on its own, so only rename needs one made first.
const write = async (path: string, contents: string | Uint8Array, platform: string): Promise<Result<void, FilesError>> => {
  try {
    await Bun.write(path, contents);
    return ok(undefined);
  } catch (error) {
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
  listDirectoryNames: listDirectoryNamesAt,
  writeText: async (path, content) => write(path, content, platform),
  writeBytes: async (path, bytes) => write(path, bytes, platform),
  move: async (from, to) => moveTo(from, to, platform),
  exists: async (path) => ok(await Bun.file(path).exists()),
});
