import { describe, expect, it } from 'bun:test';
import { parseChannelPost, parsePostsDelta, postTitle } from './channel-post.ts';
import type { ChannelPost } from './channel-post.ts';

const graphPost = {
  id: '1757491200000',
  replyToId: null,
  etag: '1757491200000',
  messageType: 'message',
  createdDateTime: '2026-09-10T08:00:00.000Z',
  lastModifiedDateTime: '2026-09-10T09:30:00.000Z',
  deletedDateTime: null,
  subject: 'Venue for the offsite',
  importance: 'normal',
  webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1757491200000',
  from: { user: { id: '0000-jane', displayName: 'Jane Doe' } },
  body: { contentType: 'html', content: '<div>Three options, see below.</div>' },
  attachments: [],
};

const post = (over: Partial<ChannelPost> = {}): ChannelPost => ({
  id: '1757491200000',
  subject: '',
  author: 'Jane Doe',
  created: '2026-09-10T08:00:00.000Z',
  lastModified: '2026-09-10T09:30:00.000Z',
  deleted: false,
  webUrl: '',
  preview: '',
  ...over,
});

describe('reading a channel post as Graph answers for it', () => {
  it('a post carries what names it, who wrote it, when it last changed, and enough of its body to be named by', () => {
    expect(parseChannelPost(graphPost)).toEqual({
      id: '1757491200000',
      subject: 'Venue for the offsite',
      author: 'Jane Doe',
      created: '2026-09-10T08:00:00.000Z',
      lastModified: '2026-09-10T09:30:00.000Z',
      deleted: false,
      webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1757491200000',
      preview: 'Three options, see below.',
    });
  });

  it('a membership event, a call, or anything else the client wrote is not a post', () => {
    expect(parseChannelPost({ ...graphPost, messageType: 'systemEventMessage' })).toBeUndefined();
    expect(parseChannelPost({ ...graphPost, messageType: 'unknownFutureValue' })).toBeUndefined();
  });

  it('a reply is not a post either: its root is what the delta reports, and the root renders its replies', () => {
    expect(parseChannelPost({ ...graphPost, replyToId: '1757400000000' })).toBeUndefined();
  });

  it('a post Graph has deleted is a post still, marked so, since its copy on disk has to be put aside', () => {
    expect(parseChannelPost({ ...graphPost, deletedDateTime: '2026-09-11T10:00:00Z', body: null })?.deleted).toBe(true);
  });

  it('a post with no id is no post, and one with nothing else is a post with blanks', () => {
    expect(parseChannelPost({ messageType: 'message' })).toBeUndefined();
    expect(parseChannelPost('nope')).toBeUndefined();
    expect(parseChannelPost({ id: '1', messageType: 'message' })).toEqual(post({ id: '1', author: '', created: '', lastModified: '', preview: '' }));
  });

  it('a post from an application rather than a person is written by the application', () => {
    expect(parseChannelPost({ ...graphPost, from: { user: null, application: { id: 'app', displayName: 'Planner' } } })?.author).toBe('Planner');
  });

  it('the preview is the first line of the body with the markup gone, cut short where a filename would get long', () => {
    const long = { ...graphPost, subject: null, body: { contentType: 'html', content: `<p>${'word '.repeat(40)}</p><p>second paragraph</p>` } };

    expect(parseChannelPost(long)?.preview).toBe(`${'word '.repeat(40)}`.trim().slice(0, 80));
    expect(parseChannelPost({ ...graphPost, body: { contentType: 'text', content: 'plain &amp; simple\nsecond' } })?.preview).toBe('plain & simple');
  });
});

describe('naming a post the way a person would find it', () => {
  it('a post with a subject is named by it', () => {
    expect(postTitle(post({ subject: 'Venue for the offsite', preview: 'Three options' }))).toBe('Venue for the offsite');
  });

  it('a post with no subject is named by what it opens with, and one with nothing at all by its id', () => {
    expect(postTitle(post({ preview: 'Three options, see below.' }))).toBe('Three options, see below.');
    expect(postTitle(post({ id: '42' }))).toBe('post 42');
  });
});

describe('reading a page of the channel delta', () => {
  it('a page holds the posts it reports and whichever cursor Graph put on it, with the percent-escaped dollar read back', () => {
    const page = parsePostsDelta({
      value: [graphPost, { ...graphPost, id: '2', messageType: 'systemEventMessage' }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/delta?%24skiptoken=abc',
    });

    expect(page.posts.map((entry) => entry.id)).toEqual(['1757491200000']);
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/delta?$skiptoken=abc');
    expect(page.deltaLink).toBeUndefined();
  });

  it('a final page carries the cursor to ask later with, and a page with no value array holds nothing', () => {
    expect(parsePostsDelta({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?%24deltatoken=z' }).deltaLink).toBe(
      'https://graph.microsoft.com/v1.0/x?$deltatoken=z'
    );
    expect(parsePostsDelta('nope').posts).toHaveLength(0);
  });
});
