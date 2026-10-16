import { dirname, normalize, relative } from 'node:path/posix';
import { memberFile } from './kb-path.ts';
import { linkDestination } from './markdown-link.ts';

// Each member of an archive and the file its text lands in.
export type PlacedMember<T> = { readonly entry: T; readonly file: string };

// How much of each member's path is the folder every member sits in, when that folder is named for
// the archive: zipping a folder whole makes one, and unpacked beside the archive it only repeats the
// archive's name. The archive is routed by its extension, so its name has one to cut.
const sharedTopLength = (archiveName: string, paths: ReadonlyArray<string>): number => {
  const top = `${archiveName.slice(0, archiveName.lastIndexOf('.'))}/`.toLowerCase();
  return paths.every((path) => path.toLowerCase().startsWith(top)) ? top.length : 0;
};

// Where each member of an archive unpacked into `folder` lands: under its own folders, less the one
// every member shares when it is named for the archive.
export const placeMembers = <T extends { readonly path: string }>(
  folder: string,
  archiveName: string,
  entries: ReadonlyArray<T>,
  budget: number | undefined
): ReadonlyArray<PlacedMember<T>> => {
  const cut = sharedTopLength(
    archiveName,
    entries.map((entry) => entry.path)
  );
  return entries.map((entry) => ({ entry, file: memberFile(folder, entry.path.slice(cut), budget) }));
};

// A link and not a picture, its destination bare or in angle brackets. `[^[\]]` and `[^()]` rather
// than open classes, so a run of brackets with no close fails at each one instead of rescanning.
const LINK = /(?<!!)\[([^[\]]*)\]\((<[^<>]*>|[^()\s<>]*)\)/g;
// Where the path of a destination stops: its anchor or its query, which go along as they are.
const SUFFIX = /[?#]/;

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
// it. A site, a mail address, an anchor or a path out of the archive names no member, so the lookup
// finds nothing for it. A root path is left as it is: it names the root of a site, which need not be
// the root of the archive.
const memberAt = (from: string, path: string): string => (path.startsWith('/') ? '' : normalize(`${dirname(from)}/${decoded(path)}`));

const relinked = (whole: string, label: string, written: string, from: string, files: ReadonlyMap<string, string>): string => {
  const destination = written.startsWith('<') ? written.slice(1, -1) : written;
  const cut = destination.search(SUFFIX);
  const end = cut === -1 ? destination.length : cut;
  const target = files.get(memberAt(from, destination.slice(0, end)));
  const own = files.get(from);
  return target === undefined || own === undefined ? whole : `[${label}](${linkDestination(relative(dirname(own), target) + destination.slice(end))})`;
};

// A page an archive holds links to the pages beside it by their own names, `week2.html`, and on disk
// each became its markdown, `week2.html.md`: a dead link in every page of a zipped report. A link that
// leads to another member is pointed at the file written for it. `files` maps each member's path
// inside the archive to that file, and `from` is the path of the member the text came from.
export const linkMembers = (text: string, from: string, files: ReadonlyMap<string, string>): string =>
  text.replace(LINK, (whole, label: string, written: string) => relinked(whole, label, written, from, files));
