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
const NUMERIC = /&#(x[0-9a-f]+|\d+);/gi;
const NAMED = /&([a-z]+);/gi;

const decodeNumeric = (match: string, code: string): string => {
  const point = code.toLowerCase().startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
  return Number.isFinite(point) ? String.fromCodePoint(point) : match;
};

const decodeEntities = (text: string): string => text.replace(NUMERIC, decodeNumeric).replace(NAMED, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);

// A picture reads as a link to itself, named by its alt text when it has one: the bytes are not
// here, and a bare `[image]` says less than where it was.
const imageLink = (whole: string, attributes: string): string => {
  const src = SRC.exec(attributes)?.[1];
  if (src === undefined) return whole;
  const alt = ALT.exec(attributes)?.[1] ?? '';
  return `[${alt.length > 0 ? alt : 'image'}](${src})`;
};

// Order matters: the constructs that keep something (a link, a picture, a list item, a table cell)
// are rewritten first, while their tags are still there to recognise them by, and only then is
// every remaining tag stripped.
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(HIDDEN, '')
      .replace(ANCHOR, '[$2]($1)')
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
