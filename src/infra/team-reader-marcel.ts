import { parsePostsDelta } from '../domain/channel-post.ts';
import type { ChannelPost, PostsDeltaPage } from '../domain/channel-post.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { PostsDelta, TeamReader, TeamReaderError } from '../use-cases/ports/team-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// A team reads through four commands that arrived together in 2.7.0, all on Graph and the basic
// token. The channel delta is the same shape the drive and mail deltas are, cursors and all, and the
// post rendering answers the envelope `convert-mail-to-markdown` does.

// The most Graph allows on a channel delta; the library refuses more.
const PAGE_SIZE = '50';

// A thing Graph named with nothing is still offered, under its own id, rather than under a blank
// the operator could not tell from another blank.
const named = (raw: unknown): { readonly id: string; readonly name: string } | undefined => {
  const id = readString(raw, 'id');
  return id === undefined ? undefined : { id, name: readString(raw, 'displayName') ?? id };
};

const namedOf = (raw: unknown): ReadonlyArray<{ readonly id: string; readonly name: string }> =>
  listOf(raw).flatMap((entry: unknown) => {
    const found = named(entry);
    return found === undefined ? [] : [found];
  });

export const createTeamReaderFromCall = (call: MarcelCall): TeamReader => {
  const page = async (name: string, params: Record<string, string>): Promise<Result<PostsDeltaPage, TeamReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? ok(parsePostsDelta(raw.value)) : raw;
  };

  return {
    listTeams: async () => {
      const raw = await call('list-joined-teams', {});
      return raw.ok ? ok(namedOf(raw.value)) : raw;
    },
    listChannels: async (teamId) => {
      const raw = await call('list-team-channels', { teamId });
      return raw.ok ? ok(namedOf(raw.value)) : raw;
    },
    // Followed to its end before anything is handed back: a delta cut short would hand over a cursor
    // standing past posts nobody has read. The `seen` set is the guard the other sweeps keep, since
    // a cursor pointing at itself would otherwise page forever.
    postsDelta: async (teamId, channelId, cursor) => {
      const posts: ChannelPost[] = [];
      const seen = new Set<string>();
      let deltaLink: string | undefined;
      let next: { readonly name: string; readonly params: Record<string, string> } | undefined =
        cursor === undefined ? { name: 'list-team-channel-messages-delta', params: { teamId, channelId, top: PAGE_SIZE } } : { name: 'next-page', params: { url: cursor } };
      while (next !== undefined) {
        const answered: Result<PostsDeltaPage, TeamReaderError> = await page(next.name, next.params);
        if (!answered.ok) return answered;
        posts.push(...answered.value.posts);
        deltaLink = answered.value.deltaLink ?? deltaLink;
        const link = answered.value.nextLink;
        next = link === undefined || seen.has(link) ? undefined : { name: 'next-page', params: { url: link } };
        if (link !== undefined) seen.add(link);
      }
      const delta: PostsDelta = deltaLink === undefined ? { posts } : { posts, deltaLink };
      return ok(delta);
    },
    postMarkdown: async (teamId, channelId, postId) => {
      const raw = await call('convert-team-channel-message-to-markdown', { teamId, channelId, messageId: postId });
      return raw.ok ? ok(readString(raw.value, 'text') ?? '') : raw;
    },
  };
};
