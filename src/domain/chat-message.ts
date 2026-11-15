import { htmlToText } from './html-text.ts';

// A file shared in a chat: its name, and the address it is reached by at the source.
export type ChatFile = { readonly name: string; readonly url: string };

// One message of a Teams chat, as `list-teams-chat-history` answers for it. A chat has no threads and
// no subjects, so a message is who wrote it, when, and what it says.
export type ChatMessage = {
  readonly id: string;
  readonly author: string;
  readonly sent: string;
  // The words, with a marker where each pasted picture stood.
  readonly text: string;
  readonly files: ReadonlyArray<ChatFile>;
  // How many different pictures were pasted in it. The library hands them back in this order.
  readonly pictures: number;
  readonly webUrl: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

// What stands in the text where a pasted picture was, until the picture has a file to link to.
export const pictureMarker = (at: number): string => `[[picture ${at + 1}]]`;

const IMAGE = /<img\b([^<>]*)>/gi;
const SRC = /\bsrc="([^"]*)"/i;
const ALT = /\balt="([^"]*)"/i;
// How Teams marks a picture somebody pasted, and one of its own emoji.
const PASTED = 'itemtype="http://schema.skype.com/amsimage"';
const EMOJI = 'itemtype="http://schema.skype.com/emoji"';

type Marked = { readonly html: string; readonly pictures: number };

// The library reads the pictures of a message off the same tags: each different address once, in the
// order first met, with `&amp;` read as `&`. The markers are numbered the same way, so the nth marker
// is the nth picture it hands back.
const withMarkers = (html: string): Marked => {
  const sources: string[] = [];
  const marked = html.replace(IMAGE, (whole: string, attributes: string) => {
    const kind = attributes.toLowerCase();
    if (kind.includes(EMOJI)) return ALT.exec(attributes)?.[1] ?? '';
    if (!kind.includes(PASTED)) return whole;
    const source = SRC.exec(attributes)?.[1]?.replaceAll('&amp;', '&');
    if (source === undefined) return '';
    if (!sources.includes(source)) sources.push(source);
    return pictureMarker(sources.indexOf(source));
  });
  return { html: marked, pictures: sources.length };
};

// What Teams names a message typed with no formatting: its content is the words themselves.
const PLAIN = 'Text';

const filesOf = (raw: unknown): ReadonlyArray<ChatFile> => {
  const files = isRecord(raw) && Array.isArray(raw['files']) ? raw['files'] : [];
  return files.flatMap((file: unknown) => {
    const name = readString(file, 'name');
    return name === undefined ? [] : [{ name, url: readString(file, 'shareUrl') ?? readString(file, 'url') ?? '' }];
  });
};

type Body = { readonly text: string; readonly pictures: number };

const bodyOf = (raw: unknown): Body => {
  const content = readString(raw, 'content') ?? '';
  if (readString(raw, 'messagetype') === PLAIN) return { text: content.trim(), pictures: 0 };
  const marked = withMarkers(content);
  return { text: htmlToText(marked.html), pictures: marked.pictures };
};

const signedOf = (raw: unknown): Pick<ChatMessage, 'author' | 'sent' | 'webUrl'> => ({
  author: readString(raw, 'imdisplayname') ?? 'Unknown sender',
  sent: readString(raw, 'composetime') ?? readString(raw, 'originalarrivaltime') ?? '',
  webUrl: readString(raw, 'webUrl') ?? '',
});

// The HTML of a rich message as it goes to the markdown conversion: the markers and the emoji in
// place, since the converter drops a picture it is not told to keep. A message typed plain is the
// words themselves, and an entry of the client is not a message: neither has HTML to convert.
export const chatMessageHtml = (raw: unknown): string | undefined => {
  const content = readString(raw, 'content') ?? '';
  const plain = readString(raw, 'messagetype') === PLAIN || readString(raw, 'event') !== undefined;
  return plain || content.length === 0 ? undefined : withMarkers(content).html;
};

// An entry the client wrote (a call, a member added) carries an `event`. A message deleted in Teams
// stays in the history with nothing in it, and is left out the same way.
export const parseChatMessage = (raw: unknown): ChatMessage | undefined => {
  const id = readString(raw, 'id');
  if (id === undefined || readString(raw, 'event') !== undefined) return undefined;
  const body = bodyOf(raw);
  const files = filesOf(raw);
  if (body.text.length === 0 && files.length === 0 && body.pictures === 0) return undefined;
  return { id, ...signedOf(raw), ...body, files };
};
