import { chatFolderName, chatName } from './chat.ts';
import type { Chat, ChatKind } from './chat.ts';
import type { DayMessages } from './chat-document.ts';
import type { ChatMessage } from './chat-message.ts';
import { idHash } from './kb-path.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { isGivenUp, parseAttempts } from './retry-ledger.ts';
import type { Attempts } from './retry-ledger.ts';
import { isBefore, widens } from './sync-window.ts';
import { compareText } from './utilities/compare-text.ts';

export const CHATS_STATE_VERSION = 1;

// The chats are one source, the way the mailbox is: one folder, one state, one report.
export const CHATS_FOLDER = 'Chats';
export const CHATS_SOURCE = { kind: 'chats', id: 'chats', name: 'Chats' } as const;

// One day of a chat already written. `hash` is of the messages the note was made from, so a day read
// again with nothing changed is not written again; it is empty when a file or a picture of the day did
// not arrive, which is what has the day made again. `held` is every file the day keeps beside its
// note, and `links` and `versions` are what the linked files were named and pulled at.
export type DayRecord = {
  readonly file: string;
  readonly hash: string;
  readonly messages: number;
  readonly held?: ReadonlyArray<string>;
  readonly links?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, string>>;
};

// One chat already filed. The folder is kept as first given, whatever the chat is renamed to, and the
// name follows the chat. `since` is the day the chat was read back to, absent when it was read whole.
export type ChatRecord = {
  readonly name: string;
  readonly folder: string;
  readonly kind: ChatKind;
  readonly lastMessageAt: string;
  readonly since?: string;
  readonly days: Readonly<Record<string, DayRecord>>;
};

// Every chat, or the chats named one by one, by id.
export type Follow = 'all' | ReadonlyArray<string>;

export type ChatsState = {
  readonly version: typeof CHATS_STATE_VERSION;
  readonly source: typeof CHATS_SOURCE;
  readonly lastRun: string;
  readonly follow: Follow;
  readonly chats: Readonly<Record<string, ChatRecord>>;
  // The chats a read left unfinished, by chat id, three runs at most on the same last message.
  readonly retry?: Attempts;
};

export type ChatsStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyChatsState = (): ChatsState => ({ version: CHATS_STATE_VERSION, source: CHATS_SOURCE, lastRun: '', follow: [], chats: {} });

export const serializeChatsState = (state: ChatsState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const stringsOf = (raw: unknown): ReadonlyArray<string> => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []);

const namesOf = (raw: unknown): Readonly<Record<string, string>> =>
  isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};

const recordsOf = <T>(raw: unknown, parse: (entry: Record<string, unknown>) => T): Readonly<Record<string, T>> =>
  isRecord(raw) ? Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, parse(entry)] as const] : []))) : {};

const dayOf = (entry: Record<string, unknown>): DayRecord => ({
  file: readString(entry, 'file') ?? '',
  hash: readString(entry, 'hash') ?? '',
  messages: typeof entry['messages'] === 'number' ? entry['messages'] : 0,
  held: stringsOf(entry['held']),
  links: namesOf(entry['links']),
  versions: namesOf(entry['versions']),
});

const KINDS: ReadonlyArray<ChatKind> = ['oneOnOne', 'group', 'meeting'];

const kindOf = (raw: string | undefined): ChatKind => KINDS.find((kind) => kind === raw) ?? 'group';

const chatOf = (entry: Record<string, unknown>): ChatRecord => {
  const since = readString(entry, 'since');
  return {
    name: readString(entry, 'name') ?? '',
    folder: readString(entry, 'folder') ?? '',
    kind: kindOf(readString(entry, 'kind')),
    lastMessageAt: readString(entry, 'lastMessageAt') ?? '',
    ...(since === undefined ? {} : { since }),
    days: recordsOf(entry['days'], dayOf),
  };
};

// A state written by a version of decant that kept it another way is not read as this one: the run
// starts over in memory and leaves the file as it is.
export const parseChatsState = (raw: unknown): Result<ChatsState, ChatsStateError> => {
  if (!isRecord(raw) || raw['version'] !== CHATS_STATE_VERSION) return err({ kind: 'malformed', message: 'not a chats state of this version' });
  const retry = parseAttempts(raw['retry']);
  return ok({
    version: CHATS_STATE_VERSION,
    source: CHATS_SOURCE,
    lastRun: readString(raw, 'lastRun') ?? '',
    follow: raw['follow'] === 'all' ? 'all' : stringsOf(raw['follow']),
    chats: recordsOf(raw['chats'], chatOf),
    ...(retry === undefined ? {} : { retry }),
  });
};

// What a run asks for is added to what the runs before it asked for: every chat stays every chat, and
// a chat named now joins the ones named before.
export const following = (state: ChatsState, asked: Follow | undefined): ChatsState => {
  if (asked === undefined || state.follow === 'all') return state;
  return { ...state, follow: asked === 'all' ? 'all' : [...new Set([...state.follow, ...asked])] };
};

const isFollowed = (state: ChatsState, chat: Chat): boolean => state.follow === 'all' || state.follow.includes(chat.id);

// One chat to read: the folder it is filed in, and the day its messages are asked from, absent when
// the whole chat is.
export type ChatRead = { readonly chat: Chat; readonly folder: string; readonly from?: string };

