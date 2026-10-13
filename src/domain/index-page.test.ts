import { describe, expect, it } from 'bun:test';
import { indexDay, relativeTo, renderIndexPage } from './index-page.ts';

describe('listing what a source holds on one page', () => {
  it('each item is one line: its day, its title linked to its file, and the field a reader picks it out by', () => {
    const page = renderIndexPage('Mailbox', [
      { heading: 'By last message', rows: [{ day: '2026-10-12', title: 'Venue for the offsite', file: '2026-10-12-a3f9c1e0d2-venue/venue.md', note: 'Jane Doe' }] },
    ]);

    expect(page).toBe('# Mailbox\n\n## By last message\n\n- 2026-10-12 · [Venue for the offsite](2026-10-12-a3f9c1e0d2-venue/venue.md) · Jane Doe\n');
  });

  it('a part with nothing in it is left out, and a section with no item is not written', () => {
    const page = renderIndexPage('Tasks', [
      { heading: 'Open, by due day', rows: [] },
      { heading: 'Open, with no due day', rows: [{ day: '', title: 'Water the plants', file: 'undated/Water the plants.md', note: '' }] },
    ]);

    expect(page).toBe('# Tasks\n\n## Open, with no due day\n\n- [Water the plants](<undated/Water the plants.md>)\n');
  });

  // A title on two lines or with one bracket would end the link early, and an empty one would leave
  // nothing to click.
  it('a title is kept on one line with its brackets escaped, and an item with no title is linked by its file', () => {
    const page = renderIndexPage('Tasks', [
      {
        heading: 'Open',
        rows: [
          { day: '', title: ' Call [Contoso]\nabout the venue ', file: 'a.md', note: '' },
          { day: '', title: '', file: 'b.md', note: '' },
        ],
      },
    ]);

    expect(page).toContain('- [Call \\[Contoso\\] about the venue](a.md)\n');
    expect(page).toContain('- [b.md](b.md)\n');
  });

  it('a source that holds nothing yet says so, rather than leaving a page with a title alone', () => {
    expect(renderIndexPage('Mailbox', [{ heading: 'By last message', rows: [] }])).toBe('# Mailbox\n\nNothing here yet.\n');
  });

  it('a file is linked from the folder the page sits in, and one outside it as it was recorded', () => {
    expect(relativeTo('kb/To Do/Tasks', 'kb/To Do/Tasks/undated/a.md')).toBe('undated/a.md');
    expect(relativeTo('kb/To Do/Tasks', 'kb/To Do/Tasks archive/a.md')).toBe('kb/To Do/Tasks archive/a.md');
  });

  it('an instant is listed under the day it falls on in the zone of the knowledge base, and no instant under no day', () => {
    expect(indexDay('2026-10-11T23:00:00Z', 'Asia/Shanghai')).toBe('2026-10-12');
    expect(indexDay('', 'Asia/Shanghai')).toBe('');
  });
});
