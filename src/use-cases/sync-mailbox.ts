import type { MailFolder } from '../domain/mail-folder.ts';
import { syncableFolders } from '../domain/mail-folder.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { MailboxState, ThreadRecord } from '../domain/mail-state.ts';
import { emptyMailboxState, needsRender, parseMailboxState, serializeMailboxState, withFolderCursor, withLinked, withPending, withThread } from '../domain/mail-state.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { MailReader, MailReaderError } from './ports/mail-reader.ts';
import type { StepError } from './ports/step-error.ts';
import type { Clock } from './ports/clock.ts';
import type { RenderThread } from './render-thread.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const MAIL_STATE_FILE = '.sync-state.json';

export type SyncMailboxDeps = {
  readonly reader: MailReader;
  readonly files: Files;
  readonly renderThread: RenderThread;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly kbRoot: string;
};

export type SyncMailboxInput = {
  readonly maxBytes: number;
  readonly ocrLabel: string;
  readonly dryRun: boolean;
  // Only conversations touched on or after this day are written. Applied to what the sweep
  // returned rather than to the sweep itself: Outlook's delta does not narrow by date.
  readonly since?: string;
};

export type SyncMailbox = (input: SyncMailboxInput) => Promise<Result<RunSummary, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const mailboxRoot = (kbRoot: string): string => `${kbRoot}/Mailbox`;

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

const conversationsOf = (
  messages: ReadonlyArray<MailMessage>,
  since: string | undefined
): ReadonlyArray<{ readonly id: string; readonly messageIds: ReadonlyArray<string>; readonly last: string }> => {
  const grouped = new Map<string, { messageIds: string[]; last: string }>();
  for (const message of messages) {
    if (message.conversationId.length === 0) continue;
    if (since !== undefined && message.received < since) continue;
    const entry = grouped.get(message.conversationId) ?? { messageIds: [], last: '' };
    entry.messageIds.push(message.id);
    entry.last = entry.last > message.received ? entry.last : message.received;
    grouped.set(message.conversationId, entry);
  }
  return [...grouped.entries()].map(([id, entry]) => ({ id, messageIds: entry.messageIds, last: entry.last })).sort((left, right) => left.last.localeCompare(right.last));
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
  const queued = withPending(
    state,
    dirty.map((conversation) => conversation.id)
  );
  const saved = await save(deps.files, statePath, queued, input.dryRun);
  return saved.ok ? ok(queued) : saved;
};

const renderOne = async (
  deps: SyncMailboxDeps,
  input: SyncMailboxInput,
  state: MailboxState,
  conversationId: string
): Promise<{ readonly state: MailboxState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> }> => {
  const rendered = await deps.renderThread({
    conversationId,
    maxBytes: input.maxBytes,
    ocrLabel: input.ocrLabel,
    linked: state.linked,
  });
  if (!rendered.ok) {
    deps.logger.warn('thread.failed', { cause: rendered.error.kind });
    return { state, counted: { failed: 1 }, notes: { failed: [{ path: `conversation ${conversationId}`, reason: rendered.error.message }] } };
  }
  if (rendered.value.kind === 'empty') return { state, counted: { skipped: 1 }, notes: {} };
  const thread = rendered.value.thread;
  return {
    state: recordThread(state, conversationId, thread),
    counted: { converted: 1, skipped: thread.attachmentsSkipped.length, failed: thread.attachmentsFailed.length },
    notes: { skipped: thread.attachmentsSkipped, failed: thread.attachmentsFailed },
  };
};

const recordThread = (
  state: MailboxState,
  conversationId: string,
  thread: { readonly record: ThreadRecord; readonly linked: Readonly<Record<string, { readonly path: string }>> }
): MailboxState => {
  const withRecord = withThread(state, conversationId, thread.record);
  return Object.entries(thread.linked).reduce((carried, [key, record]) => withLinked(carried, key, record), withRecord);
};

export const createSyncMailbox =
  (deps: SyncMailboxDeps): SyncMailbox =>
  async (input) => {
    const statePath = statePathOf(deps.kbRoot);
    const loaded = await loadMailboxState(deps.files, statePath, deps.logger);
    const queued = await queueWork(deps, input, loaded, statePath);
    if (!queued.ok) return queued;
    if (input.dryRun) return ok({ ...EMPTY, queued: queued.value.pending.length });
    return drainQueue(deps, input, queued.value, statePath);
  };

const drainQueue = async (deps: SyncMailboxDeps, input: SyncMailboxInput, state: MailboxState, statePath: string): Promise<Result<RunSummary, StepError>> => {
  let current = state;
  let summary = EMPTY;
  let notes: RunNotes = { skipped: [], failed: [], archived: [] };
  for (;;) {
    const conversationId = current.pending[0];
    if (conversationId === undefined) break;
    const done = await renderOne(deps, input, current, conversationId);
    const advanced = withPending(done.state, done.state.pending.slice(1));
    const saved = await save(deps.files, statePath, advanced, input.dryRun);
    if (!saved.ok) return saved;
    current = advanced;
    summary = {
      ...summary,
      converted: summary.converted + (done.counted.converted ?? 0),
      skipped: summary.skipped + (done.counted.skipped ?? 0),
      failed: summary.failed + (done.counted.failed ?? 0),
    };
    notes = { skipped: [...notes.skipped, ...(done.notes.skipped ?? [])], failed: [...notes.failed, ...(done.notes.failed ?? [])], archived: notes.archived };
  }
  const finished = { ...current, lastRun: deps.clock.nowIso() };
  const saved = await save(deps.files, statePath, finished, input.dryRun);
  if (!saved.ok) return saved;
  await writeReport(deps, input, mailboxRoot(deps.kbRoot), 'Mailbox', summary, notes);
  return ok(summary);
};
