import { describe, expect, it } from 'bun:test';
import { renderPostDocument } from './channel-document.ts';
import type { ChannelPost } from './channel-post.ts';

const post: ChannelPost = {
  id: '1757491200000',
  subject: 'Venue for the offsite',
  author: 'Jane Doe',
  created: '2026-09-10T08:00:00Z',
  lastModified: '2026-09-10T09:30:00Z',
  deleted: false,
  webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1757491200000',
  preview: 'Three options, see below.',
};

const MARKDOWN = [
  '### 2026-09-10 08:00 · Jane Doe',
  '',
  '**Venue for the offsite**',
  '',
  'Three options, see below.',
  '',
  '> **Derek Bushaw · 2026-09-10 09:30**',
  '> The second one.',
  '',
].join('\n');

describe('writing one channel post and its replies as a document', () => {
  it('a post opens with where it came from, then carries the thread exactly as the library rendered it', () => {
    expect(renderPostDocument({ post, team: 'MOOV Leadership', channel: 'General', markdown: MARKDOWN, syncedAt: '2026-09-11T14:00:00Z' })).toBe(
      [
        '---',
        'source: https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1757491200000',
        'team: MOOV Leadership',
        'channel: General',
        'subject: Venue for the offsite',
        'author: Jane Doe',
        'created: "2026-09-10T08:00:00Z"',
        'last_modified: "2026-09-10T09:30:00Z"',
        'synced_at: "2026-09-11T14:00:00Z"',
        '---',
        '',
        '### 2026-09-10 08:00 · Jane Doe',
        '',
        '**Venue for the offsite**',
        '',
        'Three options, see below.',
        '',
        '> **Derek Bushaw · 2026-09-10 09:30**',
        '> The second one.',
        '',
      ].join('\n')
    );
  });

  it('a post with no subject and no address says so by leaving those lines out, and a source in words stands in for the link', () => {
    const written = renderPostDocument({ post: { ...post, subject: '', webUrl: '' }, team: 'T', channel: 'General', markdown: 'body', syncedAt: 'now' });

    expect(written).not.toContain('subject:');
    expect(written).toContain('source: Teams channel - T - General');
  });
});
