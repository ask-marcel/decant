// `node:fs/promises` for the one thing Bun's file API has no call for: taking away the folder a copy
// was written in, with the copy inside it.
import { rm } from 'node:fs/promises';
import type { Result } from '../domain/result.ts';
import { err } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';

// The library converts a file in the process that asks, and some files never let it finish: SheetJS
// reads a whole workbook of millions of cells before its cell cap applies, synchronously, so the run
// stood still for minutes on one file, its progress bar and every other file with it. Each conversion
// runs in a child process instead, which the run stops when it takes too long, and which can run out
// of memory without taking the run down with it.
export type ChildProcess = {
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  readonly exited: Promise<number>;
  readonly kill: () => void;
};

// What to start and what to hand it on its standard input.
export type SpawnChild = (command: ReadonlyArray<string>, input: string) => ChildProcess;

export type ChildConversionOptions = {
  readonly spawn: SpawnChild;
  readonly timeoutMs: number;
  // The folder a file held in memory is copied into for the child to read.
  readonly scratch: string;
};

export type ChildConversion = {
  // A file already on disk, given by `params.path`, read the way `convert-local-file-to-markdown` reads it.
  readonly path: (params: Record<string, string>) => Promise<Result<unknown, GraphErrorShape>>;
  // A file held in memory. The library tells the kinds apart by extension, so the copy keeps the one
  // `name` has, and the copy is gone again when the conversion ends, however it ends.
  readonly bytes: (bytes: Uint8Array, name: string, params: Record<string, string>) => Promise<Result<unknown, GraphErrorShape>>;
};

const CHILD_SCRIPT = `${import.meta.dir}/convert-child.ts`;

const failed = (message: string): Result<never, GraphErrorShape> => err({ type: 'api_error', message });

const lastLine = (text: string): string => text.trim().split('\n').slice(-1)[0] ?? '';

const parsed = (stdout: string): Result<unknown, GraphErrorShape> => {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null && 'ok' in value ? (value as Result<unknown, GraphErrorShape>) : failed('the conversion answered nothing readable');
  } catch {
    return failed('the conversion answered nothing readable');
  }
};

const LATE = -1;

// The deadline is a race between the child ending and a timer, and the timer is always cleared, so a
// conversion that ended in time leaves nothing behind to hold the run open.
const endedWithin = async (child: ChildProcess, timeoutMs: number): Promise<number> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(LATE), timeoutMs);
  });
  const code = await Promise.race([child.exited, late]);
  clearTimeout(timer);
  return code;
};

const run = async (options: ChildConversionOptions, params: Record<string, string>): Promise<Result<unknown, GraphErrorShape>> => {
  const child = options.spawn([process.execPath, CHILD_SCRIPT], JSON.stringify(params));
  const code = await endedWithin(child, options.timeoutMs);
  if (code === LATE) {
    child.kill();
    await child.exited;
    return failed(`the conversion took longer than ${options.timeoutMs / 1000} s and was stopped`);
  }
  if (code !== 0) return failed(`the conversion stopped with exit code ${code}: ${lastLine(await child.stderr)}`);
  return parsed(await child.stdout);
};

// Only the extension of the name is kept, in letters and digits: the rest of a name an attachment
// carries can hold what no file system takes, and the library reads nothing of it.
const copyName = (name: string): string => {
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot + 1).replaceAll(/[^\dA-Za-z]/g, '');
  return extension === '' ? 'file' : `file.${extension}`;
};

// A copy that cannot be taken away (Windows can still hold it a moment after a stopped child) is left
// in the temporary folder, which the system empties: a run is not failed over it.
const removeQuietly = async (folder: string): Promise<void> => {
  try {
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    return;
  }
};

export const createChildConversion = (options: ChildConversionOptions): ChildConversion => ({
  path: async (params) => run(options, params),
  bytes: async (bytes, name, params) => {
    const folder = `${options.scratch}/decant-${crypto.randomUUID()}`;
    const path = `${folder}/${copyName(name)}`;
    try {
      await Bun.write(path, bytes);
      return await run(options, { ...params, path });
    } catch (error) {
      return failed(formatError(error));
    } finally {
      await removeQuietly(folder);
    }
  },
});

export const createBunSpawn = (): SpawnChild => (command, input) => {
  const spawned = Bun.spawn([...command], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: new Response(spawned.stdout).text(),
    stderr: new Response(spawned.stderr).text(),
    exited: spawned.exited,
    kill: () => spawned.kill(),
  };
};
