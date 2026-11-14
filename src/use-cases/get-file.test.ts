import { describe, expect, it } from 'bun:test';
import type { DriveItem } from '../domain/drive-item.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import { createConvertFile } from './convert-file.ts';
import { createGetFile } from './get-file.ts';
import type { Got } from './get-file.ts';
import type { Result } from '../domain/result.ts';
import type { StepError } from './ports/step-error.ts';

const LINK = 'https://contoso.sharepoint.com/sites/Pepco/Shared%20Documents/Operations/QBR.docx';
const FILE = { driveId: 'b!one', itemId: '01QBR' };

const item = (over: Partial<DriveItem> = {}): DriveItem => ({
  id: '01QBR',
  name: 'QBR.docx',
  kind: 'file',
  size: 4096,
  path: 'Operations/QBR.docx',
  lastModified: '2026-11-12T09:31:00Z',
  cTag: 'c1',
  webUrl: 'https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7B1%7D&file=QBR.docx',
  ...over,
});

// The root of the library, whose address names the site and the library.
const LIBRARY = item({ id: 'root', name: 'root', kind: 'folder', path: '', webUrl: 'https://contoso.sharepoint.com/sites/Pepco/Shared%20Documents' });

const get = async (
  seed: DriveReaderSeed = {},
  maxBytes = 50 * 1024 * 1024
): Promise<{ got: Result<Got, StepError>; files: FilesFake; reader: ReturnType<typeof createDriveReaderFake> }> => {
  const files = createFilesFake();
  const reader = createDriveReaderFake({ links: { [LINK]: FILE }, items: { '01QBR': item(), root: LIBRARY }, markdown: { '01QBR': '# Quarterly review' }, ...seed });
  const convertFile = createConvertFile({ reader, files, ocr: createOcrFake(), clock: createClockFake(), logger: createLoggerFake(), progress: createProgressFake() });
  const getFile = createGetFile({ drive: reader, convertFile, kbRoot: 'kb' });
  return { got: await getFile({ url: LINK, maxBytes }), files, reader };
};

describe('getting one file by its address', () => {
  it('the file is found from its address alone, converted under the site and library it sits in, and its note is named', async () => {
    const { got, files, reader } = await get();

    expect(got).toEqual({ ok: true, value: { path: 'kb/Picked/Files/Pepco/Shared Documents/Operations/QBR.docx.md' } });
    expect(files.written.get('kb/Picked/Files/Pepco/Shared Documents/Operations/QBR.docx.md')).toContain('# Quarterly review');
    expect(reader.calls.slice(0, 2)).toEqual([`fromLink:${LINK}`, 'item:01QBR']);
  });

  it('a file of a library whose address cannot be read goes under a folder named from the drive, so it still lands', async () => {
    const { got } = await get({ items: { '01QBR': item() } });

    expect(got.ok && got.value.path).toMatch(/^kb\/Picked\/Files\/drive-[0-9a-f]{10}\/Operations\/QBR\.docx\.md$/);
  });

  it('getting a file leaves no record a later update would read as a synced source', async () => {
    const { files } = await get();

    expect([...files.written.keys()].filter((path) => path.endsWith('.sync-state.json') || path.endsWith('.sync-cursor.json'))).toHaveLength(0);
  });

  it('an address that points at a folder is refused, with what to give', async () => {
    const { got, files } = await get({ items: { '01QBR': item({ kind: 'folder', name: 'Operations' }), root: LIBRARY } });

    expect(got).toEqual({ ok: false, error: { step: 'readFile', cause: 'not-a-file', message: 'this address is a folder: give the address of one file' } });
    expect(files.written.size).toBe(0);
  });

  it('an address Graph cannot resolve fails naming the step and what Graph said', async () => {
    const { got } = await get({ links: {} });

    expect(got).toEqual({ ok: false, error: { step: 'resolveAddress', cause: 'permanent', message: `no file at ${LINK}` } });
  });

  it('a file that cannot be read once found fails naming the step', async () => {
    const { got } = await get({ failItemReads: { '01QBR': { kind: 'permanent', message: 'access denied' } } });

    expect(got).toEqual({ ok: false, error: { step: 'readFile', cause: 'permanent', message: 'access denied' } });
  });

  it('a file larger than the limit is not converted, and the answer says why', async () => {
    const { got, files } = await get({}, 1024);

    expect(got.ok).toBe(false);
    expect(got.ok === false && got.error).toMatchObject({ step: 'convert', cause: 'too-large' });
    expect(files.written.size).toBe(0);
  });

  it('a file whose conversion fails says what failed', async () => {
    const { got } = await get({ failItems: { '01QBR': { kind: 'permanent', message: 'locked' } } });

    expect(got.ok === false && got.error).toMatchObject({ step: 'convert', cause: 'failed' });
  });
});

