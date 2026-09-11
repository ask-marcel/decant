import type { ChannelPost } from '../../domain/channel-post.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError } from './drive-reader.ts';

// A team fails the way the rest does: the same Graph client is underneath.
export type TeamReaderError = DriveReaderError;

export type TeamSummary = { readonly id: string; readonly name: string };

export type ChannelSummary = { readonly id: string; readonly name: string };

// What changed in a channel since the cursor, or the whole channel without one. Followed to its end
// before it is handed back, so the cursor that comes with it stands for all of it.
export type PostsDelta = { readonly posts: ReadonlyArray<ChannelPost>; readonly deltaLink?: string };

// Finding the teams and their channels, reading what changed in one, and rendering one post with
// its replies. The rendering is the library's, the way a mail message's is: it converts the Teams
// HTML, flattens the mentions, resolves the attachment links and quotes the replies, and a second
// rendering here would only drift from it.
export type TeamReader = {
  readonly listTeams: () => Promise<Result<ReadonlyArray<TeamSummary>, TeamReaderError>>;
  readonly listChannels: (teamId: string) => Promise<Result<ReadonlyArray<ChannelSummary>, TeamReaderError>>;
  readonly postsDelta: (teamId: string, channelId: string, cursor: string | undefined) => Promise<Result<PostsDelta, TeamReaderError>>;
  readonly postMarkdown: (teamId: string, channelId: string, postId: string) => Promise<Result<string, TeamReaderError>>;
};
