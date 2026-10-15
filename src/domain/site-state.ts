import type { Folders } from './drive-folders.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import type { RetryEntry, RetryLedger } from './retry-policy.ts';
import type { Manifest, ManifestEntry, WorkItem } from './worklist.ts';
import { undatedOutput } from './output-paths.ts';

// What one run leaves behind so the next one, or a restart after a stop, picks up exactly where it
// left off: the cursor Graph gave us, the queue still to process, what every item produced, and what
// could not be read. The last of those is not derivable from the others: the cursor has moved past a
// failed item, and a delta only reports what changed, so nothing but this record brings it back.
export type DriveState = {
  readonly name: string;
  readonly deltaLink?: string;
  // The day the cursor was taken reaching back to, absent when it reached everything. A run reaching
  // further back reads the library whole again. A file written before this reached everything.
  readonly since?: string;
  readonly pending: ReadonlyArray<WorkItem>;
  readonly items: Manifest;
  readonly retry: RetryLedger;
  // Each folder of the library by id, at its path. Absent from a state from before they were kept,
  // and the sync then reads the library whole once, to record them. Additive, so `STATE_VERSION` stays.
  readonly folders?: Folders;
};

export type SiteRef = { readonly id: string; readonly name: string; readonly webUrl: string };

export type SiteState = {
  readonly version: 1;
  readonly source: { readonly kind: 'site' } & SiteRef;
  readonly lastRun: string;
  readonly drives: Readonly<Record<string, DriveState>>;
  // The layout the documents on disk were filed in. Absent is the first one, under the day each
  // document last changed; `LIBRARY_LAYOUT` files them by their folders alone. Additive, so
  // `STATE_VERSION` stays: a file from before reads as the first layout, which is what it holds.
  readonly layout?: number;
};

export const LIBRARY_LAYOUT = 2;

export type SiteStateError = { readonly kind: 'malformed'; readonly message: string };

export const STATE_VERSION = 1;

export const emptySiteState = (site: SiteRef): SiteState => ({
  version: STATE_VERSION,
  source: { kind: 'site', ...site },
  lastRun: '',
  drives: {},
});

export const serializeSiteState = (state: SiteState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const parseSource = (raw: unknown): Result<SiteRef, SiteStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state has no source' });
  const id = readString(raw, 'id');
  const name = readString(raw, 'name');
  if (id === undefined || name === undefined) return err({ kind: 'malformed', message: 'source is missing id or name' });
  return ok({ id, name, webUrl: readString(raw, 'webUrl') ?? '' });
};

const parseManifest = (raw: unknown): Manifest => {
  if (!isRecord(raw)) return {};
  const pairs = Object.entries(raw).flatMap(([id, entry]) => (isRecord(entry) ? [[id, entryOf(entry)] as const] : []));
  return Object.fromEntries(pairs);
};

const entryOf = (entry: Record<string, unknown>): ManifestEntry => ({
  path: readString(entry, 'path') ?? '',
  cTag: readString(entry, 'cTag') ?? '',
  outputs: Array.isArray(entry['outputs']) ? entry['outputs'].filter((value): value is string => typeof value === 'string') : [],
  modified: readString(entry, 'modified'),
  modifiedBy: readString(entry, 'modifiedBy'),
});

// A queued item is trusted as written: this file is ours, and a half-written one is rejected whole
// by the JSON parse before it reaches here.
const parsePending = (raw: unknown): ReadonlyArray<WorkItem> => (Array.isArray(raw) ? (raw.filter(isRecord) as unknown as ReadonlyArray<WorkItem>) : []);

// Trusted as written, for the same reason the queue above is. A file from before failures were
// remembered carries no ledger at all and loads with an empty one, which is what it means.
const parseRetry = (raw: unknown): RetryLedger => (isRecord(raw) ? (Object.fromEntries(Object.entries(raw).filter(([, entry]) => isRecord(entry))) as unknown as RetryLedger) : {});

// Only the paths: a folder recorded as anything else is left out, and is recorded again the next
// time a sweep reports it.
const parseFolders = (raw: unknown): Folders | undefined =>
  isRecord(raw) && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;

