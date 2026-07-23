// Bun has no primitive for directories: `Bun.file(dir).exists()` answers "is a file", and there is
// no rename. `node:fs/promises` takes those two calls, the boundary carve-out in rule 20. Every
// file read and write below stays on the Bun file API.
import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { Files, FilesError } from '../use-cases/ports/files.ts';

const writeFailed = (path: string, error: unknown): Result<never, FilesError> => err({ kind: 'write-failed', path, message: formatError(error) });

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
const write = async (path: string, contents: string | Uint8Array): Promise<Result<void, FilesError>> => {
  try {
    await Bun.write(path, contents);
    return ok(undefined);
  } catch (error) {
    return writeFailed(path, error);
  }
};

const moveTo = async (from: string, to: string): Promise<Result<void, FilesError>> => {
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return ok(undefined);
  } catch (error) {
    return writeFailed(to, error);
  }
};

export const createBunFiles = (): Files => ({
  readText: readTextAt,
  listDirectoryNames: listDirectoryNamesAt,
  writeText: write,
  writeBytes: write,
  move: moveTo,
  exists: async (path) => ok(await Bun.file(path).exists()),
});
