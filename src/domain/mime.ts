// A saved email, read out of the raw MIME a mail client writes. The library converts every other
// kind for us but has no parser for this one, and its passthrough hands back the file whole: a
// header block, the text in whatever encoding survived a 7-bit transport, and every attachment as
// base64 in the middle of it. What a reader wants is the message and the files as files.
import { HEADER_BREAK, decodeBytes, decodeHeader, decodeText, unfold } from './mime-text.ts';

type Headers = ReadonlyArray<string>;

const headerOf = (headers: Headers, name: string): string | undefined => {
  const prefix = `${name.toLowerCase()}:`;
  const found = headers.find((line) => line.toLowerCase().startsWith(prefix));
  return found === undefined ? undefined : decodeHeader(found.slice(prefix.length).trim());
};

// A parameter of a header, quoted or bare. One pattern per parameter rather than one built from a
// name: a quoted value may hold a semicolon, so splitting the header on `;` would cut it in half.
const BOUNDARY = /boundary\s*=\s*("[^"]*"|[^;\s]+)/i;
const FILENAME = /filename\s*=\s*("[^"]*"|[^;\s]+)/i;
const NAME = /\bname\s*=\s*("[^"]*"|[^;\s]+)/i;

const parameterOf = (header: string, pattern: RegExp): string | undefined => {
  const [value] = pattern.exec(header)?.slice(1, 2) ?? [];
  return value === undefined ? undefined : decodeHeader(value.replace(/^"|"$/g, ''));
};

export type MimePart = { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array };

export type MimeMessage = { readonly text: string; readonly parts: ReadonlyArray<MimePart> };

type Section = { readonly headers: Headers; readonly body: string };

const sectionOf = (raw: string): Section => {
  const found = HEADER_BREAK.exec(raw);
  if (found === null) return { headers: [], body: raw };
  return { headers: unfold(raw.slice(0, found.index)), body: raw.slice(found.index + found[0].length) };
};

// The parts between one boundary and the next. Split on the delimiter as the text it is: a boundary
// is chosen by the sending client and routinely carries `=`, `_`, `+` and `.`, which a pattern built
// around it would read as syntax of its own. The preamble before the first one and the epilogue
// after the last are what no client shows, so both ends go.
const splitParts = (body: string, boundary: string): ReadonlyArray<string> =>
  body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.replace(/^\r?\n/, ''))
    .filter((part) => part.trim().length > 0);

const contentTypeOf = (headers: Headers): string => headerOf(headers, 'content-type') ?? 'text/plain';

const kindOf = (headers: Headers): string => (contentTypeOf(headers).split(';')[0] ?? '').trim().toLowerCase();

const encodingOf = (headers: Headers): string => (headerOf(headers, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();

const EXTENSION_BY_KIND: Readonly<Partial<Record<string, string>>> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

// A part the message never named still has to land under something, and the kind is the only thing
// left to name it by.
const nameOf = (headers: Headers, at: number): string => {
  const named = parameterOf(headerOf(headers, 'content-disposition') ?? '', FILENAME) ?? parameterOf(contentTypeOf(headers), NAME);
  return named ?? `part-${at}.${EXTENSION_BY_KIND[kindOf(headers)] ?? 'bin'}`;
};

type Gathered = { readonly text: ReadonlyArray<string>; readonly parts: ReadonlyArray<MimePart> };

const gather = (section: Section, at: number): Gathered => {
  const boundary = parameterOf(contentTypeOf(section.headers), BOUNDARY);
  if (boundary !== undefined) return gatherParts(splitParts(section.body, boundary));
  if (kindOf(section.headers).startsWith('text/')) return { text: [decodeText(section.body, encodingOf(section.headers))], parts: [] };
  const bytes = decodeBytes(section.body, encodingOf(section.headers));
  return { text: [], parts: bytes === undefined || bytes.length === 0 ? [] : [{ name: nameOf(section.headers, at), contentType: kindOf(section.headers), bytes }] };
};

// A `multipart/alternative` offers the same message twice; the plain one is the one worth reading,
// and taking the first text at every level keeps that true however deep the nesting goes.
const gatherParts = (raws: ReadonlyArray<string>): Gathered => {
  const gathered = raws.map((raw, at) => gather(sectionOf(raw), at + 1));
  return { text: gathered.flatMap((one) => one.text).slice(0, 1), parts: gathered.flatMap((one) => one.parts) };
};

const HEADER_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Subject', 'subject'],
  ['From', 'from'],
  ['To', 'to'],
  ['Cc', 'cc'],
  ['Date', 'date'],
];

const headerBlock = (headers: Headers): ReadonlyArray<string> =>
  HEADER_ROWS.flatMap(([label, name]) => {
    const value = headerOf(headers, name);
    return value === undefined || value.length === 0 ? [] : [`**${label}:** ${value}`];
  });

// A transport writes every line ending as a carriage return and a newline. Markdown on disk here is
// written with newlines alone, so the pair is folded before the text ever reaches a file.
const asLines = (text: string): string => text.replace(/\r\n/g, '\n').trim();

export const readMime = (raw: string): MimeMessage => {
  const section = sectionOf(raw);
  const gathered = gather(section, 1);
  return { text: asLines([...headerBlock(section.headers), '', asLines(gathered.text.join('\n'))].join('\n')), parts: gathered.parts };
};
