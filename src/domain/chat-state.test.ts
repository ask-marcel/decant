import { describe, expect, it } from 'bun:test';
import type { Chat } from './chat.ts';
import type { ChatMessage } from './chat-message.ts';
import {
  CHATS_SOURCE,
  chatRecord,
  chatWork,
  dayHash,
  dayWork,
  emptyChatsState,
  following,
  parseChatsState,
  serializeChatsState,
  withChat,
  withDay,
  withoutDay,
} from './chat-state.ts';
import type { ChatRecord, ChatsState } from './chat-state.ts';

const JANE = '19:0000-jane_0000-me@unq.gbl.spaces';
const BUDGET = '19:aaa111@thread.v2';

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: BUDGET,
  kind: 'group',
  topic: 'Budget review',
  members: ['Jane Doe', 'Li Wei'],
  lastMessageAt: '2026-11-13T02:15:30.1230000Z',
  ...over,
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1',
  author: 'Jane Doe',
  sent: '2026-11-13T02:15:30.1230000Z',
  text: 'hello',
  files: [],
  pictures: 0,
  webUrl: '',
  ...over,
});

const record = (over: Partial<ChatRecord> = {}): ChatRecord => ({
  name: 'Budget review',
  folder: 'Budget review',
  kind: 'group',
  lastMessageAt: '2026-11-13T02:15:30.1230000Z',
  days: { '2026-11-13': { file: 'kb/Chats/Budget review/2026-11-13.md', hash: 'h13', messages: 1 } },
  ...over,
});

const state = (over: Partial<ChatsState> = {}): ChatsState => ({ ...emptyChatsState(), follow: 'all', ...over });

describe('keeping the state of the chats', () => {
  it('a state read back is the state that was saved', () => {
    const saved: ChatsState = {
      ...state({ lastRun: '2026-11-14T01:00:00.000Z' }),
      chats: {
        [BUDGET]: record({
          since: '2026-11-01',
          days: {
            '2026-11-13': {
              file: 'kb/Chats/Budget review/2026-11-13.md',
              hash: 'h13',
              messages: 2,
              held: ['kb/Chats/Budget review/2026-11-13/_linked/Budget.xlsx.md'],
              links: { 'd1:i1': 'Budget.xlsx' },
              versions: { 'd1:i1': 'v7' },
            },
          },
        }),
      },
      retry: { [BUDGET]: { attempts: 1, version: '2026-11-13T02:15:30.1230000Z', name: 'Budget review', reason: 'a file did not arrive' } },
    };

    expect(parseChatsState(JSON.parse(serializeChatsState(saved)))).toEqual({ ok: true, value: saved });
    expect(serializeChatsState(saved).endsWith('}\n')).toBe(true);
  });

  it('a state that names its chats one by one is read back naming them, and one with no ledger has none', () => {
    const named = state({ follow: [BUDGET] });

    expect(parseChatsState(JSON.parse(serializeChatsState(named)))).toEqual({ ok: true, value: named });
  });

  it('a state of another version, or one that is no state at all, is refused', () => {
    expect(parseChatsState({ ...state(), version: 2 }).ok).toBe(false);
    expect(parseChatsState('chats')).toEqual({ ok: false, error: { kind: 'malformed', message: 'not a chats state of this version' } });
    expect(parseChatsState([])).toMatchObject({ ok: false });
  });

  it('a record that lost a field reads with nothing in its place, and an entry that is no record is dropped', () => {
    const raw = {
      version: 1,
      source: CHATS_SOURCE,
      chats: { [BUDGET]: { kind: 'channel', days: { '2026-11-13': { messages: '2' }, broken: 7 } }, lost: 'x' },
      follow: [BUDGET, 7],
    };

    expect(parseChatsState(raw)).toEqual({
      ok: true,
      value: {
        ...emptyChatsState(),
        follow: [BUDGET],
        chats: {
          [BUDGET]: { name: '', folder: '', kind: 'group', lastMessageAt: '', days: { '2026-11-13': { file: '', hash: '', messages: 0, held: [], links: {}, versions: {} } } },
        },
      },
    });
  });
});

describe('which chats a run follows', () => {
  it('a run that asks for nothing follows what the runs before it followed', () => {
    expect(following(state({ follow: [BUDGET] }), undefined).follow).toEqual([BUDGET]);
  });

  it('a chat named now joins the ones named before, once', () => {
    expect(following(state({ follow: [BUDGET] }), [JANE, BUDGET]).follow).toEqual([BUDGET, JANE]);
  });

  it('every chat stays every chat, whatever is named after', () => {
    expect(following(state({ follow: [BUDGET] }), 'all').follow).toBe('all');
    expect(following(state({ follow: 'all' }), [JANE]).follow).toBe('all');
  });

  it('a state that follows names does not take a new chat, and one that follows every chat takes it', () => {
    const chats = [chat(), chat({ id: JANE, kind: 'oneOnOne', topic: '', members: ['Jane Doe'] })];

    expect(chatWork(state({ follow: [BUDGET] }), chats, undefined).map((read) => read.chat.id)).toEqual([BUDGET]);
    expect(chatWork(state(), chats, undefined).map((read) => read.chat.id)).toEqual([BUDGET, JANE]);
  });
});

