import { safeSegment } from './kb-path.ts';
import type { MailFolder } from './mail-folder.ts';
import type { MessageMarks, MessageRecord } from './message-record.ts';
import { parseMessageRecords, sameMarks } from './message-record.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { MAX_CONVERSION_ATTEMPTS } from './retry-policy.ts';
import { compareText } from './utilities/compare-text.ts';

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
  // Every file the thread's folder holds besides its note, as the last write left it: what each
  // attachment produced, each card, and each linked document with its card. What a later write does
  // not write again is what the thread no longer holds. Absent from a thread written before the list
  // was kept, which only its attachments say anything about.
  readonly files?: ReadonlyArray<string>;
  // The name each file a message carried was written under in the thread's folder, by the arrival it
  // came with: the message, and which of the files of that name in it. A file keeps its name when an
  // earlier file of that name goes. Absent from a thread written before the names were kept.
  readonly names?: Readonly<Record<string, string>>;
  // The name each linked document was written under in the thread's folder, by the item it is at the
  // source. Absent from a thread written before these were kept.
  readonly links?: Readonly<Record<string, string>>;
  // The version each linked document whose files the thread holds was pulled at, by the item: a write
  // that finds the same version at the source keeps those files. Absent from a thread written before
  // these were kept, whose documents are all pulled again once.
  readonly linkedVersions?: Readonly<Record<string, string>>;
  // What the index pages list a thread by: its subject, when it began, and who wrote last. Absent from
  // a thread written before they were kept, until a new message writes it again.
  readonly subject?: string;
  readonly firstMessage?: string;
  readonly lastFrom?: string;
  // What each message was when the thread was written, oldest first: the marks a sweep compares, and
  // what the message index lists it by. Absent from a thread written before they were kept.
  readonly messages?: ReadonlyArray<MessageRecord>;
};

// The files one linked SharePoint document produced, the way an attachment records its own: a
// conversion yields more than the markdown alone (a deck also renders a PDF, an image is kept
// beside the text read out of it), and a record naming one of them could not say what the rest are.
export type LinkedRecord = { readonly paths: ReadonlyArray<string> };

// One entry per attachment content, keyed by its content address (see `content-hash.ts`): the name it
// was stored under and the files it produced. A file a message carried is stored in its thread's own
// `_attachments` folder, so a file sent in many threads is written in each, and the entry is the one
// the last of them wrote; a picture shown in a body is stored once, in the mailbox's `_inline`. `name`
// is kept so a later run placing a different file of the same name disambiguates it rather than
// overwriting this one.
// `primary` is the file to link a reader to out of everything the conversion wrote, so a second
// message carrying the same attachment points at the same one without converting it again.
// `media` is the subset of `paths` holding pictures taken out of the document itself. They are files
// this run wrote, so the record names them, but they are not what the message carried.
// `text` is set only for a picture shown inside a message body, which is stored once for the whole
// mailbox and read into every thread that shows it. It is remembered here because no document holds
// it any more: the words live in the threads, and a second thread meeting the same picture would
// otherwise have nothing to put under it. Empty, the picture holds no words, is too small to hold any,
// or the run turned OCR off; absent, it was stored before readings were kept, or OCR could not run or
// failed on it, and it is read again.
export type AttachmentRecord = {
  readonly name: string;
  readonly paths: ReadonlyArray<string>;
  readonly primary: string;
  readonly media: ReadonlyArray<string>;
  readonly text?: string;
};

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

// One thread the run could not write, and how many runs have tried. Only the id is kept: everything
// a render needs is rebuilt from the conversations, which are recorded whether the render worked or
// not. Without this record a failure disappears, because the folder cursors moved on when the thread
// was swept and a delta only ever reports what changed since.
export type RetryRecord = { readonly attempts: number; readonly reason: string };

// What each folder cursor reads a message with, and what each thread record keeps of it. Raised when
// either grows: Graph keeps the fields of the request that opened a cursor inside the cursor, and a
// thread written before keeps none of the new ones. A sweep that finds a state below it drops the
// cursors and writes every thread again, once. `STATE_VERSION` stays where it is, since a state from
// before is understood, and refusing it would cost a full sweep and the record of every thread.
export const MAIL_FIELDS = 2;

