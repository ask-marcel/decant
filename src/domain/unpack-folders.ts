import { basename, dirname } from 'node:path/posix';
import type { ConversionRoute } from './conversion-plan.ts';
import { planFile } from './conversion-plan.ts';
import { safeSegment } from './kb-path.ts';
import type { ManifestEntry } from './worklist.ts';
import type { DriveState, Refiled } from './site-state.ts';

const MARKDOWN = '.md';

// The kinds a library unpacks into a folder of their own.
const routeOf = (path: string): ConversionRoute | undefined => {
  const decision = planFile({ name: basename(path), size: 0 }, Number.POSITIVE_INFINITY);
  return decision.kind === 'process' && (decision.route === 'archive' || decision.route === 'message') ? decision.route : undefined;
};

// The folder an archive or a saved email unpacked into, as the first archive layout named it and as this
// one names it: `<folder>/Livraison/` and `<folder>/Livraison.zip/`. Read off the file the conversion
// wrote first, the archive itself (`…/Livraison.zip`) or the message (`…/Fwd.eml.md`), so a name decant
// made safe or cut to fit a path keeps what was done to it.
const foldersOf = (route: ConversionRoute, first: string): { readonly from: string; readonly to: string } => {
  const written = basename(first);
  const name = route === 'message' ? written.slice(0, -MARKDOWN.length) : written;
  const parent = dirname(dirname(first));
  return { from: `${parent}/${safeSegment(name.slice(0, name.lastIndexOf('.')))}`, to: `${parent}/${name}` };
};

const unpackEntry = (entry: ManifestEntry, moves: { from: string; to: string }[]): ManifestEntry => {
  const route = routeOf(entry.path);
  const first = entry.outputs[0];
  if (route === undefined || first === undefined) return entry;
  const { from, to } = foldersOf(route, first);
  const pairs = entry.outputs.map((output) => ({ from: output, to: output.startsWith(`${from}/`) ? `${to}${output.slice(from.length)}` : output }));
  moves.push(...pairs.filter((pair) => pair.from !== pair.to));
  return { ...entry, outputs: pairs.map((pair) => pair.to) };
};

// A library as this archive layout files it, and the files to move to get there: each archive and saved
// email out of the folder named for it less its extension, which a library folder of that name could
// share, into the folder named for the whole file. A file already there stays where it is.
export const unpackDrive = (drive: DriveState): Refiled => {
  const moves: { from: string; to: string }[] = [];
  const items = Object.fromEntries(Object.entries(drive.items).map(([id, entry]) => [id, unpackEntry(entry, moves)] as const));
  return { drive: { ...drive, items }, moves };
};
