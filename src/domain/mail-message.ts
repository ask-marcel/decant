import type { Result } from './result.ts';
import { err, ok } from './result.ts';

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
};

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

const canonicalCursor = (link: string | undefined): string | undefined => link?.replace(/%24/gi, '$');

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
    conversationId: readString(raw, 'conversationId') ?? '',
    subject: readString(raw, 'subject') ?? '',
    received: readString(raw, 'receivedDateTime') ?? '',
    hasAttachments: raw['hasAttachments'] === true,
    from: correspondentOf(raw['from']),
    to: recipientsOf(raw['toRecipients']),
    // Graph marks a message removed since the last sweep with an `@removed` facet, id only.
    isDeleted: raw['@removed'] !== undefined,
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
  [...messages].sort((left, right) => (left.received === right.received ? left.id.localeCompare(right.id) : left.received.localeCompare(right.received)));