export type MailboxState = {
  readonly version: typeof STATE_VERSION;
  readonly source: { readonly kind: 'mailbox'; readonly id: string; readonly name: string };
  // The `MAIL_FIELDS` the cursors and the thread records were made with. Absent from a state written
  // before the fields were counted.
  readonly fields?: number;
  readonly lastRun: string;
  readonly folders: Readonly<Record<string, { readonly name: string; readonly deltaLink?: string }>>;
  readonly threads: Readonly<Record<string, ThreadRecord>>;
  readonly conversations: Readonly<Record<string, ConversationRecord>>;
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  readonly attachments: Readonly<Record<string, AttachmentRecord>>;
  readonly pending: ReadonlyArray<string>;
  // Additive, so `STATE_VERSION` stays where it is: a file written before this loads with an empty
  // ledger, which is what it means, and bumping would cost a full mailbox re-sweep for nothing.
  readonly retry: Readonly<Record<string, RetryRecord>>;
  // The day the folder cursors were taken reaching back to, absent when they reached everything. A
  // run reaching further back than this sweeps every folder from the start. Additive for the same
  // reason as the ledger: a file written before this reached everything.
  readonly since?: string;
  // The subject each thread still queued, or owed another try, goes by, so a run that resumes the
  // queue or tries a thread again names it on the counter as the sweep that queued it did. Kept for
  // those threads only and dropped once one is written. Additive: a file from before holds none.
  readonly titles: Readonly<Record<string, string>>;
  // The folders the sweep passes over (Deleted Items, Junk Email, Drafts, Outbox), by name only: a
  // conversation holds messages in them too, and each message says which folder it sits in. Kept so
  // a run that resumes its queue, and lists no folders, can still name them. Additive.
  readonly unsweptFolders: Readonly<Record<string, string>>;
  // The addresses the mailbox sends from, as the last sweep read them: what tells the message index a
  // message sent from one received. Additive: a file from before holds none.
  readonly ownAddresses: ReadonlyArray<string>;
};

export type MailStateError = { readonly kind: 'malformed'; readonly message: string };

export const MAILBOX_ID = 'me';
export const MAILBOX_NAME = 'Mailbox';

export const emptyMailboxState = (): MailboxState => ({
  version: STATE_VERSION,
  source: { kind: 'mailbox', id: MAILBOX_ID, name: MAILBOX_NAME },
  fields: MAIL_FIELDS,
  lastRun: '',
  folders: {},
  threads: {},
  conversations: {},
  linked: {},
  attachments: {},
  pending: [],
  retry: {},
  titles: {},
  unsweptFolders: {},
  ownAddresses: [],
});

export const serializeMailboxState = (state: MailboxState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

export const stringList = (raw: unknown): ReadonlyArray<string> => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []);

// A run on Windows once wrote some of these paths with backslashes. No name this tool writes can
// hold one, since every segment is sanitized, so each is read back with forward slashes and a later
// run compares the paths it builds against the same spelling.
const posixPath = (path: string): string => path.replaceAll('\\', '/');

const pathList = (raw: unknown): ReadonlyArray<string> => stringList(raw).map(posixPath);

export const threadOf = (raw: Record<string, unknown>): ThreadRecord => ({
  folder: readString(raw, 'folder') ?? '',
  conversationIds: stringList(raw['conversationIds']),
  file: posixPath(readString(raw, 'file') ?? ''),
  messageIds: stringList(raw['messageIds']),
  lastMessage: readString(raw, 'lastMessage') ?? '',
  attachments: pathList(raw['attachments']),
  inlineImages: pathList(raw['inlineImages']),
  files: Array.isArray(raw['files']) ? pathList(raw['files']) : undefined,
  names: isRecord(raw['names']) ? textsOf(raw['names']) : undefined,
  links: isRecord(raw['links']) ? textsOf(raw['links']) : undefined,
  linkedVersions: isRecord(raw['linkedVersions']) ? textsOf(raw['linkedVersions']) : undefined,
  subject: readString(raw, 'subject'),
  firstMessage: readString(raw, 'firstMessage'),
  lastFrom: readString(raw, 'lastFrom'),
  messages: parseMessageRecords(raw['messages']),
});

export const linkedOf = (entry: Record<string, unknown>): LinkedRecord => ({ paths: pathList(entry['paths']) });

