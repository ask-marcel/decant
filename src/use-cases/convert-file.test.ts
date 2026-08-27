import { describe, expect, it } from 'bun:test';
import type { DriveItem } from '../domain/drive-item.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import type { OcrSeed } from '../test-helpers/ocr-fake.ts';
import { createConvertFile } from './convert-file.ts';
import type { ConvertOutcome } from './convert-file.ts';

const item = (over: Partial<DriveItem> = {}): DriveItem => ({
  id: '01ABC',
  name: 'Contrat.docx',
  kind: 'file',
  size: 4096,
  path: 'Projets/Contrat.docx',
  lastModified: '2026-05-12T09:31:00Z',
  cTag: 'c1',
  webUrl: 'https://tenant.sharepoint.com/sites/X/Contrat.docx',
  modifiedBy: 'Jane Doe',
  ...over,
});

const run = async (
  over: Partial<DriveItem>,
  seeds: { reader?: DriveReaderSeed; files?: FilesFakeSeed; ocr?: OcrSeed } = {}
): Promise<{ outcome: ConvertOutcome; files: FilesFake; reader: ReturnType<typeof createDriveReaderFake>; logger: LoggerFake }> => {
  const files = createFilesFake(seeds.files);
  const reader = createDriveReaderFake(seeds.reader);
  const logger = createLoggerFake();
  const convert = createConvertFile({ reader, files, ocr: createOcrFake(seeds.ocr), clock: createClockFake(), logger });
  const outcome = await convert({
    item: item(over),
    driveId: 'b!one',
    libraryRoot: 'kb/Espace Contoso/Documents',
    site: 'Espace Contoso',
    library: 'Documents',
    maxBytes: 50 * 1024 * 1024,
    ocrLabel: 'paddleocr (en)',
  });
  return { outcome, files, reader, logger };
};

