import type { Result } from './result.ts';
import { err, ok } from './result.ts';

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
const canonicalCursor = (link: string | undefined): string | undefined => link?.replace(/%24/gi, '$');

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

const parseItem = (raw: unknown): DriveItem | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw, 'id');
  const name = readString(raw, 'name');
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
