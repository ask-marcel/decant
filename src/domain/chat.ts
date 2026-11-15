import { freeSegment, holdsIgnoringCase, safeSegment } from './kb-path.ts';

// Two people, a group, or the chat of a meeting. Teams keeps all three in one list.
export type ChatKind = 'oneOnOne' | 'group' | 'meeting';

// One chat of the signed-in person, as `list-teams-chats-with-messages` lists it. `members` are the
// others in it, by name. `lastMessageAt` is what a later run compares against: a chat whose last
// message did not move has nothing new to read.
export type Chat = {
  readonly id: string;
  readonly kind: ChatKind;
  readonly topic: string;
  readonly members: ReadonlyArray<string>;
  readonly lastMessageAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

// The id is the one field that says what a chat is in a form Microsoft documents: a chat between two
// people ends `@unq.gbl.spaces`, and the chat of a meeting opens `19:meeting_`.
const kindOf = (id: string): ChatKind => {
  if (id.endsWith('@unq.gbl.spaces')) return 'oneOnOne';
  return id.startsWith('19:meeting_') ? 'meeting' : 'group';
};

// The signed-in person is a member of every chat, and a chat named after them names nothing. A member
// from another organisation can come with an id and no name: there is nothing to call them by.
const othersOf = (raw: unknown, ownId: string | undefined): ReadonlyArray<string> => {
  const members = Array.isArray(raw) ? raw : [];
  return members.flatMap((member: unknown) => {
    const name = readString(member, 'displayName');
    return name === undefined || readString(member, 'objectId') === ownId ? [] : [name];
  });
};

export const parseChat = (raw: unknown, ownId: string | undefined): Chat | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  return {
    id,
    kind: kindOf(id),
    topic: readString(raw, 'title') ?? '',
    members: othersOf(raw['members'], ownId),
    lastMessageAt: readString(raw['lastMessage'], 'composeTime') ?? '',
  };
};

// How many members name a chat before the rest are counted.
const NAMED_MEMBERS = 4;

// A chat with a topic is found by it, and a meeting's chat carries the meeting's title as its topic.
// Without one, Teams itself shows the chat under the names of the others in it.
export const chatName = (chat: Chat): string => {
  if (chat.topic.length > 0) return chat.topic;
  if (chat.members.length === 0) return 'Unnamed chat';
  const named = chat.members.slice(0, NAMED_MEMBERS).join(', ');
  const more = chat.members.length - NAMED_MEMBERS;
  return more > 0 ? `${named} and ${more} more` : named;
};

// The folder a chat is first filed in, which it keeps: a name another chat's folder holds takes a
// suffix cut from its own id, so two chats with one person, or two meetings of one title, stay apart.
export const chatFolderName = (chat: Chat, taken: ReadonlyArray<string>): string =>
  freeSegment(safeSegment(chatName(chat)), chat.id, (candidate) => holdsIgnoringCase(taken, candidate));
