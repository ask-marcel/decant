import { describe, expect, it } from 'bun:test';
import { attachmentRows, linkRows, mailboxIndexPage, messageRows, renderJsonl, threadRows } from './mail-meta.ts';
import { emptyMailboxState, withAttachment, withConversation, withLinked, withThread } from './mail-state.ts';
import type { ThreadRecord } from './mail-state.ts';
import type { MessageRecord } from './message-record.ts';

const thread = {
  folder: '2026-05-12-d9f4e0a3c1-contrat',
  conversationIds: ['conv-1'],
  file: 'threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md',
  messageIds: ['m1', 'm2'],
  firstMessage: '2026-05-12T09:31:00Z',
  lastMessage: '2026-05-13T10:00:00Z',
  attachments: ['_attachments/Contrat-a1b2.docx.md'],
  inlineImages: [],
};

const held = withThread(withConversation(emptyMailboxState(), 'conv-1', { threadId: 'd9f4e0a3c1', root: '<r@x>' }), 'd9f4e0a3c1', thread);

describe('indexing what a mailbox holds', () => {
  // Front matter inside a markdown file is only text. This is the file that makes "everything from
  // Li Wei since June" a query rather than a grep, so it is pinned whole: one line per thread, and
  // nothing wrapped across lines.
  it('one line per thread, carrying what a query would filter on', () => {
    const line = '{"thread_id":"d9f4e0a3c1","folder":"2026-05-12-d9f4e0a3c1-contrat","file":"threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md",';
    const rest = '"conversation_ids":["conv-1"],"message_count":2,"first_message":"2026-05-12T09:31:00Z","last_message":"2026-05-13T10:00:00Z","attachments":1}\n';

    expect(renderJsonl(threadRows(held))).toBe(`${line}${rest}`);
  });

  it('a mailbox holding nothing indexes nothing, rather than a blank line', () => {
    expect(renderJsonl(threadRows(emptyMailboxState()))).toBe('');
  });

  // Sorted, not left to the order a JSON object happens to iterate in. Roughly one thread id in a
  // hundred is all digits, and an integer-like key sorts ahead of every other in an object, so an
  // unsorted index would reshuffle itself on runs that changed nothing.
  it('threads are indexed in a fixed order, so a run that changed nothing rewrites nothing', () => {
    // Inserted in reverse, and neither id is integer-like, so only an actual sort puts them right.
    const reversed = withThread(withThread(emptyMailboxState(), 'ffff000000', thread), 'aaaa111111', thread);

    expect(threadRows(reversed).map((row) => row.thread_id)).toEqual(['aaaa111111', 'ffff000000']);
  });

  // The hazard the sort exists for: an object puts an integer-like key ahead of every other one,
  // whatever order it was built in, and roughly one thread id in a hundred is all digits.
  it('an all-digit thread id is indexed in its place, not at the head', () => {
    const digits = withThread(withThread(emptyMailboxState(), 'aaaa111111', thread), '1234567890', thread);

    expect(threadRows(digits).map((row) => row.thread_id)).toEqual(['1234567890', 'aaaa111111']);
  });

  it('every row gets its own line, with nothing between them but the break', () => {
    expect(renderJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  it('one line per stored file, addressed by the content that named it', () => {
    const stored = withAttachment(held, 'ba7816bf8f01', {
      name: 'Contrat-ba78.docx',
      paths: ['_attachments/Contrat-ba78.docx.md'],
      primary: '_attachments/Contrat-ba78.docx.md',
      media: [],
    });

    expect(renderJsonl(attachmentRows(stored))).toBe(
      '{"content_hash":"ba7816bf8f01","name":"Contrat-ba78.docx","primary":"_attachments/Contrat-ba78.docx.md","files":["_attachments/Contrat-ba78.docx.md"]}\n'
    );
  });

  // Filtering this on a drive item is what gives every thread that ever cited one document.
  it('one line per document pointed at, keyed by the drive item it lives in', () => {
    const linked = withLinked(held, 'b!one:01ABC', { paths: ['_linked/2026-05-11/Rapport.docx.md'] });

    expect(renderJsonl(linkRows(linked))).toBe('{"item":"b!one:01ABC","files":["_linked/2026-05-11/Rapport.docx.md"]}\n');
  });

  it('a line holding a quote or a newline stays one line', () => {
    expect(renderJsonl([{ name: 'a "quoted"\nname' }])).toBe('{"name":"a \\"quoted\\"\\nname"}\n');
  });
});

describe('the page a reader opens the mailbox by', () => {
  it('a thread is listed under the day of its last message where the knowledge base counts its days, by its subject and who wrote last', () => {
    const late = withThread(emptyMailboxState(), 'd9f4e0a3c1', { ...thread, lastMessage: '2026-05-13T23:30:00Z', subject: 'Contrat', lastFrom: 'Li Wei' });

    expect(mailboxIndexPage(late, 'Asia/Shanghai')).toContain('- 2026-05-14 · [Contrat](threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md) · Li Wei\n');
  });

  // Newest first; a tie keeps the order of the keys, so the page reads the same on every run.
  it('the thread with the newest message comes first, and two at one moment keep the order of their keys', () => {
    const at = (lastMessage: string, file: string): ThreadRecord => ({ ...thread, lastMessage, file, subject: file });
    const state = withThread(
      withThread(withThread(emptyMailboxState(), 'bbbb', at('2026-05-13T10:00:00Z', 'b.md')), 'aaaa', at('2026-05-13T10:00:00Z', 'a.md')),
      'cccc',
      at('2026-05-14T08:00:00Z', 'c.md')
    );
    const lines = mailboxIndexPage(state, 'UTC')
      .split('\n')
      .filter((line) => line.startsWith('- '));

    expect(lines).toEqual(['- 2026-05-14 · [c.md](c.md)', '- 2026-05-13 · [a.md](a.md)', '- 2026-05-13 · [b.md](b.md)']);
  });

  // A thread written before its subject was kept is linked by its file until a new message writes it.
  it('a thread kept without a subject or a sender is still listed, linked by its file', () => {
    expect(mailboxIndexPage(held, 'UTC')).toContain('- 2026-05-13 · [threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md](threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md)\n');
  });
});

// One line per message, with the field names the filters already written against the message index
// ask for, so `$_.flag -eq 'open'` and `$_.direction -eq 'received'` keep working.
describe('indexing each message the mailbox holds', () => {
  const recorded = (over: Partial<MessageRecord> = {}): MessageRecord => ({
    id: 'm1',
    received: '2026-05-12T09:31:00Z',
    subject: 'Contrat Contoso',
    from: { name: 'Jane Doe', address: 'jane@contoso.com' },
    to: [{ name: 'Valerie FAIRBANKS', address: 'valerie@contoso.com' }],
    cc: [{ name: 'Li Wei', address: 'li.wei@northwind.example' }],
    folderId: 'AAMk-follow',
    flag: 'flagged',
    importance: 'high',
    categories: ['Blue category'],
    folder: 'To_Follow',
    draft: false,
    internetMessageId: '<AM0PR04MB6f21@contoso.com>',
    preview: 'Hi Valerie, the figures are attached.',
    attachments: ['Contrat.docx'],
    linked: ['Rapport.docx'],
    ...over,
  });
  const holding = (messages: ReadonlyArray<MessageRecord> | undefined, ownAddresses: ReadonlyArray<string> = []): ReturnType<typeof emptyMailboxState> => ({
    ...withThread(emptyMailboxState(), 'd9f4e0a3c1', { ...thread, messages }),
    ownAddresses,
  });

  it('a message is one line, with when, who, where and how it is marked', () => {
    const replied = recorded({ id: 'm2', received: '2026-05-13T22:30:00Z', from: { name: 'Valerie FAIRBANKS', address: 'valerie@contoso.com' }, to: [], cc: [] });

    expect(messageRows(holding([recorded(), replied]), 'Europe/Paris')).toEqual([
      {
        date: '2026-05-12',
        time: '11:31',
        utc: '2026-05-12T09:31:00Z',
        direction: 'received',
        from: 'Jane Doe',
        from_email: 'jane@contoso.com',
        to: ['Valerie FAIRBANKS'],
        to_emails: ['valerie@contoso.com'],
        cc: ['Li Wei'],
        cc_emails: ['li.wei@northwind.example'],
        subject: 'Contrat Contoso',
        folder: 'To_Follow',
        flag: 'open',
        categories: ['Blue category'],
        importance: 'high',
        attachments: ['Contrat.docx'],
        linked_files: ['Rapport.docx'],
        preview: 'Hi Valerie, the figures are attached.',
        note: 'Mailbox/threads/2026-05-12-d9f4e0a3c1-contrat/contrat.md',
        position: '1/2',
        thread_id: 'd9f4e0a3c1',
        message_id: 'm1',
        internet_message_id: '<AM0PR04MB6f21@contoso.com>',
      },
      expect.objectContaining({ date: '2026-05-14', time: '00:30', utc: '2026-05-13T22:30:00Z', to: [], cc_emails: [], position: '2/2', message_id: 'm2' }),
    ]);
  });

  // Told by the address it went out from, not by the folder: a reply filed with its conversation in a
  // project folder is still mail the mailbox sent.
  it('a message from an address of the mailbox was sent, in whatever case the address is written, and a draft is a draft', () => {
    const own = ['jane@contoso.com'];
    const directions = (records: ReadonlyArray<MessageRecord>): ReadonlyArray<string> => messageRows(holding(records, own), 'UTC').map((row) => row.direction);

    expect(directions([recorded({ from: { name: 'Jane Doe', address: 'Jane@Contoso.com' } })])).toEqual(['sent']);
    expect(directions([recorded({ draft: true })])).toEqual(['draft']);
    expect(directions([recorded({ from: { name: 'Li Wei', address: 'li.wei@northwind.example' } })])).toEqual(['received']);
    expect(directions([recorded({ from: undefined })])).toEqual(['received']);
  });

  it('a message with no sender and no time leaves those fields empty, and a flag marked complete says so', () => {
    const [row] = messageRows(holding([recorded({ from: undefined, received: '', flag: 'complete' })]), 'UTC');

    expect(row).toMatchObject({ date: '', time: '', utc: '', from: '', from_email: '', flag: 'complete' });
  });

  it('lines run oldest first across every thread, a tie kept apart by the message id', () => {
    const state = withThread(holding([recorded({ id: 'b', received: '2026-05-12T09:31:00Z' }), recorded({ id: 'c', received: '2026-05-14T09:31:00Z' })]), 'ffff000000', {
      ...thread,
      messages: [recorded({ id: 'a', received: '2026-05-12T09:31:00Z' }), recorded({ id: 'd', received: '2026-05-13T09:31:00Z' })],
    });

    expect(messageRows(state, 'UTC').map((row) => row.message_id)).toEqual(['a', 'b', 'd', 'c']);
  });

  // A thread written before its messages were recorded has nothing to list yet, and the one-time
  // update writes it again.
  it('a thread with no message records gives no line', () => {
    expect(messageRows(holding(undefined), 'UTC')).toStrictEqual([]);
    expect(renderJsonl(messageRows(holding([]), 'UTC'))).toBe('');
  });
});
