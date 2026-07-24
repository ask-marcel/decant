import { safeSegment } from './kb-path.ts';
import type { Correspondent, MailMessage } from './mail-message.ts';
import { inReceivedOrder } from './mail-message.ts';

export type ThreadPart = {
  readonly message: MailMessage;
  readonly body: string;
};

export type Thread = {
  readonly conversationId: string;
  readonly subject: string;
  readonly parts: ReadonlyArray<ThreadPart>;
};

const HASH_LENGTH = 6;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const SUBJECT_LIMIT = 80;
// One prefix at a time, stripped in a loop: a single pattern repeated by `+` over optional spaces
// backtracks exponentially on a long subject, which is a denial of service waiting to happen.
// Whatever sits between the marker and its colon (a space, a `[2]`, both) is matched by one class:
// two adjacent optional groups would make the pattern ambiguous and slow to fail.
const REPLY_PREFIX = /^(re|fw|fwd|tr|rép|rep)[\s[\]\d]*:\s*/i;

// A short, stable fingerprint of the conversation id: two threads that share a date and a subject
// still get their own file, and a thread keeps its name for as long as it exists. Not a security
// value, so a plain non-cryptographic hash is the right tool.
export const shortHash = (value: string): string => {
  let hash = FNV_OFFSET;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, HASH_LENGTH);
};

// `RE:` and `FW:` say how a message travelled, not what it is about, so the thread is filed under
// the bare subject. The stored name never changes afterwards, whatever later replies are titled.
export const threadTitle = (subject: string): string => {
  let bare = subject.trim();
  let previous = '';
  while (bare !== previous) {
    previous = bare;
    bare = bare.replace(REPLY_PREFIX, '').trim();
  }
  return bare.length === 0 ? 'No subject' : bare;
};

export const threadFileName = (thread: { readonly conversationId: string; readonly subject: string; readonly firstReceived: string }): string => {
  const day = thread.firstReceived.slice(0, 10);
  const title = safeSegment(threadTitle(thread.subject)).slice(0, SUBJECT_LIMIT);
  return `${day} ${title} ${shortHash(thread.conversationId)}.md`;
};

export const threadYear = (firstReceived: string): string => firstReceived.slice(0, 4);

const nameOf = (who: Correspondent | undefined): string => who?.name ?? 'Unknown sender';

const recipients = (message: MailMessage): string => (message.to.length === 0 ? '' : ` to ${message.to.map((who) => who.name).join(', ')}`);

const heading = (part: ThreadPart): string => `## ${part.message.received.slice(0, 16).replace('T', ' ')} — ${nameOf(part.message.from)}${recipients(part.message)}`;

// The converter opens every message with a `**Subject:** / **From:** / **To:** / **Date:**` block.
// The section heading above already says who wrote to whom and when, and the subject is the title
// of the file, so those lines are dropped rather than repeated ten times in one conversation.
const MAIL_HEADER_LINE = /^\*\*(Subject|From|To|Cc|Bcc|Date|Sent):\*\*/;

export const withoutMailHeaders = (body: string): string => {
  const lines = body.split('\n');
  let start = 0;
  while (start < lines.length && (MAIL_HEADER_LINE.test(lines[start] ?? '') || (lines[start] ?? '').trim().length === 0)) start += 1;
  return lines.slice(start).join('\n');
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
