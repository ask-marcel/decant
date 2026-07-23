import { describe, expect, it } from 'bun:test';
import { NEVER_RUN } from '../domain/sync-state.ts';
import { renderSyncedSources } from './render-sources.ts';

describe('showing the operator what is already in the knowledge base', () => {
  it('an empty knowledge base says so in one line', () => {
    expect(renderSyncedSources([])).toBe('No source synced yet.');
  });

  it('each synced source is listed with when it last ran and how many files it holds', () => {
    const rendered = renderSyncedSources([
      { kind: 'site', id: 'a', name: 'Espace MOOV', lastRun: '2026-07-22T09:00:00Z', fileCount: 143 },
      { kind: 'mailbox', id: 'me', name: 'Mailbox', lastRun: NEVER_RUN, fileCount: 0 },
    ]);

    expect(rendered).toBe(['Already synced:', '1) Espace MOOV (synced 2026-07-22T09:00:00Z, 143 files)', '2) Mailbox (never completed a run)'].join('\n'));
  });
});
