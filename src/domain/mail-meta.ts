import type { MailboxState } from './mail-state.ts';

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
  readonly last_message: string;
  readonly attachments: number;
};

// Sorted by key rather than left in the order an object iterates. Roughly one thread id in a
// hundred is all digits, and JavaScript puts an integer-like key ahead of every other one in an
// object, so an unsorted index would reshuffle itself on runs that changed nothing at all.
const byKey = <T>(entries: Readonly<Record<string, T>>): ReadonlyArray<readonly [string, T]> => Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));

export const threadRows = (state: MailboxState): ReadonlyArray<ThreadRow> =>
  byKey(state.threads).map(([threadId, record]) => ({
    thread_id: threadId,
    folder: record.folder,
    file: record.file,
    conversation_ids: record.conversationIds,
    message_count: record.messageIds.length,
    last_message: record.lastMessage,
    attachments: record.attachments.length,
  }));

export type AttachmentRow = { readonly content_hash: string; readonly name: string; readonly primary: string; readonly files: ReadonlyArray<string> };

export const attachmentRows = (state: MailboxState): ReadonlyArray<AttachmentRow> =>
  byKey(state.attachments).map(([hash, record]) => ({ content_hash: hash, name: record.name, primary: record.primary, files: record.paths }));

export type LinkRow = { readonly item: string; readonly files: ReadonlyArray<string> };

export const linkRows = (state: MailboxState): ReadonlyArray<LinkRow> => byKey(state.linked).map(([item, record]) => ({ item, files: record.paths }));
