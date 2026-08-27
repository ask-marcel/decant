import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import type { AttachmentRecord } from '../domain/mail-state.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { shortHash } from '../domain/thread.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createConvertAttachment } from './convert-attachment.ts';
import { createConvertFile } from './convert-file.ts';
import { createRenderThread } from './render-thread.ts';
import type { RenderThreadOutcome } from './render-thread.ts';

const CONV = 'AAQkADk0...=';
const threadAt = (day: string): string => `threads/${day}/Contrat Contoso ${shortHash(CONV)}.md`;
const THREAD_RELATIVE = threadAt('2026-05-12');
const THREAD_FILE = `kb/Mailbox/${THREAD_RELATIVE}`;
// A thread whose latest message is the next day is filed under that day instead.
const THREAD_FILE_REPLIED = `kb/Mailbox/${threadAt('2026-05-13')}`;
// Attachments live in one store shared across every thread, not in a folder beside each thread.
const ATTACHMENTS_STORE = 'kb/Mailbox/_attachments';
// The bytes the mail-reader fake hands back for an attachment, so a test can address its store copy.
const bytesOf = (attachmentId: string): Uint8Array => new TextEncoder().encode(`bytes ${attachmentId}`);
// The name an attachment lands under: always a short slice of its content address, so it is fixed
// by the bytes alone and two files placed at once never collide.
const storedName = (name: string, attachmentId: string): string => disambiguateSegment(name, contentHash(bytesOf(attachmentId)));

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm1',
  conversationId: CONV,
  subject: 'Contrat Contoso',
  received: '2026-05-12T09:31:00Z',
  hasAttachments: false,
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ name: 'Vincent DELACOURT', address: 'vincent@example.com' }],
  isDeleted: false,
  ...over,
});

const run = async (
  seeds: {
    reader?: MailReaderSeed;
    drive?: DriveReaderSeed;
    files?: FilesFakeSeed;
    linked?: Record<string, { paths: string[] }>;
    attachments?: Record<string, AttachmentRecord>;
  } = {}
): Promise<{ outcome: RenderThreadOutcome | undefined; files: FilesFake; logger: LoggerFake; ok: boolean }> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const reader = createMailReaderFake(seeds.reader);
  const drive = createDriveReaderFake(seeds.drive);
  const render = createRenderThread({
    reader,
    drive,
    files,
    logger,
    clock: createClockFake(),
    mailboxRoot: 'kb/Mailbox',
    convertAttachment: createConvertAttachment({ reader, files, ocr: createOcrFake(), unpackArchive: drive.localArchive }),
    convertFile: createConvertFile({ reader: drive, files, ocr: createOcrFake(), clock: createClockFake(), logger }),
  });
  const result = await render({ conversationId: CONV, maxBytes: 50 * 1024 * 1024, ocrLabel: 'paddleocr (en)', linked: seeds.linked ?? {}, attachments: seeds.attachments ?? {} });
  return { outcome: result.ok ? result.value : undefined, files, logger, ok: result.ok };
};