// The address Office gives a document names it by an id, and Graph does not resolve that address.
// The file is then looked for by its name, and the one whose own address holds the same id is it.
describe('getting one file by the address Office gives it', () => {
  const OFFICE = 'https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7BAAAA1111-2222-3333-4444-555566667777%7D&file=QBR.docx&action=default';
  const other = item({
    id: '01OTHER',
    path: 'Archive/QBR.docx',
    webUrl: 'https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7BBBBB1111-2222-3333-4444-555566667777%7D&file=QBR.docx',
  });
  const wanted = item({
    webUrl: 'https://contoso.sharepoint.com/sites/Pepco/_layouts/15/Doc.aspx?sourcedoc=%7Baaaa1111-2222-3333-4444-555566667777%7D&file=QBR.docx&action=default',
  });
  const named = { 'QBR.docx': [{ driveId: 'b!one', itemId: '01OTHER' }, FILE] };

  const getOffice = async (seed: DriveReaderSeed = {}): Promise<{ got: Result<Got, StepError>; reader: ReturnType<typeof createDriveReaderFake> }> => {
    const files = createFilesFake();
    const reader = createDriveReaderFake({ links: {}, named, items: { '01QBR': wanted, '01OTHER': other, root: LIBRARY }, markdown: { '01QBR': '# Quarterly review' }, ...seed });
    const convertFile = createConvertFile({ reader, files, ocr: createOcrFake(), clock: createClockFake(), logger: createLoggerFake(), progress: createProgressFake() });
    return { got: await createGetFile({ drive: reader, convertFile, kbRoot: 'kb' })({ url: OFFICE, maxBytes: 50 * 1024 * 1024 }), reader };
  };

  it('the file is found by its name, and of two files of that name the one with the same document id is taken', async () => {
    const { got, reader } = await getOffice();

    expect(got).toEqual({ ok: true, value: { path: 'kb/Picked/Files/Pepco/Shared Documents/Operations/QBR.docx.md' } });
    expect(reader.calls.slice(0, 4)).toEqual([`fromLink:${OFFICE}`, 'filesNamed:QBR.docx', 'item:01OTHER', 'item:01QBR']);
  });

  it('no file of that name with the same document id fails, saying which address to give in its place', async () => {
    const { got } = await getOffice({ named: { 'QBR.docx': [{ driveId: 'b!one', itemId: '01OTHER' }] } });

    expect(got).toEqual({
      ok: false,
      error: { step: 'resolveAddress', cause: 'not-found', message: 'no file was found for this Office address: give the address from Copy link in SharePoint or OneDrive' },
    });
  });

  it('a file of that name that cannot be read is passed over, and the search that fails ends the get', async () => {
    const passed = await getOffice({ failItemReads: { '01OTHER': { kind: 'permanent', message: 'access denied' } } });
    const unsearched = await getOffice({ failNamed: { kind: 'transient', message: 'Graph is busy' } });

    expect(passed.got.ok).toBe(true);
    expect(unsearched.got).toEqual({ ok: false, error: { step: 'resolveAddress', cause: 'transient', message: 'Graph is busy' } });
  });
});
