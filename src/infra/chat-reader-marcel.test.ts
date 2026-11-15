import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { DriveReaderError } from '../use-cases/ports/drive-reader.ts';
import { createChatReaderFromCall } from './chat-reader-marcel.ts';
import type { ConvertBytes, GraphErrorShape } from './drive-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

// Each command answers its seeded answers in turn, and its last one from then on.
const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, DriveReaderError>>>>>
): { reader: ReturnType<typeof createChatReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createChatReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const seeded = answers[name] ?? [];
    return seeded[at] ?? seeded.at(-1) ?? ok({});
  });
  return { reader, recorded };
};

const ME = ok({ id: '0000-me' });

const member = (id: string, displayName: string): Record<string, unknown> => ({ mri: `8:orgid:${id}`, objectId: id, displayName });

const substrateChat = (id: string, title: string | null): Record<string, unknown> => ({
  id,
  title,
  chatType: 'chat',
  members: [member('0000-me', 'Me Myself'), member('0000-jane', 'Jane Doe')],
  lastMessage: { composeTime: '2026-11-13T02:15:30.1230000Z' },
});

const substrateMessage = (id: string, content: string): Record<string, unknown> => ({
  id,
  composetime: '2026-11-13T02:15:30.1230000Z',
  messagetype: 'RichText/Html',
  imdisplayname: 'Jane Doe',
  content,
  webUrl: `https://teams.microsoft.com/l/message/19%3Aabc%40thread.v2/${id}`,
});

const SIGNED_OUT: DriveReaderError = { kind: 'auth', message: 'chatsvcagg (Teams chat) token unavailable' };

