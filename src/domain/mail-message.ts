import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { canonicalCursor } from './utilities/graph-cursor.ts';
import { compareText } from './utilities/compare-text.ts';

export type Correspondent = { readonly name: string; readonly address: string };

export type MailMessage = {
  readonly id: string;
  readonly conversationId: string;
  readonly subject: string;
  readonly received: string;
  readonly hasAttachments: boolean;
  readonly from?: Correspondent;
  readonly to: ReadonlyArray<Correspondent>;
  readonly isDeleted: boolean;
  // What a search finds a message by besides who wrote it, read off the message itself. Absent on a
  // post in a group inbox, which has no recipients of its own (the group is its audience), no folder,
  // no flag and no category: an empty `cc` says a message was copied to nobody, an absent one says
  // the source keeps no such list.
  readonly cc?: ReadonlyArray<Correspondent>;
  readonly folderId?: string;
  // Graph's own `flagStatus`: `notFlagged`, `flagged` or `complete`.
  readonly flag?: string;
  readonly categories?: ReadonlyArray<string>;
  readonly importance?: string;
  // The RFC `Message-ID`, which stays the same when the message moves to another folder.
  readonly internetMessageId?: string;
  readonly isDraft?: boolean;
  // The opening words of the body, as Graph cuts them.
  readonly preview?: string;
};

// How a flag reads in a note and in the message index: `open` while it waits, `complete` once done,
// and nothing for a message never flagged. `open` because the filters written against the message
// index before decant wrote it already ask for that word.
const FLAG_WORDS: Readonly<Partial<Record<string, string>>> = { flagged: 'open', complete: 'complete' };

export const flagWord = (flag: string | undefined): string => FLAG_WORDS[flag ?? ''] ?? '';

export type MailDeltaPage = {
  readonly messages: ReadonlyArray<MailMessage>;
  readonly skipped: number;
  readonly nextLink?: string;
  readonly deltaLink?: string;
};

export type MailParseError = { readonly kind: 'malformed'; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const textOf = (record: Record<string, unknown>, key: string): string => readString(record, key) ?? '';

const textsOf = (raw: unknown): ReadonlyArray<string> => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []);

const flagOf = (raw: unknown): string => (isRecord(raw) ? textOf(raw, 'flagStatus') : '');

const correspondentOf = (raw: unknown): Correspondent | undefined => {
  if (!isRecord(raw) || !isRecord(raw['emailAddress'])) return undefined;
  const address = readString(raw['emailAddress'], 'address');
  return address === undefined ? undefined : { name: readString(raw['emailAddress'], 'name') ?? address, address };
};

const recipientsOf = (raw: unknown): ReadonlyArray<Correspondent> =>
  Array.isArray(raw) ? raw.map(correspondentOf).filter((entry): entry is Correspondent => entry !== undefined) : [];

export const parseMessage = (raw: unknown): MailMessage | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw, 'id');
  if (id === undefined) return undefined;
  return {
    id,
    conversationId: textOf(raw, 'conversationId'),
    subject: textOf(raw, 'subject'),
    received: textOf(raw, 'receivedDateTime'),
    hasAttachments: raw['hasAttachments'] === true,
    from: correspondentOf(raw['from']),
    to: recipientsOf(raw['toRecipients']),
    // Graph marks a message removed since the last sweep with an `@removed` facet, id only.
    isDeleted: raw['@removed'] !== undefined,
    cc: recipientsOf(raw['ccRecipients']),
    folderId: textOf(raw, 'parentFolderId'),
    flag: flagOf(raw['flag']),
    categories: textsOf(raw['categories']),
    importance: textOf(raw, 'importance'),
    internetMessageId: textOf(raw, 'internetMessageId'),
    isDraft: raw['isDraft'] === true,
    preview: textOf(raw, 'bodyPreview'),
  };
};

export const parseMailDelta = (raw: unknown): Result<MailDeltaPage, MailParseError> => {
  if (!isRecord(raw) || !Array.isArray(raw['value'])) return err({ kind: 'malformed', message: 'mail response has no value array' });
  const parsed = raw['value'].map(parseMessage);
  const messages = parsed.filter((message): message is MailMessage => message !== undefined);
  return ok({
    messages,
    skipped: parsed.length - messages.length,
    nextLink: canonicalCursor(readString(raw, '@odata.nextLink')),
    deltaLink: canonicalCursor(readString(raw, '@odata.deltaLink')),
  });
};

// A thread is read newest-page-first by Graph and comes back unordered, so it is sorted here.
export const inReceivedOrder = (messages: ReadonlyArray<MailMessage>): ReadonlyArray<MailMessage> =>
  [...messages].sort((left, right) => (left.received === right.received ? compareText(left.id, right.id) : compareText(left.received, right.received)));