// A state written before the store remembered which file to link falls back to the first one it
// wrote, which is the only one for a document and the file itself for everything else.
export const attachmentOf = (entry: Record<string, unknown>): AttachmentRecord => {
  const paths = pathList(entry['paths']);
  return {
    name: readString(entry, 'name') ?? '',
    paths,
    primary: posixPath(readString(entry, 'primary') ?? paths[0] ?? ''),
    media: pathList(entry['media']),
    text: readString(entry, 'text'),
  };
};

export const retryOf = (entry: Record<string, unknown>): RetryRecord => ({
  attempts: typeof entry['attempts'] === 'number' ? entry['attempts'] : 0,
  reason: readString(entry, 'reason') ?? '',
});

export const mapOf = <T>(raw: unknown, parse: (entry: Record<string, unknown>) => T): Readonly<Record<string, T>> => {
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
    fields: typeof raw['fields'] === 'number' ? raw['fields'] : undefined,
    lastRun: readString(raw, 'lastRun') ?? '',
    folders: mapOf(raw['folders'], (entry) => ({ name: readString(entry, 'name') ?? '', deltaLink: readString(entry, 'deltaLink') })),
    threads: mapOf(raw['threads'], threadOf),
    conversations: mapOf(raw['conversations'], (entry) => ({ threadId: readString(entry, 'threadId') ?? '', root: readString(entry, 'root') ?? '' })),
    linked: mapOf(raw['linked'], linkedOf),
    attachments: mapOf(raw['attachments'], attachmentOf),
    pending: stringList(raw['pending']),
    retry: mapOf(raw['retry'], retryOf),
    since: readString(raw, 'since'),
    titles: textsOf(raw['titles']),
    unsweptFolders: textsOf(raw['unsweptFolders']),
    ownAddresses: stringList(raw['ownAddresses']),
  });
};

// Only the entries that are text: a subject is only ever shown, so anything else is no subject.
const textsOf = (raw: unknown): Readonly<Record<string, string>> =>
  isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};

// The subjects kept for the threads still queued or owed another try, and no others.
export const keptTitles = (state: MailboxState): MailboxState => ({
  ...state,
  titles: Object.fromEntries(Object.entries(state.titles).filter(([threadId]) => state.pending.includes(threadId) || state.retry[threadId] !== undefined)),
});

export const withTitles = (state: MailboxState, titles: Readonly<Record<string, string>>): MailboxState => keptTitles({ ...state, titles: { ...state.titles, ...titles } });

export const withFolderCursor = (state: MailboxState, folderId: string, name: string, deltaLink: string | undefined): MailboxState => ({
  ...state,
  folders: { ...state.folders, [folderId]: { name, ...(deltaLink === undefined ? {} : { deltaLink }) } },
});

// The folders this sweep passed over, as the listing named them, in place of the ones before. By id,
// so a listing that gives the same folders in another order leaves the state file as it was.
export const withUnsweptFolders = (state: MailboxState, folders: ReadonlyArray<MailFolder>): MailboxState => ({
  ...state,
  unsweptFolders: Object.fromEntries(folders.map((folder) => [folder.id, folder.name] as const).toSorted(([left], [right]) => compareText(left, right))),
});

export const withOwnAddresses = (state: MailboxState, ownAddresses: ReadonlyArray<string>): MailboxState => ({ ...state, ownAddresses });

// Every folder's name by its id, swept or passed over.
export const folderNames = (state: MailboxState): Readonly<Record<string, string>> => ({
  ...state.unsweptFolders,
  ...Object.fromEntries(Object.entries(state.folders).map(([id, folder]) => [id, folder.name])),
});

