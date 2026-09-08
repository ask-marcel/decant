import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import type { RetryEntry, RetryLedger } from './retry-policy.ts';
import type { Manifest, ManifestEntry, WorkItem } from './worklist.ts';

// What one run leaves behind so the next one, or a restart after a stop, picks up exactly where it
// left off: the cursor Graph gave us, the queue still to process, what every item produced, and what
// could not be read. The last of those is not derivable from the others: the cursor has moved past a
// failed item, and a delta only reports what changed, so nothing but this record brings it back.
export type DriveState = {
  readonly name: string;
  readonly deltaLink?: string;
  readonly pending: ReadonlyArray<WorkItem>;
  readonly items: Manifest;
  readonly retry: RetryLedger;
};

export type SiteRef = { readonly id: string; readonly name: string; readonly webUrl: string };

export type SiteState = {
  readonly version: 1;
  readonly source: { readonly kind: 'site' } & SiteRef;
  readonly lastRun: string;
  readonly drives: Readonly<Record<string, DriveState>>;
};

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
});

// A queued item is trusted as written: this file is ours, and a half-written one is rejected whole
// by the JSON parse before it reaches here.
const parsePending = (raw: unknown): ReadonlyArray<WorkItem> => (Array.isArray(raw) ? (raw.filter(isRecord) as unknown as ReadonlyArray<WorkItem>) : []);

// Trusted as written, for the same reason the queue above is. A file from before failures were
// remembered carries no ledger at all and loads with an empty one, which is what it means.
const parseRetry = (raw: unknown): RetryLedger => (isRecord(raw) ? (Object.fromEntries(Object.entries(raw).filter(([, entry]) => isRecord(entry))) as unknown as RetryLedger) : {});

const parseDrive = (raw: unknown): DriveState => {
  if (!isRecord(raw)) return { name: '', pending: [], items: {}, retry: {} };
  return {
    name: readString(raw, 'name') ?? '',
    deltaLink: readString(raw, 'deltaLink'),
    pending: parsePending(raw['pending']),
    items: parseManifest(raw['items']),
    retry: parseRetry(raw['retry']),
  };
};

const parseDrives = (raw: unknown): Readonly<Record<string, DriveState>> =>
  isRecord(raw) ? Object.fromEntries(Object.entries(raw).map(([id, drive]) => [id, parseDrive(drive)])) : {};

export const parseSiteState = (raw: unknown): Result<SiteState, SiteStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = parseSource(raw['source']);
  if (!source.ok) return source;
  return ok({ version: STATE_VERSION, source: { kind: 'site', ...source.value }, lastRun: readString(raw, 'lastRun') ?? '', drives: parseDrives(raw['drives']) });
};

export const countSyncedItems = (state: SiteState): number => Object.values(state.drives).reduce((total, drive) => total + Object.keys(drive.items).length, 0);

// Two sites can share a display name and so alias onto the same folder path. A freshly-created
// `emptySiteState(site)` always carries that same site's own id, so this only ever reads true when
// a state file genuinely loaded off disk belongs to a different site than the one being synced now.
export const belongsToAnotherSite = (state: SiteState, site: SiteRef): boolean => state.source.id !== site.id;

// A real site id embeds the tenant hostname (`tenant.sharepoint.com,guid,guid`), shared by every
// site in the tenant, so slicing the id itself would not distinguish two colliding sites. Hashing
// first spreads that difference across the whole string before `disambiguateSegment` (kb-path.ts)
// takes its slice.
export const siteIdHash = (id: string): string => new Bun.CryptoHasher('sha256').update(id).digest('hex');

export const withDrive = (state: SiteState, driveId: string, drive: DriveState): SiteState => ({ ...state, drives: { ...state.drives, [driveId]: drive } });

export const recordItem = (drive: DriveState, itemId: string, entry: ManifestEntry): DriveState => ({ ...drive, items: { ...drive.items, [itemId]: entry } });

// Forgotten whole: an item the source no longer has owes nothing, neither an output to keep track of
// nor a conversion to try again.
export const forgetItem = (drive: DriveState, itemId: string): DriveState => {
  const remaining = Object.entries(drive.items).filter(([id]) => id !== itemId);
  return forgetFailure({ ...drive, items: Object.fromEntries(remaining) }, itemId);
};

export const rememberFailure = (drive: DriveState, entry: RetryEntry): DriveState => ({ ...drive, retry: { ...drive.retry, [entry.item.id]: entry } });

export const forgetFailure = (drive: DriveState, itemId: string): DriveState => {
  const remaining = Object.entries(drive.retry).filter(([id]) => id !== itemId);
  return { ...drive, retry: Object.fromEntries(remaining) };
};

export const renameItem = (drive: DriveState, itemId: string, path: string, outputs: ReadonlyArray<string>): DriveState => {
  const known = drive.items[itemId];
  return known === undefined ? drive : recordItem(drive, itemId, { ...known, path, outputs });
};
