import { describe, expect, it } from 'bun:test';
import { parseSyncedSource } from './sync-state.ts';

describe('reading the sync state left by a previous run', () => {
  it('a site synced yesterday is reported with its name and how many files it holds', () => {
    const state = {
      version: 1,
      source: { kind: 'site', id: 'contoso,1,2', name: 'Espace MOOV' },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { items: { a: {}, b: {} } }, 'b!two': { items: { c: {} } } },
    };

    const parsed = parseSyncedSource(state);

    expect(parsed).toEqual({ ok: true, value: { kind: 'site', id: 'contoso,1,2', name: 'Espace MOOV', lastRun: '2026-07-22T09:00:00Z', fileCount: 3 } });
  });

  it('a source that has never completed a run reports no files and no last run', () => {
    const parsed = parseSyncedSource({ source: { kind: 'mailbox', id: 'me', name: 'Mailbox' } });

    expect(parsed).toEqual({ ok: true, value: { kind: 'mailbox', id: 'me', name: 'Mailbox', lastRun: 'never', fileCount: 0 } });
  });

  it('a state file holding something other than an object is rejected as malformed', () => {
    const parsed = parseSyncedSource('not a state');

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'sync state is not an object' } });
  });

  it('an empty state file that parsed to nothing is rejected as malformed', () => {
    const parsed = parseSyncedSource(null);

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'sync state is not an object' } });
  });

  it('a state file with no source block is rejected as malformed', () => {
    const parsed = parseSyncedSource({ version: 1 });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'sync state has no source object' } });
  });

  it('a source naming a kind this tool cannot sync is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'notebook', id: 'x', name: 'y' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'unknown source kind: notebook' } });
  });

  it('a source missing its id is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', name: 'Espace MOOV' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('a source missing its name is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', id: 'contoso,1,2' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('a source whose id was written as a number is rejected as malformed', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', id: 42, name: 'Espace MOOV' } });

    expect(parsed).toEqual({ ok: false, error: { kind: 'malformed', message: 'source is missing id or name' } });
  });

  it('drives recorded without an item map contribute no files to the count', () => {
    const parsed = parseSyncedSource({ source: { kind: 'site', id: 'a', name: 'b' }, drives: { 'b!one': {}, 'b!two': 'broken', 'b!three': null } });

    expect(parsed.ok && parsed.value.fileCount).toBe(0);
  });
});
