import { describe, expect, it } from 'bun:test';
import type { ThreadRecord } from '../domain/mail-state.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderFake, DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import { CONV, LINK_BODIES, ROOT, THREAD_FOLDER, THREAD_ID, message } from '../test-helpers/thread-harness.ts';
import { createConvertAttachment } from './convert-attachment.ts';
import { createConvertFile } from './convert-file.ts';
import { createRenderThread } from './render-thread.ts';
import type { RenderedThread } from './render-thread.ts';
import { writtenBefore } from './thread-folders.ts';

// A thread is written again for a reply, a flag or a folder that changed, and each write pulled every
// document the thread linked to again: a download and a conversion for each, the same text each time.
// A write now reads the document's metadata, and keeps what the thread holds when the source has the
// version the thread pulled.
describe('a thread written again and the documents it links to', () => {
  const REPORT = {
    id: '01ABC',
    name: 'Rapport.docx',
    kind: 'file' as const,
    size: 4096,
    path: 'Rapport.docx',
    lastModified: '2026-05-11T08:00:00Z',
    modifiedBy: 'Jane Doe',
    cTag: 'c1',
    webUrl: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
  };
  const KEY = 'b!one:01ABC';
  const LINKED = `kb/Mailbox/threads/${THREAD_FOLDER}/_linked`;
  const CARD = `${LINKED}/Rapport.docx.md`;
  const seed: MailReaderSeed = {
    conversations: { [CONV]: [message()] },
    bodies: LINK_BODIES,
    links: { m1: [{ url: 'https://tenant.sharepoint.com/x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' }] },
  };
  const at = (over: Partial<typeof REPORT> = {}): DriveReaderSeed => ({ items: { '01ABC': { ...REPORT, ...over } } });

  // One write of the thread, from the record the write before left, the way a sync hands it over: the
  // mailbox as it is then, and how long a path may be.
  type Over = { readonly mail?: MailReaderSeed; readonly pathBudget?: number };

  const write = async (files: FilesFake, drive: DriveReaderFake, record?: ThreadRecord, over: Over = {}): Promise<RenderedThread | undefined> => {
    const reader = createMailReaderFake(over.mail ?? seed);
    const logger = createLoggerFake();
    const progress = createProgressFake();
    const render = createRenderThread({
      reader,
      drive,
      files,
      logger,
      progress,
      clock: createClockFake(),
      sourceName: 'Mailbox',
      mailboxRoot: 'kb/Mailbox',
      timezone: 'Europe/Paris',
      pathBudget: over.pathBudget,
      convertAttachment: createConvertAttachment({ reader, files, ocr: createOcrFake(), logger, unpackArchive: drive.localArchive, convertLocal: drive.localMarkdown }),
      convertFile: createConvertFile({ reader: drive, files, ocr: createOcrFake(), clock: createClockFake(), logger, progress, pathBudget: over.pathBudget }),
    });
    const result = await render({
      threadId: THREAD_ID,
      label: 'Contrat Contoso',
      conversationIds: [CONV],
      root: ROOT,
      folder: record?.folder ?? '',
      ...writtenBefore(record),
      maxBytes: 50 * 1024 * 1024,
      linked: {},
      attachments: {},
    });
    return result.ok && result.value.kind === 'rendered' ? result.value.thread : undefined;
  };

  type WrittenAgain = { once?: RenderedThread; twice?: RenderedThread; drive: DriveReaderFake; files: FilesFake; card?: string };

  // The thread written once, then again as the next run writes it, with what the source holds then.
  const writtenAgain = async (first: DriveReaderSeed, then: DriveReaderSeed, record?: (written: ThreadRecord) => ThreadRecord): Promise<WrittenAgain> => {
    const files = createFilesFake();
    const once = await write(files, createDriveReaderFake(first));
    const card = files.written.get(CARD);
    const drive = createDriveReaderFake(then);
    const before = once === undefined ? undefined : (record ?? ((written: ThreadRecord): ThreadRecord => written))(once.record);
    const twice = await write(files, drive, before);
    return { once, twice, drive, files, card };
  };

  it('keeps a linked document the source has at the version the thread pulled, and converts it no second time', async () => {
    const { once, twice, drive, files, card } = await writtenAgain(at(), at());

    expect(drive.calls).toStrictEqual(['item:01ABC']);
    expect(files.written.get(CARD)).toBe(card);
    expect(twice?.record.files).toStrictEqual(once?.record.files);
    expect(twice?.record.linkedVersions).toStrictEqual({ [KEY]: 'c1' });
    expect(twice?.linked[KEY]).toStrictEqual({ paths: [CARD] });
    expect(twice?.unread ?? []).toStrictEqual([]);
  });

  it('pulls a linked document again when the source has a new version', async () => {
    const { twice, drive, files } = await writtenAgain(at(), at({ cTag: 'c2', lastModified: '2026-06-01T08:00:00Z' }));

    expect(drive.calls).toContain('markdown:01ABC');
    expect(files.written.get(CARD)).toContain('last_modified: "2026-06-01T08:00:00Z"');
    expect(twice?.record.linkedVersions).toStrictEqual({ [KEY]: 'c2' });
  });

  // OneDrive for Business can leave the cTag out, and the time of the last change is what is left.
  it('tells the version by the time of the last change when the source gives no cTag', async () => {
    const { twice, drive } = await writtenAgain(at({ cTag: '' }), at({ cTag: '' }));

    expect(drive.calls).toStrictEqual(['item:01ABC']);
    expect(twice?.record.linkedVersions).toStrictEqual({ [KEY]: '2026-05-11T08:00:00Z' });
  });

  it('pulls again a linked document whose pull failed, since its card holds no text of it', async () => {
    const { once, twice, files } = await writtenAgain({ ...at(), failItems: { '01ABC': { kind: 'transient', message: 'timed out' } } }, at());

    expect(once?.record.linkedVersions).toStrictEqual({});
    expect(files.written.get(CARD)).toContain('converted 01ABC');
    expect(twice?.record.linkedVersions).toStrictEqual({ [KEY]: 'c1' });
  });

  // The card stays as it was when the source cannot be read, and so does the version it came from: the
  // write after that keeps the document again rather than pulling it.
  it('keeps the version of a document it could not read now, so the next write keeps the document', async () => {
    const { twice, files } = await writtenAgain(at(), { failWith: { kind: 'throttled', message: 'slow down' } });
    const drive = createDriveReaderFake(at());
    const thrice = await write(files, drive, twice?.record);

    expect(twice?.record.linkedVersions).toStrictEqual({ [KEY]: 'c1' });
    expect(drive.calls).toStrictEqual(['item:01ABC']);
    expect(thrice?.record.files).toStrictEqual([CARD]);
  });

  it('pulls again each document of a thread written before the versions were kept', async () => {
    const { drive } = await writtenAgain(at(), at(), (written) => ({ ...written, linkedVersions: undefined }));

    expect(drive.calls).toContain('markdown:01ABC');
  });

  it('pulls again a document whose card is not among the files the thread holds', async () => {
    const { drive } = await writtenAgain(at(), at(), (written) => ({ ...written, files: [] }));

    expect(drive.calls).toContain('markdown:01ABC');
  });

  // An archive or a saved mail unpacks into a folder named for it without its extension, beside its card.
  it('keeps what a linked archive unpacked when the source has the version the thread pulled', async () => {
    const mail = { ...seed, links: { m1: [{ url: 'https://tenant.sharepoint.com/z', driveId: 'b!one', itemId: '01ZIP', name: 'Contracts.zip' }] } };
    const zipped = (): DriveReaderFake =>
      createDriveReaderFake({
        items: { '01ZIP': { ...REPORT, id: '01ZIP', name: 'Contracts.zip', path: 'Contracts.zip' } },
        archiveEntries: [{ path: 'terms.docx', text: '# Terms' }],
      });
    const files = createFilesFake();
    const once = await write(files, zipped(), undefined, { mail });
    const later = zipped();
    const twice = await write(files, later, once?.record, { mail });

    expect(once?.record.files).toContain(`${LINKED}/Contracts/terms.docx.md`);
    expect(later.calls).toStrictEqual(['item:01ZIP']);
    expect(twice?.record.files).toStrictEqual(once?.record.files);
  });

  // A file a message attached is the copy the thread keeps: a document the thread holds is compared
  // with it first, as a document pulled for the first time is.
  it('keeps a document the thread holds once, as the attachment, when a later message attached it', async () => {
    const files = createFilesFake();
    const once = await write(files, createDriveReaderFake(at()));
    const reply = message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true });
    const attached = {
      ...seed,
      conversations: { [CONV]: [message(), reply] },
      attachments: { m2: [{ id: 'att1', name: 'Rapport.docx', contentType: 'application/vnd', size: 4096, isInline: false }] },
    };
    await write(files, createDriveReaderFake({ ...at(), bytes: { '01ABC': new TextEncoder().encode('bytes att1') } }), once?.record, { mail: attached });

    expect(files.written.get(CARD)).toContain('the same file');
  });

  // The documents of a message whose links could not be listed keep their names and their files until
  // a write that lists them, and so their versions.
  it('keeps the version of each document when a message`s links could not be listed', async () => {
    const files = createFilesFake();
    const once = await write(files, createDriveReaderFake(at()));
    const unlisted = { ...seed, failCalls: { sharepointLinks: { kind: 'transient' as const, message: 'timeout' } } };
    const twice = await write(files, createDriveReaderFake(at()), once?.record, { mail: unlisted });

    expect(twice?.record.linkedVersions).toStrictEqual({ [KEY]: 'c1' });
  });
});
