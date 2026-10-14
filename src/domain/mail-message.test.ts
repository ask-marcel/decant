import { describe, expect, it } from 'bun:test';
import { inReceivedOrder, parseMailDelta, parseMessage } from './mail-message.ts';
import type { MailMessage } from './mail-message.ts';

// Trimmed from a real `list-mail-folder-messages-delta` response.
const rawMessage = {
  '@odata.type': '#microsoft.graph.message',
  id: 'AAMkADk0...=',
  receivedDateTime: '2026-07-23T13:12:06Z',
  hasAttachments: false,
  subject: 'RE: Integration Status Update',
  conversationId: 'AAQkADk0...=',
  from: { emailAddress: { name: 'Erica English', address: 'erica.english@contoso.com' } },
  toRecipients: [
    { emailAddress: { name: 'Valerie FAIRBANKS', address: 'valerie.fairbanks@contoso.com' } },
    { emailAddress: { name: 'David Chang', address: 'david.chang@contoso.com' } },
  ],
};

describe('reading a message out of a mailbox sweep', () => {
  it('a message arrives with who wrote it, who received it and which thread it belongs to', () => {
    expect(parseMessage(rawMessage)).toEqual({
      id: 'AAMkADk0...=',
      conversationId: 'AAQkADk0...=',
      subject: 'RE: Integration Status Update',
      received: '2026-07-23T13:12:06Z',
      hasAttachments: false,
      from: { name: 'Erica English', address: 'erica.english@contoso.com' },
      to: [
        { name: 'Valerie FAIRBANKS', address: 'valerie.fairbanks@contoso.com' },
        { name: 'David Chang', address: 'david.chang@contoso.com' },
      ],
      isDeleted: false,
      cc: [],
      folderId: '',
      flag: '',
      categories: [],
      importance: '',
      internetMessageId: '',
      isDraft: false,
      preview: '',
    });
  });

  // What a search finds a message by besides who wrote it: where it sits, whether it is flagged, how
  // it is marked, and who was copied. All of it read off the message, none of it worked out.
  it('a message read with its search fields carries its folder, flag, categories, importance, copies and opening words', () => {
    const parsed = parseMessage({
      ...rawMessage,
      ccRecipients: [{ emailAddress: { name: 'Li Wei', address: 'li.wei@northwind.example' } }],
      parentFolderId: 'AAMk-follow',
      flag: { flagStatus: 'flagged' },
      categories: ['Blue category', 'Project X'],
      importance: 'high',
      internetMessageId: '<AM0PR04MB6f21@contoso.com>',
      isDraft: false,
      bodyPreview: 'Hi Valerie, the figures are attached.',
    });

    expect(parsed).toMatchObject({
      cc: [{ name: 'Li Wei', address: 'li.wei@northwind.example' }],
      folderId: 'AAMk-follow',
      flag: 'flagged',
      categories: ['Blue category', 'Project X'],
      importance: 'high',
      internetMessageId: '<AM0PR04MB6f21@contoso.com>',
      isDraft: false,
      preview: 'Hi Valerie, the figures are attached.',
    });
  });

  it('a draft says it is one', () => {
    expect(parseMessage({ ...rawMessage, isDraft: true })?.isDraft).toBe(true);
  });

  it('a flag Graph gave no status for reads as no flag, and a category that is not text is dropped', () => {
    const parsed = parseMessage({ ...rawMessage, flag: {}, categories: ['Blue category', 7, null] });

    expect(parsed?.flag).toBe('');
    expect(parsed?.categories).toEqual(['Blue category']);
    expect(parseMessage({ ...rawMessage, flag: 'flagged', categories: 'Blue category' })).toMatchObject({ flag: '', categories: [] });
  });

  it('a field Graph gave as something other than text reads as empty', () => {
    expect(parseMessage({ ...rawMessage, importance: 3, bodyPreview: { text: 'Hi' } })).toMatchObject({ importance: '', preview: '' });
  });

  it('a sender given without a display name falls back to the address', () => {
    const parsed = parseMessage({ ...rawMessage, from: { emailAddress: { address: 'noreply@qoder.com' } } });

    expect(parsed?.from).toEqual({ name: 'noreply@qoder.com', address: 'noreply@qoder.com' });
  });

  it('a sender Graph did not name at all is simply absent', () => {
    expect(parseMessage({ ...rawMessage, from: { emailAddress: { name: 'No address' } } })?.from).toBeUndefined();
    expect(parseMessage({ ...rawMessage, from: undefined })?.from).toBeUndefined();
  });

  it('recipients Graph returned unusable are dropped rather than breaking the header', () => {
    const parsed = parseMessage({ ...rawMessage, toRecipients: [{ emailAddress: { name: 'Nobody' } }, 'broken'] });

    expect(parsed?.to).toStrictEqual([]);
  });

  it('a message with no recipients recorded still reads', () => {
    expect(parseMessage({ ...rawMessage, toRecipients: undefined })?.to).toStrictEqual([]);
  });

  it('a message deleted since the last sweep is marked deleted, id and all', () => {
    const parsed = parseMessage({ id: 'AAMkADk0...=', '@removed': { reason: 'deleted' } });

    expect(parsed?.isDeleted).toBe(true);
    expect(parsed?.id).toBe('AAMkADk0...=');
  });

  it('an entry with no id at all cannot be acted on', () => {
    expect(parseMessage({ subject: 'orphan' })).toBeUndefined();
    expect(parseMessage(null)).toBeUndefined();
  });

  it('a message carrying attachments says so', () => {
    expect(parseMessage({ ...rawMessage, hasAttachments: true })?.hasAttachments).toBe(true);
  });
});

describe('reading a page of mailbox changes', () => {
  it('the cursor closing the sweep is handed back for the next run', () => {
    const page = parseMailDelta({ value: [rawMessage], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?%24deltatoken=abc' });

    expect(page.ok && page.value.messages).toHaveLength(1);
    expect(page.ok && page.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc');
  });

  it('the cursor for the next page is handed back while the sweep is still running', () => {
    const page = parseMailDelta({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?%24skiptoken=abc' });

    expect(page.ok && page.value.nextLink).toBe('https://graph.microsoft.com/v1.0/x?$skiptoken=abc');
  });

  it('entries Graph returned unusable are counted rather than stopping the sweep', () => {
    const page = parseMailDelta({ value: [{ subject: 'no id' }, rawMessage] });

    expect(page.ok && page.value).toMatchObject({ skipped: 1 });
    expect(page.ok && page.value.messages).toHaveLength(1);
  });

  it('a response that is not a page of messages is rejected', () => {
    expect(parseMailDelta({ nope: true })).toEqual({ ok: false, error: { kind: 'malformed', message: 'mail response has no value array' } });
  });
});

describe('putting a thread in the order it was written', () => {
  const message = (id: string, received: string): MailMessage => ({ id, conversationId: 'c', subject: 's', received, hasAttachments: false, to: [], isDeleted: false });

  it('messages come back oldest first, whatever order Graph returned them in', () => {
    const sorted = inReceivedOrder([message('c', '2026-05-03T00:00:00Z'), message('a', '2026-05-01T00:00:00Z'), message('b', '2026-05-02T00:00:00Z')]);

    expect(sorted.map((found) => found.id)).toEqual(['a', 'b', 'c']);
  });

  it('two messages stamped at the same moment keep a stable order between runs', () => {
    const sorted = inReceivedOrder([message('b', '2026-05-01T00:00:00Z'), message('a', '2026-05-01T00:00:00Z')]);

    expect(sorted.map((found) => found.id)).toEqual(['a', 'b']);
  });
});
