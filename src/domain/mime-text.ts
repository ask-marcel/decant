// The encodings a mail transport forces on a message on its way through. A header holds nothing but
// ASCII, and a body was long assumed to hold nothing but 7-bit, so a subject in any other script, a
// file name, and every attachment arrive wrapped in one of these and mean nothing until unwrapped.

export const HEADER_BREAK = /\r?\n\r?\n/;

const NEWLINE = /\r?\n/;

// A header continued on a line that opens with a space or a tab, the same folding iCalendar uses.
const FOLD = /^[ \t]/;

export const unfold = (block: string): ReadonlyArray<string> =>
  block.split(NEWLINE).reduce<string[]>((lines, line) => {
    const previous = lines[lines.length - 1];
    if (previous === undefined || !FOLD.test(line)) return [...lines, line];
    return [...lines.slice(0, -1), `${previous} ${line.trim()}`];
  }, []);

const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.codePointAt(0) ?? 0);

const decodeBase64Text = (body: string): string => {
  try {
    return atob(body);
  } catch {
    return body;
  }
};

const decodeQuotedPrintable = (body: string): string =>
  body.replace(/=\r?\n/g, '').replace(/=([\dA-Fa-f]{2})/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

// A subject or a file name in any other script travels as `=?utf-8?B?...?=`: base64 for the `B`
// form, quoted-printable with an underscore standing in for a space for the `Q` one.
const ENCODED_WORD = /=\?[^?]+\?([BbQq])\?([^?]*)\?=/g;

const decodeWord = (kind: string, body: string): string => {
  const raw = kind.toLowerCase() === 'b' ? decodeBase64Text(body) : decodeQuotedPrintable(body.replace(/_/g, ' '));
  return new TextDecoder().decode(bytesOf(raw));
};

export const decodeHeader = (value: string): string => value.replace(ENCODED_WORD, (_, kind: string, body: string) => decodeWord(kind, body));

// The bytes a part really holds. Base64 is the only encoding that hides them; the rest are text the
// transport left readable, so they are taken as the characters they are.
export const decodeBytes = (body: string, encoding: string): Uint8Array | undefined => {
  if (encoding !== 'base64') return bytesOf(encoding === 'quoted-printable' ? decodeQuotedPrintable(body) : body);
  try {
    return Uint8Array.from(atob(body.replace(/\s+/g, '')), (character) => character.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
};

export const decodeText = (body: string, encoding: string): string => {
  const bytes = decodeBytes(body, encoding);
  return bytes === undefined ? body : new TextDecoder().decode(bytes);
};