describe('writing one conversation as one file', () => {
  it('the whole thread lands in a single file, filed under the day of its latest message', async () => {
    const conversations = { [CONV]: [message({ id: 'm2', received: '2026-05-13T10:00:00Z' }), message()] };
    const { outcome, files } = await run({ reader: { conversations, bodies: { m1: 'Here is the contract.', m2: 'Agreed.' } } });

    expect(outcome).toMatchObject({ kind: 'rendered' });
    const written = files.written.get(THREAD_FILE_REPLIED) ?? '';
    expect(written).toContain('# Contrat Contoso');
    expect(written).toContain('Here is the contract.');
    expect(written).toContain('Agreed.');
  });

  it('the head of the file states exactly where the conversation came from', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z', from: { name: 'Vincent DELACOURT', address: 'v@example.com' }, to: [] })] };
    const { files } = await run({ reader: { conversations, bodies: { m1: 'One.', m2: 'Two.' } } });
    const head = (files.written.get(THREAD_FILE_REPLIED) ?? '').split('\n---\n')[0] ?? '';

    expect(`${head}\n---`).toBe(
      [
        '---',
        `source: conversation ${CONV}`,
        'site: Mailbox',
        'subject: Contrat Contoso',
        'participants:',
        '  - Jane Doe',
        '  - Vincent DELACOURT',
        'first_message: "2026-05-12T09:31:00Z"',
        'last_message: "2026-05-13T10:00:00Z"',
        'message_count: 2',
        'synced_at: "2026-07-23T14:00:00Z"',
        '---',
      ].join('\n')
    );
  });

  it('an attachment is stamped with the conversation it arrived in and who wrote last', async () => {
    const conversations = { [CONV]: [message({ hasAttachments: true })] };
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations, attachments } });
    const written = files.written.get(`${ATTACHMENTS_STORE}/${storedName('Contrat.docx', 'att1')}.md`) ?? '';

    expect(written).toContain(`source: conversation ${CONV}`);
    expect(written).toContain('site: Mailbox');
    expect(written).toContain('library: Mailbox');
    expect(written).toContain('modified_by: Jane Doe');
    expect(written).toContain('last_modified: "2026-05-12T09:31:00Z"');
  });

  it('a thread replied to on a later day is filed under the reply, not under the day it started', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations } });

    expect(files.written.has(THREAD_FILE_REPLIED)).toBe(true);
    expect(files.written.has(THREAD_FILE)).toBe(false);
  });

  it('the file records who took part, when it started and ended, and how many messages it holds', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations } });
    const written = files.written.get(THREAD_FILE_REPLIED) ?? '';

    expect(written).toContain('participants:');
    expect(written).toContain('  - Jane Doe');
    expect(written).toContain('  - Vincent DELACOURT');
    expect(written).toContain('first_message: "2026-05-12T09:31:00Z"');
    expect(written).toContain('last_message: "2026-05-13T10:00:00Z"');
    expect(written).toContain('message_count: 2');
  });

  it('the conversation is recorded with every message it held, so a reply is noticed later', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { outcome } = await run({ reader: { conversations } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record).toMatchObject({
      file: threadAt('2026-05-13'),
      messageIds: ['m1', 'm2'],
      lastMessage: '2026-05-13T10:00:00Z',
    });
  });

  it('a message deleted from the thread is left out, and the rest still reads', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z', isDeleted: true })] };
    const { outcome, files } = await run({ reader: { conversations, bodies: { m1: 'Only me left.' } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.messageIds).toEqual(['m1']);
    expect(files.written.get(THREAD_FILE)).toContain('Only me left.');
  });

  it('a conversation whose every message is gone writes nothing', async () => {
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: [message({ isDeleted: true })] } } });

    expect(outcome).toEqual({ kind: 'empty' });
    expect(files.written.size).toBe(0);
  });

  it('a conversation Graph no longer knows writes nothing', async () => {
    const { outcome } = await run({ reader: { conversations: {} } });

    expect(outcome).toEqual({ kind: 'empty' });
  });
});

