import type { ChatKind } from './chat.ts';
import { pictureMarker } from './chat-message.ts';
import type { ChatMessage } from './chat-message.ts';
import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { linkDestination } from './markdown-link.ts';
import { compareText } from './utilities/compare-text.ts';
import { dayIn, timeIn } from './zoned-day.ts';

// The messages of one chat that fall on one day, where the knowledge base counts its days.
export type DayMessages = { readonly day: string; readonly messages: ReadonlyArray<ChatMessage> };

// A chat is read page by page and can be read twice over one stretch, so a message can come more than
// once: the one read last stands. Within a day the messages go in the order they were written, two of
// one instant in the order of their ids, so a day reads the same on every run.
export const byDay = (messages: ReadonlyArray<ChatMessage>, zone: string): ReadonlyArray<DayMessages> => {
  const latest = [...new Map(messages.map((message) => [message.id, message])).values()];
  const ordered = latest.toSorted((left, right) => compareText(left.sent, right.sent) || compareText(left.id, right.id));
  const days = new Map<string, ChatMessage[]>();
  for (const message of ordered) {
    const day = dayIn(message.sent, zone);
    days.set(day, [...(days.get(day) ?? []), message]);
  }
  return [...days.entries()].toSorted(([left], [right]) => compareText(left, right)).map(([day, held]) => ({ day, messages: held }));
};

// A pasted picture once it is a file: where the note links to, and what OCR read in it, if it read.
export type PictureLink = { readonly link: string; readonly text?: string };

// A file a message shared, as the note names it: linked to its card when it has one, with what
// became of it when it did not arrive whole.
export type FileLine = { readonly name: string; readonly link?: string; readonly note?: string };

// A message with what the run made of its pictures and files. A picture that could not be saved is
// absent at its place in the list.
export type NotedMessage = { readonly message: ChatMessage; readonly pictures: ReadonlyArray<PictureLink | undefined>; readonly files: ReadonlyArray<FileLine> };

export type DayNoteInput = {
  readonly chat: string;
  readonly kind: ChatKind;
  readonly members: ReadonlyArray<string>;
  readonly day: string;
  readonly zone: string;
  readonly messages: ReadonlyArray<NotedMessage>;
  readonly syncedAt: string;
};

const KIND_WORDS: Readonly<Record<ChatKind, string>> = { oneOnOne: 'one-to-one', group: 'group', meeting: 'meeting' };

// A chat has no address of its own that Microsoft documents, and a message has: the day links to its
// first message, which opens the chat at that day.
const sourceOf = (input: DayNoteInput): string => {
  const link = input.messages.map((noted) => noted.message.webUrl).find((url) => url.length > 0);
  return link ?? 'Teams chat';
};

const fieldsOf = (input: DayNoteInput): ReadonlyArray<FrontMatterField> => [
  ['source', sourceOf(input)],
  ['chat', input.chat],
  ['kind', KIND_WORDS[input.kind]],
  ['members', input.members],
  ['day', input.day],
  ['messages', input.messages.length],
  ['synced_at', input.syncedAt],
];

const NOT_SAVED = '\\[picture not saved\\]';

const pictureText = (picture: PictureLink | undefined): string => (picture === undefined ? NOT_SAVED : `![picture](${linkDestination(picture.link)})`);

// Each picture goes where it stood in the message.
const withPictures = (noted: NotedMessage): string =>
  Array.from({ length: noted.message.pictures }, (_, at) => at).reduce((text, at) => text.replaceAll(pictureMarker(at), pictureText(noted.pictures[at])), noted.message.text);

const quoted = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');

// What OCR read goes under the message, not at the picture: a picture can stand in the middle of a
// sentence, and a quote there would cut the sentence in two.
const readings = (noted: NotedMessage): ReadonlyArray<string> =>
  noted.pictures.flatMap((picture, at) => {
    const text = picture?.text ?? '';
    return text.length === 0 ? [] : [[`Text in picture ${at + 1}:`, quoted(text)].join('\n\n')];
  });

// Link text ends at an unpaired bracket, and a file name can hold one.
const linkText = (name: string): string => name.replaceAll(/[[\]]/g, (bracket) => `\\${bracket}`);

const fileLine = (file: FileLine): string => {
  const named = file.link === undefined ? file.name : `[${linkText(file.name)}](${linkDestination(file.link)})`;
  return `- ${[named, ...(file.note === undefined ? [] : [file.note])].join(': ')}`;
};

const TIME_START = 'YYYY-MM-DD '.length;

// The hour is told where the knowledge base counts its days, the day being the note itself.
const heading = (message: ChatMessage, zone: string): string => `### ${timeIn(message.sent, zone).slice(TIME_START)} · ${message.author}`;

const messageBlock = (noted: NotedMessage, zone: string): string => {
  const text = withPictures(noted);
  const files = noted.files.map(fileLine).join('\n');
  return [heading(noted.message, zone), text, ...readings(noted), files].filter((part) => part.length > 0).join('\n\n');
};

// One day of one chat: who was in it, then each message under the hour it was written and who wrote
// it, with its pictures in their place and its files listed under it.
export const renderDayNote = (input: DayNoteInput): string =>
  withFrontMatter(renderFrontMatter(fieldsOf(input)), [`# ${input.chat}, ${input.day}`, ...input.messages.map((noted) => messageBlock(noted, input.zone))].join('\n\n'));