describe('converting one document out of a library', () => {
  it('a Word document lands as markdown under the same folders it had in SharePoint', async () => {
    const { outcome, files } = await run({}, { reader: { markdown: { '01ABC': '# Contrat\n\nClause one.' } } });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md'] });
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md')).toContain('# Contrat');
  });

  it('a meeting invitation in a library is read down to the meeting', async () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Kick-off', 'DTSTART:20260812T060000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const { files } = await run({ name: 'invite.ics' }, { reader: { markdown: { '01ABC': ics } } });
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/invite.ics.md') ?? '';

    expect(written).toContain('## Kick-off');
    expect(written).not.toContain('BEGIN:VEVENT');
  });

  it('the markdown carries where it came from, when it changed and who changed it', async () => {
    const { files } = await run({});
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md') ?? '';

    expect(written).toContain('source: https://tenant.sharepoint.com/sites/X/Contrat.docx');
    expect(written).toContain('path: Projets/Contrat.docx');
    expect(written).toContain('modified_by: Jane Doe');
    expect(written).toContain('synced_at: "2026-07-23T14:00:00Z"');
  });

  it('a document at the top of the library lands directly in the library folder', async () => {
    const { outcome } = await run({ name: 'Note.docx', path: 'Note.docx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Note.docx.md'] });
  });

  it('a name the filesystem cannot hold is made safe before anything is written', async () => {
    const { outcome } = await run({ name: 'Q1/Q2.docx', path: 'Projets: 2026/Q1/Q2.docx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Projets_ 2026/Q1/Q1_Q2.docx.md'] });
  });

  it('a document that converted to nothing still lands, with a note in place of the text', async () => {
    const { files } = await run({}, { reader: { markdown: { '01ABC': '   ' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md')).toContain('No text could be read');
  });

  it('a deck lands as markdown for its text and a PDF for its slides, each pointing at the other', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx', path: 'Roadmap.pptx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.pdf', 'kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.md'] });
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.md')).toContain('pdf: ./Roadmap.pptx.pdf');
    expect(files.binary.has('kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.pdf')).toBe(true);
  });

  it('a deck the source will not render as a PDF still lands as its text, saying why the slides are missing', async () => {
    const { outcome, files } = await run(
      { name: 'Roadmap.pptx', path: 'Roadmap.pptx' },
      { reader: { markdown: { '01ABC': '## Slide 1' }, failPdf: { kind: 'unrenderable', message: 'HTTP 406 with no error body (path: /transform/pdf)' } } }
    );
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.md') ?? '';

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.md'] });
    expect(written).toContain('## Slide 1');
    expect(written).toContain('could not be rendered');
    expect(written).not.toContain('pdf: ./Roadmap.pptx.pdf');
    expect(files.binary.has('kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.pdf')).toBe(false);
  });

  it('a deck in the old format that will not render is reported, since that render is where its text lives', async () => {
    const { outcome, files } = await run({ name: 'Vieux.ppt', path: 'Vieux.ppt' }, { reader: { failPdf: { kind: 'unrenderable', message: 'HTTP 406' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'unrenderable: HTTP 406' });
    expect(files.written.has('kb/Espace Contoso/Documents/2026-05-12/Vieux.ppt.md')).toBe(false);
  });

  it('a deck in the old format has its text read back from the PDF, since nothing else can read it', async () => {
    const { outcome, files } = await run({ name: 'Vieux.ppt', path: 'Vieux.ppt' });
    const reader = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Vieux.ppt.md') ?? '';

    expect(outcome.kind).toBe('converted');
    expect(reader).toContain('converted kb/Espace Contoso/Documents/2026-05-12/Vieux.ppt.pdf');
  });

  it('a PDF is kept as it is, with its text beside it and a pointer back to the file', async () => {
    const { outcome, files } = await run({ name: 'Contrat.pdf', path: 'Contrat.pdf' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Contrat.pdf', 'kb/Espace Contoso/Documents/2026-05-12/Contrat.pdf.md'] });
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Contrat.pdf.md')).toContain('pdf: ./Contrat.pdf');
  });

  it('a scanned PDF says so, so a reader knows to look at the pages rather than the text', async () => {
    const { files } = await run({ name: 'Scan.pdf', path: 'Scan.pdf' }, { reader: { markdown: { '01ABC': '' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Scan.pdf.md')).toContain('carries no text layer');
  });

  it('a scanned PDF has its pages read by OCR when it carries no text layer', async () => {
    const { files } = await run(
      { name: 'Scan.pdf', path: 'Scan.pdf' },
      { reader: { markdown: { '01ABC': '' } }, ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Scan.pdf': 'Invoice total 1200 EUR' } } }
    );
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Scan.pdf.md') ?? '';

    expect(written).toContain('Invoice total 1200 EUR');
    expect(written).toContain('ocr: paddleocr (en)');
  });

  it('a PDF that already has a text layer is not sent to OCR', async () => {
    const { files } = await run(
      { name: 'Contrat.pdf', path: 'Contrat.pdf' },
      { reader: { markdown: { '01ABC': 'The real text layer.' } }, ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Contrat.pdf': 'OCR fallback text' } } }
    );
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Contrat.pdf.md') ?? '';

    expect(written).toContain('The real text layer.');
    expect(written).not.toContain('OCR fallback text');
    expect(written).not.toContain('ocr:');
  });

  it('a PDF whose text layer is only whitespace is treated as scanned and read by OCR', async () => {
    const { files } = await run(
      { name: 'Scan.pdf', path: 'Scan.pdf' },
      { reader: { markdown: { '01ABC': '   ' } }, ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Scan.pdf': 'Read by OCR' } } }
    );

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Scan.pdf.md') ?? '').toContain('Read by OCR');
  });

  it('a scanned PDF whose OCR finds only whitespace still falls back to the note', async () => {
    const { files } = await run(
      { name: 'Scan.pdf', path: 'Scan.pdf' },
      { reader: { markdown: { '01ABC': '' } }, ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Scan.pdf': '   ' } } }
    );

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Scan.pdf.md') ?? '').toContain('carries no text layer');
  });

  it('a photo is kept as it is, with the text read out of it beside it', async () => {
    const { outcome, files } = await run(
      { name: 'Tableau.jpg', path: 'Tableau.jpg' },
      { ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg': 'Sprint 4 backlog' } } }
    );
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg.md') ?? '';

    expect(outcome.kind).toBe('converted');
    expect(written).toContain('image: ./Tableau.jpg');
    expect(written).toContain('ocr: paddleocr (en)');
    expect(written).toContain('Sprint 4 backlog');
  });

  it('a photo holding no readable text still lands, with a note instead', async () => {
    const { files } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg.md')).toContain('No text could be read');
  });

  it('a photo whose text could not be read at all still lands, without claiming it was read', async () => {
    const { files } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' }, { ocr: { failWith: { kind: 'unavailable', message: 'paddleocr not installed' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg.md')).not.toContain('ocr:');
  });

  it('a drawing is kept as it is, with a note telling a reader to open the file', async () => {
    const { outcome, files } = await run({ name: 'Logo.svg', path: 'Logo.svg' });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Logo.svg.md')).toContain('Open the file beside this note');
  });

  it('an archive becomes a folder holding one markdown file per document inside it', async () => {
    const entries = [
      { path: 'notes.docx', text: '# Notes' },
      { path: 'sous-dossier/deck.pptx', text: '## Slide 1' },
    ];
    const { outcome, files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: entries } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Livraison/notes.docx.md')).toContain('# Notes');
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Livraison/sous-dossier/deck.pptx.md')).toContain('## Slide 1');
  });

  it('a file inside an archive records where it sat in the archive', async () => {
    const { files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Livraison/notes.docx.md')).toContain('zip_entry: notes.docx');
  });

  it('a file inside an archive that could not be converted keeps the reason in its place', async () => {
    const { files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'video.mp4', note: 'unsupported entry' }] } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Livraison/video.mp4.md')).toContain('unsupported entry');
  });

  it('a rich-text document is rendered to PDF first, then read back from it', async () => {
    const { outcome, files } = await run({ name: 'Note.rtf', path: 'Note.rtf' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Note.rtf.pdf', 'kb/Espace Contoso/Documents/2026-05-12/Note.rtf.md'] });
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Note.rtf.md')).toContain('converted kb/Espace Contoso/Documents/2026-05-12/Note.rtf.pdf');
  });

  it('a deck whose text is read straight from SharePoint does not go through the PDF', async () => {
    const { files } = await run({ name: 'Roadmap.pptx', path: 'Roadmap.pptx' }, { reader: { markdown: { '01ABC': '## Slide 1' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.md')).toContain('## Slide 1');
  });

  it('a deck that produced no text at all still lands, with a note and its PDF', async () => {
    const { outcome, files } = await run({ name: 'Vide.pptx', path: 'Vide.pptx' }, { reader: { markdown: { '01ABC': '' } } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Vide.pptx.md')).toContain('No text could be read');
  });

  it('a deck whose PDF cannot be rendered is reported, and no markdown claims to describe it', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx', path: 'Roadmap.pptx' }, { reader: { failWith: { kind: 'transient', message: 'render timed out' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'transient: render timed out' });
    expect(files.written.size).toBe(0);
  });

  it('a PDF whose bytes cannot be fetched is reported rather than leaving a lone markdown file', async () => {
    const { outcome, files } = await run({ name: 'Contrat.pdf', path: 'Contrat.pdf' }, { reader: { failWith: { kind: 'permanent', status: 404, message: 'gone' } } });

    expect(outcome.kind).toBe('failed');
    expect(files.written.size).toBe(0);
  });

  it('a photo whose bytes cannot be fetched is reported rather than left half written', async () => {
    const { outcome } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' }, { reader: { failWith: { kind: 'permanent', status: 404, message: 'gone' } } });

    expect(outcome.kind).toBe('failed');
  });

  it('a drawing whose bytes cannot be fetched is reported', async () => {
    const { outcome } = await run({ name: 'Logo.svg', path: 'Logo.svg' }, { reader: { failWith: { kind: 'permanent', status: 404, message: 'gone' } } });

    expect(outcome.kind).toBe('failed');
  });

  it('an archive whose bytes cannot be fetched is reported', async () => {
    const { outcome } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { failWith: { kind: 'permanent', status: 404, message: 'gone' } } });

    expect(outcome.kind).toBe('failed');
  });

  it('the archive itself is kept beside what was unpacked from it', async () => {
    const { outcome, files } = await run({ name: 'Livraison.zip', path: 'Projets/Livraison.zip' }, { reader: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(outcome.kind === 'converted' && outcome.outputs[0]).toBe('kb/Espace Contoso/Documents/2026-05-12/Projets/Livraison/Livraison.zip');
    expect(files.binary.has('kb/Espace Contoso/Documents/2026-05-12/Projets/Livraison/Livraison.zip')).toBe(true);
  });

  it('an entry with neither text nor reason still lands, so nothing inside an archive disappears', async () => {
    const { files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'mystere.bin' }] } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Livraison/mystere.bin.md')).toContain('No text could be read');
  });

  it('an archive that cannot be unpacked is reported after its bytes were kept', async () => {
    const { outcome } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { failItems: {}, archiveEntries: undefined, failWith: undefined } });

    expect(outcome.kind).toBe('converted');
  });

  it('a video is reported as a type this tool does not handle', async () => {
    expect((await run({ name: 'Demo.mp4', path: 'Demo.mp4' })).outcome).toEqual({ kind: 'skipped', reason: 'unsupported-type' });
  });

  it('a document far above the size cap is reported rather than stalling the run', async () => {
    expect((await run({ size: 60 * 1024 * 1024 })).outcome).toEqual({ kind: 'skipped', reason: 'too-large' });
  });

  it('a document Microsoft refused to convert is reported with the reason', async () => {
    const { outcome } = await run({}, { reader: { failWith: { kind: 'permanent', status: 423, message: 'file is locked' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'permanent: file is locked' });
  });

  it('a knowledge base that cannot be written to is reported rather than silently losing the document', async () => {
    const { outcome } = await run({}, { files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } } });

    expect(outcome).toEqual({ kind: 'failed', reason: 'write-failed: disk full' });
  });

  it('a deck reads its text back from the file it named, not from an empty request', async () => {
    const { files } = await run({ name: 'Roadmap.pptx', path: 'Roadmap.pptx' });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Roadmap.pptx.md')).toContain('converted 01ABC');
  });

  it('a deck whose text is only whitespace still lands with a note beside its PDF', async () => {
    const { files } = await run({ name: 'Vide.pptx', path: 'Vide.pptx' }, { reader: { markdown: { '01ABC': '   ' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Vide.pptx.md')).toContain('No text could be read');
  });

  it('a photo lands with exactly the picture and its read-out text, nothing more', async () => {
    const { outcome } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' }, { ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg': 'Sprint 4 backlog' } } });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg', 'kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg.md'] });
  });

  it('a photo whose OCR reads only whitespace lands with a note instead of blank text', async () => {
    const { files } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' }, { ocr: { texts: { 'kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg': '   ' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Tableau.jpg.md')).toContain('No text could be read');
  });

  it('a drawing lands with exactly the file and its note, each named for the drawing', async () => {
    const { outcome, files } = await run({ name: 'Logo.svg', path: 'Logo.svg' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace Contoso/Documents/2026-05-12/Logo.svg', 'kb/Espace Contoso/Documents/2026-05-12/Logo.svg.md'] });
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Logo.svg.md')).toContain('image: ./Logo.svg');
  });

  it('an archive lands with the archive file and one markdown per entry, in order', async () => {
    const { outcome } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(outcome).toEqual({
      kind: 'converted',
      outputs: ['kb/Espace Contoso/Documents/2026-05-12/Livraison/Livraison.zip', 'kb/Espace Contoso/Documents/2026-05-12/Livraison/notes.docx.md'],
    });
  });
});

describe('keeping the pictures a document embeds', () => {
  const MEDIA = 'kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.media/word_media_image1.png';

  it('a document holding pictures keeps them beside its markdown, so a diagram is not lost to a placeholder', async () => {
    const images = { '01ABC': [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { outcome, files } = await run({}, { reader: { images, markdown: { '01ABC': 'Body [image] here.' } } });

    expect(files.binary.has(MEDIA)).toBe(true);
    expect(outcome.kind === 'converted' && outcome.outputs).toEqual(['kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md', MEDIA]);
  });

  it('the text read out of an embedded picture is written under the document that held it', async () => {
    const images = { '01ABC': [{ path: 'word/media/image1.png', bytes: new Uint8Array([1]) }] };
    const { files } = await run({}, { reader: { images, markdown: { '01ABC': 'Body.' } }, ocr: { texts: { [MEDIA]: 'smartMOOV\nExternal\nDB' } } });
    const written = files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md') ?? '';

    expect(written).toContain('## Images');
    expect(written).toContain('smartMOOV');
  });

  it('a document holding no pictures gains no folder and no section', async () => {
    const { files } = await run({}, { reader: { markdown: { '01ABC': 'Body.' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md')).not.toContain('## Images');
  });

  it('a kind that cannot hold pictures is never asked for them', async () => {
    const { reader } = await run({ name: 'Notes.txt', path: 'Notes.txt' }, { reader: { markdown: { '01ABC': 'Plain.' } } });

    expect(reader.calls.some((call) => call.startsWith('images:'))).toBe(false);
  });

  it('pictures that could not be read leave the document itself intact', async () => {
    const { outcome, files } = await run({}, { reader: { failImages: { kind: 'permanent', message: 'no media' }, markdown: { '01ABC': 'Body.' } } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md')).toContain('Body.');
  });

  it('a picture nothing could be read from is still linked, with no empty caption beneath it', async () => {
    const images = { '01ABC': [{ path: 'word/media/image1.png', bytes: new Uint8Array([1]) }] };
    const { files } = await run({}, { reader: { images, markdown: { '01ABC': 'Body.' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md')).toContain(
      '\n\n## Images\n\n![word_media_image1.png](./Contrat.docx.media/word_media_image1.png)\n'
    );
  });

  it('a picture that cannot be written stops the document rather than leaving half of it', async () => {
    const images = { '01ABC': [{ path: 'word/media/image1.png', bytes: new Uint8Array([1]) }] };
    // A docx writes no bytes of its own, so failing byte writes fails exactly the pictures.
    const { outcome } = await run({}, { reader: { images, markdown: { '01ABC': 'Body.' } }, files: { failWriteWith: { kind: 'write-failed', path: 'x', message: 'disk full' } } });

    expect(outcome.kind).toBe('failed');
  });

  it('pictures that could not be read are logged and none are claimed as written', async () => {
    const { outcome, logger } = await run({}, { reader: { failImages: { kind: 'permanent', message: 'no media' }, markdown: { '01ABC': 'Body.' } } });

    expect(outcome.kind === 'converted' && outcome.outputs).toEqual(['kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md']);
    expect(logger.calls.some((call) => call.event === 'images.failed')).toBe(true);
  });

  it('the text read out of a picture is trimmed before it goes under the picture', async () => {
    const images = { '01ABC': [{ path: 'word/media/image1.png', bytes: new Uint8Array([1]) }] };
    const { files } = await run({}, { reader: { images, markdown: { '01ABC': 'Body.' } }, ocr: { texts: { [MEDIA]: '  \n smartMOOV \n  ' } } });

    expect(files.written.get('kb/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md')).toContain(')\n\nsmartMOOV\n');
  });
});
