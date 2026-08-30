import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import type { AttachmentRecord } from '../domain/mail-state.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { tooLargeReason } from '../domain/report.ts';
import { threadIdOf } from '../domain/thread-id.ts';
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
import type { OcrSeed } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import { createConvertAttachment } from './convert-attachment.ts';
import { createConvertFile } from './convert-file.ts';
import { createRenderThread } from './render-thread.ts';
import type { RenderThreadOutcome } from './render-thread.ts';

const CONV = 'AAQkADk0...=';
// Named once, from the thread's FIRST message, and never again: the day it began, the id its root
// message hashes to, and what it is about. A reply no longer moves it, which is why one constant
// serves where a replied-to thread used to need its own.
const ROOT = '<AM0PR04MB6f21@example.com>';
const THREAD_ID = threadIdOf(ROOT);
const THREAD_FOLDER = `2026-05-12-${THREAD_ID}-contrat-contoso`;
const THREAD_RELATIVE = `threads/${THREAD_FOLDER}/contrat-contoso.md`;
const THREAD_FILE = `kb/Mailbox/${THREAD_RELATIVE}`;
// Everything a thread received lives beside it: the file and the card that stands for it, in the
// thread's own folder. There is no store shared across threads any more.
const ATTACHMENTS_STORE = `kb/Mailbox/threads/${THREAD_FOLDER}/_attachments`;
const INLINE_STORE = 'kb/Mailbox/_inline';
// A body that carries a SharePoint address, since that is what makes the run ask a message what it
// points at. Real mail carries the address in its text; a message with none is never asked.
const LINK_BODIES = { m1: 'See https://tenant.sharepoint.com/sites/team/Rapport.docx', m2: 'See https://tenant.sharepoint.com/sites/team/Rapport.docx' };
// The bytes the mail-reader fake hands back for an attachment, so a test can address its store copy.
const bytesOf = (attachmentId: string): Uint8Array => new TextEncoder().encode(`bytes ${attachmentId}`);
// The name an attachment lands under. No content address in it: one thread's folder only has to
// separate a same-name-different-content pair, which a number says more plainly than a hash.
const storedName = (name: string): string => name;

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
    conversationIds?: string[];
    folder?: string;
    linked?: Record<string, { paths: string[] }>;
    attachments?: Record<string, AttachmentRecord>;
    ocr?: OcrSeed;
  } = {}
): Promise<{ outcome: RenderThreadOutcome | undefined; files: FilesFake; logger: LoggerFake; reader: ReturnType<typeof createMailReaderFake>; ok: boolean }> => {
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
    timezone: 'Europe/Paris',
    convertAttachment: createConvertAttachment({ reader, files, ocr: createOcrFake(seeds.ocr), logger, unpackArchive: drive.localArchive, convertLocal: drive.localMarkdown }),
    convertFile: createConvertFile({ reader: drive, files, ocr: createOcrFake(), clock: createClockFake(), logger, progress: createProgressFake() }),
  });
  const result = await render({
    threadId: THREAD_ID,
    conversationIds: seeds.conversationIds ?? [CONV],
    root: ROOT,
    folder: seeds.folder ?? '',
    maxBytes: 50 * 1024 * 1024,
    linked: seeds.linked ?? {},
    attachments: seeds.attachments ?? {},
  });
  return { outcome: result.ok ? result.value : undefined, files, logger, reader, ok: result.ok };
};

