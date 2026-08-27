import { describe, expect, it } from 'bun:test';
import { UNSUPPORTED_REASON } from './report.ts';
import { renderAttachmentList, withoutAttachmentList } from './mail-body.ts';

// A message body as the library hands it back: its own closing list of what the message carried,
// naming a raw Graph id and telling the reader to fetch bytes that are already on disk by then.
const CONVERTED = [
  'Hi Vincent,',
  '',
  'Please find the CV attached.',
  '',
  '**Attachments:**',
  '- Jerry+Zhang-EN.pdf (292.1 KB, application/pdf, id: AAMkADc3NTlhODYyLTgwODItNGVkNA==)',
  '_Use `convert-mail-attachment-to-pdf` or `get-mail-attachment` with the attachment id to fetch._',
].join('\n');

describe('the list of files the converter closes a message with', () => {
  it('is cut away, because the files it names are already converted and beside the thread', () => {
    expect(withoutAttachmentList(CONVERTED)).toBe('Hi Vincent,\n\nPlease find the CV attached.');
  });

  it('a message that carried nothing is left exactly as it came', () => {
    expect(withoutAttachmentList('Hi Vincent,\n\nNo files here.')).toBe('Hi Vincent,\n\nNo files here.');
  });

  it('a sentence merely mentioning the words is not mistaken for the list', () => {
    const body = 'The **Attachments:** heading below is what I meant.';

    expect(withoutAttachmentList(body)).toBe(body);
  });

  it('a message that is nothing but the list keeps none of it', () => {
    expect(withoutAttachmentList('**Attachments:**\n- Contrat.docx (4.0 KB)')).toBe('');
  });
});

describe('naming what a message carried, so a reader opens it where it lies', () => {
  it('a converted file is one line linking where it landed, with no Graph id in sight', () => {
    const rendered = renderAttachmentList([
      { name: 'Jerry+Zhang-EN.pdf', size: 299110, contentType: 'application/pdf', path: '../../_attachments/Jerry+Zhang-EN-d8871f82.pdf.md' },
    ]);

    expect(rendered).toBe('**Attachments:**\n- [Jerry+Zhang-EN.pdf](../../_attachments/Jerry+Zhang-EN-d8871f82.pdf.md) (292.1 KB, application/pdf)');
  });

  it('a file nothing was written for keeps its name and says why', () => {
    const rendered = renderAttachmentList([{ name: 'Demo.mp4', size: 12_900_000, contentType: 'video/mp4', note: UNSUPPORTED_REASON }]);

    expect(rendered).toBe('**Attachments:**\n- Demo.mp4 (12.3 MB, video/mp4), a kind of file this tool does not read');
  });

  it('a small file is measured in bytes rather than a rounded nothing', () => {
    const rendered = renderAttachmentList([{ name: 'note.txt', size: 512, contentType: 'text/plain', path: './note.txt.md' }]);

    expect(rendered).toContain('(512 B, text/plain)');
  });

  it('a file the source never typed is measured without an empty type beside it', () => {
    const rendered = renderAttachmentList([{ name: 'noname', size: 2048, contentType: '', path: './noname.md' }]);

    expect(rendered).toBe('**Attachments:**\n- [noname](./noname.md) (2.0 KB)');
  });

  it('a message that carried nothing renders no list at all', () => {
    expect(renderAttachmentList([])).toBe('');
  });
});
