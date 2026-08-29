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
  // Where the text read out of the file sits, and where the file itself was kept. Either can be
  // absent: a file too large to fetch has neither, and a kind nothing reads has only the original.
  readonly holds?: string;
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
  if (card.holds === undefined) return `${carriedLine(card)} ${card.note ?? 'Nothing was read out of it.'}`;
  return `${carriedLine(card)} The text read out of it is in [the shared store](${card.holds}),\nwhere it is held once however many threads carried it.`;
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
      ['holds', card.holds],
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

// Two attachments of one name in a single thread is ordinary, a form resent after correction being
// the usual way. Both are kept: the store already holds them apart by content, so the only thing
// missing is a name for the second card.
export const cardFileName = (filename: string, taken: ReadonlyArray<string>): SafeSegment => {
  const cut = extensionStart(filename);
  const stem = filename.slice(0, cut);
  const extension = filename.slice(cut);
  let attempt = 1;
  let candidate = safeSegment(`${filename}.md`);
  while (taken.includes(candidate)) {
    attempt += 1;
    candidate = safeSegment(`${stem}-${attempt}${extension}.md`);
  }
  return candidate;
};
