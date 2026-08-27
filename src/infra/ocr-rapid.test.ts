import { describe, expect, it } from 'bun:test';
import { createNoOcr, createRapidOcr } from './ocr-rapid.ts';
import type { ShellRun } from './ocr-rapid.ts';

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
  it('reads with the Chinese model first, and keeps that reading when the image is Chinese', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf(CHINESE)], capture).read('kb/Site/Annonce.jpg');

    expect(read).toEqual({ ok: true, value: { text: CHINESE, label: 'rapidocr (ch)' } });
    expect(capture).toHaveLength(1);
    expect(capture[0]?.slice(3)).toEqual(['ch', 'PP-OCRv4']);
  });

  it('reads a Latin image again with the Latin model, so the words keep their spaces and accents', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf(RUN_TOGETHER), linesOf(SPACED)], capture).read('kb/Site/Nota.png');

    expect(read).toEqual({ ok: true, value: { text: SPACED, label: 'rapidocr (latin)' } });
    expect(capture).toHaveLength(2);
    expect(capture[1]?.slice(3)).toEqual(['latin', 'PP-OCRv5']);
  });

  it('a Chinese page carrying an English brand name is not read a second time', async () => {
    const capture: string[][] = [];

    const read = await chooserOver([linesOf('欢迎使用 Contoso 系统，请先登录。')], capture).read('kb/Site/Bienvenue.jpg');

    expect(read.ok === true && read.value.label).toBe('rapidocr (ch)');
    expect(capture).toHaveLength(1);
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
