import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileOcrCache, createNoOcr, createRapidOcr } from './ocr-rapid.ts';
import type { OcrCache, ShellRun } from './ocr-rapid.ts';
import type { OcrReading } from '../use-cases/ports/ocr.ts';

// Trimmed from a real `en_PP-OCRv4` run against a live image this session: to_json() gives one
// clean line of [{box, txt, score}], nothing else — RapidOCR's own logging goes to stderr.
const REAL_OUTPUT = JSON.stringify([
  {
    box: [
      [134, 23],
      [1697, 25],
      [1697, 179],
      [134, 177],
    ],
    txt: 'WEHAVELIFTOFF!',
    score: 0.98673,
  },
  {
    box: [
      [1096, 299],
      [1230, 225],
      [1253, 267],
      [1120, 341],
    ],
    txt: 'MAXWT',
    score: 0.95481,
  },
]);

// The boxes carry no meaning past the first fixture: only `txt` is read back out.
const linesOf = (...texts: ReadonlyArray<string>): string => JSON.stringify(texts.map((txt) => ({ box: [[0, 0]], txt, score: 0.98 })));

const CHINESE = '公司年度会议将于下周举行，请各部门准时参加。';
const JAPANESE = '社内お知らせ\n四半期ごとに優秀な社員を選出します。';
const RUN_TOGETHER = 'Toegangtotgegevens';
const SPACED = 'Toegang tot gegevens';

const readerFor = (run: Partial<ShellRun>, capture: string[][] = [], lang = 'en'): ReturnType<typeof createRapidOcr> =>
  createRapidOcr({
    lang,
    shell: async (command) => {
      capture.push([...command]);
      return { exitCode: 0, stdout: '', stderr: '', ...run };
    },
  });

// Each successive reading of the same image answers from the next entry, so a run that reads twice
// can be told apart from one that reads once.
const chooserOver = (outputs: ReadonlyArray<string>, capture: string[][] = []): ReturnType<typeof createRapidOcr> =>
  createRapidOcr({
    lang: 'auto',
    shell: async (command) => {
      capture.push([...command]);
      return { exitCode: 0, stdout: outputs[capture.length - 1] ?? '[]', stderr: '' };
    },
  });

describe('reading the text out of an image', () => {
  it('the lines RapidOCR recognised come back, and nothing else', async () => {
    expect(await readerFor({ stdout: REAL_OUTPUT }).read('kb/Site/Documents/Tableau.jpg')).toEqual({
      ok: true,
      value: { text: 'WEHAVELIFTOFF!\nMAXWT', label: 'rapidocr (en)' },
    });
  });

  it('an image holding no text comes back empty rather than as a failure', async () => {
    expect(await readerFor({ stdout: '[]' }).read('photo.jpg')).toEqual({ ok: true, value: { text: '', label: 'rapidocr (en)' } });
  });

  it('the image is passed by path with the language the run asked for, through the bundled script', async () => {
    const capture: string[][] = [];
    await readerFor({ stdout: REAL_OUTPUT }, capture).read('kb/Site/Tableau.jpg');

    expect(capture[0]?.[0]).toBe('python3');
    expect(capture[0]?.[1]).toEndWith('rapidocr-run.py');
    expect(capture[0]?.[2]).toBe('kb/Site/Tableau.jpg');
    expect(capture[0]?.slice(3)).toEqual(['en', 'PP-OCRv4']);
  });

  it('a failing run reports what RapidOCR said last rather than a bare exit code', async () => {
    const failed = await readerFor({ exitCode: 1, stderr: 'Traceback...\nValueError: not a valid LangRec' }).read('photo.heic');

    expect(failed).toEqual({ ok: false, error: { kind: 'failed', message: 'ValueError: not a valid LangRec' } });
  });

  it('a failing run that said nothing still reports the exit code', async () => {
    const failed = await readerFor({ exitCode: 2, stderr: '  ' }).read('photo.jpg');

    expect(failed).toEqual({ ok: false, error: { kind: 'failed', message: 'rapidocr exited 2' } });
  });

  it('malformed output is reported as unavailable, not as an unreadable image', async () => {
    const read = await readerFor({ stdout: 'not json' }).read('photo.jpg');

    expect(read.ok === false && read.error.kind).toBe('unavailable');
  });

  it('RapidOCR not being installed is reported as unavailable, not as an unreadable image', async () => {
    const ocr = createRapidOcr({
      lang: 'en',
      shell: async () => {
        throw new Error('spawn python3 ENOENT');
      },
    });

    const read = await ocr.read('photo.jpg');

    expect(read.ok === false && read.error.kind).toBe('unavailable');
  });
});

