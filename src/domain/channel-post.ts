import { canonicalCursor } from './utilities/graph-cursor.ts';

// One root post in a channel of a Microsoft Team, as the channel delta answers for it. Only what
// the sync needs to decide and to file: the post and its replies are rendered by the library, so
// the body travels here only as far as a preview to name the file by.
export type ChannelPost = {
  readonly id: string;
  readonly subject: string;
  readonly author: string;
  readonly created: string;
  // Moved by an edit and by a reply, since a fresh reply updates its root. This is what says the
  // document on disk is behind, and the day the document is filed under.
  readonly lastModified: string;
  readonly deleted: boolean;
  // A real link, which Graph gives for a channel post where it gives none for a mail or a task.
  readonly webUrl: string;
  readonly preview: string;
};

export type PostsDeltaPage = { readonly posts: ReadonlyArray<ChannelPost>; readonly nextLink?: string; readonly deltaLink?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

// What a person or an app wrote, as opposed to a member added, a channel renamed, or a call. Graph
// names the first `message` and everything else something else.
const MESSAGE = 'message';

// A reply is reached through its root: the delta reports the root when a reply lands, and the root
// renders its replies beneath it, so a reply on its own would be written twice.
const isRootPost = (raw: Record<string, unknown>): boolean => raw['messageType'] === MESSAGE && (raw['replyToId'] === null || raw['replyToId'] === undefined);

// A person signs a post through `from.user`; an app, through `from.application`.
const authorOf = (raw: Record<string, unknown>): string => {
  const from = raw['from'];
  return readString(isRecord(from) ? from['user'] : undefined, 'displayName') ?? readString(isRecord(from) ? from['application'] : undefined, 'displayName') ?? '';
};

const PREVIEW_LENGTH = 80;
const TAGS = /<[^<>]+>/g;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const NAMED_ENTITY = /&([a-z]+);/gi;

// Enough of the body to name the file by: the first line with the markup gone. The body itself is
// not read here, since the library renders the whole thread and a second reading would drift.
const previewOf = (body: unknown): string => {
  const text = (readString(body, 'content') ?? '')
    .replace(TAGS, '\n')
    .replace(NAMED_ENTITY, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (text ?? '').slice(0, PREVIEW_LENGTH);
};

export const parseChannelPost = (raw: unknown): ChannelPost | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined || !isRootPost(raw)) return undefined;
  return {
    id,
    subject: readString(raw, 'subject') ?? '',
    author: authorOf(raw),
    created: readString(raw, 'createdDateTime') ?? '',
    lastModified: readString(raw, 'lastModifiedDateTime') ?? '',
    deleted: typeof raw['deletedDateTime'] === 'string',
    webUrl: readString(raw, 'webUrl') ?? '',
    preview: previewOf(raw['body']),
  };
};

// A post with a subject is found by it; most have none, and are found by what they open with.
export const postTitle = (post: ChannelPost): string => {
  if (post.subject.length > 0) return post.subject;
  return post.preview.length > 0 ? post.preview : `post ${post.id}`;
};

const listOf = (value: unknown): ReadonlyArray<unknown> => (isRecord(value) && Array.isArray(value['value']) ? value['value'] : []);

export const parsePostsDelta = (raw: unknown): PostsDeltaPage => {
  const posts = listOf(raw).flatMap((entry) => {
    const post = parseChannelPost(entry);
    return post === undefined ? [] : [post];
  });
  const nextLink = canonicalCursor(readString(raw, '@odata.nextLink'));
  const deltaLink = canonicalCursor(readString(raw, '@odata.deltaLink'));
  return { posts, ...(nextLink === undefined ? {} : { nextLink }), ...(deltaLink === undefined ? {} : { deltaLink }) };
};
