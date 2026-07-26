import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { Ocr, OcrError } from '../use-cases/ports/ocr.ts';

// RapidOCR's own CLI prints a free-text dataclass repr and its `--lang_type` flag only feeds
// visualisation, never the recognizer (confirmed by reading its source), so this drives the Python
// API directly through a bundled script instead: clean JSON out, and the language actually applies.
export type ShellRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type Shell = (command: ReadonlyArray<string>) => Promise<ShellRun>;

export type RapidOptions = {
  readonly shell: Shell;
  readonly lang: string;
  readonly binary?: string;
};

const SCRIPT_PATH = `${import.meta.dir}/rapidocr-run.py`;

const argsFor = (binary: string, path: string, lang: string): ReadonlyArray<string> => [binary, SCRIPT_PATH, path, lang];

const lastLine = (text: string): string => text.trim().split('\n').slice(-1)[0] ?? '';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// Each entry is `{box, txt, score}`; only the recognised text lines are what the image actually said.
const textsFrom = (stdout: string): string => {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return '';
  return parsed
    .filter(isRecord)
    .map((entry) => entry['txt'])
    .filter((txt): txt is string => typeof txt === 'string')
    .join('\n');
};

export const createRapidOcr = (options: RapidOptions): Ocr => ({
  read: async (path): Promise<Result<string, OcrError>> => {
    try {
      const run = await options.shell(argsFor(options.binary ?? 'python3', path, options.lang));
      if (run.exitCode !== 0) return err({ kind: 'failed', message: lastLine(run.stderr) || `rapidocr exited ${run.exitCode}` });
      return ok(textsFrom(run.stdout));
    } catch (error) {
      return err({ kind: 'unavailable', message: formatError(error) });
    }
  },
});

// Chosen when the run turned OCR off (`--no-ocr`): every read reports "unavailable", so an image or
// a scanned PDF falls back to its note and no `ocr:` line ever claims text was read.
export const createNoOcr = (): Ocr => ({ read: async () => err({ kind: 'unavailable', message: 'ocr disabled' }) });

export const createBunShell = (): Shell => async (command) => {
  const [binary, ...args] = command;
  const spawned = Bun.spawn([binary ?? '', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()]);
  return { exitCode: await spawned.exited, stdout, stderr };
};