describe('keeping what a conversation carried', () => {
  const withAttachment = {
    conversations: { [CONV]: [message({ hasAttachments: true })] },
    attachments: { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] },
  };

  it('an attachment is converted once into the shared store and listed in the head', async () => {
    const { outcome, files } = await run({ reader: withAttachment });
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx', 'att1')}.md`;

    expect(files.written.has(stored)).toBe(true);
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([stored]);
  });

  it('the head points at the shared store, climbing out of the thread folder to reach it', async () => {
    const { files } = await run({ reader: withAttachment });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).toContain('attachments:');
    expect(written).toContain(`  - ../../_attachments/${storedName('Contrat.docx', 'att1')}.md`);
    expect(written).not.toContain('  - kb/Mailbox/');
  });

  it('the conversation records who wrote last, so a reader knows how fresh it is', async () => {
    const messages = [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z', from: { name: 'David Chang', address: 'd@example.com' }, hasAttachments: true })];
    const attachments = { m2: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/${storedName('Contrat.docx', 'att1')}.md`)).toContain('modified_by: David Chang');
  });

  it('a revised file resent under the same name is stored beside the first, told apart by content', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = {
      m1: [{ id: 'att1', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
      m2: [{ id: 'att2', name: 'Budget.xlsx', contentType: 'application/vnd', size: 5120, isInline: false }],
    };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    expect(stored[0]).toBe(`${ATTACHMENTS_STORE}/${storedName('Budget.xlsx', 'att1')}.md`);
    expect(stored[1]).toBe(`${ATTACHMENTS_STORE}/${storedName('Budget.xlsx', 'att2')}.md`);
    expect(stored[0]).not.toBe(stored[1]);
  });

  it('two files of one conversation sharing a name and a byte count are both kept, being different files', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = {
      m1: [{ id: 'att1', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
      m2: [{ id: 'att2', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
    };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    expect(stored).toEqual([`${ATTACHMENTS_STORE}/${storedName('Budget.xlsx', 'att1')}.md`, `${ATTACHMENTS_STORE}/${storedName('Budget.xlsx', 'att2')}.md`]);
  });

  it('a signature image riding on every message is converted once, not once per message', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const signature = [{ id: 'sig', name: 'image001.png', contentType: 'image/png', size: 100, isInline: true }];
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: signature, m2: signature } } });
    const raw = `${ATTACHMENTS_STORE}/${storedName('image001.png', 'sig')}`;

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([raw, `${raw}.md`]);
  });

  it('a file another conversation already stored is referenced, not converted again', async () => {
    const store: Record<string, AttachmentRecord> = {
      [contentHash(bytesOf('att1'))]: { name: 'Contrat.docx', paths: [`${ATTACHMENTS_STORE}/Contrat.docx.md`], primary: `${ATTACHMENTS_STORE}/Contrat.docx.md` },
    };
    const { outcome, files } = await run({ reader: withAttachment, attachments: store });

    expect(files.written.has(`${ATTACHMENTS_STORE}/Contrat.docx.md`)).toBe(false);
    expect(files.written.get(THREAD_FILE)).toContain('  - ../../_attachments/Contrat.docx.md');
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/Contrat.docx.md`]);
  });

  it('what a conversation stored is handed back, keyed by content, for the next conversation to reuse', async () => {
    const { outcome } = await run({ reader: withAttachment });

    expect(outcome?.kind === 'rendered' && outcome.thread.attachments[contentHash(bytesOf('att1'))]).toEqual({
      name: storedName('Contrat.docx', 'att1'),
      paths: [`${ATTACHMENTS_STORE}/${storedName('Contrat.docx', 'att1')}.md`],
      primary: `${ATTACHMENTS_STORE}/${storedName('Contrat.docx', 'att1')}.md`,
    });
  });

  it('a different file whose name is already taken in the store is told apart by its content', async () => {
    const store: Record<string, AttachmentRecord> = {
      otherhash000: { name: 'Contrat.docx', paths: [`${ATTACHMENTS_STORE}/Contrat.docx.md`], primary: `${ATTACHMENTS_STORE}/Contrat.docx.md` },
    };
    const { outcome } = await run({ reader: withAttachment, attachments: store });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    expect(stored[0]).toMatch(/^kb\/Mailbox\/_attachments\/Contrat-[0-9a-f]{8}\.docx\.md$/);
  });

  it('a message flagged as carrying nothing is passed over even when attachments are listed for it', async () => {
    const messages = [message({ id: 'm1', hasAttachments: false })];
    const attachments = { m1: [{ id: 'att1', name: 'Ghost.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([]);
  });

  it('an attachment whose bytes cannot be fetched is counted as failed, and the thread still lands', async () => {
    const { outcome, files } = await run({ reader: { ...withAttachment, failCalls: { attachmentBytes: { kind: 'transient', message: 'timeout' } } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Contrat.docx`, reason: 'transient: timeout' }]);
    expect(files.written.has(THREAD_FILE)).toBe(true);
  });

  it('a too-large attachment adds nothing to what the conversation lists', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Enorme.docx', contentType: 'application/vnd', size: 60 * 1024 * 1024, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([]);
  });

  it('an unsupported attachment adds nothing to what the conversation lists', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([]);
  });

  it('an attachment whose bytes failed adds nothing to what the conversation lists', async () => {
    const { outcome } = await run({ reader: { ...withAttachment, failCalls: { attachmentBytes: { kind: 'transient', message: 'timeout' } } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([]);
  });

  it('a message that carries nothing is never asked for its attachments', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] } } });

    expect(files.written.get(THREAD_FILE)).not.toContain('attachments:');
  });

  it('an attachment of a type this tool does not handle is counted, and the thread still lands', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] } };
    const { outcome, files } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toHaveLength(1);
    expect(files.written.has(THREAD_FILE)).toBe(true);
  });

  it('a message whose attachment list cannot be read names the message and the reason', async () => {
    const { outcome, files } = await run({ reader: { ...withAttachment, failAttachmentList: { kind: 'transient', message: 'timeout' } } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: message m1`, reason: 'could not list what it carried: timeout' }]);
    expect(files.written.has(THREAD_FILE)).toBe(true);
  });

  it('an attachment left out names itself and why, so the report can say what is missing', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Demo.mp4`, reason: 'a kind of file this tool does not read' }]);
  });

  it('an attachment above the size cap says so, with the cap it exceeded', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Enorme.docx', contentType: 'application/vnd', size: 60 * 1024 * 1024, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Enorme.docx`, reason: 'larger than the 50 MB cap' }]);
  });

  it('an attachment locked with a password is left out rather than counted as a failure', async () => {
    const reader = { ...withAttachment, failCalls: { attachmentMarkdown: { kind: 'protected' as const, message: 'xlsx parse failed: File is password-protected' } } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([
      { path: `${THREAD_RELATIVE}: Contrat.docx`, reason: 'locked with a password, so nothing could be read from it' },
    ]);
    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([]);
  });

  it('an attachment that could not be converted names itself and the reason', async () => {
    const { outcome } = await run({ reader: withAttachment, files: { failWritesMatching: '_attachments/' } });

    const failed = outcome?.kind === 'rendered' ? outcome.thread.filesFailed : [];

    expect(failed).toHaveLength(1);
    expect(failed[0]?.path.endsWith(': Contrat.docx')).toBe(true);
    expect(failed[0]?.reason.startsWith('write-failed: ')).toBe(true);
  });

  it('a message carrying nothing is never asked what it carried', async () => {
    const messages = [message({ id: 'm1', hasAttachments: false }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = { m2: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/${storedName('Contrat.docx', 'att1')}.md`]);
  });

  it('an attachment Microsoft would not convert is counted as failed without losing the thread', async () => {
    const reader = {
      ...withAttachment,
      attachments: { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] },
      attachmentTexts: {},
    };
    const { outcome } = await run({ reader, files: { failWritesMatching: '_attachments/' } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toHaveLength(1);
  });
});

describe('following the SharePoint files a conversation points at', () => {
  const linked = { m1: [{ url: 'https://tenant.sharepoint.com/x', driveId: 'b!one', itemId: '01ABC', name: 'Rapport.docx' }] };
  // A linked file is read for its own metadata before it is converted, the same read a swept file
  // gets, so the day it last changed decides the folder it lands in.
  const REPORT = {
    id: '01ABC',
    name: 'Rapport.docx',
    kind: 'file' as const,
    size: 4096,
    path: 'Rapport.docx',
    lastModified: '2026-05-11T08:00:00Z',
    cTag: 'c1',
    webUrl: 'https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx',
  };
  const items = { items: { '01ABC': REPORT } };
  const REPORT_MD = 'kb/Mailbox/_linked/2026-05-11/Rapport.docx.md';

  it('a linked document is pulled once and listed in the conversation head', async () => {
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: items });

    expect(files.written.has(REPORT_MD)).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain('linked_files:');
    expect(outcome?.kind === 'rendered' && outcome.thread.linked['b!one:01ABC']).toEqual({ paths: [REPORT_MD] });
  });

  it('a linked document is stamped with where it came from, so it can be traced back', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: items });
    const written = files.written.get(REPORT_MD) ?? '';

    expect(written).toContain('source: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx?web=1');
    expect(written).toContain('site: Mailbox');
    expect(written).toContain('library: _linked');
    expect(written).toContain('path: Rapport.docx');
    expect(written).toContain('synced_at: "2026-07-23T14:00:00Z"');
  });

  it('a message whose links cannot be looked up leaves the other messages of the thread intact', async () => {
    const messages = [message({ id: 'm1' }), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })];
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, links: { m2: linked.m1 } }, drive: items });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(REPORT_MD)).toBe(true);
  });

  it('a linked file the drive will not hand over is named in the report as having failed', async () => {
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'permanent: fake has no item 01ABC' }]);
  });

  it('a linked file of a kind this tool does not read is named in the report', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, name: 'Recording.mp4', path: 'Recording.mp4' } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'a kind of file this tool does not read' }]);
  });

  it('a linked file that could not be converted is named in the report, not lost between the two', async () => {
    const seeded = { items: { '01ABC': REPORT }, failItems: { '01ABC': { kind: 'permanent' as const, message: 'cannot convert' } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'permanent: cannot convert' }]);
  });

  it('a document linked from two messages is listed once in the head, not once per message', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect((files.written.get(THREAD_FILE_REPLIED) ?? '').match(/- \.\/_linked\/2026-05-11\/Rapport\.docx\.md/g)).toHaveLength(1);
  });

  it('a document another conversation already pulled is referenced, not fetched again', async () => {
    const already = { 'b!one:01ABC': { paths: [REPORT_MD] } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: items, linked: already });

    expect(files.written.has(REPORT_MD)).toBe(false);
    expect(files.written.get(THREAD_FILE)).toContain('  - ./_linked/2026-05-11/Rapport.docx.md');
  });

  it('a linked deck is kept as slides as well as text, the way a deck in a library is', async () => {
    const deck = { m1: [{ url: 'https://tenant.sharepoint.com/d', driveId: 'b!one', itemId: '01DECK', name: 'Deck.pptx' }] };
    const seeded = { items: { '01DECK': { ...REPORT, id: '01DECK', name: 'Deck.pptx', path: 'Deck.pptx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, links: deck }, drive: seeded });

    expect(files.binary.has('kb/Mailbox/_linked/2026-05-11/Deck.pptx.pdf')).toBe(true);
    expect(files.written.has('kb/Mailbox/_linked/2026-05-11/Deck.pptx.md')).toBe(true);
  });

  it('a linked file past the size cap is left where it is rather than pulled', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, size: 60 * 1024 * 1024 } } };
    const { files, logger } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: seeded });

    expect(files.written.has(REPORT_MD)).toBe(false);
    expect(logger.calls.some((call) => call.event === 'linked.skipped')).toBe(true);
  });

  it('a linked file too large to pull is named in the report rather than passed over in silence', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, size: 60 * 1024 * 1024 } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'larger than the 50 MB cap' }]);
  });

  it('a linked file the folders under SharePoint hold is filed under those folders too', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, path: 'Decks/Q3/Rapport.docx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked }, drive: seeded });

    expect(files.written.has('kb/Mailbox/_linked/2026-05-11/Decks/Q3/Rapport.docx.md')).toBe(true);
  });

  it('the same document linked from two messages of a thread is listed once', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { outcome } = await run({ reader: { conversations, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect(outcome?.kind === 'rendered' && Object.keys(outcome.thread.linked)).toEqual(['b!one:01ABC']);
  });

  it('a linked document that cannot be written is reported and the conversation still lands', async () => {
    const { outcome, files, logger } = await run({
      reader: { conversations: { [CONV]: [message()] }, links: linked },
      drive: items,
      files: { failWritesMatching: '_linked/' },
    });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(THREAD_FILE)).toBe(true);
    expect(logger.calls.some((call) => call.event === 'linked.failed')).toBe(true);
  });

  it('a message whose links cannot be looked up leaves the conversation intact', async () => {
    const { outcome, files } = await run({
      reader: { conversations: { [CONV]: [message()] }, failMessages: { m1: { kind: 'transient', message: 'timeout' } }, bodies: { m1: 'body' } },
    });

    expect(outcome).toBeUndefined();
    expect(files.written.size).toBe(0);
  });

  it('a linked document that cannot be read is reported and the conversation still lands', async () => {
    const { outcome, files, logger } = await run({
      reader: { conversations: { [CONV]: [message()] }, links: linked },
      drive: { failWith: { kind: 'permanent', status: 403, message: 'no access' } },
    });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(THREAD_FILE)).toBe(true);
    expect(logger.calls.some((call) => call.event === 'linked.failed')).toBe(true);
  });
});

describe('when the mailbox or the disk refuses', () => {
  it('a conversation Graph refuses to hand over ends the render with the reason', async () => {
    const { ok: succeeded } = await run({ reader: { failWith: { kind: 'throttled', message: 'too many requests' } } });

    expect(succeeded).toBe(false);
  });

  it('a body Graph refuses to convert ends the render rather than writing half a thread', async () => {
    const { ok: succeeded, files } = await run({ reader: { conversations: { [CONV]: [message()] }, failMessages: { m1: { kind: 'permanent', message: 'blocked' } } } });

    expect(succeeded).toBe(false);
    expect(files.written.size).toBe(0);
  });

  it('a knowledge base that cannot be written to is reported', async () => {
    const { ok: succeeded } = await run({
      reader: { conversations: { [CONV]: [message()] } },
      files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } },
    });

    expect(succeeded).toBe(false);
  });
});

describe('what a message body says about the files it carried', () => {
  const PASTED = { id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' };
  const shownAt = (attachmentId: string, name: string): string => `../../_attachments/${storedName(name, attachmentId)}`;

  it('a picture pasted into a message is kept and shown where it stood, though Graph said the message carried nothing', async () => {
    const messages = [message({ hasAttachments: false })];
    const bodies = { m1: 'Regards,\n\n\\[inline image: logo.png\\]' };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments: { m1: [PASTED] } } });

    expect(files.binary.has(`${ATTACHMENTS_STORE}/${storedName('logo.png', 'sig')}`)).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain(`![logo.png](${shownAt('sig', 'logo.png')})`);
  });

  it('a picture shown in the body is named under inline_images, never among the attachments', async () => {
    const messages = [message({ hasAttachments: false })];
    const bodies = { m1: '\\[inline image: logo.png\\]' };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments: { m1: [PASTED] } } });
    const raw = `${ATTACHMENTS_STORE}/${storedName('logo.png', 'sig')}`;

    expect(files.written.get(THREAD_FILE)).toContain('inline_images:\n  - ../../_attachments/');
    expect(files.written.get(THREAD_FILE)).not.toContain('attachments:\n');
    expect(outcome?.kind === 'rendered' && outcome.thread.record.inlineImages).toEqual([raw, `${raw}.md`]);
  });

  it('a message Graph says carries nothing, showing no picture, is never asked what it carried', async () => {
    const messages = [message({ hasAttachments: false })];
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: [PASTED] } } });

    expect(files.binary.size).toBe(0);
  });

  it('a file a message carried is named under that message, linking where it landed', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(files.written.get(THREAD_FILE)).toContain(`**Attachments:**\n- [Contrat.docx](${shownAt('att1', 'Contrat.docx')}.md) (4.0 KB, application/vnd)`);
  });

  it('the list the converter closed the body with is replaced, taking its Graph id with it', async () => {
    const messages = [message({ hasAttachments: true })];
    const bodies = { m1: 'Please find it attached.\n\n**Attachments:**\n- Contrat.docx (4.0 KB, application/vnd, id: AAMkADc3NTlh==)' };
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments } });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).not.toContain('id: AAMkADc3NTlh==');
    expect(written.split('**Attachments:**')).toHaveLength(2);
  });

  it('a file that was left alone keeps its name in the body with the reason beside it', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 4096, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(files.written.get(THREAD_FILE)).toContain('- Demo.mp4 (4.0 KB, video/mp4), a kind of file this tool does not read');
  });
});
