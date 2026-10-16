import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { canonicalCursor } from './utilities/graph-cursor.ts';

export type DriveItemKind = 'file' | 'folder' | 'deleted';

export type DriveItem = {
  readonly id: string;
  readonly name: string;
  readonly kind: DriveItemKind;
  readonly size: number;
  readonly path: string;
  readonly lastModified: string;
  readonly cTag: string;
  readonly webUrl: string;
  readonly modifiedBy?: string;
};

export type DriveDeltaPage = {
  readonly items: ReadonlyArray<DriveItem>;
  readonly skipped: number;
  readonly nextLink?: string;
  readonly deltaLink?: string;
};

export type DriveDeltaError = { readonly kind: 'malformed'; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

// Graph hands cursors back with `$` percent-escaped; only that escape is decoded, because the rest
// encode literal bytes inside the skiptoken. Same rule the CLI's presenter applies.
// decodeURIComponent throws on a lone `%` or a bad escape. A pure-domain fallback (rule 17): a
// path we cannot decode is used as it came rather than ending the sweep.
const decodeOrKeep = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// `parentReference.path` reads `/drives/{id}/root:/Projets/2026`, percent-escaped by Graph. What
// follows `root:` is either empty (the library root) or a single leading slash then the folders.
const parentFolders = (item: Record<string, unknown>): string => {
  const raw = isRecord(item['parentReference']) ? readString(item['parentReference'], 'path') : undefined;
  const decoded = decodeOrKeep(raw?.split('root:')[1] ?? '');
  return decoded.startsWith('/') ? decoded.slice(1) : decoded;
};

const kindOf = (item: Record<string, unknown>): DriveItemKind => {
  if (item['deleted'] !== undefined) return 'deleted';
  return item['folder'] === undefined ? 'file' : 'folder';
};

const modifiedByOf = (item: Record<string, unknown>): string | undefined => {
  const by = item['lastModifiedBy'];
  return isRecord(by) && isRecord(by['user']) ? readString(by['user'], 'displayName') : undefined;
};

// OneDrive for Business leaves the name out of a deleted item: its id is all a sweep needs of it.
const nameOf = (item: Record<string, unknown>): string | undefined => readString(item, 'name') ?? (item['deleted'] === undefined ? undefined : '');

// Exported for the single-item read as well as the sweep: a file reached by a link in an email is
// the same kind of thing as a file found by walking a library, and reading it twice two ways is how
// the two drift apart.
export const parseItem = (raw: unknown): DriveItem | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw, 'id');
  const name = nameOf(raw);
  if (id === undefined || name === undefined) return undefined;
  const folders = parentFolders(raw);
  const size = raw['size'];
  return {
    id,
    name,
    kind: kindOf(raw),
    size: typeof size === 'number' ? size : 0,
    path: folders.length === 0 ? name : `${folders}/${name}`,
    lastModified: readString(raw, 'lastModifiedDateTime') ?? '',
    cTag: readString(raw, 'cTag') ?? '',
    webUrl: readString(raw, 'webUrl') ?? '',
    modifiedBy: modifiedByOf(raw),
  };
};

// What two versions of a document are told apart by: the cTag, which changes with the content alone.
// OneDrive for Business can leave it out of a changed item, and then the day and time of the last
// change are what is left. A record keeps that day as `modified`.
export type Versioned = { readonly cTag: string; readonly lastModified?: string };

export const sameVersion = (left: Versioned, right: Versioned): boolean =>
  left.cTag !== '' && right.cTag !== '' ? left.cTag === right.cTag : left.lastModified === right.lastModified;

// The same, said in one word a record can keep: the cTag, or the day and time of the last change when
// the source left the cTag out. Empty when it gave neither, which tells no version from another.
export const versionOf = (item: Pick<DriveItem, 'cTag' | 'lastModified'>): string => (item.cTag !== '' ? item.cTag : item.lastModified);

// A document a run looked for by id and the source no longer has: as good as one a sweep reports
// deleted, which is all the sync needs to put its files aside.
export const goneItem = (id: string): DriveItem => ({ id, name: '', kind: 'deleted', size: 0, path: '', lastModified: '', cTag: '', webUrl: '' });

export const parseDriveDelta = (raw: unknown): Result<DriveDeltaPage, DriveDeltaError> => {
  if (!isRecord(raw) || !Array.isArray(raw['value'])) return err({ kind: 'malformed', message: 'delta response has no value array' });
  const parsed = raw['value'].map(parseItem);
  const items = parsed.filter((item): item is DriveItem => item !== undefined);
  return ok({
    items,
    skipped: parsed.length - items.length,
    nextLink: canonicalCursor(readString(raw, '@odata.nextLink')),
    deltaLink: canonicalCursor(readString(raw, '@odata.deltaLink')),
  });
};
