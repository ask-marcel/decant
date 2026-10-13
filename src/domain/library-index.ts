import { indexDay, relativeTo, renderIndexPage } from './index-page.ts';
import { outputPrefix } from './output-paths.ts';
import type { DriveState } from './site-state.ts';
import { compareText } from './utilities/compare-text.ts';
import type { ManifestEntry } from './worklist.ts';

// The note a document reads as: the markdown named after it, or the first markdown it produced when a
// name was cut to fit the path, or what it produced at all.
const noteOf = (libraryRoot: string, entry: ManifestEntry): string => {
  const named = `${outputPrefix(libraryRoot, entry.path)}.md`;
  return entry.outputs.includes(named) ? named : (entry.outputs.find((output) => output.endsWith('.md')) ?? entry.outputs[0] ?? '');
};

// A library as a reader scans it: the document changed last first, under the day it changed, by its
// path in SharePoint and who changed it. Two documents changed at one moment keep the order of their
// paths, so the page does not change between runs that changed nothing. A document that produced no
// file, one skipped for its size or kind, has no line.
export const libraryIndexPage = (libraryName: string, libraryRoot: string, drive: DriveState | undefined, zone: string): string => {
  const rows = Object.values(drive?.items ?? {})
    .filter((entry) => entry.outputs.length > 0)
    .toSorted((left, right) => compareText(right.modified ?? '', left.modified ?? '') || compareText(left.path, right.path))
    .map((entry) => ({ day: indexDay(entry.modified ?? '', zone), title: entry.path, file: relativeTo(libraryRoot, noteOf(libraryRoot, entry)), note: entry.modifiedBy ?? '' }));
  return renderIndexPage(libraryName, [{ heading: 'By last change', rows }]);
};
