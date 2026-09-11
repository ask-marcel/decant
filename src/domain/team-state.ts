import type { ChannelPost } from './channel-post.ts';
import { postTitle } from './channel-post.ts';
import { CATEGORY_FOLDER } from './kb-category.ts';
import { disambiguateSegment, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import { datedRoot } from './output-paths.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export const TEAM_STATE_VERSION = 1;

export const teamRootName = (name: string): SafeRelPath => safeRelPath([CATEGORY_FOLDER.team, name]);

// One post already written, and where. `lastModified` is what a later run compares against, since a
// reply moves it as surely as an edit does; `file` is what moves aside when the post is refiled
// under a later day or deleted; `title` is what is left to call it by once the channel has dropped it.
export type PostRecord = { readonly file: string; readonly lastModified: string; readonly title: string };

// A channel is to a team what a library is to a site: it holds its own cursor and its own posts,
// and a team's state is the set of them. The name is kept so `update` can refresh a channel without
// listing the team's channels again.
export type ChannelState = { readonly name: string; readonly deltaLink?: string; readonly posts: Readonly<Record<string, PostRecord>> };

export type TeamState = {
  readonly version: typeof TEAM_STATE_VERSION;
  readonly source: { readonly kind: 'team'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly channels: Readonly<Record<string, ChannelState>>;
};

export type TeamStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyTeamState = (id: string, name: string): TeamState => ({ version: TEAM_STATE_VERSION, source: { kind: 'team', id, name }, lastRun: '', channels: {} });

export const serializeTeamState = (state: TeamState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const recordsOf = <T>(raw: unknown, parse: (entry: Record<string, unknown>) => T): Readonly<Record<string, T>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, parse(entry)] as const] : [])));
};

const postOf = (entry: Record<string, unknown>): PostRecord => ({
  file: readString(entry, 'file') ?? '',
  lastModified: readString(entry, 'lastModified') ?? '',
  title: readString(entry, 'title') ?? '',
});

const channelOf = (entry: Record<string, unknown>): ChannelState => {
  const deltaLink = readString(entry, 'deltaLink');
  return { name: readString(entry, 'name') ?? '', ...(deltaLink === undefined ? {} : { deltaLink }), posts: recordsOf(entry['posts'], postOf) };
};

export const parseTeamState = (raw: unknown): Result<TeamState, TeamStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'team') return err({ kind: 'malformed', message: 'state is not a team' });
  if (raw['version'] !== TEAM_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${TEAM_STATE_VERSION}` });
  return ok({
    version: TEAM_STATE_VERSION,
    source: { kind: 'team', id: readString(source, 'id') ?? '', name: readString(source, 'name') ?? '' },
    lastRun: readString(raw, 'lastRun') ?? '',
    channels: recordsOf(raw['channels'], channelOf),
  });
};

const channelIn = (state: TeamState, channelId: string, name: string): ChannelState => state.channels[channelId] ?? { name, posts: {} };

const withChannel = (state: TeamState, channelId: string, channel: ChannelState): TeamState => ({ ...state, channels: { ...state.channels, [channelId]: channel } });

export const withChannelCursor = (state: TeamState, channelId: string, name: string, deltaLink: string | undefined): TeamState =>
  withChannel(state, channelId, { ...channelIn(state, channelId, name), name, ...(deltaLink === undefined ? {} : { deltaLink }) });

export const withPost = (state: TeamState, channelId: string, name: string, postId: string, record: PostRecord): TeamState => {
  const channel = channelIn(state, channelId, name);
  return withChannel(state, channelId, { ...channel, posts: { ...channel.posts, [postId]: record } });
};

export const withoutPost = (state: TeamState, channelId: string, postId: string): TeamState => {
  const channel = state.channels[channelId];
  if (channel === undefined) return state;
  return withChannel(state, channelId, { ...channel, posts: Object.fromEntries(Object.entries(channel.posts).filter(([id]) => id !== postId)) });
};

export type ChannelWork = { readonly write: ReadonlyArray<ChannelPost>; readonly archive: ReadonlyArray<{ readonly id: string; readonly record: PostRecord }> };

// What a channel's delta page owes. A deleted post is put aside if it was ever written and is
// nothing otherwise; a post the ledger holds at the same `lastModified` is skipped, which is what
// makes re-reading a delta after a stopped run cost nothing; the rest is written, oldest change
// first so a stopped run leaves a prefix.
export const channelWork = (state: TeamState, channelId: string, posts: ReadonlyArray<ChannelPost>): ChannelWork => {
  const known = state.channels[channelId]?.posts ?? {};
  const archive = posts.flatMap((post) => {
    const record = known[post.id];
    return post.deleted && record !== undefined ? [{ id: post.id, record }] : [];
  });
  const write = posts
    .filter((post) => !post.deleted && known[post.id]?.lastModified !== post.lastModified)
    .sort((left, right) => left.lastModified.localeCompare(right.lastModified));
  return { write, archive };
};

export type PlannedPost = { readonly post: ChannelPost; readonly file: string };

const MARKDOWN = '.md';

const fileAt = (channelRoot: string, post: ChannelPost, name: string): string => `${datedRoot(channelRoot, post.lastModified)}/${name}`;

// Where each post about to be written goes, settled before any is written. Two posts can carry
// the same subject and last change on the same day; the second takes a suffix from its own id, as
// a document sharing a name in one library does. A path held by a post not being rewritten is taken.
export const planPostFiles = (channelRoot: string, posts: ReadonlyArray<ChannelPost>, state: TeamState, channelId: string): ReadonlyArray<PlannedPost> => {
  const rewriting = new Set(posts.map((post) => post.id));
  const taken = new Set(Object.entries(state.channels[channelId]?.posts ?? {}).flatMap(([id, record]) => (rewriting.has(id) ? [] : [record.file])));
  const planned: PlannedPost[] = [];
  for (const post of posts) {
    const name = `${safeSegment(postTitle(post))}${MARKDOWN}`;
    const plain = fileAt(channelRoot, post, name);
    const file = taken.has(plain) ? fileAt(channelRoot, post, disambiguateSegment(name, post.id)) : plain;
    taken.add(file);
    planned.push({ post, file });
  }
  return planned;
};
