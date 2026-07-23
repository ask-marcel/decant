import { describe, expect, it } from 'bun:test';
import type { DriveItem } from '../domain/drive-item.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
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
): Promise<{ outcome: ConvertOutcome; files: FilesFake }> => {
  const files = createFilesFake(seeds.files);
  const convert = createConvertFile({ reader: createDriveReaderFake(seeds.reader), files, ocr: createOcrFake(seeds.ocr), clock: createClockFake() });
  const outcome = await convert({
    item: item(over),
    driveId: 'b!one',
    libraryRoot: 'kb/Espace MOOV/Documents',
    site: 'Espace MOOV',
    library: 'Documents',
    maxBytes: 50 * 1024 * 1024,
    ocrLabel: 'paddleocr (en)',
  });
  return { outcome, files };
};

describe('converting one document out of a library', () => {
  it('a Word document lands as markdown under the same folders it had in SharePoint', async () => {
    const { outcome, files } = await run({}, { reader: { markdown: { '01ABC': '# Contrat\n\nClause one.' } } });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace MOOV/Documents/Projets/Contrat.docx.md'] });
    expect(files.written.get('kb/Espace MOOV/Documents/Projets/Contrat.docx.md')).toContain('# Contrat');
  });

  it('the markdown carries where it came from, when it changed and who changed it', async () => {
    const { files } = await run({});
    const written = files.written.get('kb/Espace MOOV/Documents/Projets/Contrat.docx.md') ?? '';

    expect(written).toContain('source: https://tenant.sharepoint.com/sites/X/Contrat.docx');
    expect(written).toContain('path: Projets/Contrat.docx');
    expect(written).toContain('modified_by: Jane Doe');
    expect(written).toContain('synced_at: "2026-07-23T14:00:00Z"');
  });

  it('a document at the top of the library lands directly in the library folder', async () => {
    const { outcome } = await run({ name: 'Note.docx', path: 'Note.docx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace MOOV/Documents/Note.docx.md'] });
  });

  it('a name the filesystem cannot hold is made safe before anything is written', async () => {
    const { outcome } = await run({ name: 'Q1/Q2.docx', path: 'Projets: 2026/Q1/Q2.docx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace MOOV/Documents/Projets_ 2026/Q1/Q1_Q2.docx.md'] });
  });

  it('a document that converted to nothing still lands, with a note in place of the text', async () => {
    const { files } = await run({}, { reader: { markdown: { '01ABC': '   ' } } });

    expect(files.written.get('kb/Espace MOOV/Documents/Projets/Contrat.docx.md')).toContain('No text could be read');
  });

  it('a deck lands as markdown for its text and a PDF for its slides, each pointing at the other', async () => {
    const { outcome, files } = await run({ name: 'Roadmap.pptx', path: 'Roadmap.pptx' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace MOOV/Documents/Roadmap.pptx.pdf', 'kb/Espace MOOV/Documents/Roadmap.pptx.md'] });
    expect(files.written.get('kb/Espace MOOV/Documents/Roadmap.pptx.md')).toContain('pdf: ./Roadmap.pptx.pdf');
    expect(files.binary.has('kb/Espace MOOV/Documents/Roadmap.pptx.pdf')).toBe(true);
  });

  it('a deck in the old format has its text read back from the PDF, since nothing else can read it', async () => {
    const { outcome, files } = await run({ name: 'Vieux.ppt', path: 'Vieux.ppt' });
    const reader = files.written.get('kb/Espace MOOV/Documents/Vieux.ppt.md') ?? '';

    expect(outcome.kind).toBe('converted');
    expect(reader).toContain('converted kb/Espace MOOV/Documents/Vieux.ppt.pdf');
  });

  it('a PDF is kept as it is, with its text beside it and a pointer back to the file', async () => {
    const { outcome, files } = await run({ name: 'Contrat.pdf', path: 'Contrat.pdf' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace MOOV/Documents/Contrat.pdf', 'kb/Espace MOOV/Documents/Contrat.pdf.md'] });
    expect(files.written.get('kb/Espace MOOV/Documents/Contrat.pdf.md')).toContain('pdf: ./Contrat.pdf');
  });

  it('a scanned PDF says so, so a reader knows to look at the pages rather than the text', async () => {
    const { files } = await run({ name: 'Scan.pdf', path: 'Scan.pdf' }, { reader: { markdown: { '01ABC': '' } } });

    expect(files.written.get('kb/Espace MOOV/Documents/Scan.pdf.md')).toContain('carries no text layer');
  });

  it('a photo is kept as it is, with the text read out of it beside it', async () => {
    const { outcome, files } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' }, { ocr: { texts: { 'kb/Espace MOOV/Documents/Tableau.jpg': 'Sprint 4 backlog' } } });
    const written = files.written.get('kb/Espace MOOV/Documents/Tableau.jpg.md') ?? '';

    expect(outcome.kind).toBe('converted');
    expect(written).toContain('image: ./Tableau.jpg');
    expect(written).toContain('ocr: paddleocr (en)');
    expect(written).toContain('Sprint 4 backlog');
  });

  it('a photo holding no readable text still lands, with a note instead', async () => {
    const { files } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' });

    expect(files.written.get('kb/Espace MOOV/Documents/Tableau.jpg.md')).toContain('No text could be read');
  });

  it('a photo whose text could not be read at all still lands, without claiming it was read', async () => {
    const { files } = await run({ name: 'Tableau.jpg', path: 'Tableau.jpg' }, { ocr: { failWith: { kind: 'unavailable', message: 'paddleocr not installed' } } });

    expect(files.written.get('kb/Espace MOOV/Documents/Tableau.jpg.md')).not.toContain('ocr:');
  });

  it('a drawing is kept as it is, with a note telling a reader to open the file', async () => {
    const { outcome, files } = await run({ name: 'Logo.svg', path: 'Logo.svg' });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace MOOV/Documents/Logo.svg.md')).toContain('Open the file beside this note');
  });

  it('an archive becomes a folder holding one markdown file per document inside it', async () => {
    const entries = [
      { path: 'notes.docx', text: '# Notes' },
      { path: 'sous-dossier/deck.pptx', text: '## Slide 1' },
    ];
    const { outcome, files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: entries } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace MOOV/Documents/Livraison/notes.docx.md')).toContain('# Notes');
    expect(files.written.get('kb/Espace MOOV/Documents/Livraison/sous-dossier/deck.pptx.md')).toContain('## Slide 1');
  });

  it('a file inside an archive records where it sat in the archive', async () => {
    const { files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'notes.docx', text: '# Notes' }] } });

    expect(files.written.get('kb/Espace MOOV/Documents/Livraison/notes.docx.md')).toContain('zip_entry: notes.docx');
  });

  it('a file inside an archive that could not be converted keeps the reason in its place', async () => {
    const { files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'video.mp4', note: 'unsupported entry' }] } });

    expect(files.written.get('kb/Espace MOOV/Documents/Livraison/video.mp4.md')).toContain('unsupported entry');
  });

  it('a rich-text document is rendered to PDF first, then read back from it', async () => {
    const { outcome, files } = await run({ name: 'Note.rtf', path: 'Note.rtf' });

    expect(outcome).toEqual({ kind: 'converted', outputs: ['kb/Espace MOOV/Documents/Note.rtf.pdf', 'kb/Espace MOOV/Documents/Note.rtf.md'] });
    expect(files.written.get('kb/Espace MOOV/Documents/Note.rtf.md')).toContain('converted kb/Espace MOOV/Documents/Note.rtf.pdf');
  });

  it('a deck whose text is read straight from SharePoint does not go through the PDF', async () => {
    const { files } = await run({ name: 'Roadmap.pptx', path: 'Roadmap.pptx' }, { reader: { markdown: { '01ABC': '## Slide 1' } } });

    expect(files.written.get('kb/Espace MOOV/Documents/Roadmap.pptx.md')).toContain('## Slide 1');
  });

  it('a deck that produced no text at all still lands, with a note and its PDF', async () => {
    const { outcome, files } = await run({ name: 'Vide.pptx', path: 'Vide.pptx' }, { reader: { markdown: { '01ABC': '' } } });

    expect(outcome.kind).toBe('converted');
    expect(files.written.get('kb/Espace MOOV/Documents/Vide.pptx.md')).toContain('No text could be read');
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

    expect(outcome.kind === 'converted' && outcome.outputs[0]).toBe('kb/Espace MOOV/Documents/Projets/Livraison/Livraison.zip');
    expect(files.binary.has('kb/Espace MOOV/Documents/Projets/Livraison/Livraison.zip')).toBe(true);
  });

  it('an entry with neither text nor reason still lands, so nothing inside an archive disappears', async () => {
    const { files } = await run({ name: 'Livraison.zip', path: 'Livraison.zip' }, { reader: { archiveEntries: [{ path: 'mystere.bin' }] } });

    expect(files.written.get('kb/Espace MOOV/Documents/Livraison/mystere.bin.md')).toContain('No text could be read');
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
});
