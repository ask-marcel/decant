import type { ChatKind } from './chat.ts';
import type { ChatRecord, ChatsState } from './chat-state.ts';
import { INDEX_FILE, indexDay, renderIndexPage } from './index-page.ts';
import { compareText } from './utilities/compare-text.ts';

const KIND_WORDS: Readonly<Record<ChatKind, string>> = { oneOnOne: 'one-to-one', group: 'group', meeting: 'meeting' };

// Every chat as a reader scans them: the one written in last first, under the day of that message, by
// its name and what kind of chat it is. A chat with no day filed has no page to link to and is left
// out. Two chats at one moment keep the order of their ids, so the page does not change between runs
// that changed nothing.
export const chatsIndexPage = (state: ChatsState, zone: string): string => {
  const rows = Object.entries(state.chats)
    .filter(([, record]) => Object.keys(record.days).length > 0)
    .toSorted(([leftId, left], [rightId, right]) => compareText(right.lastMessageAt, left.lastMessageAt) || compareText(leftId, rightId))
    .map(([, record]) => ({ day: indexDay(record.lastMessageAt, zone), title: record.name, file: `${record.folder}/${INDEX_FILE}`, note: KIND_WORDS[record.kind] }));
  return renderIndexPage('Chats', [{ heading: 'By last message', rows }]);
};

const counted = (messages: number): string => (messages === 1 ? '1 message' : `${messages} messages`);

// One chat as a reader scans it: each day it was written in, the latest first, with how much was said.
export const chatIndexPage = (record: ChatRecord): string => {
  const rows = Object.entries(record.days)
    .toSorted(([left], [right]) => compareText(left, right))
    .toReversed()
    .map(([day, filed]) => ({ day: '', title: day, file: `${day}.md`, note: counted(filed.messages) }));
  return renderIndexPage(record.name, [{ heading: 'By day', rows }]);
};
