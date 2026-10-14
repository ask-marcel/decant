import { indexDay, renderIndexPage } from './index-page.ts';
import type { IndexRow } from './index-page.ts';
import type { Correspondent } from './mail-message.ts';
import { flagWord } from './mail-message.ts';
import { MAILBOX_NAME } from './mail-state.ts';
import type { MailboxState, ThreadRecord } from './mail-state.ts';
import type { MessageRecord } from './message-record.ts';
import { compareText } from './utilities/compare-text.ts';
import { timeIn } from './zoned-day.ts';

// The cross-thread index. Front matter inside a markdown file is only text, so filtering on a date,
// a sender or a missing dependency means reading every file; these are what make that a query.
//
// One JSON document per line, which is what lets a reader stream them and `grep` pick whole records
// out. `JSON.stringify` escapes the newlines and quotes a subject can carry, so a line stays a line.
export const renderJsonl = <T>(rows: ReadonlyArray<T>): string => rows.map((row) => `${JSON.stringify(row)}\n`).join('');

export type ThreadRow = {
  readonly thread_id: string;
  readonly folder: string;
  readonly file: string;
  readonly conversation_ids: ReadonlyArray<string>;
  readonly message_count: number;
  readonly first_message: string;
  readonly last_message: string;
  readonly attachments: number;
};

// Sorted by key rather than left in the order an object iterates. Roughly one thread id in a
// hundred is all digits, and JavaScript puts an integer-like key ahead of every other one in an
// object, so an unsorted index would reshuffle itself on runs that changed nothing at all.
const byKey = <T>(entries: Readonly<Record<string, T>>): ReadonlyArray<readonly [string, T]> => Object.entries(entries).sort(([left], [right]) => compareText(left, right));

export const threadRows = (state: MailboxState): ReadonlyArray<ThreadRow> =>
  byKey(state.threads).map(([threadId, record]) => ({
    thread_id: threadId,
    folder: record.folder,
    file: record.file,
    conversation_ids: record.conversationIds,
    message_count: record.messageIds.length,
    first_message: record.firstMessage ?? '',
    last_message: record.lastMessage,
    attachments: record.attachments.length,
  }));

export type AttachmentRow = { readonly content_hash: string; readonly name: string; readonly primary: string; readonly files: ReadonlyArray<string> };

export const attachmentRows = (state: MailboxState): ReadonlyArray<AttachmentRow> =>
  byKey(state.attachments).map(([hash, record]) => ({ content_hash: hash, name: record.name, primary: record.primary, files: record.paths }));

export type LinkRow = { readonly item: string; readonly files: ReadonlyArray<string> };

export const linkRows = (state: MailboxState): ReadonlyArray<LinkRow> => byKey(state.linked).map(([item, record]) => ({ item, files: record.paths }));

const threadRow = ([threadId, record]: readonly [string, ThreadRecord], zone: string): IndexRow & { readonly at: string; readonly id: string } => ({
  day: indexDay(record.lastMessage, zone),
  title: record.subject ?? '',
  file: record.file,
  note: record.lastFrom ?? '',
  at: record.lastMessage,
  id: threadId,
});

// The mailbox as a reader scans it: the thread with the newest message first, under the day of that
// message, by its subject and the one who wrote last. Two threads at one moment keep the order of
// their keys, so the page does not change between runs that changed nothing.
export const mailboxIndexPage = (state: MailboxState, zone: string): string => {
  const rows = Object.entries(state.threads)
    .map((entry) => threadRow(entry, zone))
    .toSorted((left, right) => compareText(right.at, left.at) || compareText(left.id, right.id));
  return renderIndexPage('Mailbox', [{ heading: 'By last message', rows }]);
};

// One line per message, under the field names that the filters written against the message index
// before decant wrote it already use, and five more: `cc`, `cc_emails`, `categories`, `importance` and
// `internet_message_id`.
export type MessageRow = {
  readonly date: string;
  readonly time: string;
  readonly utc: string;
  readonly direction: 'received' | 'sent' | 'draft';
  readonly from: string;
  readonly from_email: string;
  readonly to: ReadonlyArray<string>;
  readonly to_emails: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly cc_emails: ReadonlyArray<string>;
  readonly subject: string;
  readonly folder: string;
  readonly flag: string;
  readonly categories: ReadonlyArray<string>;
  readonly importance: string;
  readonly attachments: ReadonlyArray<string>;
  readonly linked_files: ReadonlyArray<string>;
  readonly preview: string;
  readonly note: string;
  readonly position: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly internet_message_id: string;
};

// The day and the `HH:MM` a message arrived, where the knowledge base counts its days, and nothing for
// a message that gave no time rather than a day nobody lived.
const arrival = (received: string, zone: string): { readonly date: string; readonly time: string } => {
  if (received.length === 0) return { date: '', time: '' };
  const [date = '', time = ''] = timeIn(received, zone).split(' ');
  return { date, time };
};

// Told by the address a message went out from, not by its folder: a reply filed with its conversation
// in a project folder is still mail the mailbox sent. A draft is a draft whoever wrote it.
const directionOf = (message: MessageRecord, own: ReadonlySet<string>): MessageRow['direction'] => {
  if (message.draft) return 'draft';
  return own.has((message.from?.address ?? '').toLowerCase()) ? 'sent' : 'received';
};

const namesOf = (who: ReadonlyArray<Correspondent>): ReadonlyArray<string> => who.map((one) => one.name);

const addressesOf = (who: ReadonlyArray<Correspondent>): ReadonlyArray<string> => who.map((one) => one.address);

type Placed = { readonly threadId: string; readonly record: ThreadRecord; readonly position: string };

const messageRow = (message: MessageRecord, placed: Placed, own: ReadonlySet<string>, zone: string): MessageRow => ({
  ...arrival(message.received, zone),
  utc: message.received,
  direction: directionOf(message, own),
  from: message.from?.name ?? '',
  from_email: message.from?.address ?? '',
  to: namesOf(message.to),
  to_emails: addressesOf(message.to),
  cc: namesOf(message.cc),
  cc_emails: addressesOf(message.cc),
  subject: message.subject,
  folder: message.folder,
  flag: flagWord(message.flag),
  categories: message.categories,
  importance: message.importance,
  attachments: message.attachments,
  linked_files: message.linked,
  preview: message.preview,
  // From the knowledge base, the way a reader opens it, rather than from the mailbox root.
  note: `${MAILBOX_NAME}/${placed.record.file}`,
  position: placed.position,
  thread_id: placed.threadId,
  message_id: message.id,
  internet_message_id: message.internetMessageId,
});

// Every message of every thread, written from the state the way the thread index is: an ordinary run
// writes a few threads, and the index still lists them all. Oldest first, a tie kept apart by the
// message id, so a run that changed nothing writes the same file.
export const messageRows = (state: MailboxState, zone: string): ReadonlyArray<MessageRow> => {
  const own = new Set(state.ownAddresses);
  return Object.entries(state.threads)
    .flatMap(([threadId, record]) =>
      (record.messages ?? []).map((message, index, all) => messageRow(message, { threadId, record, position: `${index + 1}/${all.length}` }, own, zone))
    )
    .toSorted((left, right) => compareText(left.utc, right.utc) || compareText(left.message_id, right.message_id));
};
