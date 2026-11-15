import { chatName } from '../domain/chat.ts';
import type { Chat } from '../domain/chat.ts';
import { byDay } from '../domain/chat-document.ts';
import { chatIndexPage, chatsIndexPage } from '../domain/chat-index.ts';
import {
  CHATS_FOLDER,
  CHATS_SOURCE,
  chatRecord,
  chatWork,
  dayWork,
  emptyChatsState,
  following,
  parseChatsState,
  serializeChatsState,
  withChat,
  withDay,
  withoutDay,
} from '../domain/chat-state.ts';
import type { ChatRead, ChatRecord, ChatsState, DayRecord, Follow } from '../domain/chat-state.ts';
import { INDEX_FILE } from '../domain/index-page.ts';
import { sameIgnoringCase } from '../domain/kb-path.ts';
import type { ReportEntry } from '../domain/report.ts';
import { withGaveUp } from '../domain/report.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { clearAttempt, gaveUpNotes, givenUpNotes, isGivenUp, nextAttempt, recordAttempt } from '../domain/retry-ledger.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { writeDay } from './chat-day.ts';
import type { ChatDayDeps, DayPlace } from './chat-day.ts';
import { inPool } from './in-pool.ts';
import type { ChatReader } from './ports/chat-reader.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import { putAside } from './put-aside.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const CHATS_STATE_FILE = '.sync-state.json';

export type SyncChatsDeps = Omit<ChatDayDeps, 'reader' | 'progress'> & { readonly reader: ChatReader; readonly progress: Progress };

// The chats are one source: every chat, or the ones named run after run, each read from the last day
// it filed. Only messages written on or after `since` are filed; absent, every message is.
export type SyncChatsInput = {
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly maxBytes: number;
  readonly since?: string;
  // Follow every chat from this run on.
  readonly all?: boolean;
  // Follow one more chat, named by its topic, by somebody in it, or by its id.
  readonly chat?: string;
};