describe('reading Teams chats through the ask-marcel library', () => {
  it('the chats are read page after page until the list says there is no more, with the signed-in person taken off the members', async () => {
    const { reader, recorded } = readerFor({
      'get-current-user': [ME],
      'list-teams-chats-with-messages': [
        ok({ chats: [substrateChat('19:aaa@thread.v2', 'Budget review'), { title: 'no id' }], hasMoreData: true, continuationToken: 'page-2' }),
        ok({ chats: [substrateChat('19:0000-jane_0000-me@unq.gbl.spaces', null)], hasMoreData: false, continuationToken: 'page-3' }),
      ],
    });

    const chats = await reader.listChats();

    expect(chats).toEqual({
      ok: true,
      value: [
        { id: '19:aaa@thread.v2', kind: 'group', topic: 'Budget review', members: ['Jane Doe'], lastMessageAt: '2026-11-13T02:15:30.1230000Z' },
        { id: '19:0000-jane_0000-me@unq.gbl.spaces', kind: 'oneOnOne', topic: '', members: ['Jane Doe'], lastMessageAt: '2026-11-13T02:15:30.1230000Z' },
      ],
    });
    expect(recorded).toEqual([
      { name: 'get-current-user', params: { select: 'id' } },
      { name: 'list-teams-chats-with-messages', params: { pageSize: '100' } },
      { name: 'list-teams-chats-with-messages', params: { pageSize: '100', continuationToken: 'page-2' } },
    ]);
  });

  it('a list that hands out a token it already handed out is not followed round again, and one that says more with no token ends', async () => {
    const looping = readerFor({ 'get-current-user': [ME], 'list-teams-chats-with-messages': [ok({ chats: [], hasMoreData: true, continuationToken: 'same' })] });
    const tokenless = readerFor({
      'get-current-user': [ME],
      'list-teams-chats-with-messages': [ok({ chats: [substrateChat('19:aaa@thread.v2', 'Budget review')], hasMoreData: true })],
    });

    expect(await looping.reader.listChats()).toEqual({ ok: true, value: [] });
    expect(looping.recorded.filter((call) => call.name === 'list-teams-chats-with-messages')).toHaveLength(2);
    expect((await tokenless.reader.listChats()).ok).toBe(true);
    expect(tokenless.recorded).toHaveLength(2);
  });

  it('a sign-in that lapsed for every source shows on the first call as what it is, and no chat is listed', async () => {
    const { reader, recorded } = readerFor({ 'get-current-user': [err({ kind: 'auth', message: 'sign in again' })] });

    expect(await reader.listChats()).toEqual({ ok: false, error: { kind: 'auth', message: 'sign in again' } });
    expect(recorded).toHaveLength(1);
  });

  it('a sign-in the Teams substrate refuses is not an auth failure, which would end the run for every source, and says to log in', async () => {
    const { reader } = readerFor({
      'get-current-user': [ME],
      'list-teams-chats-with-messages': [err(SIGNED_OUT)],
      'list-teams-chat-history': [err(SIGNED_OUT)],
      'extract-teams-chat-message-images': [err(SIGNED_OUT)],
    });
    const refused: Result<never, DriveReaderError> = err({
      kind: 'permanent',
      message: 'Teams did not accept the sign-in for chats. Run `ask-marcel-office login`, then run decant again: chatsvcagg (Teams chat) token unavailable',
    });

    expect(await reader.listChats()).toEqual(refused);
    expect(await reader.messages('19:aaa@thread.v2')).toEqual(refused);
    expect(await reader.pictures('19:aaa@thread.v2', '1')).toEqual(refused);
  });

  it('any other failure of the substrate comes through as it is', async () => {
    const throttled: DriveReaderError = { kind: 'throttled', retryAfterSeconds: 5, message: 'slow down' };
    const { reader } = readerFor({ 'get-current-user': [ME], 'list-teams-chats-with-messages': [err(throttled)] });

    expect(await reader.listChats()).toEqual({ ok: false, error: throttled });
  });

  it('the messages of a chat are asked from the first instant of the day, whole and without the entries the client wrote, and followed while the library says there is more', async () => {
    const { reader, recorded } = readerFor({
      'list-teams-chat-history': [
        ok({
          messages: [substrateMessage('1', '<p>first</p>'), { ...substrateMessage('x', ''), event: 'call-started' }],
          hasMore: true,
          nextSyncState: 'https://teams.microsoft.com/api/chatsvc/emea/v1/next',
        }),
        ok({ messages: [substrateMessage('2', '<p>second</p>')], hasMore: false }),
      ],
    });

    const messages = await reader.messages('19:aaa@thread.v2', '2026-11-01');

    expect(messages.ok && messages.value.map((message) => [message.id, message.text])).toEqual([
      ['1', 'first'],
      ['2', 'second'],
    ]);
    expect(recorded).toEqual([
      { name: 'list-teams-chat-history', params: { chatId: '19:aaa@thread.v2', skipSystem: 'true', maxContentChars: '1000000', since: '2026-11-01T00:00:00Z' } },
      {
        name: 'list-teams-chat-history',
        params: { chatId: '19:aaa@thread.v2', skipSystem: 'true', maxContentChars: '1000000', syncState: 'https://teams.microsoft.com/api/chatsvc/emea/v1/next' },
      },
    ]);
  });

  it('a chat read whole sends no day, a walk that comes back to where it was ends, and a page that fails ends the read', async () => {
    const whole = readerFor({ 'list-teams-chat-history': [ok({ messages: [], hasMore: true, nextSyncState: 'same' })] });
    const failing = readerFor({ 'list-teams-chat-history': [err({ kind: 'transient', message: 'timeout' })] });

    expect(await whole.reader.messages('19:aaa@thread.v2')).toEqual({ ok: true, value: [] });
    expect(whole.recorded.map((call) => call.params)).toEqual([
      { chatId: '19:aaa@thread.v2', skipSystem: 'true', maxContentChars: '1000000' },
      { chatId: '19:aaa@thread.v2', skipSystem: 'true', maxContentChars: '1000000', syncState: 'same' },
    ]);
    expect(await failing.reader.messages('19:aaa@thread.v2')).toEqual({ ok: false, error: { kind: 'transient', message: 'timeout' } });
  });

  it('a message written before the day asked for, which Teams hands back all the same, is left out', async () => {
    const history = ok({
      messages: [
        { ...substrateMessage('1', '<p>changed later</p>'), composetime: '2026-11-08T05:55:32.4400000Z' },
        { ...substrateMessage('2', '<p>first instant</p>'), composetime: '2026-11-10T00:00:00.0000000Z' },
        { ...substrateMessage('3', '<p>that morning</p>'), composetime: '2026-11-10T07:02:00.0000000Z' },
      ],
      hasMore: false,
    });
    const fromTheDay = readerFor({ 'list-teams-chat-history': [history] });
    const whole = readerFor({ 'list-teams-chat-history': [history] });

    const kept = await fromTheDay.reader.messages('19:aaa@thread.v2', '2026-11-10');
    const all = await whole.reader.messages('19:aaa@thread.v2');

    expect(kept.ok && kept.value.map((message) => message.id)).toEqual(['2', '3']);
    expect(all.ok && all.value.map((message) => message.id)).toEqual(['1', '2', '3']);
  });

  it('the pictures of a message arrive as bytes under the names the library gave them, one with no bytes left out', async () => {
    const { reader, recorded } = readerFor({
      'extract-teams-chat-message-images': [
        ok({
          count: 2,
          media: [
            { path: 'image-1.png', contentType: 'image/png', sizeBytes: 3, base64: Buffer.from([1, 2, 3]).toString('base64') },
            { path: 'image-2.jpg', contentType: 'image/jpeg', sizeBytes: 1, base64: Buffer.from([9]).toString('base64') },
            { path: 'image-3.png', savedTo: 'elsewhere' },
            { base64: 'AAAA' },
          ],
        }),
      ],
    });

    expect(await reader.pictures('19:aaa@thread.v2', '1794536130123')).toEqual({
      ok: true,
      value: [
        { path: 'image-1.png', bytes: new Uint8Array([1, 2, 3]) },
        { path: 'image-2.jpg', bytes: new Uint8Array([9]) },
      ],
    });
    expect(recorded).toEqual([{ name: 'extract-teams-chat-message-images', params: { chatId: '19:aaa@thread.v2', messageId: '1794536130123' } }]);
  });

  it('a shared file is found at the source through its link, as the drive item it is', async () => {
    const file = { name: 'Budget.xlsx', url: 'https://contoso-my.sharepoint.com/:x:/g/personal/jane_contoso_com/EaBcD' };
    const { reader, recorded } = readerFor({
      'resolve-drive-share-link': [
        ok({
          driveId: 'b!drive',
          itemId: '01ITEM',
          name: 'Budget 2027.xlsx',
          webUrl: 'https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Budget%202027.xlsx',
          size: 1200,
        }),
        ok({ driveId: 'b!drive', itemId: '01ITEM' }),
      ],
    });

    expect(await reader.fileLink(file)).toEqual({
      ok: true,
      value: { url: 'https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Budget%202027.xlsx', driveId: 'b!drive', itemId: '01ITEM', name: 'Budget 2027.xlsx' },
    });
    expect(await reader.fileLink(file)).toEqual({ ok: true, value: { url: file.url, driveId: 'b!drive', itemId: '01ITEM', name: 'Budget.xlsx' } });
    expect(recorded[0]).toEqual({ name: 'resolve-drive-share-link', params: { url: file.url } });
  });

  it('a link the library refuses, or one that leads to no file, answers with the reason, and a lapsed sign-in there stays one', async () => {
    const file = { name: 'Plan.docx', url: 'https://example.com/Plan.docx' };
    const refused = readerFor({ 'resolve-drive-share-link': [err({ kind: 'permanent', message: 'not a OneDrive or SharePoint link' })] });
    const empty = readerFor({ 'resolve-drive-share-link': [ok({ name: 'Plan.docx' }), ok({ driveId: 'b!drive' })] });
    const lapsed = readerFor({ 'resolve-drive-share-link': [err({ kind: 'auth', message: 'sign in again' })] });

    expect(await refused.reader.fileLink(file)).toEqual({ ok: false, error: { kind: 'permanent', message: 'not a OneDrive or SharePoint link' } });
    expect(await empty.reader.fileLink(file)).toEqual({ ok: false, error: { kind: 'permanent', message: 'the link did not lead to a file in a library' } });
    expect(await empty.reader.fileLink(file)).toEqual({ ok: false, error: { kind: 'permanent', message: 'the link did not lead to a file in a library' } });
    expect(await lapsed.reader.fileLink(file)).toEqual({ ok: false, error: { kind: 'auth', message: 'sign in again' } });
  });
});

