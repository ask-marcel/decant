import type { Result } from './result.ts';
import { err, ok } from './result.ts';

// What a mailbox run leaves behind: a cursor per folder, what every conversation produced, and the
// files already fetched, so a re-run converts nothing it has seen and a stop loses one thread.
export type ThreadRecord = {
  // The folder the thread was filed under, kept because it is settled once and never recomputed.
  // Recomputing would give the same answer today, but the slug and zone rules that produce it are
  // code: recording the answer is what makes a later change to those rules harmless to threads
  // already written.
  readonly folder: string;
  // Every Graph conversation that fed this thread. More than one when an external party replied
  // from outside Exchange and Graph opened a second conversation for the same exchange.
  readonly conversationIds: ReadonlyArray<string>;
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
// `media` is the subset of `paths` holding pictures taken out of the document itself. They are files
// this run wrote, so the record names them, but they are not what the message carried.
export type AttachmentRecord = { readonly name: string; readonly paths: ReadonlyArray<string>; readonly primary: string; readonly media: ReadonlyArray<string> };

// Bumped whenever the shape below, or the layout it describes, changes. A file written by another
// version is refused rather than half understood: the threads of the version before this one were
// keyed by Graph's conversation id and named paths under a tree that no longer exists, so reading
// one would answer `needsRender` with false for every conversation already held and report a run
// that wrote nothing as a success. Refusing costs one full sweep, which is the honest price.
export const STATE_VERSION = 2;

// Which thread a Graph conversation belongs to, and the root message that decided it. Written once
// and never revisited: re-resolving every run would let a message arriving late, older than
// anything held, answer with a different root and rename a folder that is already on disk and
// already linked to. The cost of freezing is a merge found late rather than never, which is the
// cheaper mistake: a missed merge is a second folder, a changed one is a moved tree.
export type ConversationRecord = { readonly threadId: string; readonly root: string };

export type MailboxState = {
  readonly version: typeof STATE_VERSION;
  readonly source: { readonly kind: 'mailbox'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly folders: Readonly<Record<string, { readonly name: string; readonly deltaLink?: string }>>;
  readonly threads: Readonly<Record<string, ThreadRecord>>;
  readonly conversations: Readonly<Record<string, ConversationRecord>>;
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  readonly attachments: Readonly<Record<string, AttachmentRecord>>;
  readonly pending: ReadonlyArray<string>;
};

export type MailStateError = { readonly kind: 'malformed'; readonly message: string };

export const MAILBOX_ID = 'me';
export const MAILBOX_NAME = 'Mailbox';

export const emptyMailboxState = (): MailboxState => ({
  version: STATE_VERSION,
  source: { kind: 'mailbox', id: MAILBOX_ID, name: MAILBOX_NAME },
  lastRun: '',
  folders: {},
  threads: {},
  conversations: {},
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
  folder: readString(raw, 'folder') ?? '',
  conversationIds: stringList(raw['conversationIds']),
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
  return { name: readString(entry, 'name') ?? '', paths, primary: readString(entry, 'primary') ?? paths[0] ?? '', media: stringList(entry['media']) };
};

const mapOf = <T>(raw: unknown, parse: (entry: Record<string, unknown>) => T): Readonly<Record<string, T>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, parse(entry)] as const] : [])));
};

export const parseMailboxState = (raw: unknown): Result<MailboxState, MailStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  if (!isRecord(raw['source']) || readString(raw['source'], 'kind') !== 'mailbox') return err({ kind: 'malformed', message: 'state is not a mailbox' });
  if (raw['version'] !== STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${STATE_VERSION}` });
  return ok({
    version: STATE_VERSION,
    source: { kind: 'mailbox', id: readString(raw['source'], 'id') ?? MAILBOX_ID, name: readString(raw['source'], 'name') ?? MAILBOX_NAME },
    lastRun: readString(raw, 'lastRun') ?? '',
    folders: mapOf(raw['folders'], (entry) => ({ name: readString(entry, 'name') ?? '', deltaLink: readString(entry, 'deltaLink') })),
    threads: mapOf(raw['threads'], threadOf),
    conversations: mapOf(raw['conversations'], (entry) => ({ threadId: readString(entry, 'threadId') ?? '', root: readString(entry, 'root') ?? '' })),
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

export const withConversation = (state: MailboxState, conversationId: string, record: ConversationRecord): MailboxState => ({
  ...state,
  conversations: { ...state.conversations, [conversationId]: record },
});

export const threadOfConversation = (state: MailboxState, conversationId: string): ConversationRecord | undefined => state.conversations[conversationId];

export const withLinked = (state: MailboxState, key: string, record: LinkedRecord): MailboxState => ({ ...state, linked: { ...state.linked, [key]: record } });

export const withAttachment = (state: MailboxState, hash: string, record: AttachmentRecord): MailboxState => ({ ...state, attachments: { ...state.attachments, [hash]: record } });

export const withPending = (state: MailboxState, pending: ReadonlyArray<string>): MailboxState => ({ ...state, pending });

// Every conversation resolved into one thread. Derived rather than stored beside the thread, so
// there is one place a conversation's thread is written and no second copy to fall out of step.
export const conversationsInThread = (state: MailboxState, threadId: string): ReadonlyArray<{ readonly id: string; readonly root: string }> =>
  Object.entries(state.conversations)
    .filter(([, record]) => record.threadId === threadId)
    .map(([id, record]) => ({ id, root: record.root }))
    .sort((left, right) => left.id.localeCompare(right.id));

// A conversation needs writing again when it holds a message the last run never saw. A message
// merely being reread, or its read flag flipping, changes nothing that lands on disk.
//
// A conversation nobody has resolved yet always needs writing, and for a second reason as well as
// the first: without a thread there is no document to have written it into.
export const needsRender = (state: MailboxState, conversationId: string, messageIds: ReadonlyArray<string>): boolean => {
  const belongs = state.conversations[conversationId];
  if (belongs === undefined) return true;
  const known = state.threads[belongs.threadId];
  if (known === undefined) return true;
  const seen = new Set(known.messageIds);
  return messageIds.some((id) => !seen.has(id));
};

export const countThreads = (state: MailboxState): number => Object.keys(state.threads).length;
