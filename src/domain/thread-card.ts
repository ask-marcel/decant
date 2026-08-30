import { renderFrontMatter } from './front-matter.ts';
import { safeSegment } from './kb-path.ts';
import type { SafeSegment } from './kb-path.ts';

// What one thread carried, standing beside that thread rather than in the store the file itself
// lives in. The card is small on purpose: the bytes and the text read out of them are held once,
// addressed by content, so a signature logo riding on two hundred threads is two hundred cards of a
// few hundred bytes and one copy of the image. What cannot be shared is exactly what is here, since
// it belongs to the arrival rather than to the file: who sent it, when, and under which message.
export type ThreadCard = {
  readonly threadId: string;
  readonly messageId: string;
  readonly filename: string;
  readonly sender?: string;
  readonly received: string;
  readonly bytes?: number;
  // The text read out of the file, carried here rather than pointed at, so a thread folder reads on
  // its own without following a path three levels up. Absent when nothing could be read: a file past
  // the size cap, or a kind nothing reads, which then has only its original.
  readonly body?: string;
  // The file itself, which stays in the store however many threads carried it. The bytes are the
  // expensive thing to duplicate; the text is a fraction of them, which is why only the text moves.
  readonly original?: string;
  readonly note?: string;
};

const DAY_LENGTH = 10;

const carriedLine = (card: ThreadCard): string => {
  const who = card.sender === undefined ? 'Carried' : `Carried by ${card.sender}`;
  return `${who} on ${card.received.slice(0, DAY_LENGTH)}.`;
};

// A card with nothing behind it still earns its place: it is the record that the file arrived at
// all, and the reason the knowledge base does not hold it.
const bodyOf = (card: ThreadCard): string => {
  if (card.body === undefined) return `${carriedLine(card)} ${card.note ?? 'Nothing was read out of it.'}`;
  return `${carriedLine(card)}\n\n${card.body}`;
};

export const renderThreadCard = (card: ThreadCard): string =>
  [
    renderFrontMatter([
      ['attachment_of', card.threadId],
      ['message_id', card.messageId],
      ['filename', card.filename],
      ['sender', card.sender],
      ['received', card.received],
      ['bytes', card.bytes],
      ['original', card.original],
    ]),
    '',
    `# ${card.filename}`,
    '',
    bodyOf(card),
    '',
  ].join('\n');

// A leading dot names a hidden file rather than opening an extension, so `.gitignore` is numbered
// whole. Matches how the shared store splits a name for the same reason.
const extensionStart = (name: string): number => {
  const lastDot = name.lastIndexOf('.');
  return lastDot <= 0 ? name.length : lastDot;
};

// The file itself, under a name no other file in this thread has taken. Two attachments of one name
// in a single thread is ordinary, a form resent after correction being the usual way, and both are
// kept: the second is numbered. The card beside it is this plus `.md`, so the pair is one decision
// rather than two that have to be kept in step.
export const uniqueName = (filename: string, taken: ReadonlyArray<string>): SafeSegment => {
  const cut = extensionStart(filename);
  const stem = filename.slice(0, cut);
  const extension = filename.slice(cut);
  let attempt = 1;
  let candidate = safeSegment(filename);
  while (taken.includes(candidate)) {
    attempt += 1;
    candidate = safeSegment(`${stem}-${attempt}${extension}`);
  }
  return candidate;
};
