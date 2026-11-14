import type { GetTarget } from '../domain/get-target.ts';
import { inReceivedOrder } from '../domain/mail-message.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { rootMessageId } from '../domain/root-message-id.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { bareSubject } from '../domain/thread-subject.ts';
import type { Got } from './get-file.ts';
import { notFound } from './graph-status.ts';
import type { MailReader } from './ports/mail-reader.ts';
import type { StepError } from './ports/step-error.ts';
import type { RenderThread } from './render-thread.ts';

// One conversation, asked for by a message of it, where a sync takes the whole mailbox. Written the
// way a sync writes a thread, under `Picked`, which holds no state: see `get-file.ts`.
export const PICKED_MAILBOX = 'Picked/Mailbox';

export type MailTarget = Exclude<GetTarget, { readonly kind: 'file' }>;

export type GetMailDeps = {
  readonly reader: Pick<MailReader, 'messageOfLink' | 'conversationOf' | 'conversation' | 'messageHeaders'>;
  readonly renderThread: RenderThread;
  // Where the picked threads are written, which is where `renderThread` was built to write.
  readonly mailboxRoot: string;
};

export type GetMailInput = { readonly target: MailTarget; readonly maxBytes: number };

export type GetMail = (input: GetMailInput) => Promise<Result<Got, StepError>>;

const failed = (step: string, cause: string, message: string): Result<never, StepError> => err({ step, cause, message });

// What was typed, as the id of a message: an address in Outlook on the web names one.
const messageIdOf = async (deps: GetMailDeps, target: MailTarget): Promise<Result<string, StepError>> => {
  if (target.kind === 'mail') return ok(target.id);
  const found = await deps.reader.messageOfLink(target.url);
  return found.ok ? found : failed('resolveAddress', found.error.kind, found.error.message);
};

// The conversation a message belongs to. An id no message answers to is tried as the id of a
// conversation, since a listing hands out both and nothing in an id says which it is.
const conversationIdOf = async (deps: GetMailDeps, messageId: string): Promise<Result<string, StepError>> => {
  const found = await deps.reader.conversationOf(messageId);
  if (found.ok) return found;
  return notFound(found.error) ? ok(messageId) : failed('findMessage', found.error.kind, found.error.message);
};

// The oldest message of the conversation, which is the one that names its thread.
const oldestOf = async (deps: GetMailDeps, conversationId: string): Promise<Result<MailMessage, StepError>> => {
  const found = await deps.reader.conversation(conversationId);
  if (!found.ok) return failed('readConversation', found.error.kind, found.error.message);
  const oldest = inReceivedOrder(found.value)[0];
  return oldest === undefined ? failed('readConversation', 'not-found', `no message was found for ${conversationId}`) : ok(oldest);
};

// The thread is named from the oldest message, as a sync names it: a reply carries a later time, and
// read from one the same conversation would land in a second place.
const write = async (deps: GetMailDeps, input: GetMailInput, conversationId: string, oldest: MailMessage): Promise<Result<Got, StepError>> => {
  const headers = await deps.reader.messageHeaders(oldest.id);
  if (!headers.ok) return failed('findThread', headers.error.kind, headers.error.message);
  const root = rootMessageId(headers.value, oldest.id);
  const written = await deps.renderThread({
    threadId: threadIdOf(root),
    label: bareSubject(oldest.subject),
    conversationIds: [conversationId],
    root,
    folder: '',
    maxBytes: input.maxBytes,
    linked: {},
    attachments: {},
  });
  if (!written.ok) return failed('writeThread', written.error.kind, written.error.message);
  if (written.value.kind === 'empty') return failed('writeThread', 'empty', 'the conversation holds no message to write');
  return ok({ path: `${deps.mailboxRoot}/${written.value.thread.record.file}` });
};

export const createGetMail =
  (deps: GetMailDeps): GetMail =>
  async (input) => {
    const messageId = await messageIdOf(deps, input.target);
    if (!messageId.ok) return messageId;
    const conversationId = await conversationIdOf(deps, messageId.value);
    if (!conversationId.ok) return conversationId;
    const oldest = await oldestOf(deps, conversationId.value);
    return oldest.ok ? write(deps, input, conversationId.value, oldest.value) : oldest;
  };
