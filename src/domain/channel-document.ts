import type { ChannelPost } from './channel-post.ts';
import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';

export type RenderPostInput = { readonly post: ChannelPost; readonly team: string; readonly channel: string; readonly markdown: string; readonly syncedAt: string };

// A channel post has a real address, which a mail thread and a task never had, so `source` is a link
// a reader can open. The words stand in only when Graph gave none.
const sourceOf = (input: RenderPostInput): string => (input.post.webUrl.length > 0 ? input.post.webUrl : `Teams channel - ${input.team} - ${input.channel}`);

// The front matter writes an empty string as `""`, a field deliberately left blank, where a post
// with no subject has no subject line at all.
const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

const fieldsOf = (input: RenderPostInput): ReadonlyArray<FrontMatterField> => [
  ['source', sourceOf(input)],
  ['team', input.team],
  ['channel', input.channel],
  ['subject', stated(input.post.subject)],
  ['author', stated(input.post.author)],
  ['created', stated(input.post.created)],
  ['last_modified', stated(input.post.lastModified)],
  ['synced_at', input.syncedAt],
];

// The body is the library's own rendering of the post and its replies, carried through untouched:
// the heading, the quoted replies, the edit and reaction markers are its, and a second rendering
// here would only drift from it.
export const renderPostDocument = (input: RenderPostInput): string => withFrontMatter(renderFrontMatter(fieldsOf(input)), input.markdown);
