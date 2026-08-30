import { describe, expect, it } from 'bun:test';
import { unsupportedReason } from './report.ts';
import type { CarriedFile } from './mail-body.ts';
import { renderAttachmentList, rewriteMessageBody, withoutAttachmentList } from './mail-body.ts';

// The words the vault uses to say a block was read off a picture rather than typed by a person.
// Pinned here because saying it in words is the point: a `>` block alone reads as quoted mail.
const NOTE = '_Text below was read out of the picture by OCR, so it can be wrong. Open the image above to check._';

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
    const rendered = renderAttachmentList([{ name: 'Demo.mp4', size: 12_900_000, contentType: 'video/mp4', note: unsupportedReason('Demo.mp4') }]);

    expect(rendered).toBe('**Attachments:**\n- Demo.mp4 (12.3 MB, video/mp4), a .mp4 file, which this tool does not read');
  });

  it('a small file is measured in bytes rather than a rounded nothing', () => {
    const rendered = renderAttachmentList([{ name: 'note.txt', size: 512, contentType: 'text/plain', path: './note.txt.md' }]);

    expect(rendered).toContain('(512 B, text/plain)');
  });

  it('a file the source never typed is measured without an empty type beside it', () => {
    const rendered = renderAttachmentList([{ name: 'noname', size: 2048, contentType: '', path: './noname.md' }]);

    expect(rendered).toBe('**Attachments:**\n- [noname](./noname.md) (2.0 KB)');
  });

  it('exactly a kilobyte reads as one, not as a thousand and twenty-four bytes', () => {
    expect(renderAttachmentList([{ name: 'a.txt', size: 1024, contentType: 'text/plain' }])).toContain('(1.0 KB, text/plain)');
  });

  it('exactly a megabyte reads as one, not as a thousand kilobytes', () => {
    expect(renderAttachmentList([{ name: 'a.bin', size: 1024 * 1024, contentType: '' }])).toContain('(1.0 MB)');
  });

  it('a message that carried nothing renders no list at all', () => {
    expect(renderAttachmentList([])).toBe('');
  });
});

// What one message carried, as the thread knows it by the time the body is written: the files are
// converted, their paths are relative to the folder the thread sits in, and a picture the body
// showed inline carries the picture itself beside the markdown read out of it.
const LOGO: CarriedFile = {
  name: 'image931066.png',
  size: 64760,
  contentType: 'image/png',
  contentId: 'image931066.png@1B0A3865.2858A107',
  isInline: true,
  path: '../../_attachments/image931066-a1b2c3d4.png.md',
  picture: '../../_attachments/image931066-a1b2c3d4.png',
};

const CV: CarriedFile = {
  name: 'Jerry+Zhang-EN.pdf',
  size: 299110,
  contentType: 'application/pdf',
  contentId: '',
  isInline: false,
  path: '../../_attachments/Jerry+Zhang-EN-d8871f82.pdf.md',
};

describe('what a message body says once the files it carried are on disk', () => {
  // The wiring, not the function. `withoutPlaceholders` had its own tests and passed them while
  // nothing called it, so the vault kept ten markers a re-sync was supposed to have taken away.
  it('a marker for a file nothing could place is gone from the rewritten body', () => {
    const refused: CarriedFile = { ...LOGO, path: undefined, picture: undefined };
    const rewritten = rewriteMessageBody('Hi,\n\n\\[inline image: image931066.png\\]\n\nRegards,', [refused]);

    expect(rewritten.body).toContain('Hi,');
    expect(rewritten.body).toContain('Regards,');
    expect(rewritten.body).not.toContain('inline image:');
  });

  // The picture and its words arrive together or the words are lost: nothing else in the thread
  // names an inline picture, so a reader who does not open it never learns what it said.
  it('the text read out of an inline picture is carried into the body under it', () => {
    const withText: CarriedFile = { ...LOGO, text: 'Michael Pronk\nStratego Development' };
    const { body } = rewriteMessageBody('Regards,\n\n\\[inline image: image931066.png\\]', [withText]);

    expect(body).toBe(`Regards,\n\n![image931066.png](../../_attachments/image931066-a1b2c3d4.png)\n\n${NOTE}\n\n> Michael Pronk\n> Stratego Development`);
  });

  it('a picture the message showed is shown again, from where it landed', () => {
    const rewritten = rewriteMessageBody('Regards,\n\n\\[inline image: image931066.png\\]', [LOGO]);

    expect(rewritten.body).toBe('Regards,\n\n![image931066.png](../../_attachments/image931066-a1b2c3d4.png)');
    expect(rewritten.pictures).toEqual(['../../_attachments/image931066-a1b2c3d4.png']);
  });

  it('a picture put back in the body is not listed under it as well', () => {
    expect(rewriteMessageBody('\\[inline image: image931066.png\\]', [LOGO]).body).not.toContain('**Attachments:**');
  });

  it('a file the message carried is named below it, linking where it landed', () => {
    const rewritten = rewriteMessageBody('Please find the CV attached.', [CV]);

    expect(rewritten.body).toBe(
      'Please find the CV attached.\n\n**Attachments:**\n- [Jerry+Zhang-EN.pdf](../../_attachments/Jerry+Zhang-EN-d8871f82.pdf.md) (292.1 KB, application/pdf)'
    );
    expect(rewritten.pictures).toEqual([]);
  });

  it('the list the converter left is replaced rather than added to', () => {
    const rewritten = rewriteMessageBody(CONVERTED, [CV]);

    expect(rewritten.body.split('**Attachments:**')).toHaveLength(2);
    expect(rewritten.body).not.toContain('id: AAMkADc3');
  });

  // Shown after the text rather than listed as a file to open. A picture the message carried inline
  // is part of the message however the pairing turned out, and the conversion drops placeholders
  // often enough that "no placeholder" says nothing about whether the picture belonged in the body.
  it('a picture no placeholder answered is shown after the text, not listed as a file', () => {
    const rewritten = rewriteMessageBody('No picture stood here.', [LOGO]);

    expect(rewritten.body).toBe('No picture stood here.\n\n![image931066.png](../../_attachments/image931066-a1b2c3d4.png)');
    expect(rewritten.body).not.toContain('**Attachments:**');
    expect(rewritten.pictures).toEqual(['../../_attachments/image931066-a1b2c3d4.png']);
  });

  it('a picture that was too large to keep is named with the reason, not shown', () => {
    const refused: CarriedFile = { ...LOGO, path: undefined, picture: undefined, note: 'larger than the 50 MB cap' };
    const rewritten = rewriteMessageBody('\\[inline image: image931066.png\\]', [refused]);

    expect(rewritten.body).toContain('- image931066.png (63.2 KB, image/png), larger than the 50 MB cap');
    // The marker goes with it. Nothing was placed, so it names a file that is not there, and the
    // list above already says what arrived and why it is not here.
    expect(rewritten.body).not.toContain('inline image:');
  });

  it('a picture attached rather than pasted is listed, never put into the body', () => {
    const attached: CarriedFile = { ...LOGO, isInline: false };
    const rewritten = rewriteMessageBody('\\[inline image: image931066.png\\]', [attached]);

    expect(rewritten.body).toContain('**Attachments:**');
    // Attached rather than pasted, so nothing shows it and no marker stands where it did not.
    expect(rewritten.body).not.toContain('inline image:');
    expect(rewritten.pictures).toEqual([]);
  });

  it('a message that carried nothing keeps its text and gains no list', () => {
    expect(rewriteMessageBody('Hi Vincent,\n\nNothing attached.', [])).toEqual({ body: 'Hi Vincent,\n\nNothing attached.', pictures: [] });
  });
});
