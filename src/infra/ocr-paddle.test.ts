import { describe, expect, it } from 'bun:test';
import { createPaddleOcr } from './ocr-paddle.ts';
import type { ShellRun } from './ocr-paddle.ts';

// Trimmed from a real `paddleocr ocr -i probe.png --lang en` run: the dump holds many quoted keys,
// and only the strings inside `rec_texts` are what the image actually said.
const REAL_OUTPUT = `[2026/07/23 21:21:44] paddleocr INFO: Processed item 0 in 4412.97 ms
{'res': {'input_path': '/tmp/ocr-probe.png', 'page_index': None, 'model_settings': {'use_doc_preprocessor': True}, 'text_type': 'general', 'rec_texts': ['SPRINT 4 BACKLOG', 'Owner: Jane'], 'rec_scores': array([0.99868178])}}`;

const readerFor = (run: Partial<ShellRun>, capture: string[][] = []): ReturnType<typeof createPaddleOcr> =>
  createPaddleOcr({
    lang: 'en',
    shell: async (command) => {
      capture.push([...command]);
      return { exitCode: 0, stdout: '', stderr: '', ...run };
    },
  });

describe('reading the text out of an image', () => {
  it('the lines PaddleOCR recognised come back, and nothing else from its dump', async () => {
    expect(await readerFor({ stdout: REAL_OUTPUT }).read('kb/Site/Documents/Tableau.jpg')).toEqual({ ok: true, value: 'SPRINT 4 BACKLOG\nOwner: Jane' });
  });

  it('an image holding no text comes back empty rather than as a failure', async () => {
    expect(await readerFor({ stdout: "{'res': {'rec_texts': [], 'rec_scores': array([])}}" }).read('photo.jpg')).toEqual({ ok: true, value: '' });
  });

  it('a scan spanning several pages returns every page in order', async () => {
    const twoPages = "{'res': {'rec_texts': ['page one']}}\n{'res': {'rec_texts': ['page two']}}";

    expect(await readerFor({ stdout: twoPages }).read('scan.png')).toEqual({ ok: true, value: 'page one\npage two' });
  });

  it('the image is passed by path with the language the run asked for', async () => {
    const capture: string[][] = [];
    await readerFor({ stdout: REAL_OUTPUT }, capture).read('kb/Site/Tableau.jpg');

    expect(capture[0]).toEqual(['paddleocr', 'ocr', '-i', 'kb/Site/Tableau.jpg', '--lang', 'en']);
  });

  it('a failing run reports what PaddleOCR said last rather than a bare exit code', async () => {
    const failed = await readerFor({ exitCode: 1, stderr: 'Traceback...\nValueError: unsupported image format' }).read('photo.heic');

    expect(failed).toEqual({ ok: false, error: { kind: 'failed', message: 'ValueError: unsupported image format' } });
  });

  it('a failing run that said nothing still reports the exit code', async () => {
    const failed = await readerFor({ exitCode: 2, stderr: '  ' }).read('photo.jpg');

    expect(failed).toEqual({ ok: false, error: { kind: 'failed', message: 'paddleocr exited 2' } });
  });

  it('PaddleOCR not being installed is reported as unavailable, not as an unreadable image', async () => {
    const ocr = createPaddleOcr({
      lang: 'en',
      shell: async () => {
        throw new Error('spawn paddleocr ENOENT');
      },
    });

    const read = await ocr.read('photo.jpg');

    expect(read.ok === false && read.error.kind).toBe('unavailable');
  });
});