type Converted = { readonly name: string; readonly html: string };

// A converter that records each document it is handed, and answers its seeded answers in turn.
const converterOf = (answers: ReadonlyArray<Result<unknown, GraphErrorShape>>): { convert: ConvertBytes; converted: Converted[] } => {
  const converted: Converted[] = [];
  const convert: ConvertBytes = async (bytes, name) => {
    converted.push({ name, html: new TextDecoder().decode(bytes) });
    return answers[converted.length - 1] ?? ok({});
  };
  return { convert, converted };
};

// A reader whose chat history is these messages, on one page, with the converter given.
const readerOf = (messages: ReadonlyArray<Record<string, unknown>>, convert: ConvertBytes): ReturnType<typeof createChatReaderFromCall> =>
  createChatReaderFromCall(async () => ok({ messages, hasMore: false }), convert);

const QUOTE = '<blockquote itemtype="http://schema.skype.com/Reply"><strong>Jane Doe</strong><p>Can you send it?</p></blockquote><p>Yes, <b>here</b>.</p>';
const TABLE = '<table><tbody><tr><td>Port</td><td>ETA</td></tr></tbody></table>';
const QUOTE_MARKDOWN = ['> **Jane Doe**', '> ', '> Can you send it?', '', 'Yes, **here**.'].join('\n');
const TABLE_MARKDOWN = ['| Port | ETA |', '| --- | --- |'].join('\n');

