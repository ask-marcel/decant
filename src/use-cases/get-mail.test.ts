import { describe, expect, it } from 'bun:test';
import type { GetTarget } from '../domain/get-target.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import type { MailReaderSeed } from '../test-helpers/mail-reader-fake.ts';
import type { Got } from './get-file.ts';
import { createGetMail } from './get-mail.ts';
import type { RenderThreadInput, RenderThreadOutcome } from './render-thread.ts';
import type { MailReaderError } from './ports/mail-reader.ts';
import type { StepError } from './ports/step-error.ts';

const CONV = 'AAQkAD-conv';
const LINK = 'https://outlook.office365.com/owa/?ItemID=AAMk-reply';
const NOTE = 'threads/2026-11-10-abc1234567-contrat-contoso/contrat-contoso.md';

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'AAMk-first',
  conversationId: CONV,
  subject: 'Contrat Contoso',
  received: '2026-11-10T09:31:00Z',
  hasAttachments: false,
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [],
  isDeleted: false,
  ...over,
});

const REPLY = message({ id: 'AAMk-reply', subject: 'RE: Contrat Contoso', received: '2026-11-12T08:00:00Z' });

const rendered: RenderThreadOutcome = {
  kind: 'rendered',
  thread: {
    record: {
      folder: '2026-11-10-abc1234567-contrat-contoso',
      conversationIds: [CONV],
      file: NOTE,
      messageIds: ['AAMk-first', 'AAMk-reply'],
      lastMessage: REPLY.received,
      attachments: [],
      inlineImages: [],
    },
    linked: {},
    attachments: {},
    filesSkipped: [],
    filesFailed: [],
  },
};

type Seeds = { reader?: MailReaderSeed; outcome?: Result<RenderThreadOutcome, MailReaderError> };

const get = async (
  target: Exclude<GetTarget, { kind: 'file' }>,
  seeds: Seeds = {}
): Promise<{ got: Result<Got, StepError>; asked: RenderThreadInput[]; reader: ReturnType<typeof createMailReaderFake> }> => {
  const asked: RenderThreadInput[] = [];
  const reader = createMailReaderFake({
    conversations: { [CONV]: [REPLY, message()] },
    headers: { 'AAMk-first': [{ name: 'Message-ID', value: '<first@example.com>' }] },
    messageLinks: { [LINK]: 'AAMk-reply' },
    ...seeds.reader,
  });
  const getMail = createGetMail({
    reader,
    mailboxRoot: 'kb/Picked/Mailbox',
    renderThread: async (input) => {
      asked.push(input);
      return seeds.outcome ?? ok(rendered);
    },
  });
  return { got: await getMail({ target, maxBytes: 1000 }), asked, reader };
};

describe('getting one mail conversation', () => {
  it('the id of one message gives its whole conversation, written as one thread, and its note is named', async () => {
    const { got, asked } = await get({ kind: 'mail', id: 'AAMk-reply' });

    expect(got).toEqual({ ok: true, value: { path: `kb/Picked/Mailbox/${NOTE}` } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ conversationIds: [CONV], label: 'Contrat Contoso', folder: '', maxBytes: 1000, linked: {}, attachments: {} });
  });

  // The oldest message names the thread, as in a sync: a reply or a draft carries a later time and
  // would name it after itself.
  it('the thread is named from its oldest message, so the same conversation always lands in the same place', async () => {
    const { asked, reader } = await get({ kind: 'mail', id: 'AAMk-reply' });

    expect(reader.calls.filter((call) => call.startsWith('headers:'))).toEqual(['headers:AAMk-first']);
    expect(asked[0]).toMatchObject({ root: '<first@example.com>', threadId: threadIdOf('<first@example.com>') });
  });

  it('the address of a mail in Outlook on the web gives the same conversation', async () => {
    const { got, reader } = await get({ kind: 'mail-link', url: LINK });

    expect(got).toEqual({ ok: true, value: { path: `kb/Picked/Mailbox/${NOTE}` } });
    expect(reader.calls).toContain('conversationOf:AAMk-reply');
  });

  it('an id that is the id of a conversation, not of a message, is read as the conversation', async () => {
    const { got, asked } = await get({ kind: 'mail', id: CONV });

    expect(got.ok).toBe(true);
    expect(asked[0]?.conversationIds).toEqual([CONV]);
  });

  it('an id nothing answers to fails, saying that no message was found', async () => {
    const { got, asked } = await get({ kind: 'mail', id: 'AAMk-unknown' });

    expect(got).toEqual({ ok: false, error: { step: 'readConversation', cause: 'not-found', message: 'no message was found for AAMk-unknown' } });
    expect(asked).toHaveLength(0);
  });

  it('an address that names no message fails at the address', async () => {
    const { got } = await get({ kind: 'mail-link', url: 'https://outlook.office.com/mail/elsewhere' });

    expect(got).toEqual({ ok: false, error: { step: 'resolveAddress', cause: 'permanent', message: 'the address names no message' } });
  });

  it('a lapsed sign-in fails at the message, and is not taken for an unknown id', async () => {
    const { got } = await get({ kind: 'mail', id: 'AAMk-reply' }, { reader: { failWith: { kind: 'auth', message: 'sign in again' } } });

    expect(got).toEqual({ ok: false, error: { step: 'findMessage', cause: 'auth', message: 'sign in again' } });
  });

  it('a conversation whose headers cannot be read fails, since nothing then says where the thread belongs', async () => {
    const { got } = await get({ kind: 'mail', id: 'AAMk-reply' }, { reader: { failCalls: { messageHeaders: { kind: 'transient', message: 'Graph is busy' } } } });

    expect(got).toEqual({ ok: false, error: { step: 'findThread', cause: 'transient', message: 'Graph is busy' } });
  });

  it('a thread that cannot be written, or that holds no message, fails saying so', async () => {
    const refused = await get({ kind: 'mail', id: 'AAMk-reply' }, { outcome: err({ kind: 'permanent', message: 'thread refused' }) });
    const empty = await get({ kind: 'mail', id: 'AAMk-reply' }, { outcome: ok({ kind: 'empty' }) });

    expect(refused.got).toEqual({ ok: false, error: { step: 'writeThread', cause: 'permanent', message: 'thread refused' } });
    expect(empty.got).toEqual({ ok: false, error: { step: 'writeThread', cause: 'empty', message: 'the conversation holds no message to write' } });
  });
});