describe('which chats a run reads, and from which day', () => {
  it('a chat never filed is read from the kept day, or whole when the run reaches everything', () => {
    expect(chatWork(state(), [chat()], '2026-11-01')).toEqual([{ chat: chat(), folder: 'Budget review', from: '2026-11-01' }]);
    expect(chatWork(state(), [chat()], undefined)).toEqual([{ chat: chat(), folder: 'Budget review' }]);
  });

  it('a chat never filed that holds nothing, or went quiet before the kept day, is not read', () => {
    expect(chatWork(state(), [chat({ lastMessageAt: '' })], undefined)).toStrictEqual([]);
    expect(chatWork(state(), [chat({ lastMessageAt: '2026-10-31T23:59:59.0000000Z' })], '2026-11-01')).toStrictEqual([]);
    expect(chatWork(state(), [chat({ lastMessageAt: '2026-11-01T00:00:00.0000000Z' })], '2026-11-01')).toHaveLength(1);
  });

  it('a chat whose last message is the one recorded is not read', () => {
    expect(chatWork(state({ chats: { [BUDGET]: record() } }), [chat()], undefined)).toStrictEqual([]);
  });

  it('a chat with a new message is read from the day before the last day it filed, into the folder it has', () => {
    const known = state({ chats: { [BUDGET]: record({ folder: 'Old name', days: { '2026-11-10': record().days['2026-11-13']!, '2026-11-13': record().days['2026-11-13']! } }) } });
    const moved = chat({ lastMessageAt: '2026-11-14T09:00:00.0000000Z' });

    expect(chatWork(known, [moved], undefined)).toEqual([{ chat: moved, folder: 'Old name', from: '2026-11-12' }]);
    expect(chatWork(known, [moved], '2026-11-01')[0]?.from).toBe('2026-11-12');
    expect(chatWork(known, [moved], '2026-11-13')[0]?.from).toBe('2026-11-13');
  });

  it('a chat with a day that still waits for a file is read from the day before that day', () => {
    const waiting = record({ days: { '2026-11-10': { file: 'a.md', hash: '', messages: 1 }, '2026-11-13': record().days['2026-11-13']! } });

    expect(chatWork(state({ chats: { [BUDGET]: waiting } }), [chat({ lastMessageAt: '2026-11-14T09:00:00.0000000Z' })], undefined)[0]?.from).toBe('2026-11-09');
  });

  it('a chat filed with no day at all, or only under the day nobody lived, is read from the kept day', () => {
    const moved = chat({ lastMessageAt: '2026-11-14T09:00:00.0000000Z' });

    expect(chatWork(state({ chats: { [BUDGET]: record({ days: {} }) } }), [moved], '2026-11-01')[0]?.from).toBe('2026-11-01');
    expect(chatWork(state({ chats: { [BUDGET]: record({ days: { '0000-00-00': record().days['2026-11-13']! } }) } }), [moved], undefined)).toEqual([
      { chat: moved, folder: 'Budget review' },
    ]);
  });

  it('an earlier kept day reads a chat again from the new day, though its last message did not move', () => {
    const known = state({ chats: { [BUDGET]: record({ since: '2026-11-01' }) } });

    expect(chatWork(known, [chat()], '2026-10-01')[0]?.from).toBe('2026-10-01');
    expect(chatWork(known, [chat()], undefined)).toEqual([{ chat: chat(), folder: 'Budget review' }]);
    expect(chatWork(known, [chat()], '2026-11-05')).toStrictEqual([]);
  });

  it('a chat a run left unfinished is read again while it has tries left on the same last message, and no more after three', () => {
    const version = chat().lastMessageAt;
    const tried = (attempts: number, on = version): ChatsState =>
      state({ chats: { [BUDGET]: record() }, retry: { [BUDGET]: { attempts, version: on, name: 'Budget review', reason: 'x' } } });

    expect(chatWork(tried(1), [chat()], undefined)).toHaveLength(1);
    expect(chatWork(tried(3), [chat()], undefined)).toStrictEqual([]);
    expect(chatWork(tried(3, 'an earlier message'), [chat()], undefined)).toHaveLength(1);
  });

  it('a chat never filed that is out of tries on its last message is not read until a new message comes', () => {
    const version = chat().lastMessageAt;
    const givenUp = state({ retry: { [BUDGET]: { attempts: 3, version, name: 'Budget review', reason: 'x' } } });

    expect(chatWork(givenUp, [chat()], undefined)).toStrictEqual([]);
    expect(chatWork(givenUp, [chat({ lastMessageAt: '2026-11-14T09:00:00.0000000Z' })], undefined)).toHaveLength(1);
  });

  it('two new chats of one name are given different folders before either is read, and neither takes the folder of a chat filed before', () => {
    const filed = state({ chats: { other: record({ folder: 'jane doe' }) } });
    const first = chat({ id: JANE, kind: 'oneOnOne', topic: '', members: ['Jane Doe'] });
    const second = chat({ id: '19:ccc333@thread.v2', topic: 'Jane Doe' });

    const folders = chatWork(filed, [first, second], undefined).map((read) => read.folder);

    expect(new Set(folders.map((folder) => folder.toLowerCase())).size).toBe(2);
    expect(folders.every((folder) => /^Jane Doe-[0-9a-f]{8}$/.test(folder))).toBe(true);
  });
});

