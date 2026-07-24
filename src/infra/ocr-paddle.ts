import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { Ocr, OcrError } from '../use-cases/ports/ocr.ts';

// PaddleOCR prints what it read on stdout, so the package's own ProcessRunner (whose stdio is
// always inherited) cannot be reused here: this adapter needs the output, not just the exit code.
export type ShellRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type Shell = (command: ReadonlyArray<string>) => Promise<ShellRun>;

export type PaddleOptions = {
  readonly shell: Shell;
  readonly lang: string;
  readonly binary?: string;
};

const argsFor = (binary: string, path: string, lang: string): ReadonlyArray<string> => [binary, 'ocr', '-i', path, '--lang', lang];

// The CLI prints a Python record per page. The recognised lines are the quoted strings inside that
// record's `rec_texts` list, and nothing else in the dump is text the image actually held.
const REC_TEXTS = /'rec_texts':\s*\[([^\]]*)\]/g;
const QUOTED = /'([^']*)'/g;

const textFrom = (stdout: string): string =>
  [...stdout.matchAll(REC_TEXTS)]
    .flatMap((page) => [...(page[1] ?? '').matchAll(QUOTED)].map((line) => line[1] ?? ''))
    .filter((line) => line.trim().length > 0)
    .join('\n');

const lastLine = (text: string): string => text.trim().split('\n').slice(-1)[0] ?? '';

export const createPaddleOcr = (options: PaddleOptions): Ocr => ({
  read: async (path): Promise<Result<string, OcrError>> => {
    try {
      const run = await options.shell(argsFor(options.binary ?? 'paddleocr', path, options.lang));
      if (run.exitCode !== 0) return err({ kind: 'failed', message: lastLine(run.stderr) || `paddleocr exited ${run.exitCode}` });
      return ok(textFrom(run.stdout));
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
