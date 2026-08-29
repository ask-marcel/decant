import { contentHash } from '../domain/content-hash.ts';
import type { ReadingScript } from '../domain/ocr-language.ts';
import { scriptOf } from '../domain/ocr-language.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { Ocr, OcrError, OcrReading } from '../use-cases/ports/ocr.ts';

// RapidOCR's own CLI prints a free-text dataclass repr and its `--lang_type` flag only feeds
// visualisation, never the recognizer (confirmed by reading its source), so this drives the Python
// API directly through a bundled script instead: clean JSON out, and the language actually applies.
export type ShellRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type Shell = (command: ReadonlyArray<string>) => Promise<ShellRun>;

// Where readings are kept between runs. Injected rather than reached for directly, so what is
// tested here is WHEN a reading is kept, not how the files are laid out.
//
// `digest` addresses the image by its bytes, which is what makes the cache survive a file being
// renamed, moved, or arriving again as somebody else's attachment. It answers `undefined` for an
// image it could not read, and the run then goes ahead uncached rather than failing over a cache.
export type OcrCache = {
  readonly digest: (path: string) => Promise<string | undefined>;
  readonly load: (key: string) => Promise<OcrReading | undefined>;
  readonly save: (key: string, reading: OcrReading) => Promise<void>;
};

export type RapidOptions = {
  readonly shell: Shell;
  readonly lang: string;
  readonly binary?: string;
  readonly cache?: OcrCache;
};

type Model = { readonly lang: string; readonly version: string };

const SCRIPT_PATH = `${import.meta.dir}/rapidocr-run.py`;

// A run that named no language settles it by reading the image rather than guessing from its path.
// The probe is `ch` at PP-OCRv5 because it is the widest dictionary RapidOCR ships, holding
// ideographs, both kana syllabaries and accented Latin at once, so one reading can say which script
// the image is in. Its own reading is then thrown away, since the model that recognises everything
// is the best at nothing: measured against real files, PP-OCRv5 drops characters from this tenant's
// Chinese that PP-OCRv4 reads whole. So the probe only classifies, and the answer comes from the
// model built for what it found. `latin` at PP-OCRv5 keeps the word spacing every `ch` model runs
// together and holds the accented characters Dutch and French need, which `en` cannot emit at all.
const AUTO = 'auto';
const PROBE: Model = { lang: 'ch', version: 'PP-OCRv5' };
const FOR_SCRIPT: Record<ReadingScript, Model> = {
  japanese: { lang: 'japan', version: 'PP-OCRv4' },
  chinese: { lang: 'ch', version: 'PP-OCRv4' },
  latin: { lang: 'latin', version: 'PP-OCRv5' },
};
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

// An image the probe found no text in is not read again: there is no script to get right, and a
// mailbox is full of signature pictures that would otherwise pay for a second pass saying nothing.
// A probe that failed is reported rather than retried, since the second read would fail alike.
const reading = async (options: RapidOptions, path: string): Promise<Result<OcrReading, OcrError>> => {
  if (options.lang !== AUTO) return readWith(options, path, { lang: options.lang, version: NAMED_VERSION });
  const probe = await readWith(options, path, PROBE);
  if (!probe.ok || probe.value.text.trim().length === 0) return probe;
  return readWith(options, path, FOR_SCRIPT[scriptOf(probe.value.text)]);
};

// The language is part of the key. An explicit `--ocr-lang japan` run must not read back what an
// `auto` run decided, or a deliberate correction would answer with the mistake it was correcting.
//
// Only a success is kept. A failure says something about the machine, not about the image: python
// missing, a model not downloaded, OCR turned off. Keeping one would answer every later run with
// it, and the image would never be read at all.
const cached = async (options: RapidOptions, path: string): Promise<Result<OcrReading, OcrError>> => {
  const cache = options.cache;
  if (cache === undefined) return reading(options, path);
  const digest = await cache.digest(path);
  if (digest === undefined) return reading(options, path);
  const key = `${digest}-${options.lang}`;
  const kept = await cache.load(key);
  if (kept !== undefined) return ok(kept);
  const read = await reading(options, path);
  if (read.ok) await cache.save(key, read.value);
  return read;
};

export const createRapidOcr = (options: RapidOptions): Ocr => ({
  read: async (path): Promise<Result<OcrReading, OcrError>> => {
    try {
      return await cached(options, path);
    } catch (error) {
      return err({ kind: 'unavailable', message: formatError(error) });
    }
  },
});

// Chosen when the run turned OCR off (`--no-ocr`): every read reports "unavailable", so an image or
// a scanned PDF falls back to its note and no `ocr:` line ever claims text was read.
export const createNoOcr = (): Ocr => ({ read: async () => err({ kind: 'unavailable', message: 'ocr disabled' }) });

const SHARD = 2;

// Sharded two characters at a time, so a mailbox with tens of thousands of pictures never puts them
// all in one directory, where listing it becomes the slow part of every later run.
const cachePath = (root: string, key: string): string => `${root}/${key.slice(0, SHARD)}/${key.slice(SHARD, SHARD + SHARD)}/${key}.txt`;

// The label is kept beside the text, on the first line. It is what the front matter reports as the
// model that read the image, so a cache holding text alone would make a cached image claim no model
// or, worse, one it was never read by.
export const createFileOcrCache = (root: string): OcrCache => ({
  digest: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? contentHash(await file.bytes()) : undefined;
  },
  load: async (key) => {
    const file = Bun.file(cachePath(root, key));
    if (!(await file.exists())) return undefined;
    const [label, ...rest] = (await file.text()).split('\n');
    return label === undefined ? undefined : { label, text: rest.join('\n') };
  },
  save: async (key, reading) => {
    await Bun.write(cachePath(root, key), `${reading.label}\n${reading.text}`);
  },
});

export const createBunShell = (): Shell => async (command) => {
  const [binary, ...args] = command;
  const spawned = Bun.spawn([binary ?? '', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()]);
  return { exitCode: await spawned.exited, stdout, stderr };
};