describe('writing one conversation as one file', () => {
  it('the whole thread lands in a single file, filed under the day it began', async () => {
    const conversations = { [CONV]: [message({ id: 'm2', received: '2026-05-13T10:00:00Z' }), message()] };
    const { outcome, files } = await run({ reader: { conversations, bodies: { m1: 'Here is the contract.', m2: 'Agreed.' } } });

    expect(outcome).toMatchObject({ kind: 'rendered' });
    const written = files.written.get(THREAD_FILE) ?? '';
    expect(written).toContain('# Contrat Contoso');
    expect(written).toContain('Here is the contract.');
    expect(written).toContain('Agreed.');
  });

  it('the head of the file states exactly where the conversation came from', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z', from: { name: 'Vincent DELACOURT', address: 'v@example.com' }, to: [] })] };
    const { files } = await run({ reader: { conversations, bodies: { m1: 'One.', m2: 'Two.' } } });
    const head = (files.written.get(THREAD_FILE) ?? '').split('\n---\n')[0] ?? '';

    expect(`${head}\n---`).toBe(
      [
        '---',
        `thread_id: "${THREAD_ID}"`,
        `root_message_id: "${ROOT}"`,
        'conversation_id:',
        `  - ${CONV}`,
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

  // One document per file, not a card beside an extract saying the same thing. The converter writes
  // the text at this path and the card is written over it, carrying the text forward and replacing
  // a stamp about which library it came from with the facts that matter for mail: who sent it, when,
  // and under which message.
  it('an attachment is one document, stamped with who sent it and under which message', async () => {
    const conversations = { [CONV]: [message({ hasAttachments: true })] };
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations, attachments } });
    const written = files.written.get(`${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`) ?? '';

    expect(written).toContain(`attachment_of: "${THREAD_ID}"`);
    expect(written).toContain('message_id: m1');
    expect(written).toContain('sender: Jane Doe');
    expect(written).toContain('received: "2026-05-12T09:31:00Z"');
    expect(written).toContain('converted att1');
  });

  it('a conversation whose body cannot be read is left for the next run rather than written half empty', async () => {
    const conversations = { [CONV]: [message()] };
    const { ok: succeeded, files } = await run({ reader: { conversations, failCalls: { messageMarkdown: { kind: 'transient', message: 'throttled' } } } });

    expect(succeeded).toBe(false);
    expect([...files.written.keys()].filter((path) => path.includes('/threads/') && !path.includes('/_attachments/'))).toHaveLength(0);
  });

  const CARDS = `kb/Mailbox/threads/${THREAD_FOLDER}/_attachments`;
  const attached = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };

  it('each file a thread carried gets a card beside the thread, saying who sent it and where it is kept', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: attached } });
    const card = files.written.get(`${CARDS}/Contrat.docx.md`) ?? '';

    expect(card).toContain(`attachment_of: "${THREAD_ID}"`);
    expect(card).toContain('filename: Contrat.docx');
    expect(card).toContain('sender: Jane Doe');
    expect(card).toContain('converted att1');
    // A document is read and its own copy dropped, so there is nothing else for the card to name.
    expect(card).not.toContain('original:');
  });

  // The case that decides where cards are written. The conversion is short-circuited for a content
  // the store already holds, so a card written inside it would exist only for whichever thread
  // arrived first, and every other thread would name files in its head that its folder never showed.
  // A file riding on several messages of ONE thread is converted once. Across threads it is written
  // again, which is the trade this layout makes so a folder reads without reaching into another.
  it('a file carried by two messages of a thread is written once, not once per message', async () => {
    const twice = { m1: attached.m1, m2: attached.m1 };
    const messages = [message({ hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: twice } });

    // Twice, exactly: the converter puts its extract at that path and the card is written over it,
    // which is deliberate. A third write would be a second card for the file's second arrival.
    expect(files.writeLog.filter((path) => path === `${CARDS}/Contrat.docx.md`)).toHaveLength(2);
    expect(files.written.has(`${CARDS}/Contrat-2.docx.md`)).toBe(false);
  });

  // A card is a convenience, not the content. Losing one costs an entry in a folder listing, where
  // failing the thread would cost the conversation itself.
  it('a card that cannot be written is said so and leaves the thread standing', async () => {
    const {
      files,
      logger,
      ok: succeeded,
    } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: attached },
      files: { failWritesMatching: '/_attachments/Contrat.docx.md' },
    });

    expect(succeeded).toBe(true);
    expect(files.written.has(THREAD_FILE)).toBe(true);
    expect(logger.calls.filter((call) => call.event === 'card.failed')).toEqual([
      { level: 'warn', event: 'card.failed', meta: { filename: 'Contrat.docx', cause: 'write-failed' } },
    ]);
  });

  it('a file kept whole as well as read names both copies in its card', async () => {
    const picture = { m1: [{ id: 'att1', name: 'rack.jpg', contentType: 'image/jpeg', size: 12, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: picture } });
    const card = files.written.get(`${CARDS}/rack.jpg.md`) ?? '';

    expect(card).toContain(`original: ${storedName('rack.jpg')}`);
  });

  // A picture shown in the body is not something the thread "carried" in the sense a card describes,
  // and no document is written for it at all: what was read off it is in the thread, under the
  // picture, where a reader is already looking. A card and a document would both say it again.
  it('a picture shown in the body is written as itself, with no document of any kind beside it', async () => {
    const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' }];
    const { files } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } },
    });
    const written = [...files.written.keys()].filter((path) => path.endsWith('.md'));

    expect(written).toEqual([THREAD_FILE]);
  });

  // The whole point of reading a picture at all: a signature block holds the sender's company and
  // phone number, and a thread that shows the picture but hides its words makes a reader open a
  // second document for them. Quoted, so it reads as text lifted off a picture.
  it('what was read out of a picture is shown in the thread, under the picture', async () => {
    const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' }];
    const texts = { 'kb/Mailbox/_inline/logo-3d8c205c.png': 'Michael Pronk\nStratego Development\n+31618225472' };
    const { files } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } },
      ocr: { texts },
    });

    expect(files.written.get(THREAD_FILE)).toContain('![logo.png](../../_inline/logo-3d8c205c.png)\n\n> Michael Pronk\n> Stratego Development\n> +31618225472');
  });

  const SIGNATURE = `${INLINE_STORE}/logo-3d8c205c.png`;
  const storedPicture = (text?: string): Record<string, AttachmentRecord> => ({
    [contentHash(bytesOf('sig'))]: { name: 'logo-3d8c205c.png', paths: [SIGNATURE], primary: SIGNATURE, media: [], text },
  });
  const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' }];
  const showing = { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } };

  // The reason the store is shared at all: one signature logo rides on every message its sender
  // ever wrote, so a mailbox of two hundred threads would otherwise hold two hundred copies of it.
  // The words come back with it, since no document holds them any more.
  it('a picture an earlier thread already stored is not fetched again, and still shows its words', async () => {
    const { files } = await run({ reader: showing, attachments: storedPicture('Michael Pronk') });

    expect(files.binary.size).toBe(0);
    expect(files.written.get(THREAD_FILE)).toContain('![logo.png](../../_inline/logo-3d8c205c.png)\n\n> Michael Pronk');
  });

  // Self-healing rather than silently wordless: a run from before pictures carried their reading
  // left records with no text, and honouring one would show the picture in this thread with nothing
  // under it, a loss no later run would ever repair. Converting again costs one fetch.
  it('a picture stored before the words were kept is read again rather than shown wordless', async () => {
    const { files } = await run({ reader: showing, attachments: storedPicture(undefined), ocr: { texts: { [SIGNATURE]: 'Michael Pronk' } } });

    expect(files.binary.has(SIGNATURE)).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain('> Michael Pronk');
  });

  // No placeholder in the text answered for it, so nothing shows it. It is still a picture, so it
  // gets no card, and the list that has to name it links the picture rather than a file nothing
  // wrote. A link to a card that was never written is worse than no link at all.
  it('a picture the body never showed is listed as itself, with no card standing in for it', async () => {
    // Graph reports the attachment, and the body shows no placeholder for it: the message is asked
    // what it carried, and what comes back is a picture nothing in the text points at.
    const { files } = await run({ reader: { ...showing, conversations: { [CONV]: [message({ hasAttachments: true })] }, bodies: { m1: 'Regards,' } } });

    expect(files.written.has(`${ATTACHMENTS_STORE}/logo.png.md`)).toBe(false);
    expect(files.written.get(THREAD_FILE)).toContain('- [logo.png](../../_inline/logo-3d8c205c.png) (100 B, image/png)');
  });

  // `isInline` alone does not make a picture. A PDF the body points at by `cid:` is a document: it
  // belongs to the thread that received it, is carded like any other, and its text is far too long
  // to quote under an image that would not be shown anyway.
  it('a document the body points at inline is still a document, kept with the thread', async () => {
    const inlineDoc = [{ id: 'att1', name: 'Contrat.pdf', contentType: 'application/pdf', size: 100, isInline: true, contentId: 'c@01DC1234' }];
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: { m1: inlineDoc } } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/Contrat.pdf.md`) ?? '').toContain('attachment_of:');
    expect([...files.binary.keys()].some((path) => path.startsWith(INLINE_STORE))).toBe(false);
  });

  // Nothing read is shown as nothing. The note a document uses to say it holds no text would be
  // quoted under the picture, once per signature down a long thread, telling a reader to open a
  // file beside a note that is not there any more.
  it('a picture nothing could be read out of is shown alone, with no note quoted under it', async () => {
    const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' }];
    const { files } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } },
    });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).toContain('![logo.png](../../_inline/logo-3d8c205c.png)');
    // A quoted line, not the character: the head carries a message id in angle brackets.
    expect(written).not.toContain('\n> ');
  });

  it('a file from nobody in particular is still carded, with no sender named', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true, from: undefined })] }, attachments: attached } });
    const card = files.written.get(`${CARDS}/Contrat.docx.md`) ?? '';

    expect(card).toContain('filename: Contrat.docx');
    expect(card).not.toContain('sender:');
  });

  it('two files of one name in a thread each get their own card', async () => {
    const two = {
      m1: [
        { id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false },
        { id: 'att2', name: 'Contrat.docx', contentType: 'application/vnd', size: 11, isInline: false },
      ],
    };
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: two } });

    expect(files.written.has(`${CARDS}/Contrat.docx.md`)).toBe(true);
    expect(files.written.has(`${CARDS}/Contrat-2.docx.md`)).toBe(true);
  });

  it('a thread assembled from two conversations holds every message from both, in order', async () => {
    const conversations = {
      [CONV]: [message({ id: 'm1', received: '2026-05-12T09:31:00Z' })],
      'conv-outside': [message({ id: 'm2', conversationId: 'conv-outside', received: '2026-05-13T10:00:00Z' })],
    };
    const bodies = { m1: 'Here is the contract.', m2: 'Replying from outside Exchange.' };
    const { files } = await run({ reader: { conversations, bodies }, conversationIds: [CONV, 'conv-outside'] });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).toContain('Here is the contract.');
    expect(written).toContain('Replying from outside Exchange.');
    expect(written.indexOf('Here is the contract.')).toBeLessThan(written.indexOf('Replying from outside Exchange.'));
    expect([...files.written.keys()].filter((path) => path.includes('/threads/') && !path.includes('/_attachments/'))).toHaveLength(1);
  });

  // Reused verbatim, never recomputed. The slug and timezone rules that produced it are code, and a
  // later change to either would otherwise move a folder already written and already linked to.
  it('a thread keeps the folder it was already filed under, whatever the naming rules would say today', async () => {
    const held = '2024-01-02-deadbeef00-an-older-name-entirely';
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] } }, folder: held });

    expect(files.written.has(`kb/Mailbox/threads/${held}/contrat-contoso.md`)).toBe(true);
    expect([...files.written.keys()].filter((path) => path.includes('/threads/') && !path.includes('/_attachments/'))).toHaveLength(1);
  });

  // The count is what proves it. The previous layout filed a thread under its LATEST message, so a
  // reply wrote a second file and left the first behind with nothing pointing at it and no code that
  // would ever collect it. Asserting the new path exists would not have noticed the old one lingering.
  it('a thread replied to on a later day stays in the folder it began in', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations } });

    expect(files.written.has(THREAD_FILE)).toBe(true);
    expect([...files.written.keys()].filter((path) => path.includes('/threads/') && !path.includes('/_attachments/'))).toHaveLength(1);
  });

  it('the file records who took part, when it started and ended, and how many messages it holds', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations } });
    const written = files.written.get(THREAD_FILE) ?? '';

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
      file: THREAD_RELATIVE,
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
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`;

    expect(files.written.has(stored)).toBe(true);
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([stored]);
  });

  it('the head points at the shared store, climbing out of the thread folder to reach it', async () => {
    const { files } = await run({ reader: withAttachment });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).toContain('attachments:');
    expect(written).toContain('  - _attachments/Contrat.docx.md');
    expect(written).not.toContain('  - kb/Mailbox/');
  });

  it('the conversation records who wrote last, so a reader knows how fresh it is', async () => {
    const messages = [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z', from: { name: 'David Chang', address: 'd@example.com' }, hasAttachments: true })];
    const attachments = { m2: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`)).toContain('sender: David Chang');
  });

  it('a revised file resent under the same name is stored beside the first, told apart by content', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = {
      m1: [{ id: 'att1', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
      m2: [{ id: 'att2', name: 'Budget.xlsx', contentType: 'application/vnd', size: 5120, isInline: false }],
    };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    // Told apart by a number now, not by a content address: inside one thread that is all the
    // separation a pair of same-named files needs, and it reads better in a folder listing.
    const first = `${ATTACHMENTS_STORE}/Budget.xlsx`;
    const second = `${ATTACHMENTS_STORE}/Budget-2.xlsx`;

    expect(stored).toEqual([first, `${first}.md`, second, `${second}.md`]);
  });

  it('two files of one conversation sharing a name and a byte count are both kept, being different files', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = {
      m1: [{ id: 'att1', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
      m2: [{ id: 'att2', name: 'Budget.xlsx', contentType: 'application/vnd', size: 4096, isInline: false }],
    };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments } });
    const stored = outcome?.kind === 'rendered' ? outcome.thread.record.attachments : [];

    const first = `${ATTACHMENTS_STORE}/Budget.xlsx`;
    const second = `${ATTACHMENTS_STORE}/Budget-2.xlsx`;

    expect(stored).toEqual([first, `${first}.md`, second, `${second}.md`]);
  });

  it('a signature image riding on every message is converted once, not once per message', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const signature = [{ id: 'sig', name: 'image001.png', contentType: 'image/png', size: 100, isInline: true }];
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: signature, m2: signature } } });
    // Under `attachments` rather than `inline_images` because no placeholder in the body answered
    // for it, so nothing shows it. It still lives in the mailbox's picture store, where the next
    // thread its sender writes into will find it already there.
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${INLINE_STORE}/${disambiguateSegment('image001.png', contentHash(bytesOf('sig')))}`]);
  });

  // Written here even though another thread holds the same bytes. That is the trade this layout
  // makes: a file arriving in two threads is written twice, so each folder reads on its own.
  it('a file another conversation holds is written here too, so this thread reads on its own', async () => {
    const store: Record<string, AttachmentRecord> = {
      [contentHash(bytesOf('att1'))]: {
        name: 'Contrat.docx',
        paths: ['kb/Mailbox/threads/other/_attachments/Contrat.docx.md'],
        primary: 'kb/Mailbox/threads/other/_attachments/Contrat.docx.md',
        media: [],
      },
    };
    const { outcome, files } = await run({ reader: withAttachment, attachments: store });

    expect(files.written.has(`${ATTACHMENTS_STORE}/Contrat.docx.md`)).toBe(true);
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/Contrat.docx.md`]);
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

  // Named before its bytes are asked for, which is what lets a file nobody can read still be
  // accounted for. The thread lists nothing, so without the card the only trace that anything
  // arrived would be the run's report, which no reader of the vault ever opens.
  it('a file too large to fetch still gets a card, since a card is the only record that it came', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Enorme.docx', contentType: 'application/vnd', size: 60 * 1024 * 1024, isInline: false }] } };
    const { files } = await run({ reader });
    const card = files.written.get(`${ATTACHMENTS_STORE}/Enorme.docx.md`) ?? '';

    expect(card).toContain('filename: Enorme.docx');
    expect(card).toContain('sender: Jane Doe');
    expect(card).toContain(tooLargeReason(50 * 1024 * 1024));
  });

  it('a file of exactly the size allowed is kept, the cap being what may not be passed', async () => {
    const reader = { ...withAttachment, attachments: { m1: [{ id: 'att1', name: 'Pile.docx', contentType: 'application/vnd', size: 50 * 1024 * 1024, isInline: false }] } };
    const { outcome } = await run({ reader });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/Pile.docx.md`]);
  });

  // `original:` is the card saying "the file itself is here, beside me". A conversion that yields
  // several outputs, a document with its pictures pulled out or a mail unpacked into its parts, has
  // no output that IS the file, and naming any of them is worse than naming none.
  it('a card names no original when none of the conversion outputs is the file itself', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments, attachmentImages: images } });
    const card = files.written.get(`${ATTACHMENTS_STORE}/Contrat.docx.md`) ?? '';

    expect(card).toContain('filename: Contrat.docx');
    expect(card).not.toContain('original:');
  });

  // A notification saying somebody shared a folder carries the icons its HTML is built from, named
  // by a machine id and carrying no extension, which is why nothing reads them. A card for one says
  // only that an unreadable thing with an unreadable name arrived, and thirteen of them buried the
  // two real files in the same vault. The run still counts them, so nothing goes unaccounted for.
  const ICON = { id: 'att1', name: 'a594de8f-caa3-427e-b800-23755374d464', contentType: 'image/png', size: 963, isInline: false };

  it('a refused file whose name is only a machine id gets no card and no mention in the thread', async () => {
    const messages = [message({ hasAttachments: true })];
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: { m1: [ICON] } } });

    expect(files.written.has(`${ATTACHMENTS_STORE}/${ICON.name}.md`)).toBe(false);
    expect(files.written.get(THREAD_FILE)).not.toContain(ICON.name);
    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toHaveLength(1);
  });

  // Both halves are needed. A machine id on a file that reads fine still yields a document worth
  // keeping, and the id is then the least of what the card says about it.
  it('a file named by a machine id is kept when something can read it after all', async () => {
    const messages = [message({ hasAttachments: true })];
    const readable = { m1: [{ ...ICON, name: `${ICON.name}.pdf` }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: readable } });

    expect(files.written.has(`${ATTACHMENTS_STORE}/${ICON.name}.pdf.md`)).toBe(true);
  });

  it('a refused file somebody named keeps its card, the name being the fact worth recording', async () => {
    const messages = [message({ hasAttachments: true })];
    const named = { m1: [{ id: 'att1', name: 'Demo.mp4', contentType: 'video/mp4', size: 10, isInline: false }] };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, attachments: named } });

    expect(files.written.get(`${ATTACHMENTS_STORE}/Demo.mp4.md`) ?? '').toContain('filename: Demo.mp4');
    expect(files.written.get(THREAD_FILE)).toContain('Demo.mp4');
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

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}.md`]);
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

  // Asking costs a Graph call per message, and a full run asked a thousand times to find thirty-six
  // links. The body is already in hand by then, so it is what decides whether the question is worth
  // asking at all.
  it('a message pointing at nothing is never asked what it points at', async () => {
    const { reader } = await run({ reader: { conversations: { [CONV]: [message()] }, links: linked } });

    expect(reader.calls.filter((call) => call.startsWith('links:'))).toEqual([]);
  });

  it('a linked document is pulled once and listed in the conversation head', async () => {
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });

    expect(files.written.has(REPORT_MD)).toBe(true);
    // Pinned whole rather than by its key: a reader follows this path from the folder the thread sits
    // in, so a value that resolves from the mailbox root instead would read as present and be broken.
    expect(files.written.get(THREAD_FILE)).toContain('linked_files:\n  - ../../_linked/2026-05-11/Rapport.docx.md');
    expect(outcome?.kind === 'rendered' && outcome.thread.linked['b!one:01ABC']).toEqual({ paths: [REPORT_MD] });
  });

  it('a document a thread pointed at gets a card beside the thread, naming its address at the source', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });
    const card = files.written.get(`kb/Mailbox/threads/${THREAD_FOLDER}/_linked/Rapport.docx.md`) ?? '';

    expect(card).toContain(`linked_from: "${THREAD_ID}"`);
    expect(card).toContain('url: https://tenant.sharepoint.com/x');
    expect(card).toContain('holds: ../../../_linked/2026-05-11/Rapport.docx.md');
  });

  // The card is the only place a thread's dependence on something the vault does not hold is
  // written down. Dropping it when the pull fails would make the gap invisible.
  it('a document that could not be pulled still gets a card, saying why it is not here', async () => {
    const { files } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
      drive: { failWith: { kind: 'permanent', message: 'gone' } },
    });
    const card = files.written.get(`kb/Mailbox/threads/${THREAD_FOLDER}/_linked/Rapport.docx.md`) ?? '';

    expect(card).toContain('url: https://tenant.sharepoint.com/x');
    expect(card).toContain('permanent: gone');
    expect(card).not.toContain('holds:');
  });

  it('a linked document is stamped with where it came from, so it can be traced back', async () => {
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items });
    const written = files.written.get(REPORT_MD) ?? '';

    expect(written).toContain('source: https://tenant.sharepoint.com/sites/team/Shared%20Documents/Rapport.docx?web=1');
    expect(written).toContain('site: Mailbox');
    expect(written).toContain('library: _linked');
    expect(written).toContain('path: Rapport.docx');
    expect(written).toContain('synced_at: "2026-07-23T14:00:00Z"');
  });

  it('a message whose links cannot be looked up leaves the other messages of the thread intact', async () => {
    const messages = [message({ id: 'm1' }), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })];
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, bodies: LINK_BODIES, links: { m2: linked.m1 } }, drive: items });

    expect(outcome?.kind).toBe('rendered');
    expect(files.written.has(REPORT_MD)).toBe(true);
  });

  it('a linked file the drive will not hand over is named in the report as having failed', async () => {
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked } });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'permanent: fake has no item 01ABC' }]);
  });

  it('a linked file of a kind this tool does not read is named in the report', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, name: 'Recording.mp4', path: 'Recording.mp4' } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'a kind of file this tool does not read' }]);
  });

  it('a linked file that could not be converted is named in the report, not lost between the two', async () => {
    const seeded = { items: { '01ABC': REPORT }, failItems: { '01ABC': { kind: 'permanent' as const, message: 'cannot convert' } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesFailed).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'permanent: cannot convert' }]);
  });

  it('a document linked from two messages is listed once in the head, not once per message', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { files } = await run({ reader: { conversations, bodies: LINK_BODIES, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect((files.written.get(THREAD_FILE) ?? '').match(/- \.\.\/\.\.\/_linked\/2026-05-11\/Rapport\.docx\.md/g)).toHaveLength(1);
    // And one card, not one per mention: a deck cited in four replies is one thing depended on.
    expect([...files.written.keys()].filter((path) => path.startsWith(`kb/Mailbox/threads/${THREAD_FOLDER}/_linked/`))).toEqual([
      `kb/Mailbox/threads/${THREAD_FOLDER}/_linked/Rapport.docx.md`,
    ]);
  });

  it('a document another conversation already pulled is referenced, not fetched again', async () => {
    const already = { 'b!one:01ABC': { paths: [REPORT_MD] } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: items, linked: already });

    expect(files.written.has(REPORT_MD)).toBe(false);
    expect(files.written.get(THREAD_FILE)).toContain('  - ../../_linked/2026-05-11/Rapport.docx.md');
  });

  it('a linked deck is kept as slides as well as text, the way a deck in a library is', async () => {
    const deck = { m1: [{ url: 'https://tenant.sharepoint.com/d', driveId: 'b!one', itemId: '01DECK', name: 'Deck.pptx' }] };
    const seeded = { items: { '01DECK': { ...REPORT, id: '01DECK', name: 'Deck.pptx', path: 'Deck.pptx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: deck }, drive: seeded });

    expect(files.binary.has('kb/Mailbox/_linked/2026-05-11/Deck.pptx.pdf')).toBe(true);
    expect(files.written.has('kb/Mailbox/_linked/2026-05-11/Deck.pptx.md')).toBe(true);
  });

  it('a linked file past the size cap is left where it is rather than pulled', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, size: 60 * 1024 * 1024 } } };
    const { files, logger } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(files.written.has(REPORT_MD)).toBe(false);
    expect(logger.calls.some((call) => call.event === 'linked.skipped')).toBe(true);
  });

  it('a linked file too large to pull is named in the report rather than passed over in silence', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, size: 60 * 1024 * 1024 } } };
    const { outcome } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(outcome?.kind === 'rendered' && outcome.thread.filesSkipped).toEqual([{ path: `${THREAD_RELATIVE}: Rapport.docx`, reason: 'larger than the 50 MB cap' }]);
  });

  it('a linked file the folders under SharePoint hold is filed under those folders too', async () => {
    const seeded = { items: { '01ABC': { ...REPORT, path: 'Decks/Q3/Rapport.docx' } } };
    const { files } = await run({ reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked }, drive: seeded });

    expect(files.written.has('kb/Mailbox/_linked/2026-05-11/Decks/Q3/Rapport.docx.md')).toBe(true);
  });

  it('the same document linked from two messages of a thread is listed once', async () => {
    const conversations = { [CONV]: [message(), message({ id: 'm2', received: '2026-05-13T10:00:00Z' })] };
    const { outcome } = await run({ reader: { conversations, bodies: LINK_BODIES, links: { ...linked, m2: linked.m1 } }, drive: items });

    expect(outcome?.kind === 'rendered' && Object.keys(outcome.thread.linked)).toEqual(['b!one:01ABC']);
  });

  it('a linked document that cannot be written is reported and the conversation still lands', async () => {
    const { outcome, files, logger } = await run({
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
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
      reader: { conversations: { [CONV]: [message()] }, bodies: LINK_BODIES, links: linked },
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

describe('the pictures a document attached to a mail holds', () => {
  it('are written beside its markdown and named nowhere in the head of the thread', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, attachments, attachmentImages: images } });
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}`;

    expect(files.binary.has(`${stored}.media/word_media_image1.png`)).toBe(true);
    expect(files.written.get(THREAD_FILE)).not.toContain('word_media_image1.png');
    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${stored}.md`]);
  });

  it('are remembered against the document they came out of, so a second thread writes none of them again', async () => {
    const messages = [message({ hasAttachments: true })];
    const attachments = { m1: [{ id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 4096, isInline: false }] };
    const images = { att1: [{ path: 'word/media/image1.png', bytes: new Uint8Array([1, 2, 3]) }] };
    const { outcome } = await run({ reader: { conversations: { [CONV]: messages }, attachments, attachmentImages: images } });
    const stored = `${ATTACHMENTS_STORE}/${storedName('Contrat.docx')}`;
    const record = outcome?.kind === 'rendered' ? outcome.thread.attachments[contentHash(bytesOf('att1'))] : undefined;

    expect(record?.paths).toEqual([`${stored}.md`, `${stored}.media/word_media_image1.png`]);
    expect(record?.media).toEqual([`${stored}.media/word_media_image1.png`]);
  });
});

describe('an email attached to an email', () => {
  const EMBEDDED = { kind: 'item' as const, id: 'att1', name: 'Customs documents MSDU1691268', contentType: '', size: 2764134, isInline: false };
  const RENDERED = '**Subject:** Customs documents\n\nSee attached.';
  // Its address is the address of what it renders to, an item attachment having no bytes to take one
  // from, so the name on disk follows the rendering rather than anything Graph would hand back.
  // An item attachment lands under its plain name like anything else. Its content address still
  // decides whether it is converted twice within a thread; it just no longer decides its filename.
  const renderedName = (name: string): string => name;

  it('is kept and read, though Graph hands back no bytes for it', async () => {
    const messages = [message({ hasAttachments: true })];
    const seed = { conversations: { [CONV]: messages }, attachments: { m1: [EMBEDDED] }, attachmentTexts: { att1: RENDERED } };
    const { files } = await run({ reader: seed });
    const stored = `${ATTACHMENTS_STORE}/${renderedName(EMBEDDED.name)}.md`;

    expect(files.written.get(stored)).toContain('**Subject:** Customs documents');
    expect(files.written.get(THREAD_FILE)).toContain('- [Customs documents MSDU1691268](_attachments/Customs documents MSDU1691268.md) (2.6 MB)');
  });

  it('is stored once, however many messages of the conversation forwarded it', async () => {
    const messages = [message({ id: 'm1', hasAttachments: true }), message({ id: 'm2', received: '2026-05-13T10:00:00Z', hasAttachments: true })];
    const attachments = { m1: [EMBEDDED], m2: [{ ...EMBEDDED, id: 'att2' }] };
    const seed = { conversations: { [CONV]: messages }, attachments, attachmentTexts: { att1: RENDERED, att2: RENDERED } };
    const { outcome } = await run({ reader: seed });

    expect(outcome?.kind === 'rendered' && outcome.thread.record.attachments).toEqual([`${ATTACHMENTS_STORE}/${renderedName(EMBEDDED.name)}.md`]);
  });
});

describe('what a message body says about the files it carried', () => {
  const PASTED = { id: 'sig', name: 'logo.png', contentType: 'image/png', size: 100, isInline: true, contentId: 'logo.png@01DC1234' };
  // A picture shown inside a body is stored once for the whole mailbox, not once per thread: one
  // signature logo rides on every message its sender ever wrote. A folder every thread writes into
  // needs names that cannot collide across all of them, which is what the content address gives.
  const inlineAt = (name: string, id: string): string => `${INLINE_STORE}/${disambiguateSegment(name, contentHash(bytesOf(id)))}`;
  const shownAt = (name: string, id: string): string => `../../_inline/${disambiguateSegment(name, contentHash(bytesOf(id)))}`;

  it('a picture pasted into a message is kept and shown where it stood, though Graph said the message carried nothing', async () => {
    const messages = [message({ hasAttachments: false })];
    const bodies = { m1: 'Regards,\n\n\\[inline image: logo.png\\]' };
    const { files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments: { m1: [PASTED] } } });

    expect(files.binary.has(inlineAt('logo.png', 'sig'))).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain(`![logo.png](${shownAt('logo.png', 'sig')})`);
  });

  it('a picture shown in the body is named under inline_images, never among the attachments', async () => {
    const messages = [message({ hasAttachments: false })];
    const bodies = { m1: '\\[inline image: logo.png\\]' };
    const { outcome, files } = await run({ reader: { conversations: { [CONV]: messages }, bodies, attachments: { m1: [PASTED] } } });
    const raw = inlineAt('logo.png', 'sig');

    // Pinned as the whole list, not by its key: a fragment cannot tell one entry from two, and a
    // file that is NOT shown leaking into this list is exactly the mistake worth catching. One
    // entry now, the picture: nothing else is written for it, its words being in the thread.
    expect(files.written.get(THREAD_FILE)).toContain(`inline_images:\n  - ${shownAt('logo.png', 'sig')}\n`);
    expect(files.written.get(THREAD_FILE)).not.toContain('attachments:\n');
    expect(outcome?.kind === 'rendered' && outcome.thread.record.inlineImages).toEqual([raw]);
  });

  // A message carrying both kinds at once: the picture is shown and listed under inline_images, the
  // document is not shown and belongs to the attachments. Only a message holding both can tell the
  // two lists apart, which is what a single-file test cannot do however exactly it is pinned.
  it('a picture shown beside a file that is not keeps each to its own list', async () => {
    const carried = [PASTED, { id: 'att1', name: 'Contrat.docx', contentType: 'application/vnd', size: 10, isInline: false }];
    const bodies = { m1: '\\[inline image: logo.png\\]' };
    const { files } = await run({ reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, bodies, attachments: { m1: carried } } });
    const written = files.written.get(THREAD_FILE) ?? '';
    const raw = shownAt('logo.png', 'sig');

    // What FOLLOWS the list is pinned too. Without it, a file leaking in after the picture's entry
    // still satisfies a `toContain`, which is the whole mistake this test exists to catch.
    expect(written).toContain(`attachments:\n  - _attachments/Contrat.docx.md\ninline_images:\n  - ${raw}\n---`);
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

    // The card beside the thread, not the store: `shownAt` still names the store, and stays correct
    // for a picture shown in the body, which points at the image itself rather than at a card.
    expect(files.written.get(THREAD_FILE)).toContain('**Attachments:**\n- [Contrat.docx](_attachments/Contrat.docx.md) (4.0 KB, application/vnd)');
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

    expect(files.written.get(THREAD_FILE)).toContain('- [Demo.mp4](_attachments/Demo.mp4.md) (4.0 KB, video/mp4), a kind of file this tool does not read');
  });
});
