import { describe, expect, it } from 'bun:test';
import type { MailMessage } from './mail-message.ts';
import { marksOf, messageRecordOf, parseMessageRecords, sameMarks } from './message-record.ts';

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm1',
  conversationId: 'AAQkADk0...=',
  subject: 'RE: Contrat Contoso',
  received: '2026-05-12T09:31:00Z',
  hasAttachments: true,
  from: { name: 'Jane Doe', address: 'jane@contoso.com' },
  to: [{ name: 'Valerie FAIRBANKS', address: 'valerie@contoso.com' }],
  isDeleted: false,
  cc: [{ name: 'Li Wei', address: 'li.wei@northwind.example' }],
  folderId: 'AAMk-follow',
  flag: 'flagged',
  categories: ['Blue category'],
  importance: 'high',
  internetMessageId: '<AM0PR04MB6f21@contoso.com>',
  isDraft: false,
  preview: 'Hi Valerie, the figures are attached.',
  ...over,
});

const CARRIED = { folder: 'To_Follow', attachments: ['Contrat.docx'], linked: ['Rapport.docx'] };

describe('recording what each message of a thread was', () => {
  it('a message is recorded with the marks a sweep compares and what the message index lists it by', () => {
    expect(messageRecordOf(message(), CARRIED)).toEqual({
      id: 'm1',
      received: '2026-05-12T09:31:00Z',
      subject: 'RE: Contrat Contoso',
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
    });
  });

  // One line a search can match, with the address the sender sent rather than Outlook's wrapper.
  it('the opening words lose the link wrapper, and each run of white space becomes one space', () => {
    const wrapped = 'https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Faka.ms%2FAAb9ysg&data=05%7C02&reserved=0';

    expect(messageRecordOf(message({ preview: `  Hi Valerie,\r\n\r\nsee ${wrapped}\tnow.  ` }), CARRIED).preview).toBe('Hi Valerie, see https://aka.ms/AAb9ysg now.');
  });

  // A post in a group inbox is read without any of these, and a draft says so.
  it('a message read without the search fields is recorded with empty values, and a draft is marked as one', () => {
    const bare: MailMessage = { id: 'p1', conversationId: 'g|t', subject: 'Kick-off', received: '2026-05-12T09:31:00Z', hasAttachments: false, to: [], isDeleted: false };

    expect(messageRecordOf(bare, { folder: '', attachments: [], linked: [] })).toEqual({
      id: 'p1',
      received: '2026-05-12T09:31:00Z',
      subject: 'Kick-off',
      from: undefined,
      to: [],
      cc: [],
      folderId: '',
      flag: '',
      importance: '',
      categories: [],
      folder: '',
      draft: false,
      internetMessageId: '',
      preview: '',
      attachments: [],
      linked: [],
    });
    expect(messageRecordOf(message({ isDraft: true }), CARRIED).draft).toBe(true);
  });
});

describe('telling a message that was marked from one that was only read', () => {
  it('the marks are the folder, the flag, the importance and the categories', () => {
    expect(marksOf(message())).toEqual({ folderId: 'AAMk-follow', flag: 'flagged', importance: 'high', categories: ['Blue category'] });
  });

  it('marks match whatever order the categories come in', () => {
    const left = marksOf(message({ categories: ['Blue category', 'Project X'] }));

    expect(sameMarks(left, marksOf(message({ categories: ['Project X', 'Blue category'] })))).toBe(true);
    expect(left.categories).toEqual(['Blue category', 'Project X']);
  });

  it('marks differ when any one of the four changes', () => {
    const before = marksOf(message());

    expect(sameMarks(before, marksOf(message({ folderId: 'AAMk-inbox' })))).toBe(false);
    expect(sameMarks(before, marksOf(message({ flag: 'complete' })))).toBe(false);
    expect(sameMarks(before, marksOf(message({ importance: 'normal' })))).toBe(false);
    expect(sameMarks(before, marksOf(message({ categories: ['Blue category', 'Project X'] })))).toBe(false);
    expect(sameMarks(before, marksOf(message({ categories: [] })))).toBe(false);
  });
});

describe('reading the message records back', () => {
  it('records read back as they were written', () => {
    const records = [messageRecordOf(message(), CARRIED), messageRecordOf(message({ id: 'm2', from: undefined, isDraft: true }), CARRIED)];

    expect(parseMessageRecords(JSON.parse(JSON.stringify(records)))).toEqual(records);
  });

  // A thread written before decant kept its messages has nothing to compare, which is not the same
  // as a thread that holds no messages.
  it('a thread written before the records were kept reads as having none', () => {
    expect(parseMessageRecords(undefined)).toBeUndefined();
    expect(parseMessageRecords('nope')).toBeUndefined();
    expect(parseMessageRecords([])).toStrictEqual([]);
  });

  it('an entry with no id is dropped, and a field of the wrong kind reads as empty', () => {
    const read = parseMessageRecords([
      { subject: 'no id' },
      'broken',
      { id: 'm1', from: { address: 'jane@contoso.com' }, to: [{ name: 'Nobody' }], categories: ['Blue category', 7], draft: 'yes' },
    ]);

    expect(read).toEqual([
      {
        id: 'm1',
        received: '',
        subject: '',
        from: { name: 'jane@contoso.com', address: 'jane@contoso.com' },
        to: [],
        cc: [],
        folderId: '',
        flag: '',
        importance: '',
        categories: ['Blue category'],
        folder: '',
        draft: false,
        internetMessageId: '',
        preview: '',
        attachments: [],
        linked: [],
      },
    ]);
  });
});
