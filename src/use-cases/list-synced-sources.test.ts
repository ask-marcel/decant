import { describe, expect, it } from 'bun:test';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createListSyncedSources } from './list-synced-sources.ts';

const siteState = JSON.stringify({
  version: 1,
  source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso' },
  lastRun: '2026-07-22T09:00:00Z',
  drives: { 'b!one': { items: { a: {}, b: {} } } },
});

describe('showing which sources have already been synced', () => {
  it('a knowledge base holding one synced site reports that site with its file count', async () => {
    const files = createFilesFake({
      directories: { kb: ['Espace Contoso'] },
      texts: { 'kb/Espace Contoso/.sync-state.json': siteState },
    });

    const sources = await createListSyncedSources({ files, logger: createLoggerFake(), kbRoot: 'kb' })();

    expect(sources).toEqual({ ok: true, value: [{ kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 2 }] });
  });

  it('a knowledge base that does not exist yet reports no synced sources', async () => {
    const sources = await createListSyncedSources({ files: createFilesFake(), logger: createLoggerFake(), kbRoot: 'kb' })();

    expect(sources).toEqual({ ok: true, value: [] });
  });

  it('a folder holding no state file is passed over in silence', async () => {
    const files = createFilesFake({ directories: { kb: ['_archive'] } });
    const logger = createLoggerFake();

    const sources = await createListSyncedSources({ files, logger, kbRoot: 'kb' })();

    expect(sources).toEqual({ ok: true, value: [] });
    expect(logger.calls).toEqual([]);
  });

  it('a corrupt folder alongside a healthy one leaves the healthy source in the list', async () => {
    const files = createFilesFake({
      directories: { kb: ['Broken', 'Espace Contoso'] },
      texts: { 'kb/Broken/.sync-state.json': 'not json at all', 'kb/Espace Contoso/.sync-state.json': siteState },
    });

    const sources = await createListSyncedSources({ files, logger: createLoggerFake(), kbRoot: 'kb' })();

    expect(sources.ok && sources.value.map((source) => source.name)).toEqual(['Espace Contoso']);
  });

  it('a corrupt state file is skipped and warned about so the run can continue', async () => {
    const files = createFilesFake({ directories: { kb: ['Broken'] }, texts: { 'kb/Broken/.sync-state.json': '{"source":' } });
    const logger = createLoggerFake();

    const sources = await createListSyncedSources({ files, logger, kbRoot: 'kb' })();

    expect(sources).toEqual({ ok: true, value: [] });
    expect(logger.calls).toEqual([{ level: 'warn', event: 'sync-state.unreadable', meta: { folder: 'Broken', cause: 'invalid-json' } }]);
  });

  it('a state file describing a source this tool cannot sync is skipped and warned about', async () => {
    const files = createFilesFake({ directories: { kb: ['Odd'] }, texts: { 'kb/Odd/.sync-state.json': '{"source":{"kind":"notebook","id":"x","name":"y"}}' } });
    const logger = createLoggerFake();

    const sources = await createListSyncedSources({ files, logger, kbRoot: 'kb' })();

    expect(sources).toEqual({ ok: true, value: [] });
    expect(logger.calls).toEqual([{ level: 'warn', event: 'sync-state.unreadable', meta: { folder: 'Odd', cause: 'malformed' } }]);
  });
});
