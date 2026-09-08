import type { MailFolder } from '../domain/mail-folder.ts';
import { syncableFolders } from '../domain/mail-folder.ts';
import { inReceivedOrder } from '../domain/mail-message.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { attachmentRows, linkRows, renderJsonl, threadRows } from '../domain/mail-meta.ts';
import { rootMessageId } from '../domain/root-message-id.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import type { AttachmentRecord, LinkedRecord, MailboxState, ThreadRecord } from '../domain/mail-state.ts';
import {
  MAILBOX_ID,
  MAILBOX_NAME,
  abandonedThreads,
  emptyMailboxState,
  needsRender,
  parseMailboxState,
  retriedThreads,
  serializeMailboxState,
  conversationsInThread,
  threadOfConversation,
  withAttachment,
  withConversation,
  withFolderCursor,
  withLinked,
  withPending,
  withRetry,
  withThread,
  withoutRetry,
} from '../domain/mail-state.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { MailReader, MailReaderError } from './ports/mail-reader.ts';
import type { StepError } from './ports/step-error.ts';
import type { Clock } from './ports/clock.ts';
import type { RenderThread, RenderedThread } from './render-thread.ts';
import { MAX_CONVERSION_ATTEMPTS } from '../domain/retry-policy.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const MAIL_STATE_FILE = '.sync-state.json';

export type SyncMailboxDeps = {
  readonly reader: MailReader;
  readonly files: Files;
  readonly renderThread: RenderThread;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncMailboxInput = {
  readonly maxBytes: number;
  readonly dryRun: boolean;
  // How many conversations to render at once. Attachments are stored under a name fixed by their
  // content, so a window of conversations writes without racing; the store threads through as each
  // window's results fold onto it in order, saved once per window.
  readonly concurrency: number;
  // Only conversations touched on or after this day are written. Applied to what the sweep
  // returned rather than to the sweep itself: Outlook's delta does not narrow by date.
  readonly since?: string;
};

export type SyncMailbox = (input: SyncMailboxInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const mailboxRoot = (kbRoot: string): string => `${kbRoot}/Mailbox`;

// Written from the state the run folded, not from what it happened to render. An ordinary run
// touches three conversations out of thousands, so an index built from those would say the mailbox
// holds three threads and drop every other line on every incremental run.
//
// A failed write is logged rather than fatal, for the same reason the report's is: the documents
// themselves already landed, and an index can be rebuilt from them.
const writeIndexes = async (deps: SyncMailboxDeps, input: SyncMailboxInput, state: MailboxState): Promise<void> => {
  if (input.dryRun) return;
  const root = `${mailboxRoot(deps.kbRoot)}/_meta`;
  const files = [
    { path: `${root}/threads.jsonl`, body: renderJsonl(threadRows(state)) },
    { path: `${root}/attachments.jsonl`, body: renderJsonl(attachmentRows(state)) },
    { path: `${root}/links.jsonl`, body: renderJsonl(linkRows(state)) },
  ];
  for (const file of files) {
    const written = await deps.files.writeText(file.path, file.body);
    if (!written.ok) deps.logger.warn('index.failed', { path: file.path, cause: written.error.kind });
  }
};

const statePathOf = (kbRoot: string): string => `${mailboxRoot(kbRoot)}/${MAIL_STATE_FILE}`;

export const loadMailboxState = async (files: Files, path: string, logger: Logger): Promise<MailboxState> => {
  const text = await files.readText(path);
  if (!text.ok) return emptyMailboxState();
  const parsed = parseJson(text.value);
  if (!parsed.ok) return unusable(logger, parsed.error.kind);
  const state = parseMailboxState(parsed.value);
  return state.ok ? state.value : unusable(logger, state.error.kind);
};

const unusable = (logger: Logger, cause: string): MailboxState => {
  logger.warn('mail-state.unusable', { cause });
  return emptyMailboxState();
};

const save = async (files: Files, path: string, state: MailboxState, dryRun: boolean): Promise<Result<void, StepError>> => {
  if (dryRun) return ok(undefined);
  const written = await files.writeText(path, serializeMailboxState(state));
  return written.ok ? ok(undefined) : { ok: false, error: { step: 'saveMailState', cause: written.error.kind, message: written.error.message } };
};

const stepFailure = (step: string, error: MailReaderError): Result<never, StepError> => ({ ok: false, error: { step, cause: error.kind, message: error.message } });

// Every folder that holds correspondence, including the ones nested inside another.
const folderTree = async (deps: SyncMailboxDeps): Promise<Result<ReadonlyArray<MailFolder>, MailReaderError>> => {
  const top = await deps.reader.listFolders();
  if (!top.ok) return top;
  const found: MailFolder[] = [];
  const queue = [...syncableFolders(top.value)];
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) continue;
    found.push(folder);
    if (folder.childCount === 0) continue;
    const children = await deps.reader.listChildFolders(folder.id);
    if (!children.ok) return children;
    queue.push(...syncableFolders(children.value));
  }
  return ok(found);
};

