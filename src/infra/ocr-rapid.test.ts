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

const readerFor = (run: Partial<ShellRun>, capture: string[][] = []): ReturnType<typeof createRapidOcr> =>
  createRapidOcr({
    lang: 'en',
    shell: async (command) => {
      capture.push([...command]);
      return { exitCode: 0, stdout: '', stderr: '', ...run };
    },
  });

describe('reading the text out of an image', () => {
  it('the lines RapidOCR recognised come back, and nothing else', async () => {
    expect(await readerFor({ stdout: REAL_OUTPUT }).read('kb/Site/Documents/Tableau.jpg')).toEqual({ ok: true, value: 'WEHAVELIFTOFF!\nMAXWT' });
  });

  it('an image holding no text comes back empty rather than as a failure', async () => {
    expect(await readerFor({ stdout: '[]' }).read('photo.jpg')).toEqual({ ok: true, value: '' });
  });

  it('the image is passed by path with the language the run asked for, through the bundled script', async () => {
    const capture: string[][] = [];
    await readerFor({ stdout: REAL_OUTPUT }, capture).read('kb/Site/Tableau.jpg');

    expect(capture[0]?.[0]).toBe('python3');
    expect(capture[0]?.[1]).toEndWith('rapidocr-run.py');
    expect(capture[0]?.[2]).toBe('kb/Site/Tableau.jpg');
    expect(capture[0]?.[3]).toBe('en');
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

describe('a run with reading turned off', () => {
  it('reports every read as unavailable, so a file falls back to its note without OCR', async () => {
    const read = await createNoOcr().read('kb/Site/Documents/Scan.pdf');

    expect(read).toEqual({ ok: false, error: { kind: 'unavailable', message: 'ocr disabled' } });
  });
});
