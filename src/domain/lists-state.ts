import { CATEGORY_FOLDER } from './kb-category.ts';
import { disambiguateSegment, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import type { SharePointList } from './sharepoint-list.ts';

export const LISTS_STATE_VERSION = 1;

// A site's lists are shelved under the site, under the heading the picker offered them under, so
// they sit apart from the same site's libraries under `SharePoint sites/`.
export const listsRootName = (site: string): SafeRelPath => safeRelPath([CATEGORY_FOLDER.lists, site]);

// One list already written as a table: the file, the fingerprint of the rows and columns it was
// made from, and the name that is left to call it by once the site no longer has it.
export type ListRecord = { readonly file: string; readonly fingerprint: string; readonly name: string };

export type ListsState = {
  readonly version: typeof LISTS_STATE_VERSION;
  readonly source: { readonly kind: 'lists'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly lists: Readonly<Record<string, ListRecord>>;
};

export type ListsStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyListsState = (siteId: string, siteName: string): ListsState => ({
  version: LISTS_STATE_VERSION,
  source: { kind: 'lists', id: siteId, name: siteName },
  lastRun: '',
  lists: {},
});

export const serializeListsState = (state: ListsState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const recordOf = (entry: Record<string, unknown>): ListRecord => ({
  file: readString(entry, 'file') ?? '',
  fingerprint: readString(entry, 'fingerprint') ?? '',
  name: readString(entry, 'name') ?? '',
});

const listsOf = (raw: unknown): Readonly<Record<string, ListRecord>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, recordOf(entry)] as const] : [])));
};

export const parseListsState = (raw: unknown): Result<ListsState, ListsStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'lists') return err({ kind: 'malformed', message: 'state is not a set of lists' });
  if (raw['version'] !== LISTS_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${LISTS_STATE_VERSION}` });
  return ok({
    version: LISTS_STATE_VERSION,
    source: { kind: 'lists', id: readString(source, 'id') ?? '', name: readString(source, 'name') ?? '' },
    lastRun: readString(raw, 'lastRun') ?? '',
    lists: listsOf(raw['lists']),
  });
};

export const withList = (state: ListsState, id: string, record: ListRecord): ListsState => ({ ...state, lists: { ...state.lists, [id]: record } });

export const withoutList = (state: ListsState, id: string): ListsState => ({ ...state, lists: Object.fromEntries(Object.entries(state.lists).filter(([held]) => held !== id)) });

// Whatever the ledger holds that the site no longer lists, which is put aside.
export const goneLists = (state: ListsState, present: ReadonlyArray<SharePointList>): ReadonlyArray<{ readonly id: string; readonly record: ListRecord }> => {
  const listed = new Set(present.map((list) => list.id));
  return Object.entries(state.lists).flatMap(([id, record]) => (listed.has(id) ? [] : [{ id, record }]));
};

const MARKDOWN = '.md';

// Where a list's table goes: under the site, named by the list. Two lists can share a name on one
// site; the second takes a suffix from its own id. A file held by another list is taken.
export const listFileFor = (root: string, list: SharePointList, taken: ReadonlySet<string>): string => {
  const name = `${safeSegment(list.name)}${MARKDOWN}`;
  const plain = `${root}/${name}`;
  return taken.has(plain) ? `${root}/${disambiguateSegment(name, list.id)}` : plain;
};
