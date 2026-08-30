import type { Correspondent, MailMessage } from './mail-message.ts';
import { bareSubject } from './thread-subject.ts';
import { timeIn } from './zoned-day.ts';
import { inReceivedOrder } from './mail-message.ts';

export type ThreadPart = {
  readonly message: MailMessage;
  readonly body: string;
};

export type Thread = {
  readonly subject: string;
  readonly parts: ReadonlyArray<ThreadPart>;
};

// The subject a thread is known by, with the markers saying how its mail travelled taken off. The
// stripping itself lives in `thread-subject.ts` and is shared with the folder name: a heading and a
// path that disagreed about what counts as a marker would leave a Chinese thread reading
// `# 回复: Kick-off` inside a folder called `kick-off`.
export const threadTitle = (subject: string): string => {
  const bare = bareSubject(subject);
  return bare.length === 0 ? 'No subject' : bare;
};

const nameOf = (who: Correspondent | undefined): string => who?.name ?? 'Unknown sender';

const recipients = (message: MailMessage): string => (message.to.length === 0 ? '' : ` to ${message.to.map((who) => who.name).join(', ')}`);

// Told where the mailbox lives, not sliced off the raw UTC string. The folder the thread sits in is
// already counted in that zone, so a UTC heading disagreed with its own path by the offset, and
// with the clock the reader has their mail open on. Bare, with no zone marker, because it is the
// human-facing stamp and matches what Outlook shows; the front matter keeps UTC with its `Z` for
// anything reading the file rather than the reader.
const heading = (part: ThreadPart, timezone: string): string => `## ${timeIn(part.message.received, timezone)} — ${nameOf(part.message.from)}${recipients(part.message)}`;

// The converter opens every message with a `**Subject:** / **From:** / **To:** / **Date:**` block.
// The section heading above already says who wrote to whom and when, and the subject is the title
// of the file, so those lines are dropped rather than repeated ten times in one conversation.
const MAIL_HEADER_LINE = /^\*\*(Subject|From|To|Cc|Bcc|Date|Sent):\*\*/;

const isHeaderOrBlank = (line: string): boolean => MAIL_HEADER_LINE.test(line) || line.trim().length === 0;

export const withoutMailHeaders = (body: string): string => {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => !isHeaderOrBlank(line));
  return start < 0 ? '' : lines.slice(start).join('\n');
};

// What `convert-mail-to-markdown` leaves standing where it dropped a quoted chain. It is a note to
// whoever ran the converter, not part of the message, and it repeats once per reply down a long
// thread. The third literal from the library that domain code leans on, after `**Attachments:**`
// and `[inline image: `; a reword upstream costs this cleanup and never the body itself.
//
// A whole line at a time, and only a line that IS the note. Taking the note alone would leave the
// `>` behind when the converter has quoted its own note inside a forward, which reads as a message
// somebody sent empty; and matching the phrase anywhere would eat a sentence about quoted chains.
const QUOTED_MARKER_LINE = /^[>\s]*_?\\?\[Quoted reply chain removed\b.*$/;

// Taking a line out leaves the blank lines that surrounded it next to each other, so a paragraph
// break becomes a gap. Runs are closed back up to one blank line.
const WIDENED_GAP = /\n{3,}/g;

export const withoutQuotedMarker = (body: string): string =>
  body
    .split('\n')
    .filter((line) => !QUOTED_MARKER_LINE.test(line))
    .join('\n')
    .replace(WIDENED_GAP, '\n\n')
    .trim();

const bodyOf = (part: ThreadPart): string => {
  const trimmed = withoutQuotedMarker(withoutMailHeaders(part.body)).trim();
  return trimmed.length === 0 ? '_This message had no readable body._' : trimmed;
};

const section = (part: ThreadPart, timezone: string): string => `${heading(part, timezone)}\n\n${bodyOf(part)}`;

// One file holds the whole conversation, oldest message first, each under its own heading. Quoted
// reply chains are already stripped upstream, so nothing here repeats what an earlier section said.
export const renderThread = (thread: Thread, timezone: string): string => {
  const order = new Map(inReceivedOrder(thread.parts.map((part) => part.message)).map((message, index) => [message.id, index]));
  const ordered = [...thread.parts].sort((left, right) => (order.get(left.message.id) ?? 0) - (order.get(right.message.id) ?? 0));
  return [`# ${threadTitle(thread.subject)}`, ...ordered.map((part) => section(part, timezone))].join('\n\n');
};

// Name and address both, in the shape mail itself uses. The headings name people the way a reader
// says them, so this list is the one place the addresses live: without it a thread names eleven
// people and gives no way to write to any of them, which is most of what a reader wants a
// conversation for. Deduplicated on the pair, since one person writing from two addresses is two
// ways to reach them and worth keeping apart.
const asWritten = (who: Correspondent): string => (who.address.length === 0 ? who.name : `${who.name} <${who.address}>`);

export const participantsOf = (parts: ReadonlyArray<ThreadPart>): ReadonlyArray<string> => {
  const everyone = parts.flatMap((part) => [...(part.message.from === undefined ? [] : [part.message.from]), ...part.message.to]);
  return [...new Set(everyone.map(asWritten))].sort((left, right) => left.localeCompare(right));
};