describe('which days of a chat a read comes to', () => {
  const day13 = { day: '2026-11-13', messages: [message()] };
  const day14 = { day: '2026-11-14', messages: [message({ id: '2', sent: '2026-11-14T03:00:00.0000000Z' })] };

  it('every day of a chat never filed is written', () => {
    expect(dayWork(undefined, '2026-11-01', [day13, day14])).toEqual({ write: [day13, day14], gone: [] });
  });

  it('a day whose messages are the ones its note was made from is not written again, and one that changed is', () => {
    const filed = record({
      days: {
        '2026-11-13': { file: 'a.md', hash: dayHash(day13.messages), messages: 1 },
        '2026-11-14': { file: 'b.md', hash: dayHash([message({ id: '2', text: 'before the edit' })]), messages: 1 },
      },
    });

    expect(dayWork(filed, '2026-11-12', [day13, day14])).toEqual({ write: [day14], gone: [] });
  });

  it('a day that waits for a file is written again though its messages did not change', () => {
    const filed = record({ days: { '2026-11-13': { file: 'a.md', hash: '', messages: 1 } } });

    expect(dayWork(filed, '2026-11-12', [day13]).write).toEqual([day13]);
  });

  it('a day filed is left as it is when the read began on that day, since the read holds only a part of it', () => {
    const filed = record({ days: { '2026-11-13': { file: 'a.md', hash: 'whole day', messages: 9 } } });

    expect(dayWork(filed, '2026-11-13', [day13, day14])).toEqual({ write: [day14], gone: [] });
    expect(dayWork(filed, '2026-11-14', [day14])).toEqual({ write: [day14], gone: [] });
  });

  it('a day filed that a whole read no longer holds is gone, and a day the read did not reach is kept', () => {
    const filed = record({ days: { '2026-11-10': record().days['2026-11-13']!, '2026-11-13': record().days['2026-11-13']! } });

    expect(dayWork(filed, '2026-11-12', [day14])).toEqual({ write: [day14], gone: ['2026-11-13'] });
    expect(dayWork(filed, undefined, [day14]).gone).toEqual(['2026-11-10', '2026-11-13']);
  });

  it('the hash of a day moves with a message edited, added or taken away, and with nothing else', () => {
    expect(dayHash([message()])).toBe(dayHash([message()]));
    expect(dayHash([message({ text: 'edited' })])).not.toBe(dayHash([message()]));
    expect(dayHash([message(), message({ id: '2' })])).not.toBe(dayHash([message()]));
    expect(dayHash([message()])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recording a chat', () => {
  const read = { chat: chat({ topic: 'Budget 2027', lastMessageAt: '2026-11-14T09:00:00.0000000Z' }), folder: 'Budget review' };

  it('the record takes the name the chat has now and its last message, and keeps the folder and the days it had', () => {
    expect(chatRecord(read, record(), '2026-11-01')).toEqual({ ...record(), name: 'Budget 2027', lastMessageAt: '2026-11-14T09:00:00.0000000Z', since: '2026-11-01' });
  });

  it('a chat read whole records no day it was read back to, and a new chat starts with no day filed', () => {
    expect(chatRecord(read, undefined, undefined)).toEqual({
      name: 'Budget 2027',
      folder: 'Budget review',
      kind: 'group',
      lastMessageAt: '2026-11-14T09:00:00.0000000Z',
      days: {},
    });
  });

  it('a day is added to a chat, taken off it, and the chat put in the state, each without touching the rest', () => {
    const added = withDay(record(), '2026-11-14', { file: 'b.md', hash: 'h14', messages: 3 });

    expect(Object.keys(added.days)).toEqual(['2026-11-13', '2026-11-14']);
    expect(withoutDay(added, '2026-11-13').days).toEqual({ '2026-11-14': { file: 'b.md', hash: 'h14', messages: 3 } });
    expect(withChat(state({ chats: { other: record() } }), BUDGET, added).chats).toEqual({ other: record(), [BUDGET]: added });
  });
});
