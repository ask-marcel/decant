import { extensionOf } from './conversion-plan.ts';
import { goneItem } from './drive-item.ts';
import type { DriveItem } from './drive-item.ts';
import type { RetryLedger } from './retry-policy.ts';
import { forgetSwept, givenUp } from './retry-policy.ts';
import { isBefore } from './sync-window.ts';
import { compareText } from './utilities/compare-text.ts';

export type ManifestEntry = {
  readonly path: string;
  readonly cTag: string;
  readonly outputs: ReadonlyArray<string>;
  // When the document last changed and who changed it, which the library page lists it by. Absent
  // from a document converted before they were kept, until it changes.
  readonly modified?: string;
  readonly modifiedBy?: string;
};

export type Manifest = Readonly<Record<string, ManifestEntry>>;

export type WorkItem = { readonly kind: 'convert'; readonly item: DriveItem } | { readonly kind: 'archive'; readonly itemId: string; readonly outputs: ReadonlyArray<string> };

// A Loop workspace keeps a `.pod` manifest beside its pages: its own bookkeeping, rewritten whenever a
// page changes, and nothing a reader can make a document of. Passed over like a folder, rather than
// reported as left out on every run that touched the workspace.
const MANIFEST_EXTENSION = 'pod';

const passedOver = (item: DriveItem): boolean => item.kind === 'folder' || extensionOf(item.name) === MANIFEST_EXTENSION;

// A file never filed that was last edited before the day is left out. One already filed is followed
// whatever its date, through a move or an edit, since leaving it would leave its documents stale. A
// file renamed or moved is converted again at its new place: its files say where it is, in the front
// matter and in the links to its pictures, and files only moved went on naming the place it left.
const workFor = (item: DriveItem, known: ManifestEntry | undefined, since: string | undefined): WorkItem | undefined => {
  if (item.kind === 'deleted') return known === undefined ? undefined : { kind: 'archive', itemId: item.id, outputs: known.outputs };
  if (passedOver(item)) return undefined;
  if (known === undefined) return isBefore(item.lastModified, since) ? undefined : { kind: 'convert', item };
  return known.cTag === item.cTag && known.path === item.path ? undefined : { kind: 'convert', item };
};

// What the ledger still holds decides for its documents: one with tries left is converted again, as
// the sweep holds it when the sweep listed it, and one out of tries is left alone.
const retriedWork = (owed: RetryLedger, items: ReadonlyArray<DriveItem>): ReadonlyArray<WorkItem> => {
  const listed = new Map(items.map((item) => [item.id, item]));
  return Object.values(owed)
    .filter((entry) => !givenUp(entry))
    .map((entry) => ({ kind: 'convert', item: listed.get(entry.item.id) ?? entry.item }));
};

const sortKey = (work: WorkItem): string => (work.kind === 'archive' ? ` ${work.itemId}` : `${work.item.lastModified} ${work.item.id}`);

// Oldest change first, so a run stopped halfway resumes exactly where it left off, with the id as
// tie-break so two documents saved in the same second keep a stable order between runs. What failed
// last time is queued alongside, sorted by the same key: a retry is ordinary work, not a tail.
export const buildWorklist = (items: ReadonlyArray<DriveItem>, manifest: Manifest, retry: RetryLedger = {}, since?: string): ReadonlyArray<WorkItem> => {
  const owed = forgetSwept(retry, items);
  const swept = items
    .filter((item) => owed[item.id] === undefined)
    .map((item) => workFor(item, manifest[item.id], since))
    .filter((work): work is WorkItem => work !== undefined);
  return [...swept, ...retriedWork(owed, items)].sort((left, right) => compareText(sortKey(left), sortKey(right)));
};

// A whole read of a library lists every document it holds. One recorded, or waiting on a retry, that
// the read does not list was deleted at a time no delta told of, so it goes as one a sweep reports
// deleted: its files under the archive, its retry dropped.
export const goneFromListing = (items: ReadonlyArray<DriveItem>, manifest: Manifest, retry: RetryLedger): ReadonlyArray<DriveItem> => {
  const listed = new Set(items.map((item) => item.id));
  return [...new Set([...Object.keys(manifest), ...Object.keys(retry)])].filter((id) => !listed.has(id)).map(goneItem);
};
