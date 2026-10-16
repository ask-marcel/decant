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

// A saved email as the parser reads it: each byte one character, so a header and a boundary read as
// the ASCII they are, a file keeps its bytes, and each text is decoded in the charset it names. In
// slices, since a message can run to megabytes and a call takes only so many arguments.
const SLICE = 0x8000;

export const byteString = (bytes: Uint8Array): string => {
  const slices: string[] = [];
  for (let at = 0; at < bytes.length; at += SLICE) slices.push(String.fromCharCode(...bytes.subarray(at, at + SLICE)));
  return slices.join('');
};

// The text bytes hold in a charset, or nothing when this runtime does not know the charset, or when a
// strict read finds bytes the charset has no place for.
const decodedAs = (bytes: Uint8Array, charset: string, fatal: boolean): string | undefined => {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes);
  } catch {
    return undefined;
  }
};

// The charsets that say nothing a fallback does not: ASCII, which 8-bit bytes break, and UTF-8, which
// a sender can claim for Latin-1.
const UNSAID: ReadonlySet<string> = new Set(['ascii', 'us-ascii', 'utf-8', 'utf8']);

// The text bytes hold in the charset a message names. One this runtime cannot decode, or one that
// says nothing more, reads as UTF-8 when the bytes are UTF-8 and as Windows-1252 when not: the two a
// mail client writes most, and Windows-1252 reads every byte as some character.
const decodeCharset = (bytes: Uint8Array, charset?: string): string => {
  const named = charset === undefined || UNSAID.has(charset.toLowerCase()) ? undefined : decodedAs(bytes, charset, false);
  return named ?? decodedAs(bytes, 'utf-8', true) ?? new TextDecoder('windows-1252').decode(bytes);
};

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
// form, quoted-printable with an underscore standing in for a space for the `Q` one, in the charset
// it names, which can carry a language after a star.
const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

const decodeWord = (charset: string, kind: string, body: string): string => {
  const raw = kind.toLowerCase() === 'b' ? decodeBase64Text(body) : decodeQuotedPrintable(body.replace(/_/g, ' '));
  return decodeCharset(bytesOf(raw), charset.split('*')[0]);
};

// A header as the message holds it, one byte a character: 8-bit text where a client wrote it raw,
// and encoded words, which are ASCII.
export const decodeHeader = (value: string): string =>
  decodeCharset(bytesOf(value)).replace(ENCODED_WORD, (_, charset: string, kind: string, body: string) => decodeWord(charset, kind, body));

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

export const decodeText = (body: string, encoding: string, charset?: string): string => {
  const bytes = decodeBytes(body, encoding);
  return bytes === undefined ? body : decodeCharset(bytes, charset);
};
