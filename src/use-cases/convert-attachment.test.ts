import { describe, expect, it } from 'bun:test';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { NO_TEXT_NOTE } from '../domain/kb-document.ts';
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
  path: 'Contrat Contoso',
  lastModified: '2026-05-12T09:31:00Z',
  syncedAt: '2026-07-23T14:00:00Z',
};

const attachment = (over: Partial<MailAttachment> = {}): MailAttachment => ({
  id: 'att1',
  name: 'Contrat.docx',
  contentType: 'application/vnd.openxmlformats',
  size: 4096,
  isInline: false,
  contentId: '',
  ...over,
  kind: over.kind ?? 'file',
});

const ICS = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'SUMMARY:smartMOOV x Lidl', 'DTSTART:20260812T060000Z', 'LOCATION:Teams', 'END:VEVENT', 'END:VCALENDAR'].join(
  '\r\n'
);

const EML = [
  'From: Tina Wu <tina@example.com>',
  'Subject: Fwd: Contrat',
  'Content-Type: multipart/mixed; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain',
  '',
  'Voici le contrat.',
  '--B',
  'Content-Type: application/vnd; name="Contrat.docx"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="Contrat.docx"',
  '',
  'QUJD',
  '--B--',
].join('\r\n');

const run = async (
  over: Partial<MailAttachment> = {},
  seeds: { reader?: MailReaderSeed; files?: FilesFakeSeed; ocr?: OcrSeed; drive?: DriveReaderSeed; maxBytes?: number; rendered?: string } = {}
): Promise<{ outcome: AttachmentOutcome; files: FilesFake }> => {
  const files = createFilesFake(seeds.files);
  const drive = createDriveReaderFake(seeds.drive);
  const convert = createConvertAttachment({
    reader: createMailReaderFake(seeds.reader),
    files,
    ocr: createOcrFake(seeds.ocr),
    logger: createLoggerFake(),
    unpackArchive: drive.localArchive,
    convertLocal: drive.localMarkdown,
  });
  const outcome = await convert({
    messageId: 'm1',
    attachment: attachment(over),
    folder: FOLDER,
    stamp,
    maxBytes: seeds.maxBytes ?? 50 * 1024 * 1024,
    rendered: seeds.rendered,
  });
  return { outcome, files };
};

