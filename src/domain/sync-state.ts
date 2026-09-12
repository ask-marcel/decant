import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type SourceKind = 'site' | 'mailbox' | 'group' | 'todo' | 'team' | 'people' | 'calendar' | 'notebook' | 'lists';

export type SyncedSource = {
  readonly kind: SourceKind;
  readonly id: string;
  readonly name: string;
  readonly lastRun: string;
  readonly fileCount: number;
};

export type SyncStateError = { readonly kind: 'malformed'; readonly message: string };

// A Microsoft 365 group is a site and an inbox wearing one title, and both halves land in the vault
// under that one name. A report naming them alike leaves a reader with two identical headings and no
// way to tell which is the documents and which the conversations, so the group says what it is.
export const GROUP_LABEL_SUFFIX = ' (group inbox)';

// A site's lists are the same again: they land under the site's name, beside the site's libraries
// under the same name, so the lists say what they are.
export const LISTS_LABEL_SUFFIX = ' (lists)';

const LABEL_SUFFIX: Readonly<Partial<Record<SourceKind, string>>> = { group: GROUP_LABEL_SUFFIX, lists: LISTS_LABEL_SUFFIX };

export const sourceLabel = (source: { readonly name: string; readonly kind: SourceKind }): string => `${source.name}${LABEL_SUFFIX[source.kind] ?? ''}`;

// What a source is told apart by wherever sources of every kind are held together (the picker's
// marks, the global report's tail): the id alone, except a site's lists, which carry the site's own
// id and would otherwise be taken for its libraries.
const LISTS_KEY_PREFIX = 'lists:';

export const sourceKey = (source: { readonly kind: SourceKind; readonly id: string }): string => (source.kind === 'lists' ? `${LISTS_KEY_PREFIX}${source.id}` : source.id);

type SourceIdentity = { readonly kind: SourceKind; readonly id: string; readonly name: string };

const KINDS: ReadonlyArray<SourceKind> = ['site', 'mailbox', 'group', 'todo', 'team', 'people', 'calendar', 'notebook', 'lists'];

const isSourceKind = (value: string | undefined): value is SourceKind => KINDS.some((kind) => kind === value);

export const NEVER_RUN = 'never';

const malformed = (message: string): Result<never, SyncStateError> => err({ kind: 'malformed', message });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const countKeys = (raw: unknown): number => (isRecord(raw) ? Object.keys(raw).length : 0);

// What a container holds, summed over every container: a site's libraries each hold `items`, a
// team's channels each hold `posts`.
const countWithin = (containers: unknown, held: string): number => {
  if (!isRecord(containers)) return 0;
  return Object.values(containers).reduce<number>((total, container) => total + (isRecord(container) ? countKeys(container[held]) : 0), 0);
};

const parseIdentity = (source: Record<string, unknown>): Result<SourceIdentity, SyncStateError> => {
  const kind = readString(source, 'kind');
  const id = readString(source, 'id');
  const name = readString(source, 'name');
  if (!isSourceKind(kind)) return malformed(`unknown source kind: ${String(kind)}`);
  if (id === undefined || name === undefined) return malformed('source is missing id or name');
  return ok({ kind, id, name });
};

// A site counts the documents its libraries hold and a team the posts its channels hold; a mailbox
// and a group inbox count their threads, a To Do list its tasks, the directory its people, the
// calendar its events, a notebook its pages and a site its lists, each of those being one file in
// the knowledge base.
const countFiles = (raw: Record<string, unknown>): number =>
  countWithin(raw['drives'], 'items') +
  countWithin(raw['channels'], 'posts') +
  ['threads', 'tasks', 'people', 'events', 'pages', 'lists'].reduce((total, held) => total + countKeys(raw[held]), 0);

export const parseSyncedSource = (raw: unknown): Result<SyncedSource, SyncStateError> => {
  if (!isRecord(raw)) return malformed('sync state is not an object');
  const source = raw['source'];
  if (!isRecord(source)) return malformed('sync state has no source object');
  const identity = parseIdentity(source);
  if (!identity.ok) return identity;
  return ok({ ...identity.value, lastRun: readString(raw, 'lastRun') ?? NEVER_RUN, fileCount: countFiles(raw) });
};
