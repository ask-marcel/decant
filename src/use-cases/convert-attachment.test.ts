import { describe, expect, it } from 'bun:test';
import type { DocumentStamp } from '../domain/kb-document.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import type { OcrSeed } from '../test-helpers/ocr-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createConvertAttachment } from './convert-attachment.ts';
import type { AttachmentOutcome } from './convert-attachment.ts';
import type { MailAttachment } from './ports/mail-reader.ts';

const FOLDER = 'kb/Mailbox/threads/2026/2026-05-12 Contrat a3f9c1_attachments';

const stamp: DocumentStamp = {
  source: 'https://outlook.office.com/mail/id/m1',
  site: 'Mailbox',
  library: 'Inbox',
  path: 'Contrat MOOV',
  lastModified: '2026-05-12T09:31:00Z',
  syncedAt: '2026-07-23T14:00:00Z',
};

const attachment = (over: Partial<MailAttachment> = {}): MailAttachment => ({
  id: 'att1',
  name: 'Contrat.docx',
  contentType: 'application/vnd.openxmlformats',
  size: 4096,
  isInline: false,
  ...over,
});

const run = async (
  over: Partial<MailAttachment> = {},
  seeds: { reader?: MailReaderSeed; files?: FilesFakeSeed; ocr?: OcrSeed; drive?: DriveReaderSeed; maxBytes?: number } = {}
): Promise<{ outcome: AttachmentOutcome; files: FilesFake }> => {
  const files = createFilesFake(seeds.files);
  const drive = createDriveReaderFake(seeds.drive);
  const convert = createConvertAttachment({ reader: createMailReaderFake(seeds.reader), files, ocr: createOcrFake(seeds.ocr), unpackArchive: drive.localArchive });
  const outcome = await convert({
    messageId: 'm1',
    attachment: attachment(over),
    folder: FOLDER,
    stamp,
    maxBytes: seeds.maxBytes ?? 50 * 1024 * 1024,
    ocrLabel: 'paddleocr (en)',
  });
  return { outcome, files };
};

