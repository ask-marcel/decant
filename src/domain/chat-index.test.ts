import { describe, expect, it } from 'bun:test';
import { chatIndexPage, chatsIndexPage } from './chat-index.ts';
import { emptyChatsState } from './chat-state.ts';
import type { ChatRecord, DayRecord } from './chat-state.ts';

const ZONE = 'Asia/Shanghai';

const day = (messages: number): DayRecord => ({ file: 'unused', hash: 'h', messages });

const record = (over: Partial<ChatRecord> = {}): ChatRecord => ({
  name: 'Budget review',
  folder: 'Budget review',
  kind: 'group',
  lastMessageAt: '2026-11-13T02:15:30.1230000Z',
  days: { '2026-11-13': day(2) },
  ...over,
});

describe('the page that lists every chat', () => {
  it('lists each chat under the day of its last message, the latest first, by its name and what kind of chat it is', () => {
    const chats = {
      'b-older': record({ name: 'Jane Doe', folder: 'Jane Doe', kind: 'oneOnOne', lastMessageAt: '2026-11-10T23:30:00.0000000Z' }),
      'c-latest': record({ name: 'Weekly sync', folder: 'Weekly sync-1a2b3c4d', kind: 'meeting', lastMessageAt: '2026-11-14T01:00:00.0000000Z' }),
      'a-middle': record(),
    };

    expect(chatsIndexPage({ ...emptyChatsState(), chats }, ZONE)).toBe(
      [
        '# Chats',
        '',
        '## By last message',
        '',
        '- 2026-11-14 · [Weekly sync](<Weekly sync-1a2b3c4d/_index.md>) · meeting',
        '- 2026-11-13 · [Budget review](<Budget review/_index.md>) · group',
        '- 2026-11-11 · [Jane Doe](<Jane Doe/_index.md>) · one-to-one',
        '',
      ].join('\n')
    );
  });

  it('two chats written in at one moment keep the order of their ids, and a chat with no day filed is left out', () => {
    const chats = { 'id-2': record({ name: 'Second' }), 'id-1': record({ name: 'First' }), 'id-0': record({ name: 'Nothing filed', days: {} }) };

    const page = chatsIndexPage({ ...emptyChatsState(), chats }, ZONE);

    expect(page.indexOf('[First]')).toBeLessThan(page.indexOf('[Second]'));
    expect(page).not.toContain('Nothing filed');
  });

  it('says so when no chat is filed yet', () => {
    expect(chatsIndexPage(emptyChatsState(), ZONE)).toBe('# Chats\n\nNothing here yet.\n');
  });
});

describe('the page that lists the days of one chat', () => {
  it('lists each day, the latest first, with how many messages it holds', () => {
    const days = { '2026-11-10': day(1), '2026-11-13': day(2), '2026-11-11': day(14) };

    expect(chatIndexPage(record({ days }))).toBe(
      [
        '# Budget review',
        '',
        '## By day',
        '',
        '- [2026-11-13](2026-11-13.md) · 2 messages',
        '- [2026-11-11](2026-11-11.md) · 14 messages',
        '- [2026-11-10](2026-11-10.md) · 1 message',
        '',
      ].join('\n')
    );
  });
});
