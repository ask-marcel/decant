import type { ChannelPost } from './channel-post.ts';
import { postTitle } from './channel-post.ts';
import { CATEGORY_FOLDER } from './kb-category.ts';
import { freePath, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import { datedRoot } from './output-paths.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { isBefore } from './sync-window.ts';
import { compareText } from './utilities/compare-text.ts';
import { isGivenUp, parseAttempts } from './retry-ledger.ts';
import type { Attempts } from './retry-ledger.ts';

export const TEAM_STATE_VERSION = 1;

export const teamRootName = (name: string): SafeRelPath => safeRelPath([CATEGORY_FOLDER.team, name]);

// One post already written, and where. `lastModified` is what a later run compares against, since a
// reply moves it as surely as an edit does; `file` is what moves aside when the post is refiled
// under a later day or deleted; `title` is what is left to call it by once the channel has dropped it.
export type PostRecord = { readonly file: string; readonly lastModified: string; readonly title: string };

// A channel is to a team what a library is to a site: it holds its own cursor and its own posts,
// and a team's state is the set of them. The name is kept so `update` can refresh a channel without
// listing the team's channels again. `since` is the day the cursor was taken reaching back to,
// absent when it reached everything: a run reaching further back reads the channel from the start.
export type ChannelState = { readonly name: string; readonly deltaLink?: string; readonly since?: string; readonly posts: Readonly<Record<string, PostRecord>> };

export type TeamState = {
  readonly version: typeof TEAM_STATE_VERSION;
  readonly source: { readonly kind: 'team'; readonly id: string; readonly name: string };
  readonly lastRun: string;
  readonly channels: Readonly<Record<string, ChannelState>>;
  // The posts that would not render, by post id, three runs at most on the same version.
  readonly retry?: Attempts;
  // The layout the posts on disk were filed in. Absent is the first one, under the day each post last
  // changed; `TEAMS_LAYOUT` files them under the day they were first posted.
  readonly layout?: number;
};

export const TEAMS_LAYOUT = 2;

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
  return { name: readString(entry, 'name') ?? '', ...(deltaLink === undefined ? {} : { deltaLink }), since: readString(entry, 'since'), posts: recordsOf(entry['posts'], postOf) };
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
    retry: parseAttempts(raw['retry']),
    layout: typeof raw['layout'] === 'number' ? raw['layout'] : undefined,
  });
};

const channelIn = (state: TeamState, channelId: string, name: string): ChannelState => state.channels[channelId] ?? { name, posts: {} };

const withChannel = (state: TeamState, channelId: string, channel: ChannelState): TeamState => ({ ...state, channels: { ...state.channels, [channelId]: channel } });

// The day a cursor was taken reaching back to moves with it, and stays behind with it: no day means
// it reached everything.
export const withChannelCursor = (state: TeamState, channelId: string, name: string, deltaLink: string | undefined, since?: string): TeamState =>
  withChannel(state, channelId, { ...channelIn(state, channelId, name), name, ...(deltaLink === undefined ? {} : { deltaLink, since }) });

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
// first so a stopped run leaves a prefix. A post last changed before the day is left out.
export const channelWork = (state: TeamState, channelId: string, posts: ReadonlyArray<ChannelPost>, since?: string): ChannelWork => {
  const known = state.channels[channelId]?.posts ?? {};
  const archive = posts.flatMap((post) => {
    const record = known[post.id];
    return post.deleted && record !== undefined ? [{ id: post.id, record }] : [];
  });
  const write = posts
    .filter(
      (post) => !post.deleted && known[post.id]?.lastModified !== post.lastModified && !isBefore(post.lastModified, since) && !isGivenUp(state.retry?.[post.id], post.lastModified)
    )
    .sort((left, right) => compareText(left.lastModified, right.lastModified));
  return { write, archive };
};

export type PlannedPost = { readonly post: ChannelPost; readonly file: string };

const MARKDOWN = '.md';

// Where each post about to be written goes, settled before any is written. A post is filed under the
// day it was first posted, which no reply moves, so a link into it keeps working. Two posts can carry
// the same subject on the same day; the second takes a suffix from its own id, as a document sharing
// a name in one library does. A path another post's record holds is taken, even
// when that post is rewritten this run too: its file is put aside only once its own write lands,
// which can come after a namesake's write to the same path. A post's own copy never stands in its way.
export const planPostFiles = (channelRoot: string, posts: ReadonlyArray<ChannelPost>, state: TeamState, channelId: string, budget?: number): ReadonlyArray<PlannedPost> => {
  const known = state.channels[channelId]?.posts ?? {};
  const taken = new Set(Object.values(known).map((record) => record.file));
  const planned: PlannedPost[] = [];
  for (const post of posts) {
    const file = freePath(datedRoot(channelRoot, post.created), `${safeSegment(postTitle(post))}${MARKDOWN}`, post.id, taken, known[post.id]?.file, budget);
    taken.add(file);
    planned.push({ post, file });
  }
  return planned;
};

// A post's id is the moment it was first posted, in milliseconds, so a post filed by an earlier
// layout can be filed again without asking Teams for it. An id of any other shape says nothing.
const POSTED_ID = /^\d{13}$/;

const postedOn = (id: string): string | undefined => (POSTED_ID.test(id) ? new Date(Number(id)).toISOString() : undefined);

const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

export type RefiledChannel = { readonly channel: ChannelState; readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string }> };

// A channel as the current layout files it, and the files to move to get there: each post from the
// day it last changed to the day it was first posted, under the name it already has.
export const refileChannel = (channelRoot: string, channel: ChannelState, budget?: number): RefiledChannel => {
  const taken = new Set(Object.values(channel.posts).map((record) => record.file));
  const moves: { from: string; to: string }[] = [];
  const posts = Object.fromEntries(
    Object.entries(channel.posts).map(([id, record]) => {
      const posted = postedOn(id);
      if (posted === undefined) return [id, record] as const;
      taken.delete(record.file);
      const file = freePath(datedRoot(channelRoot, posted), baseName(record.file), id, taken, record.file, budget);
      taken.add(file);
      if (file !== record.file) moves.push({ from: record.file, to: file });
      return [id, { ...record, file }] as const;
    })
  );
  return { channel: { ...channel, posts }, moves };
};
