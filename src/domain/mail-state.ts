import type { Result } from './result.ts';
import { err, ok } from './result.ts';

// What a mailbox run leaves behind: a cursor per folder, what every conversation produced, and the
// files already fetched, so a re-run converts nothing it has seen and a stop loses one thread.
export type ThreadRecord = {
  readonly file: string;
  readonly messageIds: ReadonlyArray<string>;
  readonly lastMessage: string;
  readonly attachments: ReadonlyArray<string>;
};

export type LinkedRecord = { readonly path: string };

export type MailboxState = {
  readonly version: 1;
  readonly source: { readonly kind: 'mailbox'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly folders: Readonly<Record<string, { readonly name: string; readonly deltaLink?: string }>>;
  readonly threads: Readonly<Record<string, ThreadRecord>>;
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  readonly pending: ReadonlyArray<string>;
};

export type MailStateError = { readonly kind: 'malformed'; readonly message: string };

export const MAILBOX_ID = 'me';
export const MAILBOX_NAME = 'Mailbox';

export const emptyMailboxState = (): MailboxState => ({
  version: 1,
  source: { kind: 'mailbox', id: MAILBOX_ID, name: MAILBOX_NAME },
  lastRun: '',
  folders: {},
  threads: {},
  linked: {},
  pending: [],
});

export const serializeMailboxState = (state: MailboxState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const stringList = (raw: unknown): ReadonlyArray<string> => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []);

const threadOf = (raw: Record<string, unknown>): ThreadRecord => ({
  file: readString(raw, 'file') ?? '',
  messageIds: stringList(raw['messageIds']),
  lastMessage: readString(raw, 'lastMessage') ?? '',
  attachments: stringList(raw['attachments']),
});

const mapOf = <T>(raw: unknown, parse: (entry: Record<string, unknown>) => T): Readonly<Record<string, T>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, parse(entry)] as const] : [])));
};

export const parseMailboxState = (raw: unknown): Result<MailboxState, MailStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  if (!isRecord(raw['source']) || readString(raw['source'], 'kind') !== 'mailbox') return err({ kind: 'malformed', message: 'state is not a mailbox' });
  return ok({
    version: 1,
    source: { kind: 'mailbox', id: readString(raw['source'], 'id') ?? MAILBOX_ID, name: readString(raw['source'], 'name') ?? MAILBOX_NAME },
    lastRun: readString(raw, 'lastRun') ?? '',
    folders: mapOf(raw['folders'], (entry) => ({ name: readString(entry, 'name') ?? '', deltaLink: readString(entry, 'deltaLink') })),
    threads: mapOf(raw['threads'], threadOf),
    linked: mapOf(raw['linked'], (entry) => ({ path: readString(entry, 'path') ?? '' })),
    pending: stringList(raw['pending']),
  });
};

export const withFolderCursor = (state: MailboxState, folderId: string, name: string, deltaLink: string | undefined): MailboxState => ({
  ...state,
  folders: { ...state.folders, [folderId]: { name, ...(deltaLink === undefined ? {} : { deltaLink }) } },
});

export const withThread = (state: MailboxState, conversationId: string, record: ThreadRecord): MailboxState => ({
  ...state,
  threads: { ...state.threads, [conversationId]: record },
});

export const withLinked = (state: MailboxState, key: string, record: LinkedRecord): MailboxState => ({ ...state, linked: { ...state.linked, [key]: record } });

export const withPending = (state: MailboxState, pending: ReadonlyArray<string>): MailboxState => ({ ...state, pending });

// A conversation needs writing again when it holds a message the last run never saw. A message
// merely being reread, or its read flag flipping, changes nothing that lands on disk.
export const needsRender = (state: MailboxState, conversationId: string, messageIds: ReadonlyArray<string>): boolean => {
  const known = state.threads[conversationId];
  if (known === undefined) return true;
  const seen = new Set(known.messageIds);
  return messageIds.some((id) => !seen.has(id));
};

export const countThreads = (state: MailboxState): number => Object.keys(state.threads).length;
