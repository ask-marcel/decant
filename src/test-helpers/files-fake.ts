import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { Files, FilesError } from '../use-cases/ports/files.ts';

export type FilesFake = Files & {
  // What the knowledge base looks like after the run: path to contents, so a test asserts on the
  // files a sync produced rather than on the calls it made.
  readonly written: Map<string, string>;
  readonly binary: Map<string, Uint8Array>;
  readonly moves: Array<{ readonly from: string; readonly to: string }>;
};

export type FilesFakeSeed = {
  readonly texts?: Readonly<Record<string, string>>;
  readonly directories?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly failReadWith?: FilesError;
  readonly failListWith?: FilesError;
  readonly failWriteWith?: FilesError;
  readonly failMoveWith?: FilesError;
  // Fails only the writes whose path contains this text, so one file can fail while the rest land.
  readonly failWritesMatching?: string;
};

const notFound = (path: string): Result<never, FilesError> => err({ kind: 'not-found', path, message: `no such path: ${path}` });

export const createFilesFake = (seed: FilesFakeSeed = {}): FilesFake => {
  const written = new Map<string, string>(Object.entries(seed.texts ?? {}));
  const binary = new Map<string, Uint8Array>();
  const moves: Array<{ from: string; to: string }> = [];
  return {
    written,
    binary,
    moves,
    readText: async (path) => {
      if (seed.failReadWith) return err(seed.failReadWith);
      const text = written.get(path);
      return text === undefined ? notFound(path) : ok(text);
    },
    listDirectoryNames: async (path) => {
      if (seed.failListWith) return err(seed.failListWith);
      const names = seed.directories?.[path];
      return names === undefined ? notFound(path) : ok(names);
    },
    writeText: async (path, content) => {
      if (seed.failWriteWith) return err(seed.failWriteWith);
      if (seed.failWritesMatching !== undefined && path.includes(seed.failWritesMatching)) return err({ kind: 'write-failed', path, message: `cannot write ${path}` });
      written.set(path, content);
      return ok(undefined);
    },
    writeBytes: async (path, bytes) => {
      if (seed.failWriteWith) return err(seed.failWriteWith);
      binary.set(path, bytes);
      return ok(undefined);
    },
    move: async (from, to) => {
      if (seed.failMoveWith) return err(seed.failMoveWith);
      moves.push({ from, to });
      const text = written.get(from);
      if (text !== undefined) written.set(to, text);
      written.delete(from);
      return ok(undefined);
    },
    exists: async (path) => ok(written.has(path) || binary.has(path)),
  };
};
