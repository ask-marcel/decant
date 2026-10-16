import { dirname, normalize, relative } from 'node:path/posix';
import { memberFile } from './kb-path.ts';
import { linkDestination } from './markdown-link.ts';

// Each member of an archive and the file its text lands in.
export type PlacedMember<T> = { readonly entry: T; readonly file: string };

// Where each member of an archive unpacked into `folder` lands: under its own folders. A zip made of a
// folder holds every member in that folder, and the folder stays, because a library often holds the
// folder itself beside the zip: without it, each member would land on the file of the same name.
export const placeMembers = <T extends { readonly path: string }>(folder: string, entries: ReadonlyArray<T>, budget: number | undefined): ReadonlyArray<PlacedMember<T>> =>
  entries.map((entry) => ({ entry, file: memberFile(folder, entry.path, budget) }));

// The label of a link and the start of its destination, in each form the converter writes: text that
// escapes a bracket with a backslash, and the picture of a linked picture. A link starts neither in a
// picture, which `![` opens, nor at an escaped bracket, `\[`: the converter escapes each bracket of a
// log line, and a link that could start at each one read on to the end of the page from each.
const OPENING = /(?<![!\\])\[((?:[^[\]\\!]|\\.|!(?!\[)|!\[[^[\]]*\]\([^()\s[\]]*\))*)\]\(/g;
// The rest of a link from its destination on: bare, escaping each parenthesis with a backslash, or in
// angle brackets, then a title in quotes that escapes a quote, and the closing parenthesis. Read where
// an opening ends.
const REST = /(<[^<>\n]*>|(?:[^()\s<>\\]|\\.)*)(\s+"(?:[^"\\]|\\.)*")?\)/y;
// A backslash escape, which a destination can hold before a parenthesis.
const ESCAPE = /\\(.)/g;
// A destination that names its own scheme leaves the archive: a site, a mail address. Read as a path,
// the dot segments after its host could take the scheme and the host away.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// `decodeURIComponent` throws on a `%` that starts no escape and on an escape that makes no UTF-8. A
// pure-domain fallback (rule 17): such a destination is read as it is written, as a browser reads
// it, so `100%.html` names the member `100%.html`.
const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

// The path inside the archive a destination names, read from the folder of the member that links to
// it. An anchor or a path out of the archive names no member, so the lookup finds nothing for it. A
// root path is left as it is: it names the root of a site, which need not be the root of the archive.
const memberAt = (from: string, path: string): string => (path.startsWith('/') || SCHEME.test(path) ? '' : normalize(`${dirname(from)}/${decoded(path)}`));

// The path of a destination and its anchor. Its query goes: a file on disk takes none, and
// `week2.html.md?tab=2` opens nothing.
const partsOf = (destination: string): { readonly path: string; readonly anchor: string } => {
  const hash = destination.indexOf('#');
  const beforeAnchor = hash === -1 ? destination : destination.slice(0, hash);
  const query = beforeAnchor.indexOf('?');
  return { path: query === -1 ? beforeAnchor : beforeAnchor.slice(0, query), anchor: hash === -1 ? '' : destination.slice(hash) };
};

type Link = { readonly start: number; readonly end: number; readonly label: string; readonly written: string; readonly title: string };

// The whole link an opening starts, read on to its closing parenthesis, or none when no destination
// follows it.
const linkAt = (text: string, opening: RegExpExecArray): Link | undefined => {
  REST.lastIndex = opening.index + opening[0].length;
  const rest = REST.exec(text);
  return rest === null ? undefined : { start: opening.index, end: REST.lastIndex, label: opening[1] ?? '', written: rest[1] ?? '', title: rest[2] ?? '' };
};

const relinked = (text: string, link: Link, from: string, files: ReadonlyMap<string, string>): string => {
  const { path, anchor } = partsOf((link.written.startsWith('<') ? link.written.slice(1, -1) : link.written).replace(ESCAPE, '$1'));
  const target = files.get(memberAt(from, path));
  const own = files.get(from);
  return target === undefined || own === undefined ? text.slice(link.start, link.end) : `[${link.label}](${linkDestination(relative(dirname(own), target) + anchor)}${link.title})`;
};

// A page an archive holds links to the pages beside it by their own names, `week2.html`, and on disk
// each became its markdown, `week2.html.md`: a dead link in every page of a zipped report. A link that
// leads to another member is pointed at the file written for it. `files` maps each member's path
// inside the archive to that file, and `from` is the path of the member the text came from. An
// opening inside a link already read, in its title, is part of that link.
export const linkMembers = (text: string, from: string, files: ReadonlyMap<string, string>): string => {
  const parts: string[] = [];
  let done = 0;
  for (const opening of text.matchAll(OPENING)) {
    const link = opening.index < done ? undefined : linkAt(text, opening);
    if (link === undefined) continue;
    parts.push(text.slice(done, link.start), relinked(text, link, from, files));
    done = link.end;
  }
  parts.push(text.slice(done));
  return parts.join('');
};
