import type { DriveItem } from './drive-item.ts';
import type { RetryLedger } from './retry-policy.ts';
import { forgetSwept, givenUp } from './retry-policy.ts';

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

const workFor = (item: DriveItem, known: ManifestEntry | undefined): WorkItem | undefined => {
  if (item.kind === 'deleted') return known === undefined ? undefined : { kind: 'archive', itemId: item.id, outputs: known.outputs };
  if (known === undefined) return item.kind === 'folder' ? undefined : { kind: 'convert', item };
  if (known.path !== item.path) return { kind: 'move', item, from: known.path, outputs: known.outputs };
  return known.cTag === item.cTag || item.kind === 'folder' ? undefined : { kind: 'convert', item };
};

const retriedWork = (retry: RetryLedger, items: ReadonlyArray<DriveItem>): ReadonlyArray<WorkItem> =>
  Object.values(forgetSwept(retry, items))
    .filter((entry) => !givenUp(entry))
    .map((entry) => ({ kind: 'convert', item: entry.item }));

const sortKey = (work: WorkItem): string => (work.kind === 'archive' ? ` ${work.itemId}` : `${work.item.lastModified} ${work.item.id}`);

// Oldest change first, so a run stopped halfway resumes exactly where it left off, with the id as
// tie-break so two documents saved in the same second keep a stable order between runs. What failed
// last time is queued alongside, sorted by the same key: a retry is ordinary work, not a tail.
export const buildWorklist = (items: ReadonlyArray<DriveItem>, manifest: Manifest, retry: RetryLedger = {}): ReadonlyArray<WorkItem> =>
  [...items.map((item) => workFor(item, manifest[item.id])).filter((work): work is WorkItem => work !== undefined), ...retriedWork(retry, items)].sort((left, right) =>
    sortKey(left).localeCompare(sortKey(right))
  );
