import type { ChatMessage } from './chat-message.ts';

// A Teams message is HTML, and the library converts an HTML file to markdown: a quote stays a quote,
// a table a table. A conversion is a process to start, so the messages of one read go to it together,
// as one document, and what comes back is cut into the messages again.

// One document to convert, and which of the messages asked about each of its sections is.
export type ConversionPart = { readonly html: string; readonly at: ReadonlyArray<number> };

// What stands before each message in the document, alone in a paragraph. Letters and digits only, so
// the converter hands it back as it was written.
const boundary = (at: number): string => `decantmessage${at}boundary`;

// A line of the markdown that is a boundary and nothing else.
const BOUNDARY_LINE = /^decantmessage(\d+)boundary[ \t]*$/m;

const HEADING_START = /<h[1-6]\b[^<>]*>/gi;
const HEADING_END = /<\/h[1-6]>/gi;

// A heading typed in a message would stand above the heading of the message itself in the note.
const withoutHeadings = (html: string): string => html.replace(HEADING_START, '<p><strong>').replace(HEADING_END, '</strong></p>');

const LINK_TAG = /<a\b[^<>]*>/gi;
const TITLE = /\stitle="([^"]*)"/i;
const HREF = /\shref="([^"]*)"/i;

// Teams gives a link its own address as its title, and the converter would write the address twice.
const withoutEchoedTitle = (tag: string): string => (TITLE.exec(tag)?.[1] === HREF.exec(tag)?.[1] ? tag.replace(TITLE, '') : tag);

const prepared = (html: string): string => withoutHeadings(html).replace(LINK_TAG, withoutEchoedTitle);

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

type Section = { readonly at: number; readonly html: string; readonly bytes: number };

type Group = { readonly sections: ReadonlyArray<Section>; readonly bytes: number };

// A message joins the last group while the group stays under the limit, and starts one otherwise: a
// message larger than the limit is then alone in its group.
const grouped = (groups: ReadonlyArray<Group>, section: Section, limit: number): ReadonlyArray<Group> => {
  const last = groups.at(-1);
  if (last === undefined || last.bytes + section.bytes > limit) return [...groups, { sections: [section], bytes: section.bytes }];
  return [...groups.slice(0, -1), { sections: [...last.sections, section], bytes: last.bytes + section.bytes }];
};

const partOf = (group: Group): ConversionPart => ({
  html: group.sections.map((section, place) => `<p>${boundary(place)}</p>\n${section.html}\n`).join(''),
  at: group.sections.map((section) => section.at),
});

// The library reads an HTML file above a size as plain text, so a long read goes in parts under
// `limit` bytes. A message with no HTML, one typed plain, is in no part.
export const conversionParts = (htmls: ReadonlyArray<string | undefined>, limit: number): ReadonlyArray<ConversionPart> =>
  htmls
    .flatMap((html, at) => (html === undefined ? [] : [{ at, html: prepared(html) }]))
    .map((section) => ({ ...section, bytes: bytesOf(section.html) }))
    .reduce<ReadonlyArray<Group>>((groups, section) => grouped(groups, section, limit), [])
    .map(partOf);

const ESCAPED_MARKER = /\\\[\\\[picture (\d+)\\\]\\\]/g;

// The converter puts a backslash on each bracket of a picture marker.
const tidied = (markdown: string): string => markdown.trim().replace(ESCAPED_MARKER, '[[picture $1]]');

// Cut at the boundaries, the markdown is what stood before the first one, then a number and a
// section for each boundary. It is given back only when it holds each boundary of the part once, in
// order, and nothing before the first: anything else is not the document that went in.
export const partMarkdown = (part: ConversionPart, markdown: string): ReadonlyArray<string> | undefined => {
  const [before = '', ...rest] = markdown.split(BOUNDARY_LINE);
  const numbers = rest.filter((_, place) => place % 2 === 0);
  const sections = rest.filter((_, place) => place % 2 === 1);
  const inOrder = numbers.length === part.at.length && numbers.every((number, place) => number === String(place));
  return before.trim().length === 0 && inOrder ? sections.map(tidied) : undefined;
};

// A message with nothing converted for it keeps the words read off its HTML.
export const withMarkdown = (message: ChatMessage, markdown: string | undefined): ChatMessage =>
  markdown === undefined || markdown.length === 0 ? message : { ...message, text: markdown };