const parseDrive = (raw: unknown): DriveState => {
  if (!isRecord(raw)) return { name: '', pending: [], items: {}, retry: {} };
  return {
    name: readString(raw, 'name') ?? '',
    deltaLink: readString(raw, 'deltaLink'),
    since: readString(raw, 'since'),
    pending: parsePending(raw['pending']),
    items: parseManifest(raw['items']),
    retry: parseRetry(raw['retry']),
    folders: parseFolders(raw['folders']),
  };
};

const parseDrives = (raw: unknown): Readonly<Record<string, DriveState>> =>
  isRecord(raw) ? Object.fromEntries(Object.entries(raw).map(([id, drive]) => [id, parseDrive(drive)])) : {};

export const parseSiteState = (raw: unknown): Result<SiteState, SiteStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = parseSource(raw['source']);
  if (!source.ok) return source;
  const layout = typeof raw['layout'] === 'number' ? raw['layout'] : undefined;
  return ok({ version: STATE_VERSION, source: { kind: 'site', ...source.value }, lastRun: readString(raw, 'lastRun') ?? '', drives: parseDrives(raw['drives']), layout });
};

export const countSyncedItems = (state: SiteState): number => Object.values(state.drives).reduce((total, drive) => total + Object.keys(drive.items).length, 0);

// Two sites can share a display name and so alias onto the same folder path. A freshly-created
// `emptySiteState(site)` always carries that same site's own id, so this only ever reads true when
// a state file genuinely loaded off disk belongs to a different site than the one being synced now.
export const belongsToAnotherSite = (state: SiteState, site: SiteRef): boolean => state.source.id !== site.id;

export const withDrive = (state: SiteState, driveId: string, drive: DriveState): SiteState => ({ ...state, drives: { ...state.drives, [driveId]: drive } });

export const recordItem = (drive: DriveState, itemId: string, entry: ManifestEntry): DriveState => ({ ...drive, items: { ...drive.items, [itemId]: entry } });

// Forgotten whole: an item the source no longer has owes nothing, neither an output to keep track of
// nor a conversion to try again.
export const forgetItem = (drive: DriveState, itemId: string): DriveState => {
  const remaining = Object.entries(drive.items).filter(([id]) => id !== itemId);
  return forgetFailure({ ...drive, items: Object.fromEntries(remaining) }, itemId);
};

// The files a document's record names that no other record holds. A document that took the path
// another one left, earlier in the same run, holds those files now: they are not the first one's to
// set aside.
export const ownOutputs = (drive: DriveState, itemId: string): ReadonlyArray<string> => {
  const outputs = drive.items[itemId]?.outputs ?? [];
  if (outputs.length === 0) return outputs;
  const others = new Set(
    Object.entries(drive.items)
      .filter(([id]) => id !== itemId)
      .flatMap(([, entry]) => entry.outputs)
  );
  return outputs.filter((output) => !others.has(output));
};

export const rememberFailure = (drive: DriveState, entry: RetryEntry): DriveState => ({ ...drive, retry: { ...drive.retry, [entry.item.id]: entry } });

export const forgetFailure = (drive: DriveState, itemId: string): DriveState => {
  const remaining = Object.entries(drive.retry).filter(([id]) => id !== itemId);
  return { ...drive, retry: Object.fromEntries(remaining) };
};

export type Refiled = { readonly drive: DriveState; readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string }> };

const WRITE_FAILED = 'write-failed';

// A library as the current layout files it, and the files to move to get there: each document out of
// the day folder the first layout filed it under, to the folders it has in SharePoint. A document
// that could not be written gets its tries back, since the commonest cause, a path too long for
// Windows, may no longer hold with the day folder gone.
export const refileDrive = (libraryRoot: string, drive: DriveState): Refiled => {
  const moves: { from: string; to: string }[] = [];
  const items = Object.fromEntries(
    Object.entries(drive.items).map(([id, entry]) => {
      const pairs = entry.outputs.map((from) => ({ from, to: undatedOutput(libraryRoot, entry.path, from) }));
      moves.push(...pairs.filter((pair) => pair.from !== pair.to));
      return [id, { ...entry, outputs: pairs.map((pair) => pair.to) }] as const;
    })
  );
  const retry = Object.fromEntries(Object.entries(drive.retry).map(([id, entry]) => [id, entry.reason.startsWith(WRITE_FAILED) ? { ...entry, attempts: 0 } : entry] as const));
  return { drive: { ...drive, items, retry }, moves };
};