describe('a run that left the language to the image', () => {
  it('the widest model looks first, so one reading can say which script the image is in', async () => {
    const capture: string[][] = [];

    await chooserOver([linesOf(CHINESE), linesOf(CHINESE)], capture).read('kb/Site/Annonce.jpg');

    expect(capture[0]?.slice(3)).toEqual(['ch', 'PP-OCRv5']);
  });

  it('a Chinese page is read again by the model that reads Chinese most completely', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf(CHINESE), linesOf(CHINESE)], capture).read('kb/Site/Annonce.jpg');

    expect(read).toEqual({ ok: true, value: { text: CHINESE, label: 'rapidocr (ch)' } });
    expect(capture).toHaveLength(2);
    expect(capture[1]?.slice(3)).toEqual(['ch', 'PP-OCRv4']);
  });

  it('a Japanese page is read again by the model that has kana in its dictionary', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf(JAPANESE), linesOf(JAPANESE)], capture).read('kb/Site/Oshirase.png');

    expect(read).toEqual({ ok: true, value: { text: JAPANESE, label: 'rapidocr (japan)' } });
    expect(capture[1]?.slice(3)).toEqual(['japan', 'PP-OCRv4']);
  });

  it('reads a Latin image again with the Latin model, so the words keep their spaces and accents', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf(RUN_TOGETHER), linesOf(SPACED)], capture).read('kb/Site/Nota.png');

    expect(read).toEqual({ ok: true, value: { text: SPACED, label: 'rapidocr (latin)' } });
    expect(capture).toHaveLength(2);
    expect(capture[1]?.slice(3)).toEqual(['latin', 'PP-OCRv5']);
  });

  it('an image the first reading found no text in is not read a second time', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf()], capture).read('kb/Site/Logo.png');

    expect(read).toEqual({ ok: true, value: { text: '', label: 'rapidocr (ch)' } });
    expect(capture).toHaveLength(1);
  });

  it('a first reading that failed is reported rather than tried again in another language', async () => {
    const capture: string[][] = [];
    const ocr = createRapidOcr({
      lang: 'auto',
      shell: async (command) => {
        capture.push([...command]);
        return { exitCode: 1, stdout: '', stderr: 'MemoryError' };
      },
    });

    const read = await ocr.read('kb/Site/Enorme.png');

    expect(read).toEqual({ ok: false, error: { kind: 'failed', message: 'MemoryError' } });
    expect(capture).toHaveLength(1);
  });
});

describe('a run that named its own language', () => {
  it('the named language is used as it stands, without a second reading', async () => {
    const capture: string[][] = [];

    const read = await readerFor({ stdout: linesOf(RUN_TOGETHER) }, capture, 'ch').read('kb/Site/Nota.png');

    expect(read).toEqual({ ok: true, value: { text: RUN_TOGETHER, label: 'rapidocr (ch)' } });
    expect(capture).toHaveLength(1);
  });
});

describe('a run with reading turned off', () => {
  it('reports every read as unavailable, so a file falls back to its note without OCR', async () => {
    const read = await createNoOcr().read('kb/Site/Documents/Scan.pdf');

    expect(read).toEqual({ ok: false, error: { kind: 'unavailable', message: 'ocr disabled' } });
  });
});

// A cache kept in memory rather than on disk: what is being tested is when the adapter reads and
// writes one, not how the files are laid out.
const cacheFake = (): { readonly cache: OcrCache; readonly held: Map<string, OcrReading>; readonly asked: string[] } => {
  const held = new Map<string, OcrReading>();
  const asked: string[] = [];
  return {
    held,
    asked,
    cache: {
      digest: async (path) => `hash-of-${path}`,
      load: async (key) => {
        asked.push(key);
        return held.get(key);
      },
      save: async (key, reading) => {
        held.set(key, reading);
      },
    },
  };
};