export type SyncChats = (input: SyncChatsInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

export const chatsRoot = (kbRoot: string): string => `${kbRoot}/${CHATS_FOLDER}`;

const loadState = async (deps: SyncChatsDeps): Promise<ChatsState> => {
  const text = await deps.files.readText(`${chatsRoot(deps.kbRoot)}/${CHATS_STATE_FILE}`);
  const parsed = text.ok ? parseJson(text.value) : undefined;
  if (parsed?.ok !== true) return emptyChatsState();
  const state = parseChatsState(parsed.value);
  if (state.ok) return state.value;
  // Left where it is and started over in memory, never written back over until a chat lands: the
  // notes on disk are the valuable half.
  deps.logger.warn('chats-state.unreadable', { cause: state.error.message });
  return emptyChatsState();
};

const holds = (text: string, asked: string): boolean => text.toLowerCase().includes(asked.toLowerCase());

// How many names a refusal lists before it stops.
const NAMED_IN_REFUSAL = 10;

// A chat is named by its id, by its whole name, or by a part of its name or of somebody in it. A name
// that fits more than one chat is refused with the chats it fits, so the run never files a chat
// nobody meant.
const chatNamed = (chats: ReadonlyArray<Chat>, asked: string): Result<Chat, StepError> => {
  const exact = chats.filter((chat) => chat.id === asked || sameIgnoringCase(chatName(chat), asked));
  const found = exact.length > 0 ? exact : chats.filter((chat) => holds(chatName(chat), asked) || chat.members.some((member) => holds(member, asked)));
  const [only, ...others] = found;
  if (only === undefined) return failed('findChat', 'bad-choice', `no chat of yours is named ${asked}`);
  if (others.length === 0) return ok(only);
  const names = found.slice(0, NAMED_IN_REFUSAL).map(chatName).join('; ');
  return failed('findChat', 'bad-choice', `${asked} names ${found.length} chats, give more of the name or the id: ${names}`);
};

const askedOf = (input: SyncChatsInput, chats: ReadonlyArray<Chat>): Result<Follow | undefined, StepError> => {
  if (input.all === true) return ok('all');
  if (input.chat === undefined) return ok(undefined);
  const named = chatNamed(chats, input.chat);
  return named.ok ? ok([named.value.id]) : named;
};

// What reading one chat came to. No record means its messages could not be read, and the chat is as
// it was.
type ChatDone = {
  readonly record?: ChatRecord;
  readonly written: number;
  readonly failed: ReadonlyArray<ReportEntry>;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly archived: ReadonlyArray<ReportEntry>;
};

const placeOf = (deps: SyncChatsDeps, input: SyncChatsInput, read: ChatRead): DayPlace => ({
  chatId: read.chat.id,
  name: chatName(read.chat),
  kind: read.chat.kind,
  members: read.chat.members,
  root: `${chatsRoot(deps.kbRoot)}/${read.folder}`,
  maxBytes: input.maxBytes,
});

// A day the chat no longer holds goes under the archive with what it kept beside its note.
const archiveDay = async (deps: SyncChatsDeps, place: DayPlace, day: string, filed: DayRecord): Promise<ReportEntry> => {
  for (const missed of await putAside(deps, [filed.file, ...(filed.held ?? [])])) {
    deps.logger.warn('archive.failed', { path: missed.path, cause: missed.error.kind });
  }
  return { path: `${place.name}/${day}`, reason: 'no message left at the source' };
};

const readChat = async (deps: SyncChatsDeps, input: SyncChatsInput, state: ChatsState, read: ChatRead): Promise<ChatDone> => {
  const place = placeOf(deps, input, read);
  deps.progress.begin(place.name);
  const messages = await deps.reader.messages(read.chat.id, read.from);
  if (!messages.ok) {
    deps.logger.warn('chat.unread', { chat: read.chat.id, cause: messages.error.kind });
    return { written: 0, failed: [{ path: place.name, reason: `its messages could not be read: ${messages.error.message}` }], skipped: [], archived: [] };
  }
  const before = state.chats[read.chat.id];
  const work = dayWork(before, read.from, byDay(messages.value, deps.timezone));
  let record = chatRecord(read, before, input.since);
  const done: { written: number; failed: ReportEntry[]; skipped: ReportEntry[]; archived: ReportEntry[] } = { written: 0, failed: [], skipped: [], archived: [] };
  for (const day of work.write) {
    const filed = await writeDay(deps, place, day, before?.days[day.day]);
    done.failed.push(...filed.failed);
    done.skipped.push(...filed.skipped);
    if (filed.record === undefined) continue;
    record = withDay(record, day.day, filed.record);
    done.written += 1;
  }
  for (const [day, filed] of Object.entries(record.days).filter(([held]) => work.gone.includes(held))) {
    done.archived.push(await archiveDay(deps, place, day, filed));
    record = withoutDay(record, day);
  }
  return { record, ...done };
};

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: ChatsState };

// A chat with something that did not arrive is tried again on the next run, three runs in all on the
// same last message. Out of tries, it is named under its own heading, not as a failure to try again.
const withTries = (state: ChatsState, read: ChatRead, done: ChatDone): { readonly state: ChatsState; readonly failed: ReadonlyArray<ReportEntry> } => {
  const version = read.chat.lastMessageAt;
  const [first] = done.failed;
  if (first === undefined) return { state: { ...state, retry: clearAttempt(state.retry, read.chat.id) }, failed: [] };
  const attempt = nextAttempt(state.retry?.[read.chat.id], version, chatName(read.chat), first.reason);
  return { state: { ...state, retry: recordAttempt(state.retry, read.chat.id, attempt) }, failed: isGivenUp(attempt, version) ? [] : done.failed };
};