describe('reading Teams chats with the markdown conversion of the library', () => {
  it('a quoted reply, bold words and a table arrive as markdown, from one conversion of one HTML file for the whole read', async () => {
    const { convert, converted } = converterOf([
      ok({ contentType: 'text/markdown', text: ['decantmessage0boundary', '', QUOTE_MARKDOWN, '', 'decantmessage1boundary', '', TABLE_MARKDOWN].join('\n') }),
    ]);
    const reader = readerOf(
      [
        { ...substrateMessage('0', '<p><i>too early</i></p>'), composetime: '2026-11-08T05:55:32.4400000Z' },
        substrateMessage('1', QUOTE),
        { ...substrateMessage('2', 'typed *as it is*'), messagetype: 'Text' },
        substrateMessage('3', TABLE),
      ],
      convert
    );

    const messages = await reader.messages('19:aaa@thread.v2', '2026-11-10');

    expect(messages.ok && messages.value.map((message) => [message.id, message.text])).toEqual([
      ['1', QUOTE_MARKDOWN],
      ['2', 'typed *as it is*'],
      ['3', TABLE_MARKDOWN],
    ]);
    expect(converted).toEqual([{ name: 'chat.html', html: ['<p>decantmessage0boundary</p>', QUOTE, '<p>decantmessage1boundary</p>', TABLE, ''].join('\n') }]);
  });

  it('a conversion that fails, answers no text, or answers a document with a boundary missing leaves each message with its plain words, and the read succeeds', async () => {
    const plain = [
      ['1', 'Jane DoeCan you send it?\nYes, here.'],
      ['3', 'Port | ETA'],
    ];
    const answers: ReadonlyArray<Result<unknown, GraphErrorShape>> = [
      err({ type: 'api_error', message: 'the conversion took longer than 120 seconds' }),
      ok({ contentType: 'text/markdown' }),
      ok({ text: 'decantmessage0boundary\n\nonly one section' }),
    ];

    for (const answer of answers) {
      const { convert, converted } = converterOf([answer]);
      const reader = readerOf([substrateMessage('1', QUOTE), substrateMessage('3', TABLE)], convert);

      const messages = await reader.messages('19:aaa@thread.v2');

      expect(messages.ok && messages.value.map((message) => [message.id, message.text])).toEqual(plain);
      expect(converted).toHaveLength(1);
    }
  });

  it('a read with only messages typed plain, or with no message at all, starts no conversion', async () => {
    const { convert, converted } = converterOf([]);
    const typed = readerOf([{ ...substrateMessage('1', 'hello'), messagetype: 'Text' }], convert);
    const empty = readerOf([], convert);

    const messages = await typed.messages('19:aaa@thread.v2');

    expect(messages.ok && messages.value.map((message) => message.text)).toEqual(['hello']);
    expect(await empty.messages('19:aaa@thread.v2')).toEqual({ ok: true, value: [] });
    expect(converted).toStrictEqual([]);
  });

  it('a message keeps its pictures and its files with the conversion, and its picture marker stands in the markdown', async () => {
    const pasted = '<img itemtype="http://schema.skype.com/AMSImage" src="https://eu-api.asm.skype.com/v1/objects/0-weu-d1-aaa/views/imgo">';
    const file = { name: 'Budget.xlsx', shareUrl: 'https://contoso-my.sharepoint.com/:x:/g/personal/jane_contoso_com/EaBcD' };
    const { convert, converted } = converterOf([ok({ text: ['decantmessage0boundary', '', String.raw`**Look** \[\[picture 1\]\]`].join('\n') })]);
    const reader = readerOf([{ ...substrateMessage('1', `<p><b>Look</b> ${pasted}</p>`), files: [file] }], convert);

    const messages = await reader.messages('19:aaa@thread.v2');

    expect(messages.ok && messages.value).toEqual([
      {
        id: '1',
        author: 'Jane Doe',
        sent: '2026-11-13T02:15:30.1230000Z',
        text: '**Look** [[picture 1]]',
        files: [{ name: 'Budget.xlsx', url: 'https://contoso-my.sharepoint.com/:x:/g/personal/jane_contoso_com/EaBcD' }],
        pictures: 1,
        webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.v2/1',
      },
    ]);
    expect(converted[0]?.html).toBe(['<p>decantmessage0boundary</p>', '<p><b>Look</b> [[picture 1]]</p>', ''].join('\n'));
  });
});
