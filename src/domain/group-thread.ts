import type { MailMessage } from './mail-message.ts';

// One thread in a Microsoft 365 group inbox, as `list-group-threads` answers for it. Graph's own
// `preview` is deliberately not carried: it is a few hundred characters of the latest post cut mid
// line, and the posts underneath hold the real text.
export type GroupThread = {
  readonly id: string;
  readonly topic: string;
  // What the thread is dated by. Its newest post, which is what Graph sorts on and therefore the
  // only field an incremental sweep can stop at, since group threads have no delta endpoint.
  readonly lastDelivered: string;
  readonly hasAttachments: boolean;
};

// Graph addresses a post as `/groups/{g}/threads/{t}/posts/{p}` and needs all three parts to fetch
// it again, while the rendering path speaks in one opaque id per message and always has. So the
// three travel joined and are split again by the adapter that joined them; nothing in between ever
// looks inside. The separator is safe because a Graph id is base64url plus `=` padding, and `|` is
// in neither alphabet. A thread is addressed by the first two alone, which is what the rendering
// path asks for when it asks for a conversation.
const REF_SEPARATOR = '|';

export const threadRef = (groupId: string, threadId: string): string => [groupId, threadId].join(REF_SEPARATOR);

export const postRef = (groupId: string, threadId: string, postId: string): string => [groupId, threadId, postId].join(REF_SEPARATOR);

export type PostRef = { readonly groupId: string; readonly threadId: string; readonly postId: string };

export const refParts = (ref: string): PostRef | undefined => {
  const [groupId, threadId, postId] = ref.split(REF_SEPARATOR);
  return groupId === undefined || threadId === undefined ? undefined : { groupId, threadId, postId: postId ?? '' };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

export const parseGroupThread = (raw: unknown): GroupThread | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw, 'id');
  return id === undefined
    ? undefined
    : { id, topic: readString(raw, 'topic') ?? '', lastDelivered: readString(raw, 'lastDeliveredDateTime') ?? '', hasAttachments: raw['hasAttachments'] === true };
};

const correspondentOf = (raw: unknown): MailMessage['from'] => {
  if (!isRecord(raw) || !isRecord(raw['emailAddress'])) return undefined;
  const address = readString(raw['emailAddress'], 'address');
  return address === undefined ? undefined : { name: readString(raw['emailAddress'], 'name') ?? address, address };
};

// A post as the rendering path already reads a message, so a group thread becomes a document by the
// same route a mail thread does. Three fields are answered from the thread rather than the post:
// `sender` is the person who wrote it where `from` is the group's own address, so a reader is shown
// who spoke; a post carries no subject, the thread's topic being it; and no recipients, the group
// itself being the recipient.
export const parseGroupPost = (raw: unknown, thread: GroupThread, groupId: string): MailMessage | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw, 'id');
  if (id === undefined) return undefined;
  return {
    id: postRef(groupId, thread.id, id),
    conversationId: threadRef(groupId, thread.id),
    subject: thread.topic,
    received: readString(raw, 'receivedDateTime') ?? '',
    hasAttachments: raw['hasAttachments'] === true,
    from: correspondentOf(raw['sender']) ?? correspondentOf(raw['from']),
    to: [],
    isDeleted: false,
  };
};
