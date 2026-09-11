import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type SourceKind = 'site' | 'mailbox' | 'group' | 'todo' | 'team';

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

export const sourceLabel = (source: { readonly name: string; readonly kind: SourceKind }): string =>
  source.kind === 'group' ? `${source.name}${GROUP_LABEL_SUFFIX}` : source.name;

type SourceIdentity = { readonly kind: SourceKind; readonly id: string; readonly name: string };

const isSourceKind = (value: string | undefined): value is SourceKind => value === 'site' || value === 'mailbox' || value === 'group' || value === 'todo' || value === 'team';

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
// and a group inbox count their threads and a To Do list its tasks, each of those being one file in
// the knowledge base.
const countFiles = (raw: Record<string, unknown>): number =>
  countWithin(raw['drives'], 'items') + countWithin(raw['channels'], 'posts') + countKeys(raw['threads']) + countKeys(raw['tasks']);

export const parseSyncedSource = (raw: unknown): Result<SyncedSource, SyncStateError> => {
  if (!isRecord(raw)) return malformed('sync state is not an object');
  const source = raw['source'];
  if (!isRecord(source)) return malformed('sync state has no source object');
  const identity = parseIdentity(source);
  if (!identity.ok) return identity;
  return ok({ ...identity.value, lastRun: readString(raw, 'lastRun') ?? NEVER_RUN, fileCount: countFiles(raw) });
};