describe('keeping what OCR read, so an image is only read once', () => {
  it('an image read before answers from what was kept, without spawning anything', async () => {
    const { cache, held } = cacheFake();
    held.set('hash-of-a.jpg-en', { text: 'kept', label: 'rapidocr (en)' });
    const capture: string[][] = [];
    const ocr = createRapidOcr({ lang: 'en', cache, shell: async (command) => (capture.push([...command]), { exitCode: 0, stdout: REAL_OUTPUT, stderr: '' }) });

    expect(await ocr.read('a.jpg')).toEqual({ ok: true, value: { text: 'kept', label: 'rapidocr (en)' } });
    expect(capture).toEqual([]);
  });

  it('an image read for the first time is kept, so the next run does not read it again', async () => {
    const { cache, held } = cacheFake();
    const ocr = createRapidOcr({ lang: 'en', cache, shell: async () => ({ exitCode: 0, stdout: REAL_OUTPUT, stderr: '' }) });

    await ocr.read('a.jpg');

    expect(held.get('hash-of-a.jpg-en')?.text).toContain('WEHAVELIFTOFF!');
  });

  // The language is part of the key. An explicit `--ocr-lang japan` run must not read back what an
  // `auto` run decided, or a deliberate correction would answer with the mistake it was correcting.
  it('a reading kept under one language is not answered to a run asking for another', async () => {
    const { cache, held } = cacheFake();
    held.set('hash-of-a.jpg-en', { text: 'english', label: 'rapidocr (en)' });
    const ocr = createRapidOcr({ lang: 'japan', cache, shell: async () => ({ exitCode: 0, stdout: REAL_OUTPUT, stderr: '' }) });

    expect((await ocr.read('a.jpg')).ok && (await ocr.read('a.jpg'))).not.toMatchObject({ value: { text: 'english' } });
  });

  // A failure is a state of the machine, not of the image: python missing, a model not downloaded,
  // `--no-ocr`. Keeping one would answer every later run with it, and the image would never be read.
  it('a read that failed is not kept, so the next run tries the image again', async () => {
    const { cache, held } = cacheFake();
    const ocr = createRapidOcr({ lang: 'en', cache, shell: async () => ({ exitCode: 1, stdout: '', stderr: 'no model' }) });

    expect((await ocr.read('a.jpg')).ok).toBe(false);
    expect(held.size).toBe(0);
  });

  it('an image whose bytes cannot be read is still OCRd, just not kept', async () => {
    const noDigest: OcrCache = { digest: async () => undefined, load: async () => undefined, save: async () => undefined };
    const ocr = createRapidOcr({ lang: 'en', cache: noDigest, shell: async () => ({ exitCode: 0, stdout: REAL_OUTPUT, stderr: '' }) });

    expect((await ocr.read('a.jpg')).ok).toBe(true);
  });

  it('a run with no cache at all reads the image, as it always did', async () => {
    expect((await readerFor({ stdout: REAL_OUTPUT }).read('a.jpg')).ok).toBe(true);
  });
});

describe('keeping readings on disk between runs', () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'ocr-cache-'));

  it('a reading written is read back whole, with the model that produced it', async () => {
    const root = scratch();
    const cache = createFileOcrCache(root);

    await cache.save('abcdef01-en', { text: 'first line\nsecond line', label: 'rapidocr (en)' });

    expect(await cache.load('abcdef01-en')).toEqual({ text: 'first line\nsecond line', label: 'rapidocr (en)' });
    rmSync(root, { recursive: true, force: true });
  });

  it('an image nothing has read yet has nothing kept for it', async () => {
    const root = scratch();

    expect(await createFileOcrCache(root).load('nothing-here-en')).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  // Addressed by its bytes, so a picture renamed, moved, or arriving again as somebody else's
  // attachment answers from the same entry.
  it('two files holding the same bytes address to the same entry, whatever they are called', async () => {
    const root = scratch();
    const cache = createFileOcrCache(root);
    writeFileSync(join(root, 'one.jpg'), 'same bytes');
    writeFileSync(join(root, 'two.jpg'), 'same bytes');

    expect(await cache.digest(join(root, 'one.jpg'))).toBe(await cache.digest(join(root, 'two.jpg')));
    rmSync(root, { recursive: true, force: true });
  });

  it('a file that is not there has no address, so the run reads it uncached rather than failing', async () => {
    const root = scratch();

    expect(await createFileOcrCache(root).digest(join(root, 'missing.jpg'))).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
