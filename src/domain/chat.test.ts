import { describe, expect, it } from 'bun:test';
import { chatFolderName, chatName, parseChat } from './chat.ts';
import type { Chat } from './chat.ts';

const OWN = '0000-me';

const member = (id: string, displayName?: string): Record<string, unknown> => ({
  mri: `8:orgid:${id}`,
  objectId: id,
  role: 'Admin',
  ...(displayName === undefined ? {} : { displayName }),
});

// One entry of `list-teams-chats-with-messages`, as the chat substrate answers it.
const substrateChat = {
  id: '19:aaa111@thread.v2',
  title: 'Budget review',
  chatType: 'chat',
  threadType: 'chat',
  createdAt: '2026-10-01T08:00:00.000Z',
  members: [member(OWN, 'Me Myself'), member('0000-jane', 'Jane Doe'), member('0000-li', 'Li Wei')],
  lastMessage: { id: '1794536130123', composeTime: '2026-11-13T02:15:30.1230000Z', imDisplayName: 'Jane Doe', content: '<p>ok</p>' },
};

const chat = (over: Partial<Chat> = {}): Chat => ({ id: '19:aaa111@thread.v2', kind: 'group', topic: '', members: [], lastMessageAt: '2026-11-13T02:15:30.1230000Z', ...over });

describe('reading a chat as the Teams substrate lists it', () => {
  it('a group chat keeps its id, its topic, the other members, and when its last message was written', () => {
    expect(parseChat(substrateChat, OWN)).toEqual({
      id: '19:aaa111@thread.v2',
      kind: 'group',
      topic: 'Budget review',
      members: ['Jane Doe', 'Li Wei'],
      lastMessageAt: '2026-11-13T02:15:30.1230000Z',
    });
  });

  it('the id says what a chat is: two people, a meeting, or a group', () => {
    expect(parseChat({ ...substrateChat, id: '19:0000-jane_0000-me@unq.gbl.spaces', title: null }, OWN)?.kind).toBe('oneOnOne');
    expect(parseChat({ ...substrateChat, id: '19:meeting_NjY2@thread.v2', title: 'Weekly sync' }, OWN)?.kind).toBe('meeting');
    expect(parseChat({ ...substrateChat, id: '19:meeting_NjY2@thread.v2', title: 'Weekly sync' }, OWN)?.topic).toBe('Weekly sync');
  });

  it('a member the substrate gave no name is left out, and a chat with no id, or nothing in it yet, is not one to read', () => {
    const bare = { ...substrateChat, title: null, members: [member(OWN, 'Me Myself'), member('0000-ext'), 'not a member'], lastMessage: undefined };

    expect(parseChat(bare, OWN)).toEqual({ id: '19:aaa111@thread.v2', kind: 'group', topic: '', members: [], lastMessageAt: '' });
    expect(parseChat({ ...substrateChat, id: undefined }, OWN)).toBeUndefined();
    expect(parseChat({ ...substrateChat, members: undefined }, OWN)?.members).toStrictEqual([]);
  });

  it('when the reader could not say who is signed in, every named member is kept', () => {
    expect(parseChat(substrateChat, undefined)?.members).toEqual(['Me Myself', 'Jane Doe', 'Li Wei']);
  });
});

describe('naming a chat', () => {
  it('a group chat with a topic is named by its topic, and a meeting chat by the title of its meeting', () => {
    expect(chatName(chat({ topic: 'Budget review', members: ['Jane Doe'] }))).toBe('Budget review');
    expect(chatName(chat({ kind: 'meeting', topic: 'Weekly sync', members: ['Jane Doe', 'Li Wei'] }))).toBe('Weekly sync');
  });

  it('a chat between two people is named by the other one', () => {
    expect(chatName(chat({ kind: 'oneOnOne', members: ['Jane Doe'] }))).toBe('Jane Doe');
  });

  it('a group chat with no topic is named by its members, cut after four names', () => {
    expect(chatName(chat({ members: ['Jane Doe', 'Li Wei', 'Sam Roe', 'Ana Lima'] }))).toBe('Jane Doe, Li Wei, Sam Roe, Ana Lima');
    expect(chatName(chat({ members: ['Jane Doe', 'Li Wei', 'Sam Roe', 'Ana Lima', 'Tom Poe', 'Kim Yu'] }))).toBe('Jane Doe, Li Wei, Sam Roe, Ana Lima and 2 more');
  });

  it('a chat with no topic and nobody named in it still has a name to be filed under', () => {
    expect(chatName(chat())).toBe('Unnamed chat');
  });
});

describe('the folder a chat is filed in', () => {
  it('is its name, made safe for a path', () => {
    expect(chatFolderName(chat({ topic: 'Q4: plan/review' }), [])).toBe('Q4_ plan_review');
  });

  it('two chats with one name get different folders, whatever the letter case of the first', () => {
    const first = chatFolderName(chat({ id: '19:aaa111@thread.v2', topic: 'Jane Doe' }), []);
    const second = chatFolderName(chat({ id: '19:bbb222@thread.v2', kind: 'oneOnOne', members: ['Jane Doe'] }), ['jane doe']);

    expect(first).toBe('Jane Doe');
    expect(second).toMatch(/^Jane Doe-[0-9a-f]{8}$/);
  });
});
