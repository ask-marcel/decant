import { holdsChineseText } from '../domain/ocr-language.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { Ocr, OcrError, OcrReading } from '../use-cases/ports/ocr.ts';

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

type Model = { readonly lang: string; readonly version: string };

const SCRIPT_PATH = `${import.meta.dir}/rapidocr-run.py`;

// A run that named no language settles it by reading the image rather than guessing from its path.
// `ch` goes first because it is the only recognizer that can answer in both directions: it holds
// CJK and ASCII alike, so ideographs missing from its reading really were absent. Which model each
// side uses was measured rather than assumed: `ch` reads this tenant's Chinese most completely at
// PP-OCRv4, and `latin` at PP-OCRv5 both keeps the word spacing every `ch` model runs together and
// holds the accented characters Dutch and French need, which the ASCII-only `en` model cannot emit.
const AUTO = 'auto';
const PROBE: Model = { lang: 'ch', version: 'PP-OCRv4' };
const LATIN: Model = { lang: 'latin', version: 'PP-OCRv5' };
const NAMED_VERSION = 'PP-OCRv4';

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

const readWith = async (options: RapidOptions, path: string, model: Model): Promise<Result<OcrReading, OcrError>> => {
  const run = await options.shell([options.binary ?? 'python3', SCRIPT_PATH, path, model.lang, model.version]);
  if (run.exitCode !== 0) return err({ kind: 'failed', message: lastLine(run.stderr) || `rapidocr exited ${run.exitCode}` });
  return ok({ text: textsFrom(run.stdout), label: `rapidocr (${model.lang})` });
};

// An image the probe found no text in is not read again: there is no language to get right, and a
// mailbox is full of signature pictures that would otherwise pay for a second pass saying nothing.
const reading = async (options: RapidOptions, path: string): Promise<Result<OcrReading, OcrError>> => {
  if (options.lang !== AUTO) return readWith(options, path, { lang: options.lang, version: NAMED_VERSION });
  const probe = await readWith(options, path, PROBE);
  if (!probe.ok || probe.value.text.trim().length === 0 || holdsChineseText(probe.value.text)) return probe;
  return readWith(options, path, LATIN);
};

export const createRapidOcr = (options: RapidOptions): Ocr => ({
  read: async (path): Promise<Result<OcrReading, OcrError>> => {
    try {
      return await reading(options, path);
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
