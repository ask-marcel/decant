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
  const inTop = (path: string): boolean => path.length > top.length && path.slice(0, top.length).toLowerCase() === top;
  return paths.length > 0 && paths.every(inTop) ? top.length : 0;
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
// A destination that names its own scheme leaves the archive: a site, a mail address.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Where the path of a destination stops: its anchor or its query, which go along as they are.
const SUFFIX = /[?#]/;

// `decodeURIComponent` throws on an escape that makes no UTF-8. A pure-domain fallback (rule 17): a
// destination that does not decode names no member, and its link stays as it was.
const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return '';
  }
};

// The member a destination names, by its path inside the archive, read from the folder of the member
// that links to it; empty for a site, an anchor, a root path or a path out of the archive.
const memberAt = (from: string, path: string): string => {
  if (path.length === 0 || SCHEME.test(path) || path.startsWith('/')) return '';
  const inside = normalize(`${dirname(from)}/${decoded(path)}`);
  return inside.startsWith('../') ? '' : inside;
};

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