type Swept = { readonly state: MailboxState; readonly messages: ReadonlyArray<MailMessage> };

const sweepFolder = async (deps: SyncMailboxDeps, state: MailboxState, folder: MailFolder): Promise<Result<Swept, MailReaderError>> => {
  const known = state.folders[folder.id];
  const first = known?.deltaLink === undefined ? await deps.reader.folderDelta(folder.id) : await deps.reader.deltaFrom(known.deltaLink);
  if (!first.ok) return first;
  const messages: MailMessage[] = [...first.value.messages];
  const seen = new Set<string>();
  let page = first.value;
  while (page.nextLink !== undefined && !seen.has(page.nextLink)) {
    seen.add(page.nextLink);
    const next = await deps.reader.deltaFrom(page.nextLink);
    if (!next.ok) return next;
    messages.push(...next.value.messages);
    page = next.value;
  }
  return ok({ state: withFolderCursor(state, folder.id, folder.name, page.deltaLink), messages });
};

type Conversation = { readonly id: string; readonly messageIds: ReadonlyArray<string>; readonly last: string; readonly oldest: string };

// Ordered rather than compared in place. `inReceivedOrder` already settles a tie by message id, so
// the same sweep always names the same oldest message, and it is the ordering the thread's own
// document is written in, so the two cannot disagree about which message came first.
const conversationOf = (id: string, first: MailMessage, rest: ReadonlyArray<MailMessage>): Conversation => {
  const ordered = inReceivedOrder([first, ...rest]);
  return {
    id,
    messageIds: ordered.map((message) => message.id),
    last: (ordered[ordered.length - 1] ?? first).received,
    oldest: (ordered[0] ?? first).id,
  };
};

const conversationsOf = (messages: ReadonlyArray<MailMessage>, since: string | undefined): ReadonlyArray<Conversation> => {
  // The first message of each conversation is held apart from the rest so the group is non-empty by
  // construction. Carrying a plain array instead would need a guard against emptiness that nothing
  // can reach, and an unreachable guard is dead code wearing a safety belt.
  const grouped = new Map<string, { readonly first: MailMessage; readonly rest: MailMessage[] }>();
  for (const message of messages) {
    if (message.conversationId.length === 0) continue;
    if (since !== undefined && message.received < since) continue;
    const held = grouped.get(message.conversationId);
    if (held === undefined) grouped.set(message.conversationId, { first: message, rest: [] });
    else held.rest.push(message);
  }
  return [...grouped.entries()].map(([id, held]) => conversationOf(id, held.first, held.rest)).sort((left, right) => left.last.localeCompare(right.last));
};

// One header read per conversation the run has never resolved, and never again for that one. The
// oldest message SWEPT is read rather than the thread's true oldest, and that is enough: every
// reply carries the same root, so any held message answers alike. It must not be the newest, since
// `list-conversation-messages` spans every folder and an unsent draft carries a newer time than any
// real message and no `References` at all.
const resolveThreads = async (deps: SyncMailboxDeps, state: MailboxState, conversations: ReadonlyArray<Conversation>): Promise<MailboxState> => {
  let current = state;
  for (const conversation of conversations) {
    if (threadOfConversation(current, conversation.id) !== undefined) continue;
    const headers = await deps.reader.messageHeaders(conversation.oldest);
    if (!headers.ok) {
      deps.logger.warn('thread.unresolved', { conversationId: conversation.id, cause: headers.error.kind });
      continue;
    }
    const root = rootMessageId(headers.value, conversation.oldest);
    current = withConversation(current, conversation.id, { threadId: threadIdOf(root), root });
  }
  return current;
};

// The cursors are saved once every folder has been swept, never one at a time: a cursor means "you
// have seen everything up to here", so storing one before its messages are queued would lose them
// for good. A sweep stopped halfway therefore costs a full re-sweep, which is the safe direction.
const queueWork = async (deps: SyncMailboxDeps, input: SyncMailboxInput, state: MailboxState, statePath: string): Promise<Result<MailboxState, StepError>> => {
  if (state.pending.length > 0) {
    deps.logger.info('mail.resuming', { pending: state.pending.length });
    return ok(state);
  }
  const folders = await folderTree(deps);
  if (!folders.ok) return stepFailure('listFolders', folders.error);
  let current = state;
  const messages: MailMessage[] = [];
  for (const folder of folders.value) {
    const swept = await sweepFolder(deps, current, folder);
    if (!swept.ok) return stepFailure('sweepFolder', swept.error);
    current = swept.value.state;
    messages.push(...swept.value.messages);
  }
  return finishQueue(deps, input, current, statePath, messages);
};

