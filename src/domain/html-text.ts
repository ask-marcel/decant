// What an HTML body says, without the markup. Not a general converter: it keeps the words, the
// links and the lines, and drops everything else. Anything it does not know is stripped to its
// text, so an element it has never seen costs formatting rather than content. Used where the
// library offers no rendering of its own, which is a calendar event's body.

// What the browser reads and the reader does not: the head, a style sheet, a script, a comment.
const HIDDEN = /<(head|style|script)\b[^<>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi;
const IMAGE = /<img\b([^<>]*)>/gi;
const ANCHOR = /<a\b[^<>]*\bhref="([^"]*)"[^<>]*>([\s\S]*?)<\/a>/gi;
const LIST_ITEM = /<li\b[^<>]*>([\s\S]*?)<\/li>/gi;
const CELL_END = /<\/t[dh]>\s*(?=<t[dh]\b)/gi;
const BREAK = /<br\s*\/?>/gi;
// Elements that end a line when they close. The opening tag goes with the rest of the markup.
const BLOCK_END = /<\/(p|div|li|ul|ol|blockquote|pre|h[1-6]|tr|table|section|article|header|footer)>/gi;
// `[^<>]` rather than `[^>]`, so a run of `<` with no `>` after it fails at each one instead of
// rescanning to the end from every one: the same tag, without the quadratic worst case.
const ANY_TAG = /<[^<>]+>/g;
const BLANK_LINES = /\n{2,}/g;

const SRC = /\bsrc="([^"]*)"/i;
const ALT = /\balt="([^"]*)"/i;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// A reference by number or by name, read in one pass: what one decodes to is text, never another
// reference to read again, so `&#38;amp;` reads `&amp;`, as HTML reads it.
const REFERENCE = /&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi;

// What HTML reads a number as: none for zero, a surrogate half or a number past Unicode, which read as
// the replacement character, and for 128 to 159 the character of that byte in windows-1252, which is
// what a page that wrote one meant. `String.fromCodePoint` throws past Unicode, and that stopped the
// run that read the body.
const REPLACEMENT = '\uFFFD';
const WINDOWS_1252 = new TextDecoder('windows-1252');

const isSurrogate = (point: number): boolean => point >= 0xd800 && point <= 0xdfff;

const characterOf = (point: number): string => {
  if (point === 0 || point > 0x10ffff || isSurrogate(point)) return REPLACEMENT;
  return point >= 0x80 && point <= 0x9f ? WINDOWS_1252.decode(Uint8Array.of(point)) : String.fromCodePoint(point);
};

const pointOf = (code: string): number => (code.toLowerCase().startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10));

const referenceOf = (match: string, code: string | undefined, name: string | undefined): string => {
  if (code !== undefined) return characterOf(pointOf(code));
  return ENTITIES[(name ?? '').toLowerCase()] ?? match;
};

const decodeEntities = (text: string): string => text.replace(REFERENCE, referenceOf);

// A picture reads as a link to itself, named by its alt text when it has one: the bytes are not
// here, and a bare `[image]` says less than where it was. A picture the body carried itself is named
// by a `cid:` reference into a mail no reader has, so it reads as text naming it, the way a mail
// writes one: by its alt text, or by the name before the `@` of its reference.
const CID = /^cid:([^@]*)/i;

const imageLink = (whole: string, attributes: string): string => {
  const src = SRC.exec(attributes)?.[1];
  if (src === undefined) return whole;
  const alt = ALT.exec(attributes)?.[1] ?? '';
  const carried = CID.exec(src)?.[1];
  if (carried !== undefined) return `\\[inline image: ${[alt, carried].find((name) => name.length > 0) ?? 'image'}\\]`;
  return `[${alt.length > 0 ? alt : 'image'}](${src})`;
};

// A link's text on one line: a break or a block in it reads as a space, the rest of its markup goes,
// a picture in it reads as its alt text, and white space folds, a space or a line break written as a
// reference too. The link is written before the breaks become lines, and a link whose text ran over
// two lines reached a reader that takes the note a line at a time, as an agent or a search does, in
// two halves. A link with no text left reads as its address.
const WHITE_SPACE = /\s+/g;
const SPACE_LIKE = /&(?:nbsp|#(x[0-9a-f]+|\d+));/gi;
const BLANK = /^\s$/;

const spaceOrKept = (match: string, code: string | undefined): string => (code === undefined || BLANK.test(characterOf(pointOf(code))) ? ' ' : match);

const linkOf = (_whole: string, href: string, inner: string): string => {
  const text = inner
    .replace(IMAGE, (_image, attributes: string) => ALT.exec(attributes)?.[1] ?? '')
    .replace(BREAK, ' ')
    .replace(BLOCK_END, ' ')
    .replace(ANY_TAG, '')
    .replace(SPACE_LIKE, spaceOrKept)
    .replace(WHITE_SPACE, ' ')
    .trim();
  return `[${text.length > 0 ? text : href}](${href})`;
};

// Order matters: the constructs that keep something (a link, a picture, a list item, a table cell)
// are rewritten first, while their tags are still there to recognise them by, and only then is
// every remaining tag stripped.
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(HIDDEN, '')
      .replace(ANCHOR, linkOf)
      .replace(IMAGE, imageLink)
      .replace(LIST_ITEM, '- $1\n')
      .replace(CELL_END, ' | ')
      .replace(BREAK, '\n')
      .replace(BLOCK_END, '\n')
      .replace(ANY_TAG, '')
  )
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(BLANK_LINES, '\n')
    .trim();
