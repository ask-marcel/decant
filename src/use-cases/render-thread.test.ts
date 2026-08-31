import { describe, expect, it } from 'bun:test';
import { contentHash } from '../domain/content-hash.ts';
import type { AttachmentRecord } from '../domain/mail-state.ts';
import {
  ATTACHMENTS_STORE,
  CONV,
  INLINE_STORE,
  ROOT,
  THREAD_FILE,
  THREAD_FOLDER,
  THREAD_ID,
  THREAD_RELATIVE,
  bytesOf,
  message,
  run,
  storedName,
} from '../test-helpers/thread-harness.ts';

// The words the vault uses to say a block was read off a picture rather than typed by a person.
// Pinned here because saying it in words is the point: a `>` block alone reads as quoted mail.
const NOTE = '_Text below was read out of the picture by OCR, so it can be wrong. Open the image above to check._';

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
        `path: ${THREAD_RELATIVE}`,
        'subject: Contrat Contoso',
        'participants:',
        '  - Jane Doe <jane@example.com>',
        '  - Vincent DELACOURT <v@example.com>',
        '  - Vincent DELACOURT <vincent@example.com>',
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
    const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: true, contentId: 'logo.png@01DC1234' }];
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
    const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: true, contentId: 'logo.png@01DC1234' }];
    const texts = { 'kb/Mailbox/_inline/logo-3d8c205c.png': 'Nina Alder\nAlder Consulting\n+31618225472' };
    const { files } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } },
      ocr: { texts },
    });

    expect(files.written.get(THREAD_FILE)).toContain(`![logo.png](../../_inline/logo-3d8c205c.png)\n\n${NOTE}\n\n> Nina Alder\n> Alder Consulting\n> +31618225472`);
  });

  const SIGNATURE = `${INLINE_STORE}/logo-3d8c205c.png`;
  const storedPicture = (text?: string): Record<string, AttachmentRecord> => ({
    [contentHash(bytesOf('sig'))]: { name: 'logo-3d8c205c.png', paths: [SIGNATURE], primary: SIGNATURE, media: [], text },
  });
  const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: true, contentId: 'logo.png@01DC1234' }];
  const showing = { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } };

  // The reason the store is shared at all: one signature logo rides on every message its sender
  // ever wrote, so a mailbox of two hundred threads would otherwise hold two hundred copies of it.
  // The words come back with it, since no document holds them any more.
  it('a picture an earlier thread already stored is not fetched again, and still shows its words', async () => {
    const { files } = await run({ reader: showing, attachments: storedPicture('Nina Alder') });

    expect(files.binary.size).toBe(0);
    expect(files.written.get(THREAD_FILE)).toContain(`![logo.png](../../_inline/logo-3d8c205c.png)\n\n${NOTE}\n\n> Nina Alder`);
  });

  // Self-healing rather than silently wordless: a run from before pictures carried their reading
  // left records with no text, and honouring one would show the picture in this thread with nothing
  // under it, a loss no later run would ever repair. Converting again costs one fetch.
  it('a picture stored before the words were kept is read again rather than shown wordless', async () => {
    const { files } = await run({ reader: showing, attachments: storedPicture(undefined), ocr: { texts: { [SIGNATURE]: 'Nina Alder' } } });

    expect(files.binary.has(SIGNATURE)).toBe(true);
    expect(files.written.get(THREAD_FILE)).toContain('> Nina Alder');
  });

  // No placeholder in the text answered for it, so nothing shows it. It is still a picture, so it
  // gets no card, and it is shown after the text rather than listed as a file to open: a logo the
  // conversion lost the placeholder for still belongs in the message, not in an inventory.
  it('a picture the body never showed is shown after the text, with no card standing in for it', async () => {
    // Graph reports the attachment, and the body shows no placeholder for it: the message is asked
    // what it carried, and what comes back is a picture nothing in the text points at.
    const { files } = await run({ reader: { ...showing, conversations: { [CONV]: [message({ hasAttachments: true })] }, bodies: { m1: 'Regards,' } } });

    // No document of any kind in the thread's own folder: the picture is in the mailbox store, and
    // a card for it would be a card for something that stands for itself.
    expect([...files.written.keys()].filter((path) => path.startsWith(`${ATTACHMENTS_STORE}/`))).toEqual([]);
    expect(files.written.get(THREAD_FILE)).toContain('Regards,\n\n![logo.png](../../_inline/logo-3d8c205c.png)');
    expect(files.written.get(THREAD_FILE)).not.toContain('**Attachments:**');
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
    const pasted = [{ id: 'sig', name: 'logo.png', contentType: 'image/png', size: 64 * 1024, isInline: true, contentId: 'logo.png@01DC1234' }];
    const { files } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: false })] }, bodies: { m1: '\\[inline image: logo.png\\]' }, attachments: { m1: pasted } },
    });
    const written = files.written.get(THREAD_FILE) ?? '';

    expect(written).toContain('![logo.png](../../_inline/logo-3d8c205c.png)');
    // A quoted line, not the character: the head carries a message id in angle brackets.
    expect(written).not.toContain('\n> ');
  });

  // The card takes its body from what the converter wrote, which never passed through the thread's
  // own cleaning: a saved email's signature sat in a card at six hundred characters a line while
  // the thread beside it was clean.
  it('a link Outlook wrapped inside a carded file is unwrapped, as it is in the thread', async () => {
    const wrapped = 'https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Faka.ms%2FAAb9ysg&reserved=0';
    const { files } = await run({
      reader: { conversations: { [CONV]: [message({ hasAttachments: true })] }, attachments: attached, attachmentTexts: { att1: `See ${wrapped}` } },
    });
    const card = files.written.get(`${CARDS}/Contrat.docx.md`) ?? '';

    expect(card).toContain('See https://aka.ms/AAb9ysg');
    expect(card).not.toContain('safelinks');
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

  // Reported with the reason the disk gave, and as permanent: a full disk is not something a retry
  // of this thread fixes, and an error with no kind on it tells a caller nothing it can act on.
  it('a knowledge base that cannot be written to is reported, with what the disk said', async () => {
    const { ok: succeeded, error } = await run({
      reader: { conversations: { [CONV]: [message()] } },
      files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } },
    });

    expect(succeeded).toBe(false);
    expect(error).toEqual({ kind: 'permanent', message: 'disk full' });
  });
});