const fold = (carried: Progressing, read: ChatRead, done: ChatDone): Progressing => {
  const filed = done.record === undefined ? carried.state : withChat(carried.state, read.chat.id, done.record);
  const tried = withTries(filed, read, done);
  return {
    state: tried.state,
    summary: {
      ...carried.summary,
      converted: carried.summary.converted + done.written,
      archived: carried.summary.archived + done.archived.length,
      skipped: carried.summary.skipped + done.skipped.length,
      failed: carried.summary.failed + (done.failed.length > 0 ? 1 : 0),
    },
    notes: {
      ...carried.notes,
      failed: [...carried.notes.failed, ...tried.failed],
      skipped: [...carried.notes.skipped, ...done.skipped],
      archived: [...carried.notes.archived, ...done.archived],
    },
  };
};

const save = async (deps: SyncChatsDeps, state: ChatsState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${chatsRoot(deps.kbRoot)}/${CHATS_STATE_FILE}`, serializeChatsState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

// A page that will not write is logged and leaves the run standing: the notes themselves landed.
const writePage = async (deps: SyncChatsDeps, path: string, page: string): Promise<void> => {
  const written = await deps.files.writeText(path, page);
  if (!written.ok) deps.logger.warn('index.failed', { path, cause: written.error.kind });
};

type Outcome = { readonly progressing: Progressing; readonly saved: Result<undefined, StepError> };

// Every place of the limit stays busy: a chat that ends hands its place to the next one. Each chat
// is folded into the state and saved as it ends, so a run that stops keeps what it filed.
const readChats = async (deps: SyncChatsDeps, input: SyncChatsInput, state: ChatsState, reads: ReadonlyArray<ChatRead>): Promise<Outcome> => {
  let progressing: Progressing = { summary: EMPTY, notes: NO_NOTES, state };
  let saved: Result<undefined, StepError> = ok(undefined);
  deps.progress.start(reads.length, CHATS_SOURCE.name);
  await inPool(
    reads,
    input.concurrency,
    (read) => readChat(deps, input, state, read),
    async (read, done) => {
      progressing = fold(progressing, read, done);
      const record = progressing.state.chats[read.chat.id];
      if (record !== undefined) await writePage(deps, `${chatsRoot(deps.kbRoot)}/${record.folder}/${INDEX_FILE}`, chatIndexPage(record));
      saved = await save(deps, progressing.state);
      deps.progress.step(chatName(read.chat));
      return saved.ok;
    }
  );
  deps.progress.done();
  return { progressing, saved };
};

export const createSyncChats =
  (deps: SyncChatsDeps): SyncChats =>
  async (input) => {
    const loaded = await loadState(deps);
    const chats = await deps.reader.listChats();
    if (!chats.ok) return failed('listChats', chats.error.kind, chats.error.message);
    const asked = askedOf(input, chats.value);
    if (!asked.ok) return asked;
    const state = following(loaded, asked.value);
    const reads = chatWork(state, chats.value, input.since);
    if (input.dryRun) return ok({ ...CHATS_SOURCE, source: CHATS_SOURCE.name, summary: { ...EMPTY, queued: reads.length }, notes: NO_NOTES });
    const { progressing, saved } = await readChats(deps, input, state, reads);
    if (!saved.ok) return saved;
    // Saved once at the end as well as per chat, so a run that found nothing to read still stamps its
    // own file and keeps what it was asked to follow.
    const stamped = await save(deps, progressing.state);
    if (!stamped.ok) return stamped;
    await writePage(deps, `${chatsRoot(deps.kbRoot)}/${INDEX_FILE}`, chatsIndexPage(progressing.state, deps.timezone));
    const after = progressing.state.retry;
    const notes = withGaveUp({ ...progressing.notes, givenUp: givenUpNotes(after) }, gaveUpNotes(loaded.retry, after));
    await writeReport(deps, input, chatsRoot(deps.kbRoot), CHATS_SOURCE.name, progressing.summary, notes);
    return ok({ id: CHATS_SOURCE.id, source: CHATS_SOURCE.name, summary: progressing.summary, notes });
  };
