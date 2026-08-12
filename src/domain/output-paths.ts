import { safeRelPath, safeSegment } from './kb-path.ts';

// A document is filed under the day it last changed, so the knowledge base reads in the order things
// happened rather than in the order SharePoint's folders happen to be arranged. Its folders are kept
// underneath that day: they are what holds two same-named documents apart, and they say where the
// document lived. A source that gave no date still needs somewhere to go, and a named folder says
// that plainly where an empty one would silently drop the file at the library root.
const UNDATED = 'undated';

const DAY = /^\d{4}-\d{2}-\d{2}/;

export const datedRoot = (libraryRoot: string, lastModified: string): string => `${libraryRoot}/${DAY.test(lastModified) ? lastModified.slice(0, 10) : UNDATED}`;

// Every file produced for a document is named after it and sits in the folder mirroring its
// SharePoint folders, so a rename is a prefix swap rather than a reconversion.
export const outputPrefix = (libraryRoot: string, itemPath: string): string => {
  const segments = itemPath.split('/');
  const folders = safeRelPath(segments.slice(0, -1));
  const name = safeSegment(segments[segments.length - 1] ?? '');
  return folders.length === 0 ? `${libraryRoot}/${name}` : `${libraryRoot}/${folders}/${name}`;
};

export const remapOutputs = (outputs: ReadonlyArray<string>, from: string, to: string): ReadonlyArray<string> =>
  outputs.map((output) => (output.startsWith(from) ? `${to}${output.slice(from.length)}` : output));

// Where a document's files sat can no longer be worked out from its source path, since the path now
// carries the day it last changed and a rename can change that day. It is still recoverable from the
// files themselves: each one is the document's name plus a suffix (`.md`, `.pdf`, or nothing), so the
// prefix to swap is everything up to and including the last time that name appears.
export const recordedPrefix = (output: string, name: string): string => {
  const at = output.lastIndexOf(name);
  return at < 0 ? output : output.slice(0, at + name.length);
};

export const archivePath = (archiveRoot: string, libraryRoot: string, output: string): string =>
  output.startsWith(`${libraryRoot}/`) ? `${archiveRoot}/${output.slice(libraryRoot.length + 1)}` : `${archiveRoot}/${output}`;
