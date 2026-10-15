import { safeRelPath, safeSegment } from './kb-path.ts';

// An item filed by a day goes under that day: a task under the day it is due, a post under the day it
// was first posted. One with no day still needs somewhere to go, and a named folder says that
// plainly where an empty one would silently drop the file at the root.
const UNDATED = 'undated';

const DAY = /^\d{4}-\d{2}-\d{2}/;

export const datedRoot = (libraryRoot: string, lastModified: string): string => `${libraryRoot}/${DAY.test(lastModified) ? lastModified.slice(0, 10) : UNDATED}`;

// Every file produced for a document is named after it and sits in the folder mirroring its
// SharePoint folders.
export const outputPrefix = (libraryRoot: string, itemPath: string): string => {
  const segments = itemPath.split('/');
  const folders = safeRelPath(segments.slice(0, -1));
  const name = safeSegment(segments[segments.length - 1] ?? '');
  return folders.length === 0 ? `${libraryRoot}/${name}` : `${libraryRoot}/${folders}/${name}`;
};

// The folder the first layout filed a document's files under: the day it last changed, or `undated`.
const FIRST_LAYOUT_DAY = /^(\d{4}-\d{2}-\d{2}|undated)$/;

// A file the first layout filed under the day its document last changed, given back its place under
// the document's own SharePoint folders: `<library>/<day>/<folders>/<rest>` becomes
// `<library>/<folders>/<rest>`. Only the day goes, so a name cut to fit a Windows path, the pictures
// beside a note and the members of an archive keep theirs. Any other file stays where it is: one
// already in place is not moved again, though its SharePoint folder is named like a day.
export const undatedOutput = (libraryRoot: string, itemPath: string, output: string): string => {
  if (!output.startsWith(`${libraryRoot}/`)) return output;
  const [day = '', ...inside] = output.slice(libraryRoot.length + 1).split('/');
  if (inside.length === 0 || !FIRST_LAYOUT_DAY.test(day)) return output;
  const folders = safeRelPath(itemPath.split('/').slice(0, -1));
  const rest = inside.join('/');
  return folders.length === 0 || rest.startsWith(`${folders}/`) ? `${libraryRoot}/${rest}` : output;
};