const finishQueue = async (
  deps: SyncMailboxDeps,
  input: SyncMailboxInput,
  state: MailboxState,
  statePath: string,
  messages: ReadonlyArray<MailMessage>
): Promise<Result<MailboxState, StepError>> => {
  const conversations = conversationsOf(messages, input.since);
  const dirty = conversations.filter((conversation) => needsRender(state, conversation.id, conversation.messageIds));
  deps.logger.info('mail.enumerated', { messages: messages.length, conversations: conversations.length, queued: dirty.length });
  const resolved = await resolveThreads(deps, state, dirty);
  const fresh = threadsToRender(resolved, dirty);
  const queued = withPending(cleared(resolved, fresh), [...fresh, ...retriedThreads(resolved.retry, fresh)]);
  const saved = await save(deps.files, statePath, queued, input.dryRun);
  return saved.ok ? ok(queued) : saved;
};

// A thread the sweep queued for itself is written from the messages the mailbox holds now, so what an
// earlier run remembered about it is settled either way and goes with the queueing.
const cleared = (state: MailboxState, fresh: ReadonlyArray<string>): MailboxState => fresh.reduce(withoutRetry, state);

// The queue holds THREADS, not conversations, and the grouping happens here rather than inside the
// window. Two conversations of one merged thread arriving in the same window would each decide the
// thread was new, each mint a folder for it, and each write a document holding only its own half:
// the second would overwrite the first, and `needsRender` would answer false for both from then on.
// A conversation left unresolved has no thread to be rendered into and waits for the next sweep.
const threadsToRender = (state: MailboxState, dirty: ReadonlyArray<Conversation>): ReadonlyArray<string> => {
  const threadIds = dirty.flatMap((conversation) => {
    const belongs = threadOfConversation(state, conversation.id);
    return belongs === undefined ? [] : [belongs.threadId];
  });
  return [...new Set(threadIds)];
};

// The render (with its IO) happens now; what it adds to the mailbox state comes back as a function
// so a whole window's results fold onto the state in order, after the parallel renders.
const renderOne = async (
  deps: SyncMailboxDeps,
  input: SyncMailboxInput,
  state: MailboxState,
  threadId: string
): Promise<{ readonly apply: (state: MailboxState) => MailboxState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> }> => {
  const held = conversationsInThread(state, threadId);
  const first = held[0];
  // A queue naming a thread no conversation points at has nothing to render. It is reachable: the
  // queue outlives a run, so a state file carrying a queue but not the map behind it lands here.
  // Skipping leaves it for the next sweep, where the conversation is resolved again.
  if (first === undefined) return { apply: (carried) => withoutRetry(carried, threadId), counted: { skipped: 1 }, notes: {} };
  const rendered = await deps.renderThread({
    threadId,
    conversationIds: held.map((conversation) => conversation.id),
    root: first.root,
    // Empty until a thread has been filed somewhere, and reused verbatim from then on, so a change
    // to the naming rules never moves a folder that is already written and already linked to.
    folder: state.threads[threadId]?.folder ?? '',
    maxBytes: input.maxBytes,
    linked: state.linked,
    attachments: state.attachments,
  });
  if (!rendered.ok) {
    deps.logger.warn('thread.failed', { cause: rendered.error.kind });
    const attempts = (state.retry[threadId]?.attempts ?? 0) + 1;
    // The ledger's own list names a thread that has run out of tries, so reporting it here as well
    // would print it twice under headings promising opposite things.
    const notes = attempts >= MAX_CONVERSION_ATTEMPTS ? {} : { failed: [{ path: `thread ${threadId}`, reason: rendered.error.message }] };
    return { apply: (carried) => withRetry(carried, threadId, { attempts, reason: rendered.error.message }), counted: { failed: 1 }, notes };
  }
  if (rendered.value.kind === 'empty') return { apply: (carried) => withoutRetry(carried, threadId), counted: { skipped: 1 }, notes: {} };
  return owing(state, threadId, rendered.value.thread);
};

