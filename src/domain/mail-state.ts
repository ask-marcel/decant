import type { Result } from './result.ts';
import { err, ok } from './result.ts';

// What a mailbox run leaves behind: a cursor per folder, what every conversation produced, and the
// files already fetched, so a re-run converts nothing it has seen and a stop loses one thread.
export type ThreadRecord = {
  readonly file: string;
  readonly messageIds: ReadonlyArray<string>;
  readonly lastMessage: string;
  readonly attachments: ReadonlyArray<string>;
  // Kept apart from the attachments because a body shows these where they stood, and a thread that
  // carried a signature logo should not read as a thread that carried a document.
  readonly inlineImages: ReadonlyArray<string>;
};

// The files one linked SharePoint document produced, the way an attachment records its own: a
// conversion yields more than the markdown alone (a deck also renders a PDF, an image is kept
// beside the text read out of it), and a record naming one of them could not say what the rest are.
export type LinkedRecord = { readonly paths: ReadonlyArray<string> };

// One entry per unique attachment content, keyed by its content address (see `content-hash.ts`):
// the name it was stored under and the files it produced in the shared `_attachments` store. A file
// sent across many threads is converted once; every thread after the first references what is on
// disk. `name` is kept so a later run placing a different file of the same name disambiguates it
// rather than overwriting this one.
// `primary` is the file to link a reader to out of everything the conversion wrote, so a second
// thread carrying the same attachment points at the same one without converting it again.
export type AttachmentRecord = { readonly name: string; readonly paths: ReadonlyArray<string>; readonly primary: string };

export type MailboxState = {
  readonly version: 1;
  readonly source: { readonly kind: 'mailbox'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly folders: Readonly<Record<string, { readonly name: string; readonly deltaLink?: string }>>;
  readonly threads: Readonly<Record<string, ThreadRecord>>;
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  readonly attachments: Readonly<Record<string, AttachmentRecord>>;
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
  attachments: {},
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
  inlineImages: stringList(raw['inlineImages']),
});

// A state written before the store remembered which file to link falls back to the first one it
// wrote, which is the only one for a document and the file itself for everything else.
const attachmentOf = (entry: Record<string, unknown>): AttachmentRecord => {
  const paths = stringList(entry['paths']);
  return { name: readString(entry, 'name') ?? '', paths, primary: readString(entry, 'primary') ?? paths[0] ?? '' };
};

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
    linked: mapOf(raw['linked'], (entry) => ({ paths: stringList(entry['paths']) })),
    attachments: mapOf(raw['attachments'], attachmentOf),
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

export const withAttachment = (state: MailboxState, hash: string, record: AttachmentRecord): MailboxState => ({ ...state, attachments: { ...state.attachments, [hash]: record } });

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
