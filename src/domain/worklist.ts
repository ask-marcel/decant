import { extensionOf } from './conversion-plan.ts';
import type { DriveItem } from './drive-item.ts';
import type { RetryLedger } from './retry-policy.ts';
import { forgetSwept, givenUp } from './retry-policy.ts';
import { isBefore } from './sync-window.ts';

export type ManifestEntry = {
  readonly path: string;
  readonly cTag: string;
  readonly outputs: ReadonlyArray<string>;
};

export type Manifest = Readonly<Record<string, ManifestEntry>>;

export type WorkItem =
  | { readonly kind: 'convert'; readonly item: DriveItem }
  | { readonly kind: 'move'; readonly item: DriveItem; readonly from: string; readonly outputs: ReadonlyArray<string> }
  | { readonly kind: 'archive'; readonly itemId: string; readonly outputs: ReadonlyArray<string> };

// A Loop workspace keeps a `.pod` manifest beside its pages: its own bookkeeping, rewritten whenever a
// page changes, and nothing a reader can make a document of. Passed over like a folder, rather than
// reported as left out on every run that touched the workspace.
const MANIFEST_EXTENSION = 'pod';

const passedOver = (item: DriveItem): boolean => item.kind === 'folder' || extensionOf(item.name) === MANIFEST_EXTENSION;

// A file never filed that was last edited before the day is left out. One already filed is followed
// whatever its date, through a move or an edit, since leaving it would leave its documents stale.
const workFor = (item: DriveItem, known: ManifestEntry | undefined, since: string | undefined): WorkItem | undefined => {
  if (item.kind === 'deleted') return known === undefined ? undefined : { kind: 'archive', itemId: item.id, outputs: known.outputs };
  if (known === undefined) return passedOver(item) || isBefore(item.lastModified, since) ? undefined : { kind: 'convert', item };
  if (known.path !== item.path) return { kind: 'move', item, from: known.path, outputs: known.outputs };
  return known.cTag === item.cTag || passedOver(item) ? undefined : { kind: 'convert', item };
};

const retriedWork = (retry: RetryLedger, items: ReadonlyArray<DriveItem>): ReadonlyArray<WorkItem> =>
  Object.values(forgetSwept(retry, items))
    .filter((entry) => !givenUp(entry))
    .map((entry) => ({ kind: 'convert', item: entry.item }));

const sortKey = (work: WorkItem): string => (work.kind === 'archive' ? ` ${work.itemId}` : `${work.item.lastModified} ${work.item.id}`);

// Oldest change first, so a run stopped halfway resumes exactly where it left off, with the id as
// tie-break so two documents saved in the same second keep a stable order between runs. What failed
// last time is queued alongside, sorted by the same key: a retry is ordinary work, not a tail.
export const buildWorklist = (items: ReadonlyArray<DriveItem>, manifest: Manifest, retry: RetryLedger = {}, since?: string): ReadonlyArray<WorkItem> =>
  [...items.map((item) => workFor(item, manifest[item.id], since)).filter((work): work is WorkItem => work !== undefined), ...retriedWork(retry, items)].sort((left, right) =>
    sortKey(left).localeCompare(sortKey(right))
  );