describe('keeping what was attached to a mail', () => {
  it('a Word attachment lands as markdown beside the conversation', async () => {
    const { outcome, files } = await run();

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Contrat.docx.md`], primary: `${FOLDER}/Contrat.docx.md`, media: [] });
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

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Roadmap.pptx.pdf`, `${FOLDER}/Roadmap.pptx.md`], primary: `${FOLDER}/Roadmap.pptx.md`, media: [] });
    expect(files.written.get(`${FOLDER}/Roadmap.pptx.md`)).toContain('pdf: ./Roadmap.pptx.pdf');
    expect(files.binary.has(`${FOLDER}/Roadmap.pptx.pdf`)).toBe(true);
  });

  it('a PDF attachment is kept as it came, with its text beside it', async () => {
    const { outcome, files } = await run({ name: 'Contrat.pdf' });

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Contrat.pdf`, `${FOLDER}/Contrat.pdf.md`], primary: `${FOLDER}/Contrat.pdf.md`, media: [] });
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
    expect(written).toContain('ocr: rapidocr (latin)');
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

  it('the pictures a Word attachment holds are taken out of it, since it keeps no copy you can look at', async () => {
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { outcome, files } = await run({}, { reader: { attachmentImages: images }, ocr: { texts: { [`${FOLDER}/Contrat.docx.media/word_media_image1.png`]: 'smartMOOV' } } });
    const written = files.written.get(`${FOLDER}/Contrat.docx.md`) ?? '';

    expect(files.binary.has(`${FOLDER}/Contrat.docx.media/word_media_image1.png`)).toBe(true);
    expect(written).toContain('## Images');
    expect(written).toContain('![word_media_image1.png](./Contrat.docx.media/word_media_image1.png)');
    expect(written).toContain('smartMOOV');
    expect(outcome.kind === 'converted' && outcome.media).toEqual([`${FOLDER}/Contrat.docx.media/word_media_image1.png`]);
  });

  it('a kind that keeps a copy you can look at is not asked for its pictures', async () => {
    const { outcome } = await run({ name: 'Contrat.pdf' }, { reader: { attachmentImages: { att1: [{ path: 'p.png', bytes: new Uint8Array([1]) }] } } });

    expect(outcome.kind === 'converted' && outcome.media).toEqual([]);
  });

  it('a picture read that fails costs the pictures and not the text', async () => {
    const { outcome, files } = await run({}, { reader: { failCalls: { attachmentImages: { kind: 'transient', message: 'timed out' } } } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get(`${FOLDER}/Contrat.docx.md`)).toContain('converted att1');
  });

  it('a saved email is unpacked: the message it held, and the file it carried as a file', async () => {
    const { outcome, files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: EML } } });
    const written = files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '';

    expect(written).toContain('**Subject:** Fwd: Contrat');
    expect(written).toContain('Voici le contrat.');
    expect(written).not.toContain('QUJD');
    expect(files.binary.get(`${FOLDER}/Fwd/Contrat.docx`)).toEqual(new Uint8Array([65, 66, 67]));
    expect(files.written.get(`${FOLDER}/Fwd/Contrat.docx.md`)).toContain(`converted ${FOLDER}/Fwd/Contrat.docx`);
    expect(files.written.get(`${FOLDER}/Fwd/Contrat.docx.md`)).toContain('original: ./Contrat.docx');
    expect(outcome).toEqual({
      kind: 'converted',
      outputs: [`${FOLDER}/Fwd/Fwd.eml.md`, `${FOLDER}/Fwd/Contrat.docx`, `${FOLDER}/Fwd/Contrat.docx.md`],
      primary: `${FOLDER}/Fwd/Fwd.eml.md`,
      media: [],
    });
  });

  // The wiring, not the builder. The document standing for a saved email named none of its parts:
  // a spreadsheet the mail was written to send sat converted beside it and was mentioned nowhere.
  it('the document standing for a saved email names what the email carried, and links it', async () => {
    const { files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: EML } } });
    const written = files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '';

    expect(written).toContain('**Carried by this message:**');
    expect(written).toContain('- [Contrat.docx](Contrat.docx.md)');
  });

  // The reading is what a reader wants; when the converter could not make one, the file is all
  // there is and the link has to reach that instead.
  it('a part nothing could read is linked as the file itself, there being no reading to open', async () => {
    const { files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: EML } }, drive: { failWith: { kind: 'permanent', message: 'not convertible' } } });

    expect(files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '').toContain('- [Contrat.docx](Contrat.docx)');
  });

  // Where the sender put it. The signature of a forwarded mail reads `[cid:Logo5_….png]` with the
  // picture on disk beside it under exactly that name, and nothing joined the two up.
  // The wiring, not the builder. The library refuses an image outright, so a signature inside a
  // forwarded mail was kept and never read while the same signature mailed directly was.
  it('a picture inside a saved email is read by OCR, the library refusing to convert one', async () => {
    const withLogo = EML.replace('Voici le contrat.', 'Regards\r\n\r\n[cid:Logo.png]')
      .replace('Content-Type: application/vnd; name="Contrat.docx"', 'Content-Type: image/png; name="Logo.png"')
      .replace('filename="Contrat.docx"', 'filename="Logo.png"');
    const { files } = await run(
      { name: 'Fwd.eml' },
      {
        reader: { attachmentRaw: { att1: withLogo } },
        drive: { failWith: { kind: 'permanent', message: 'png is an image' } },
        ocr: { texts: { [`${FOLDER}/Fwd/Logo.png`]: 'Bartosz Rozga' } },
      }
    );
    const written = files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '';

    expect(written).toContain('![Logo.png](Logo.png)');
    expect(written).toContain('> Bartosz Rozga');
  });

  const asPicture = (): string =>
    EML.replace('Voici le contrat.', 'Regards\r\n\r\n[cid:Logo.png]')
      .replace('Content-Type: application/vnd; name="Contrat.docx"', 'Content-Type: image/png; name="Logo.png"')
      .replace('filename="Contrat.docx"', 'filename="Logo.png"');

  const REFUSED = { failWith: { kind: 'permanent' as const, message: 'png is an image' } };

  it('a picture OCR cannot read is shown alone, with nothing quoted under it', async () => {
    const { files } = await run(
      { name: 'Fwd.eml' },
      { reader: { attachmentRaw: { att1: asPicture() } }, drive: REFUSED, ocr: { failWith: { kind: 'unavailable', message: 'no python' } } }
    );
    const written = files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '';

    expect(written).toContain('![Logo.png](Logo.png)');
    expect(written).not.toContain('\n> ');
  });

  // Nothing read is shown as nothing. OCR answering with a page of spaces is OCR finding nothing.
  it('a picture OCR read as blank is shown alone, blank being nothing read', async () => {
    const { files } = await run(
      { name: 'Fwd.eml' },
      { reader: { attachmentRaw: { att1: asPicture() } }, drive: REFUSED, ocr: { texts: { [`${FOLDER}/Fwd/Logo.png`]: '   \n  ' } } }
    );

    expect(files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '').not.toContain('\n> ');
  });

  // OCR answers for pictures and nothing else. A spreadsheet the library could not read is not a
  // picture with words in it, and running OCR over it would cost a fetch to learn that.
  it('a part that is not a picture is not read by OCR when the library refuses it', async () => {
    // A reading is seeded for it and must not appear: OCR answers for pictures and nothing else, and
    // a spreadsheet the library could not read is not a picture with words in it.
    const { files } = await run(
      { name: 'Fwd.eml' },
      { reader: { attachmentRaw: { att1: EML } }, drive: REFUSED, ocr: { texts: { [`${FOLDER}/Fwd/Contrat.docx`]: 'should not be read' } } }
    );
    const written = files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '';

    expect(written).toContain('- [Contrat.docx](Contrat.docx)');
    expect(written).not.toContain('should not be read');
  });

  it('a part whose bytes cannot be written ends the conversion rather than half unpacking it', async () => {
    const { outcome } = await run(
      { name: 'Fwd.eml' },
      { reader: { attachmentRaw: { att1: EML } }, files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } } }
    );

    expect(outcome.kind).toBe('failed');
  });

  it('a picture the saved email pointed at by cid is shown where it pointed', async () => {
    const withLogo = EML.replace('Voici le contrat.', 'Regards\r\n\r\n[cid:Logo.png]')
      .replace('Content-Type: application/vnd; name="Contrat.docx"', 'Content-Type: image/png; name="Logo.png"')
      .replace('filename="Contrat.docx"', 'filename="Logo.png"');
    const { files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: withLogo } } });
    const written = files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '';

    expect(written).toContain('![Logo.png](Logo.png)');
    expect(written).not.toContain('[cid:Logo.png]');
    expect(written).not.toContain('- [Logo.png]');
  });

  // The card standing for a saved email takes its body from this document, so a wrapper left here
  // is a wrapper in the thread's folder too.
  it('a link Outlook wrapped inside a saved email is unwrapped like any other', async () => {
    const wrapped = 'https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Faka.ms%2FAAb9ysg&reserved=0';
    const withLink = EML.replace('Voici le contrat.', `See ${wrapped}`);
    const { files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: withLink } } });

    expect(files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`) ?? '').toContain('See https://aka.ms/AAb9ysg');
  });

  it('a file inside a saved email that nothing can read keeps the file and loses only the text', async () => {
    const { outcome, files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: EML } }, drive: { failWith: { kind: 'permanent', message: 'not convertible' } } });

    expect(files.binary.has(`${FOLDER}/Fwd/Contrat.docx`)).toBe(true);
    expect(files.written.has(`${FOLDER}/Fwd/Contrat.docx.md`)).toBe(false);
    expect(outcome.kind).toBe('converted');
  });

  it('a saved email Graph refused to hand over is reported, not written half-done', async () => {
    const { outcome } = await run({ name: 'Fwd.eml' }, { reader: { failCalls: { attachmentBytes: { kind: 'transient', message: 'timed out' } } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'transient: timed out' });
  });

  it('a saved email holding no message of its own still lands, saying so', async () => {
    const { files } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: '' } } });

    expect(files.written.get(`${FOLDER}/Fwd/Fwd.eml.md`)).toContain(NO_TEXT_NOTE);
  });

  it('a saved email whose message cannot be written is reported rather than leaving its files alone on disk', async () => {
    const { outcome } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: EML } }, files: { failWritesMatching: 'Fwd.eml.md' } });

    expect(outcome.kind).toBe('failed');
  });

  it('a file inside a saved email that cannot be written is reported rather than passed over', async () => {
    const { outcome } = await run({ name: 'Fwd.eml' }, { reader: { attachmentRaw: { att1: EML } }, files: { failWritesMatching: 'Contrat.docx' } });

    expect(outcome.kind).toBe('failed');
  });

  it('a workbook the source read as empty says so rather than sitting beside a silent file', async () => {
    const { files } = await run({ name: 'Budget.xlsx' }, { reader: { attachmentTexts: { att1: '   ' } } });

    expect(files.written.get(`${FOLDER}/Budget.xlsx.md`)).toContain(NO_TEXT_NOTE);
  });

  it('a workbook Graph refused to hand over is reported after its text was read', async () => {
    const { outcome } = await run({ name: 'Budget.xlsx' }, { reader: { failCalls: { attachmentBytes: { kind: 'transient', message: 'timed out' } } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'transient: timed out' });
  });

  it('a workbook is kept as it came, beside the text read out of it', async () => {
    const { outcome, files } = await run({ name: 'Budget.xlsx' });
    const written = files.written.get(`${FOLDER}/Budget.xlsx.md`) ?? '';

    expect(outcome).toEqual({
      kind: 'converted',
      outputs: [`${FOLDER}/Budget.xlsx`, `${FOLDER}/Budget.xlsx.md`],
      primary: `${FOLDER}/Budget.xlsx.md`,
      media: [],
    });
    expect(files.binary.has(`${FOLDER}/Budget.xlsx`)).toBe(true);
    expect(written).toContain('original: ./Budget.xlsx');
    expect(written).toContain('converted att1');
  });

  it('a workbook the source refused to read is reported rather than kept with an empty note beside it', async () => {
    const { outcome } = await run({ name: 'Budget.xlsx' }, { reader: { failCalls: { attachmentMarkdown: { kind: 'transient', message: 'timed out' } } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'transient: timed out' });
  });

  it('a meeting invitation is read down to the meeting, not kept as the file it came in', async () => {
    const { outcome, files } = await run({ name: 'invite.ics', contentType: 'text/calendar' }, { reader: { attachmentTexts: { att1: ICS } } });
    const written = files.written.get(`${FOLDER}/invite.ics.md`) ?? '';

    expect(outcome.kind).toBe('converted');
    expect(written).toContain('## smartMOOV x Lidl');
    expect(written).toContain('**When:** 2026-08-12 06:00 (UTC)');
    expect(written).toContain('**Where:** Teams');
  });

  it('an invitation holding no meeting says so rather than writing an empty record', async () => {
    const { files } = await run({ name: 'invite.ics', contentType: 'text/calendar' }, { reader: { attachmentTexts: { att1: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' } } });

    expect(files.written.get(`${FOLDER}/invite.ics.md`)).toContain(NO_TEXT_NOTE);
  });

  it('an email attached to an email is written from what was rendered of it, having no bytes of its own', async () => {
    const embedded = { kind: 'item' as const, name: 'Customs documents MSDU1691268', contentType: '' };
    const { outcome, files } = await run(embedded, { rendered: '**Subject:** Customs documents\n\nAttached.' });

    expect(outcome).toEqual({
      kind: 'converted',
      outputs: [`${FOLDER}/Customs documents MSDU1691268.md`],
      primary: `${FOLDER}/Customs documents MSDU1691268.md`,
      media: [],
    });
    expect(files.written.get(`${FOLDER}/Customs documents MSDU1691268.md`)).toContain('**Subject:** Customs documents');
  });

  it('an embedded email the library could make nothing of still lands, saying so', async () => {
    const { files } = await run({ kind: 'item', name: 'Empty', contentType: '' }, { rendered: '  ' });

    expect(files.written.get(`${FOLDER}/Empty.md`)).toContain(NO_TEXT_NOTE);
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

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Q1_Q2_ budget.docx.md`], primary: `${FOLDER}/Q1_Q2_ budget.docx.md`, media: [] });
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

    expect(outcome).toEqual({ kind: 'converted', outputs: [`${FOLDER}/Logo.svg`, `${FOLDER}/Logo.svg.md`], primary: `${FOLDER}/Logo.svg.md`, media: [] });
    expect(files.written.get(`${FOLDER}/Logo.svg.md`)).toContain('image: ./Logo.svg');
  });

  // A reader is sent to the manifest, not to the archive: the zip is kept and still listed, but
  // linking a reader at a binary they have to unzip is not a knowledge base.
  it('an archive attachment lands with the archive file, one markdown per entry, and a manifest to read', async () => {
    const { outcome, files } = await run({ name: 'Livraison.zip' }, { drive: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(outcome).toEqual({
      kind: 'converted',
      outputs: [`${FOLDER}/Livraison/Livraison.zip`, `${FOLDER}/Livraison/notes.docx.md`, `${FOLDER}/Livraison.zip.md`],
      primary: `${FOLDER}/Livraison.zip.md`,
      media: [],
    });
    expect(files.written.get(`${FOLDER}/Livraison.zip.md`)).toContain('- notes.docx — # Notes');
  });

  it('a manifest that cannot be written fails the archive rather than leaving it unreadable', async () => {
    const { outcome } = await run(
      { name: 'Livraison.zip' },
      { drive: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] }, files: { failWritesMatching: 'Livraison.zip.md' } }
    );

    expect(outcome).toMatchObject({ kind: 'failed' });
  });
});
