import { describe, expect, it } from 'bun:test';
import { channelIndexPage } from './channel-index.ts';

const record = (title: string, lastModified: string, from?: string): { file: string; lastModified: string; title: string; from?: string } => ({
  file: `kb/Teams/T/General/2026-09-01/${title}.md`,
  lastModified,
  title,
  ...(from === undefined ? {} : { from }),
});

describe('the page a reader scans a channel by', () => {
  // A tie keeps the order of the ids, so the page reads the same on every run.
  it('two posts with activity at one moment keep the order of their ids, and a post kept without its author has no author', () => {
    const channel = { name: 'General', posts: { b: record('B', '2026-09-08T09:00:00Z', 'Jane Doe'), a: record('A', '2026-09-08T09:00:00Z') } };
    const lines = channelIndexPage('General', 'kb/Teams/T/General', channel, 'UTC')
      .split('\n')
      .filter((line) => line.startsWith('- '));

    expect(lines).toEqual(['- 2026-09-08 · [A](2026-09-01/A.md)', '- 2026-09-08 · [B](2026-09-01/B.md) · Jane Doe']);
  });

  it('a channel with no post yet says so', () => {
    expect(channelIndexPage('General', 'kb/Teams/T/General', undefined, 'UTC')).toBe('# General\n\nNothing here yet.\n');
  });
});