const DAY_MS = 86_400_000;
const DAY_LENGTH = 'YYYY-MM-DD'.length;

// The day before, and none for a day nobody lived, which is where a message with no time is filed.
const dayBefore = (day: string): string | undefined => {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? undefined : new Date(at - DAY_MS).toISOString().slice(0, DAY_LENGTH);
};

const laterOf = (left: string | undefined, right: string | undefined): string | undefined => {
  if (left === undefined || right === undefined) return left ?? right;
  return left > right ? left : right;
};

// The day a chat is read from when it has something new: the first day that still waits for a file or
// a picture, else the last day filed. The read starts a day earlier, since a day of the knowledge base
// can open up to a day before the same day in UTC, which is what the source counts in.
const openDay = (record: ChatRecord): string | undefined => {
  const days = Object.keys(record.days).toSorted(compareText);
  return days.find((day) => record.days[day]?.hash === '') ?? days.at(-1);
};

const readFrom = (record: ChatRecord, since: string | undefined): string | undefined => {
  const open = openDay(record);
  return laterOf(open === undefined ? undefined : dayBefore(open), since);
};

type Reach = { readonly read: boolean; readonly from?: string };

const SKIP: Reach = { read: false };

const from = (day: string | undefined): Reach => (day === undefined ? { read: true } : { read: true, from: day });

// A chat out of tries on its last message waits for a new one. A chat never filed is read from the
// kept day, unless it holds nothing or went quiet before that day. A chat filed under a later day than
// the run now reaches is read again from the new day. Any other is read when its last message moved,
// or when a run before left it unfinished, from the last day it filed.
const reachOf = (state: ChatsState, chat: Chat, since: string | undefined): Reach => {
  const record = state.chats[chat.id];
  const attempt = state.retry?.[chat.id];
  if (isGivenUp(attempt, chat.lastMessageAt)) return SKIP;
  if (record === undefined) return chat.lastMessageAt === '' || isBefore(chat.lastMessageAt, since) ? SKIP : from(since);
  if (widens(record.since, since)) return from(since);
  if (record.lastMessageAt === chat.lastMessageAt && attempt === undefined) return SKIP;
  return from(readFrom(record, since));
};

// The chats this run reads, each with its folder. The folders are given here, one after the other and
// before any chat is read, so two new chats of one name never take one folder between them.
export const chatWork = (state: ChatsState, chats: ReadonlyArray<Chat>, since: string | undefined): ReadonlyArray<ChatRead> => {
  const taken = Object.values(state.chats).map((record) => record.folder);
  const reads: ChatRead[] = [];
  for (const chat of chats.filter((one) => isFollowed(state, one))) {
    const reach = reachOf(state, chat, since);
    if (!reach.read) continue;
    const folder = state.chats[chat.id]?.folder ?? chatFolderName(chat, taken);
    taken.push(folder);
    reads.push({ chat, folder, ...(reach.from === undefined ? {} : { from: reach.from }) });
  }
  return reads;
};

// What the note of a day was made from. A message edited, added or deleted changes it.
export const dayHash = (messages: ReadonlyArray<ChatMessage>): string => idHash(JSON.stringify(messages));

// What a read comes to for a chat: the days to write, and the days filed that it no longer holds.
export type DayWork = { readonly write: ReadonlyArray<DayMessages>; readonly gone: ReadonlyArray<string> };

// A read that starts on a day holds only a part of that day where the knowledge base counts its days,
// and is whole from the day after. A day filed is made again, or taken for gone, only from a read that
// holds all of it; a day never filed is written from what the read holds, which is where the reach of
// the run begins.
const isWhole = (day: string, readFromDay: string | undefined): boolean => readFromDay === undefined || readFromDay < day;

export const dayWork = (record: ChatRecord | undefined, readFromDay: string | undefined, days: ReadonlyArray<DayMessages>): DayWork => {
  const filed = record?.days ?? {};
  const write = days.filter(({ day, messages }) => filed[day] === undefined || (isWhole(day, readFromDay) && filed[day].hash !== dayHash(messages)));
  const read = new Set(days.map(({ day }) => day));
  const gone = Object.keys(filed).filter((day) => isWhole(day, readFromDay) && !read.has(day));
  return { write, gone };
};

// The record of a chat as this run found it: the name follows the chat, the folder stays.
export const chatRecord = (read: ChatRead, before: ChatRecord | undefined, since: string | undefined): ChatRecord => ({
  name: chatName(read.chat),
  folder: read.folder,
  kind: read.chat.kind,
  lastMessageAt: read.chat.lastMessageAt,
  ...(since === undefined ? {} : { since }),
  days: before?.days ?? {},
});

export const withDay = (record: ChatRecord, day: string, filed: DayRecord): ChatRecord => ({ ...record, days: { ...record.days, [day]: filed } });

export const withoutDay = (record: ChatRecord, day: string): ChatRecord => ({ ...record, days: Object.fromEntries(Object.entries(record.days).filter(([held]) => held !== day)) });

export const withChat = (state: ChatsState, chatId: string, record: ChatRecord): ChatsState => ({ ...state, chats: { ...state.chats, [chatId]: record } });
