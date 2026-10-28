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
