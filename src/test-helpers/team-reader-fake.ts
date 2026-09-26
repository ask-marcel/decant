import type { ChannelPost } from '../domain/channel-post.ts';
import { err, ok } from '../domain/result.ts';
import type { ChannelSummary, TeamReader, TeamReaderError, TeamSummary } from '../use-cases/ports/team-reader.ts';

export type TeamReaderSeed = {
  readonly teams?: ReadonlyArray<TeamSummary>;
  readonly channels?: Readonly<Record<string, ReadonlyArray<ChannelSummary>>>;
  // What a channel's delta answers with, keyed by channel id, plus the cursor it hands back.
  readonly posts?: Readonly<Record<string, ReadonlyArray<ChannelPost>>>;
  readonly deltaLinks?: Readonly<Record<string, string>>;
  // What a channel's delta answers when read on from one cursor, in place of `posts`.
  readonly postsFrom?: Readonly<Record<string, ReadonlyArray<ChannelPost>>>;
  // The rendering of each post, keyed by post id; a post with no rendering here renders as its id.
  readonly markdown?: Readonly<Record<string, string>>;
  readonly failTeams?: TeamReaderError;
  readonly failChannels?: TeamReaderError;
  readonly failDelta?: TeamReaderError;
  // Only the posts named here fail to render, so one can fail while the rest land beside it.
  readonly failPosts?: ReadonlyArray<string>;
};

export type TeamReaderFake = TeamReader & { readonly calls: Array<string> };

export const createTeamReaderFake = (seed: TeamReaderSeed = {}): TeamReaderFake => {
  const calls: string[] = [];
  return {
    calls,
    listTeams: async () => {
      calls.push('listTeams');
      return seed.failTeams === undefined ? ok(seed.teams ?? []) : err(seed.failTeams);
    },
    listChannels: async (teamId) => {
      calls.push(`listChannels:${teamId}`);
      return seed.failChannels === undefined ? ok(seed.channels?.[teamId] ?? []) : err(seed.failChannels);
    },
    postsDelta: async (teamId, channelId, cursor) => {
      calls.push(`postsDelta:${channelId}:${cursor ?? 'fresh'}`);
      if (seed.failDelta !== undefined) return err(seed.failDelta);
      const deltaLink = seed.deltaLinks?.[channelId];
      const posts = (cursor === undefined ? undefined : seed.postsFrom?.[cursor]) ?? seed.posts?.[channelId] ?? [];
      return ok({ posts, ...(deltaLink === undefined ? {} : { deltaLink }) });
    },
    postMarkdown: async (teamId, channelId, postId) => {
      calls.push(`postMarkdown:${postId}`);
      if ((seed.failPosts ?? []).includes(postId)) return err({ kind: 'permanent', message: `cannot render ${postId}` });
      return ok(seed.markdown?.[postId] ?? `### rendered ${postId}`);
    },
  };
};
