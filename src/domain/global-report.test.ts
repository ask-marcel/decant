import { describe, expect, it } from 'bun:test';
import { renderGlobalReport } from './global-report.ts';

const CLEAN = { source: 'Espace Contoso', counts: '12 converted, 0 moved, 0 archived, 0 skipped, 0 failed.', skipped: [], failed: [], archived: [] };

describe('one report covering everything a run touched', () => {
  it('a source that left something behind gets its own section, with its counts and its lists', () => {
    const rendered = renderGlobalReport({
      at: '2026-08-27T21:00:00Z',
      ran: [
        {
          source: 'SW Project (Fabrikam instance)',
          counts: '4 converted, 0 moved, 0 archived, 1 skipped, 1 failed.',
          skipped: [{ path: 'Projets/big.zip', reason: 'larger than the 50 MB cap' }],
          failed: [{ path: 'Projets/Findings.xlsx', reason: 'read-failed: the source timed out' }],
          archived: [],
        },
      ],
      stale: [],
    });

    expect(rendered).toContain('## SW Project (Fabrikam instance)');
    expect(rendered).toContain('4 converted, 0 moved, 0 archived, 1 skipped, 1 failed.');
    expect(rendered).toContain('- Projets/big.zip: larger than the 50 MB cap');
    expect(rendered).toContain('- Projets/Findings.xlsx: read-failed: the source timed out');
  });

  it('a source that converted everything says so, rather than showing three empty lists', () => {
    const rendered = renderGlobalReport({ at: '2026-08-27T21:00:00Z', ran: [CLEAN], stale: [] });

    expect(rendered).toContain('## Espace Contoso');
    expect(rendered).toContain('Nothing was left behind.');
    expect(rendered).not.toContain('Left in place');
    expect(rendered).not.toContain('Could not be read');
  });

  it('a source the run did not touch is named with the date it last ran, so its silence does not read as clean', () => {
    const rendered = renderGlobalReport({ at: '2026-08-27T21:00:00Z', ran: [CLEAN], stale: [{ name: 'My mailbox', lastRun: '2026-08-20T08:00:00Z' }] });

    expect(rendered).toContain('Not rechecked by this run');
    expect(rendered).toContain('- My mailbox: last ran 2026-08-20T08:00:00Z');
  });

  it('nothing stale means no tail at all, so a run that covered every source reads as complete', () => {
    const rendered = renderGlobalReport({ at: '2026-08-27T21:00:00Z', ran: [CLEAN], stale: [] });

    expect(rendered).not.toContain('Not rechecked');
  });

  it('the file says when it was written, since it is rewritten each run rather than appended to', () => {
    const rendered = renderGlobalReport({ at: '2026-08-27T21:00:00Z', ran: [CLEAN], stale: [] });

    expect(rendered.startsWith('# What did not reach the knowledge base')).toBe(true);
    expect(rendered).toContain('2026-08-27T21:00:00Z');
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('several sources are sectioned in the order the run took them, so the file reads as the run ran', () => {
    const rendered = renderGlobalReport({ at: '2026-08-27T21:00:00Z', ran: [CLEAN, { ...CLEAN, source: 'Direction' }], stale: [] });

    expect(rendered.indexOf('## Espace Contoso')).toBeLessThan(rendered.indexOf('## Direction'));
  });
});

describe('the shape of the file itself', () => {
  // Pinned whole rather than by fragments: this renderer produces a document, and where its blank
  // lines fall is most of what makes it readable. `toContain` cannot see a layout that has collapsed.
  it('reads as one document: the heading, when it was written, a section per source, then the tail', () => {
    const rendered = renderGlobalReport({
      at: '2026-08-27T21:00:00Z',
      ran: [
        {
          source: 'Espace Contoso',
          counts: '1 converted, 0 moved, 0 archived, 1 skipped, 0 failed.',
          skipped: [{ path: 'Projets/big.zip', reason: 'larger than the 50 MB cap' }],
          failed: [],
          archived: [],
        },
      ],
      stale: [{ name: 'Mailbox', lastRun: '2026-08-20T08:00:00Z' }],
    });

    expect(rendered).toBe(`# What did not reach the knowledge base

Written 2026-08-27T21:00:00Z.

## Espace Contoso

1 converted, 0 moved, 0 archived, 1 skipped, 0 failed.

Left in place, nothing was written for these:
- Projets/big.zip: larger than the 50 MB cap

## Not rechecked by this run

- Mailbox: last ran 2026-08-20T08:00:00Z
`);
  });

  it('a clean run with nothing stale ends after its last source, with no empty tail left hanging', () => {
    expect(renderGlobalReport({ at: '2026-08-27T21:00:00Z', ran: [CLEAN], stale: [] })).toBe(`# What did not reach the knowledge base

Written 2026-08-27T21:00:00Z.

## Espace Contoso

12 converted, 0 moved, 0 archived, 0 skipped, 0 failed.

Nothing was left behind.
`);
  });

  it('a run that stopped early says so, so a file listing two sources is not read as covering twenty', () => {
    expect(renderGlobalReport({ at: '2026-08-28T20:00:00Z', ran: [CLEAN], stale: [], stopped: 'enumerate: token expired' })).toBe(`# What did not reach the knowledge base

Written 2026-08-28T20:00:00Z.

The run stopped early at enumerate: token expired. The sources after it were not reached.

## Espace Contoso

12 converted, 0 moved, 0 archived, 0 skipped, 0 failed.

Nothing was left behind.
`);
  });
});
