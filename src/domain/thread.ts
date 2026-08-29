import type { Correspondent, MailMessage } from './mail-message.ts';
import { bareSubject } from './thread-subject.ts';
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

const heading = (part: ThreadPart): string => `## ${part.message.received.slice(0, 16).replace('T', ' ')} — ${nameOf(part.message.from)}${recipients(part.message)}`;

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

const bodyOf = (part: ThreadPart): string => {
  const trimmed = withoutMailHeaders(part.body).trim();
  return trimmed.length === 0 ? '_This message had no readable body._' : trimmed;
};

const section = (part: ThreadPart): string => `${heading(part)}\n\n${bodyOf(part)}`;

// One file holds the whole conversation, oldest message first, each under its own heading. Quoted
// reply chains are already stripped upstream, so nothing here repeats what an earlier section said.
export const renderThread = (thread: Thread): string => {
  const order = new Map(inReceivedOrder(thread.parts.map((part) => part.message)).map((message, index) => [message.id, index]));
  const ordered = [...thread.parts].sort((left, right) => (order.get(left.message.id) ?? 0) - (order.get(right.message.id) ?? 0));
  return [`# ${threadTitle(thread.subject)}`, ...ordered.map(section)].join('\n\n');
};

export const participantsOf = (parts: ReadonlyArray<ThreadPart>): ReadonlyArray<string> => {
  const everyone = parts.flatMap((part) => [...(part.message.from === undefined ? [] : [part.message.from]), ...part.message.to]);
  return [...new Set(everyone.map((who) => who.name))].sort((left, right) => left.localeCompare(right));
};
