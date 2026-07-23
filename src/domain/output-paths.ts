import { safeRelPath, safeSegment } from './kb-path.ts';

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

export const archivePath = (archiveRoot: string, libraryRoot: string, output: string): string =>
  output.startsWith(`${libraryRoot}/`) ? `${archiveRoot}/${output.slice(libraryRoot.length + 1)}` : `${archiveRoot}/${output}`;