// The thread landed; one of the files it carried did not. Nothing narrower than the thread can bring
// that file back, because the folder cursors moved on when its messages were swept and only the queue
// reaches it now, so the thread is remembered as owing and rendered whole again next run. Writing it
// twice costs the conversions of the files that already worked, which are content-addressed and land
// on the same paths, and the document itself has to be rewritten anyway to carry the recovered file's
// card.
//
// At the cap the record goes rather than staying, which is the opposite of what a thread that never
// rendered at all does. A thread that never rendered leaves nothing in `kb/`, so the report is the
// only place it exists; this one leaves an attachment card in its own folder carrying the reason,
// which no later run can take away. So the files are named once, as files, and the ledger lets go.
const owing = (
  state: MailboxState,
  threadId: string,
  thread: RenderedThread
): { readonly apply: (state: MailboxState) => MailboxState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> } => {
  const counted = { converted: 1, skipped: thread.filesSkipped.length, failed: thread.filesFailed.length };
  const attempts = (state.retry[threadId]?.attempts ?? 0) + 1;
  // The file this thread is still worth coming back for, or nothing: either it carried none, or it
  // has run out of tries. Held as the entry rather than a flag so the ledger's own line can name what
  // the thread is waiting on, which is the only thing a state file opened by hand has to go on.
  const owed = attempts < MAX_CONVERSION_ATTEMPTS ? thread.filesFailed[0] : undefined;
  const apply = (carried: MailboxState): MailboxState => {
    const recorded = recordThread(carried, threadId, thread);
    if (owed === undefined) return withoutRetry(recorded, threadId);
    return withRetry(recorded, threadId, { attempts, reason: `${owed.path}: ${owed.reason}` });
  };
  const failed = owed === undefined ? { givenUp: thread.filesFailed } : { failed: thread.filesFailed };
  return { apply, counted, notes: { skipped: thread.filesSkipped, ...failed } };
};

const recordThread = (
  state: MailboxState,
  threadId: string,
  thread: { readonly record: ThreadRecord; readonly linked: Readonly<Record<string, LinkedRecord>>; readonly attachments: Readonly<Record<string, AttachmentRecord>> }
): MailboxState => {
  const withRecord = withThread(state, threadId, thread.record);
  const withLinks = Object.entries(thread.linked).reduce((carried, [key, record]) => withLinked(carried, key, record), withRecord);
  return Object.entries(thread.attachments).reduce((carried, [hash, record]) => withAttachment(carried, hash, record), withLinks);
};

export const createSyncMailbox =
  (deps: SyncMailboxDeps): SyncMailbox =>
  async (input) => {
    const statePath = statePathOf(deps.kbRoot);
    const loaded = await loadMailboxState(deps.files, statePath, deps.logger);
    const queued = await queueWork(deps, input, loaded, statePath);
    if (!queued.ok) return queued;
    if (input.dryRun) return ok({ id: MAILBOX_ID, source: MAILBOX_NAME, summary: { ...EMPTY, queued: queued.value.pending.length }, notes: NO_NOTES });
    return drainQueue(deps, input, queued.value, statePath);
  };

const drainQueue = async (deps: SyncMailboxDeps, input: SyncMailboxInput, state: MailboxState, statePath: string): Promise<Result<SourceRun, StepError>> => {
  let current = state;
  let summary = EMPTY;
  let notes: RunNotes = NO_NOTES;
  deps.progress.start(current.pending.length, 'Rendering');
  for (;;) {
    if (current.pending.length === 0) break;
    const window = current.pending.slice(0, input.concurrency);
    const results = await Promise.all(
      window.map((threadId) => {
        deps.progress.begin(threadId);
        return renderOne(deps, input, current, threadId).then((outcome) => {
          deps.progress.step(threadId);
          return outcome;
        });
      })
    );
    const folded = results.reduce((carried, done) => done.apply(carried), current);
    const advanced = withPending(folded, current.pending.slice(window.length));
    const saved = await save(deps.files, statePath, advanced, input.dryRun);
    if (!saved.ok) {
      deps.progress.done();
      return saved;
    }
    current = advanced;
    for (const done of results) {
      summary = {
        ...summary,
        converted: summary.converted + (done.counted.converted ?? 0),
        skipped: summary.skipped + (done.counted.skipped ?? 0),
        failed: summary.failed + (done.counted.failed ?? 0),
      };
      notes = {
        skipped: [...notes.skipped, ...(done.notes.skipped ?? [])],
        failed: [...notes.failed, ...(done.notes.failed ?? [])],
        givenUp: [...notes.givenUp, ...(done.notes.givenUp ?? [])],
        archived: notes.archived,
      };
    }
  }
  deps.progress.done();
  const finished = { ...current, lastRun: deps.clock.nowIso() };
  const saved = await save(deps.files, statePath, finished, input.dryRun);
  if (!saved.ok) return saved;
  await writeIndexes(deps, input, finished);
  // Added to, never replacing: a run reports the files a rendered thread has stopped owing as well as
  // the threads the ledger still holds, and the two lists are filled from different places.
  const withAbandoned = {
    ...notes,
    givenUp: [...notes.givenUp, ...abandonedThreads(finished.retry).map((entry) => ({ path: `thread ${entry.threadId}`, reason: entry.reason }))],
  };
  await writeReport(deps, input, mailboxRoot(deps.kbRoot), MAILBOX_NAME, summary, withAbandoned);
  return ok({ id: MAILBOX_ID, source: MAILBOX_NAME, summary, notes: withAbandoned });
};
