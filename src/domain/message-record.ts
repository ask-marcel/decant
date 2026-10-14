import type { Correspondent, MailMessage } from './mail-message.ts';
import { unwrapSafelinks } from './safelink.ts';
import { compareText } from './utilities/compare-text.ts';

// How a message is marked where it sits: what a sweep reads off every message, and what a thread is
// written again for when one of them changes. Reading a message changes none of them, so a sweep that
// meets a message only read leaves its thread alone.
export type MessageMarks = {
  readonly folderId: string;
  // Graph's own `flagStatus`.
  readonly flag: string;
  readonly importance: string;
  readonly categories: ReadonlyArray<string>;
};

// What one message of a thread was when the thread was last written: its marks, and what the message
// index lists it by. The note says all of it too, but the index is written whole from the state on
// every run, and an ordinary run writes a few threads out of thousands.
export type MessageRecord = MessageMarks & {
  readonly id: string;
  readonly received: string;
  readonly subject: string;
  readonly from?: Correspondent;
  readonly to: ReadonlyArray<Correspondent>;
  readonly cc: ReadonlyArray<Correspondent>;
  // The name of its folder when the thread was written, empty when the sync had none for it.
  readonly folder: string;
  readonly draft: boolean;
  readonly internetMessageId: string;
  readonly preview: string;
  // The names of the files it carried, and of the documents it linked to, as the sender gave them.
  readonly attachments: ReadonlyArray<string>;
  readonly linked: ReadonlyArray<string>;
};

// What the thread's render knows of a message beyond the message itself.
export type Carried = { readonly folder: string; readonly attachments: ReadonlyArray<string>; readonly linked: ReadonlyArray<string> };

export const marksOf = (message: MailMessage): MessageMarks => ({
  folderId: message.folderId ?? '',
  flag: message.flag ?? '',
  importance: message.importance ?? '',
  categories: message.categories ?? [],
});

const asSet = (texts: ReadonlyArray<string>): string => JSON.stringify(texts.toSorted(compareText));

// Categories are compared as a set: Graph owes no order to a list a person added to one at a time.
export const sameMarks = (left: MessageMarks, right: MessageMarks): boolean =>
  left.folderId === right.folderId && left.flag === right.flag && left.importance === right.importance && asSet(left.categories) === asSet(right.categories);

// The opening words as one line a search can match: the address the sender sent rather than
// Outlook's wrapper around it, and each run of white space one space.
const previewOf = (text: string): string => unwrapSafelinks(text).replaceAll(/\s+/g, ' ').trim();

export const messageRecordOf = (message: MailMessage, carried: Carried): MessageRecord => ({
  id: message.id,
  received: message.received,
  subject: message.subject,
  from: message.from,
  to: message.to,
  cc: message.cc ?? [],
  ...marksOf(message),
  folder: carried.folder,
  draft: message.isDraft === true,
  internetMessageId: message.internetMessageId ?? '',
  preview: previewOf(message.preview ?? ''),
  attachments: carried.attachments,
  linked: carried.linked,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const textOf = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

const textsOf = (raw: unknown): ReadonlyArray<string> => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []);

const correspondentOf = (raw: unknown): Correspondent | undefined => {
  if (!isRecord(raw) || typeof raw['address'] !== 'string') return undefined;
  return { name: typeof raw['name'] === 'string' ? raw['name'] : raw['address'], address: raw['address'] };
};

const correspondentsOf = (raw: unknown): ReadonlyArray<Correspondent> =>
  Array.isArray(raw) ? raw.map(correspondentOf).filter((entry): entry is Correspondent => entry !== undefined) : [];

const recordOf = (raw: unknown): ReadonlyArray<MessageRecord> => {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return [];
  return [
    {
      id: raw['id'],
      received: textOf(raw, 'received'),
      subject: textOf(raw, 'subject'),
      from: correspondentOf(raw['from']),
      to: correspondentsOf(raw['to']),
      cc: correspondentsOf(raw['cc']),
      folderId: textOf(raw, 'folderId'),
      flag: textOf(raw, 'flag'),
      importance: textOf(raw, 'importance'),
      categories: textsOf(raw['categories']),
      folder: textOf(raw, 'folder'),
      draft: raw['draft'] === true,
      internetMessageId: textOf(raw, 'internetMessageId'),
      preview: textOf(raw, 'preview'),
      attachments: textsOf(raw['attachments']),
      linked: textsOf(raw['linked']),
    },
  ];
};

// Absent rather than empty for a thread written before the records were kept: such a thread has no
// marks to compare, which is not the same as a thread that holds no messages.
export const parseMessageRecords = (raw: unknown): ReadonlyArray<MessageRecord> | undefined => (Array.isArray(raw) ? raw.flatMap(recordOf) : undefined);