describe('keeping what was attached to a mail', () => {
  it('a Word attachment lands as markdown beside the conversation', async () => {
    const { outcome, files } = await run();

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Contrat.docx.md`] });
    expect(files.written.get(`${FOLDER}/Contrat.docx.md`)).toContain('converted att1');
  });

  it('the attachment carries the same provenance as the conversation it came with', async () => {
    const { files } = await run();

    expect(files.written.get(`${FOLDER}/Contrat.docx.md`)).toContain('source: https://outlook.office.com/mail/id/m1');
  });

  it('an attachment that converted to nothing still lands, with a note in its place', async () => {
    const { files } = await run({ name: 'Vide.docx' }, { reader: { attachmentTexts: { att1: '   ' } } });

    expect(files.written.get(`${FOLDER}/Vide.docx.md`)).toContain('No text could be read');
  });

  it('a deck attachment lands as markdown and a PDF, pointing at each other', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Roadmap.pptx.pdf`, `${FOLDER}/Roadmap.pptx.md`] });
    expect(files.written.get(`${FOLDER}/Roadmap.pptx.md`)).toContain('pdf: ./Roadmap.pptx.pdf');
    expect(files.binary.has(`${FOLDER}/Roadmap.pptx.pdf`)).toBe(true);
  });

  it('a PDF attachment is kept as it came, with its text beside it', async () => {
    const { outcome, files } = await run({ name: 'Contrat.pdf' });

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Contrat.pdf`, `${FOLDER}/Contrat.pdf.md`] });
    expect(files.written.get(`${FOLDER}/Contrat.pdf.md`)).toContain('pdf: ./Contrat.pdf');
  });

  it('a scanned PDF attachment says so rather than pretending to have text', async () => {
    const { outcome, files } = await run({ name: 'Scan.pdf' }, { reader: { attachmentTexts: { att1: '' } } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get(`${FOLDER}/Scan.pdf.md`)).toContain('carries no text layer');
  });

  it('a scanned PDF attachment has its pages read by OCR when it carries no text layer', async () => {
    const { files } = await run({ name: 'Scan.pdf' }, { reader: { attachmentTexts: { att1: '' } }, ocr: { texts: { [`${FOLDER}/Scan.pdf`]: 'Invoice total 1200 EUR' } } });
    const written = files.written.get(`${FOLDER}/Scan.pdf.md`) ?? '';

    expect(written).toContain('Invoice total 1200 EUR');
    expect(written).toContain('ocr: paddleocr (en)');
  });

  it('a PDF attachment that has a text layer keeps that text rather than a note', async () => {
    const { files } = await run({ name: 'Contrat.pdf' }, { reader: { attachmentTexts: { att1: 'The signed contract.' } } });
    const written = files.written.get(`${FOLDER}/Contrat.pdf.md`) ?? '';

    expect(written).toContain('The signed contract.');
    expect(written).not.toContain('carries no text layer');
  });

  it('a PDF attachment whose text layer is only whitespace is treated as scanned and read by OCR', async () => {
    const { files } = await run({ name: 'Scan.pdf' }, { reader: { attachmentTexts: { att1: '   ' } }, ocr: { texts: { [`${FOLDER}/Scan.pdf`]: 'Read by OCR' } } });

    expect(files.written.get(`${FOLDER}/Scan.pdf.md`) ?? '').toContain('Read by OCR');
  });

  it('a scanned PDF attachment whose OCR finds only whitespace still falls back to the note', async () => {
    const { files } = await run({ name: 'Scan.pdf' }, { reader: { attachmentTexts: { att1: '' } }, ocr: { texts: { [`${FOLDER}/Scan.pdf`]: '   ' } } });

    expect(files.written.get(`${FOLDER}/Scan.pdf.md`) ?? '').toContain('carries no text layer');
  });

  it('a photo attachment is kept, with the text read out of it', async () => {
    const { outcome, files } = await run({ name: 'Tableau.jpg' }, { ocr: { texts: { [`${FOLDER}/Tableau.jpg`]: 'Sprint 4 backlog' } } });
    const written = files.written.get(`${FOLDER}/Tableau.jpg.md`) ?? '';

    expect(outcome.kind).toBe('converted');
    expect(written).toContain('image: ./Tableau.jpg');
    expect(written).toContain('Sprint 4 backlog');
  });

  it('a photo holding no readable text still lands with a note', async () => {
    const { files } = await run({ name: 'Tableau.jpg' });

    expect(files.written.get(`${FOLDER}/Tableau.jpg.md`)).toContain('No text could be read');
  });

  it('a photo whose text could not be read does not claim it was read', async () => {
    const { files } = await run({ name: 'Tableau.jpg' }, { ocr: { failWith: { kind: 'unavailable', message: 'paddleocr missing' } } });

    expect(files.written.get(`${FOLDER}/Tableau.jpg.md`)).not.toContain('ocr:');
  });

  it('a drawing attachment is kept with a note pointing at the file', async () => {
    const { files } = await run({ name: 'Logo.svg' });

    expect(files.written.get(`${FOLDER}/Logo.svg.md`)).toContain('Open the file beside this note');
  });

  it('an archive attachment becomes a folder holding one markdown file per document inside it', async () => {
    const entries = [
      { path: 'notes.docx', text: '# Notes' },
      { path: 'sous-dossier/deck.pptx', text: '## Slide 1' },
    ];
    const { outcome, files } = await run({ name: 'Livraison.zip' }, { drive: { archiveEntries: entries } });

    expect(outcome.kind).toBe('converted');
    expect(files.binary.has(`${FOLDER}/Livraison/Livraison.zip`)).toBe(true);
    expect(files.written.get(`${FOLDER}/Livraison/notes.docx.md`)).toContain('# Notes');
    expect(files.written.get(`${FOLDER}/Livraison/sous-dossier/deck.pptx.md`)).toContain('## Slide 1');
  });

  it('a document unpacked from an archive records where it sat inside it', async () => {
    const { files } = await run({ name: 'Livraison.zip' }, { drive: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(files.written.get(`${FOLDER}/Livraison/notes.docx.md`)).toContain('zip_entry: notes.docx');
  });

  it('a document inside an archive that could not be converted keeps the reason in its place', async () => {
    const { files } = await run({ name: 'Livraison.zip' }, { drive: { archiveEntries: [{ path: 'video.mp4', note: 'unsupported entry' }] } });

    expect(files.written.get(`${FOLDER}/Livraison/video.mp4.md`)).toContain('unsupported entry');
  });

  it('an archive that cannot be unpacked is reported after its bytes were kept', async () => {
    const { outcome, files } = await run({ name: 'Livraison.zip' }, { drive: { failWith: { kind: 'permanent', message: 'not a zip' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'permanent: not a zip' });
    expect(files.binary.has(`${FOLDER}/Livraison/Livraison.zip`)).toBe(true);
  });

  it('a signature image inlined in the mail is handled like any other picture', async () => {
    const { outcome } = await run({ name: 'logo-signature.png', isInline: true });

    expect(outcome.kind).toBe('converted');
  });

  it('an attachment of a type this tool does not handle is reported', async () => {
    expect((await run({ name: 'Demo.mp4' })).outcome).toEqual({ kind: 'skipped', reason: 'unsupported-type' });
  });

  it('an attachment above the size cap is reported rather than stalling the thread', async () => {
    expect((await run({ size: 60 * 1024 * 1024 })).outcome).toEqual({ kind: 'skipped', reason: 'too-large' });
  });

  it('an attachment Microsoft refused to convert is reported with the reason', async () => {
    const { outcome } = await run({}, { reader: { failWith: { kind: 'permanent', status: 415, message: 'cannot convert' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'permanent: cannot convert' });
  });

  it('a deck whose PDF cannot be rendered is reported before any markdown is written', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx' }, { reader: { failWith: { kind: 'transient', message: 'render timed out' } } });

    expect(outcome.kind).toBe('failed');
    expect(files.written.size).toBe(0);
  });

  it('a photo whose bytes cannot be fetched is reported', async () => {
    const { outcome } = await run({ name: 'Tableau.jpg' }, { reader: { failWith: { kind: 'permanent', status: 404, message: 'gone' } } });

    expect(outcome.kind).toBe('failed');
  });

  it('a deck whose text cannot be read is reported, even though its PDF arrived', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx' }, { reader: { failCalls: { attachmentMarkdown: { kind: 'permanent', message: 'no text' } } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'permanent: no text' });
    expect(files.binary.has(`${FOLDER}/Roadmap.pptx.pdf`)).toBe(true);
    expect(files.written.has(`${FOLDER}/Roadmap.pptx.md`)).toBe(false);
  });

  it('a PDF whose text cannot be read still lands, with a note saying to open the file', async () => {
    const { outcome, files } = await run({ name: 'Contrat.pdf' }, { reader: { failCalls: { attachmentMarkdown: { kind: 'permanent', message: 'no text layer' } } } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get(`${FOLDER}/Contrat.pdf.md`)).toContain('carries no text layer');
  });

  it('a document whose bytes are refused is reported before anything is written', async () => {
    const { outcome, files } = await run({ name: 'Logo.svg' }, { reader: { failCalls: { attachmentBytes: { kind: 'transient', message: 'timeout' } } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'transient: timeout' });
    expect(files.binary.size).toBe(0);
  });

  it('a deck whose PDF is refused is reported before its bytes are written', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx' }, { reader: { failCalls: { attachmentPdf: { kind: 'transient', message: 'render failed' } } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'transient: render failed' });
    expect(files.binary.size).toBe(0);
  });

  it('a knowledge base that cannot be written to is reported rather than losing the attachment', async () => {
    const { outcome } = await run({}, { files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'write-failed: disk full' });
  });

  it('an attachment whose name the filesystem cannot hold is made safe first', async () => {
    const { outcome } = await run({ name: 'Q1/Q2: budget.docx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Q1_Q2_ budget.docx.md`] });
  });

  it('a deck attachment keeps the text read from it rather than a note', async () => {
    const { files } = await run({ name: 'Roadmap.pptx' }, { reader: { attachmentTexts: { att1: 'Slide content here' } } });

    expect(files.written.get(`${FOLDER}/Roadmap.pptx.md`)).toContain('Slide content here');
  });

  it('a deck attachment whose text is only whitespace lands with a note beside its PDF', async () => {
    const { files } = await run({ name: 'Vide.pptx' }, { reader: { attachmentTexts: { att1: '   ' } } });

    expect(files.written.get(`${FOLDER}/Vide.pptx.md`)).toContain('No text could be read');
  });

  it('a drawing attachment lands with exactly the file and its note, named for the drawing', async () => {
    const { outcome, files } = await run({ name: 'Logo.svg' });

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Logo.svg`, `${FOLDER}/Logo.svg.md`] });
    expect(files.written.get(`${FOLDER}/Logo.svg.md`)).toContain('image: ./Logo.svg');
  });

  it('an archive attachment lands with the archive file and one markdown per entry, in order', async () => {
    const { outcome } = await run({ name: 'Livraison.zip' }, { drive: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Livraison/Livraison.zip`, `${FOLDER}/Livraison/notes.docx.md`] });
  });
});