// The folders that were named before and are named otherwise now. A folder new to the listing, or
// gone from it, holds no message a thread already wrote under another name.
export const renamedFolders = (before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(after)
    .filter(([id, name]) => before[id] !== undefined && before[id] !== name)
    .map(([id]) => id);

// The threads holding a message in one of these folders, by key, so a queue built from them comes out
// the same whatever order the state was read in.
export const threadsInFolders = (state: MailboxState, folderIds: ReadonlyArray<string>): ReadonlyArray<string> => {
  const wanted = new Set(folderIds);
  return Object.entries(state.threads)
    .filter(([, record]) => (record.messages ?? []).some((message) => wanted.has(message.folderId)))
    .map(([threadId]) => threadId)
    .sort(compareText);
};

// Every file the thread's folder held at its last write besides the note: the list that write kept,
// or, for a thread written before the list was kept, its attachments. Only what is inside the thread's
// own folder: a picture shown in a body sits in the store the whole mailbox shares, and an older write
// could list one among the attachments. A thread filed nowhere holds none, since no path is in a
// folder with no name.
export const filesOf = (record: ThreadRecord): ReadonlyArray<string> => (record.files ?? record.attachments).filter((path) => path.includes(`/threads/${record.folder}/`));

// What the write before held and this one did not write again: what the thread no longer holds.
export const filesLeft = (before: ThreadRecord | undefined, after: ThreadRecord): ReadonlyArray<string> => {
  if (before === undefined) return [];
  const kept = new Set(filesOf(after));
  return filesOf(before).filter((path) => !kept.has(path));
};

// A record that keeps listing files the write before held and this one did not write again: they stay
// on disk, and a later write that reads everything tells what the thread no longer holds.
export const stillHolding = (record: ThreadRecord, kept: ReadonlyArray<string>): ThreadRecord => ({
  ...record,
  files: [...new Set([...(record.files ?? []), ...kept])].toSorted(compareText),
});

// The names a thread's folder still holds in one of its subfolders, as its record lists them: each
// file, and the name a card stands for, since a card is the name of its file plus `.md`.
export const namesHeldIn = (folder: string, paths: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  (paths ?? [])
    .filter((path) => path.startsWith(`${folder}/`))
    .flatMap((path) => {
      const name = path.slice(folder.length + 1);
      return name.endsWith(CARD_SUFFIX) ? [name, name.slice(0, -CARD_SUFFIX.length)] : [name];
    });

const CARD_SUFFIX = '.md';

// Whether a file is one of the files under a name in a thread's folder: the file itself, what sits
// beside it under its name (its card, its pictures, a deck's PDF), anything in a folder of that name,
// and what an archive or a saved mail of that name unpacked into: a folder named for it without its
// extension, cleaned the way the converters clean every name.
export const underName = (path: string, name: string): boolean => {
  const slash = name.lastIndexOf('/');
  const base = name.slice(slash + 1);
  const cut = base.lastIndexOf('.');
  const unpacked = `${name.slice(0, slash + 1)}${safeSegment(cut > 0 ? base.slice(0, cut) : base)}/`;
  return path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}/`) || path.startsWith(unpacked);
};

// A map written in the order of its keys, so the state reads the same whatever order it was filled in.
export const inKeyOrder = (map: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(map).toSorted(([left], [right]) => compareText(left, right)));

// The two stores of a mailbox or a group inbox: the attachments by content, the linked documents by
// item.
export type FileStores = { readonly attachments: Readonly<Record<string, AttachmentRecord>>; readonly linked: Readonly<Record<string, LinkedRecord>> };

// The stores without the records of files put aside: an attachment whose file to link went, and a
// linked document one of whose files went. Left behind, a record would hand a later write a file that
// is no longer there.
export const storesWithout = (stores: FileStores, paths: ReadonlyArray<string>): FileStores => {
  const gone = new Set(paths);
  return {
    attachments: Object.fromEntries(Object.entries(stores.attachments).filter(([, record]) => !gone.has(record.primary))),
    linked: Object.fromEntries(Object.entries(stores.linked).filter(([, record]) => !record.paths.some((path) => gone.has(path)))),
  };
};

// The threads holding one of these messages, by key. A delta names a message removed from a folder by
// its id alone, with no conversation, so its thread is found by the ids each thread was written with.
export const threadsHolding = (state: MailboxState, messageIds: ReadonlyArray<string>): ReadonlyArray<string> => {
  const wanted = new Set(messageIds);
  return Object.entries(state.threads)
    .filter(([, record]) => record.messageIds.some((id) => wanted.has(id)))
    .map(([threadId]) => threadId)
    .sort(compareText);
};

// Every folder read again from the start, each keeping its name.
export const withoutCursors = (state: MailboxState): MailboxState => ({
  ...state,
  folders: Object.fromEntries(Object.entries(state.folders).map(([id, folder]) => [id, { name: folder.name }])),
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

// A file sent in two threads is stored in each, and the index names one copy: the one whose path
// sorts first, which is the thread that began first. Named by the thread written last, the index
// changed with the order the threads happened to render in. A copy at the same path is the same
// thread written again, and its record is the newer one.
export const withAttachment = (state: MailboxState, hash: string, record: AttachmentRecord): MailboxState => {
  const held = state.attachments[hash];
  const kept = held !== undefined && compareText(held.primary, record.primary) < 0 ? held : record;
  return { ...state, attachments: { ...state.attachments, [hash]: kept } };
};

export const withPending = (state: MailboxState, pending: ReadonlyArray<string>): MailboxState => ({ ...state, pending });

export const withRetry = (state: MailboxState, threadId: string, record: RetryRecord): MailboxState => ({ ...state, retry: { ...state.retry, [threadId]: record } });

export const withoutRetry = (state: MailboxState, threadId: string): MailboxState => ({
  ...state,
  retry: Object.fromEntries(Object.entries(state.retry).filter(([id]) => id !== threadId)),
});

// The state without a thread whose messages are all gone: its record, the conversations that fed it,
// and its retry entry. A conversation that brings a message again later is resolved again.
export const withoutThread = (state: MailboxState, threadId: string): MailboxState => ({
  ...withoutRetry(state, threadId),
  threads: Object.fromEntries(Object.entries(state.threads).filter(([id]) => id !== threadId)),
  conversations: Object.fromEntries(Object.entries(state.conversations).filter(([, record]) => record.threadId !== threadId)),
});

// What the queue owes on top of what the sweep found. A thread the sweep queued for itself is being
// written from the messages the mailbox holds now, so the older attempt it remembers has nothing left
// to answer for: it is dropped rather than counted, which is also what lets a thread that gains a
// reply start its count over.
export const retriedThreads = (retry: Readonly<Record<string, RetryRecord>>, queued: ReadonlyArray<string>): ReadonlyArray<string> => {
  const fresh = new Set(queued);
  return Object.entries(retry)
    .filter(([id, record]) => !fresh.has(id) && record.attempts < MAX_CONVERSION_ATTEMPTS)
    .map(([id]) => id);
};

// Read off the ledger rather than off this run's work, because a thread out of tries is precisely one
// this run did nothing about. Naming it every run is the point: it is the only thing standing between
// a conversation nobody can write and a conversation nobody knows about.
export const abandonedThreads = (retry: Readonly<Record<string, RetryRecord>>): ReadonlyArray<{ readonly threadId: string; readonly reason: string }> =>
  Object.entries(retry)
    .filter(([, record]) => record.attempts >= MAX_CONVERSION_ATTEMPTS)
    .map(([threadId, record]) => ({ threadId, reason: record.reason }));

// Every conversation resolved into one thread. Derived rather than stored beside the thread, so
// there is one place a conversation's thread is written and no second copy to fall out of step.
export const conversationsInThread = (state: MailboxState, threadId: string): ReadonlyArray<{ readonly id: string; readonly root: string }> =>
  Object.entries(state.conversations)
    .filter(([, record]) => record.threadId === threadId)
    .map(([id, record]) => ({ id, root: record.root }))
    .sort((left, right) => compareText(left.id, right.id));

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

// A message the sweep returned, by its id and how it is marked now.
export type SweptMarks = MessageMarks & { readonly id: string };

// A conversation holding a message marked otherwise than when its thread was written: flagged, given
// a category or an importance, or moved, which changes what the note says about it. A message read and
// nothing more is marked as it was. A thread written before its messages were recorded has no marks
// to compare, and only a new message writes it again, as `needsRender` decides.
export const marksChanged = (state: MailboxState, conversationId: string, swept: ReadonlyArray<SweptMarks>): boolean => {
  const belongs = state.conversations[conversationId];
  const known = belongs === undefined ? undefined : state.threads[belongs.threadId];
  const held = new Map((known?.messages ?? []).map((record) => [record.id, record]));
  return swept.some((message) => {
    const record = held.get(message.id);
    return record !== undefined && !sameMarks(record, message);
  });
};

export const countThreads = (state: MailboxState): number => Object.keys(state.threads).length;
