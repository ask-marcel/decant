import { describe, expect, it } from 'bun:test';
import { ok } from '../domain/result.ts';
import type { SyncedSource } from '../domain/sync-state.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import type { FilesFake } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { SourceRun } from './sync-site.ts';
import { GLOBAL_REPORT_PATH, createWriteGlobalReport } from './write-global-report.ts';

const NOTHING = { skipped: [], failed: [], archived: [] };

const COUNTS = { converted: 4, moved: 0, archived: 0, skipped: 1, failed: 1, queued: 0 };

const contoso: SourceRun = {
  id: 'site!contoso',
  source: 'Espace Contoso',
  summary: COUNTS,
  notes: { ...NOTHING, failed: [{ path: 'Projets/Findings.xlsx', reason: 'read-failed: the source timed out' }] },
};

const synced = (over: Partial<SyncedSource>): SyncedSource => ({ kind: 'site', id: 'site!other', name: 'Direction', lastRun: '2026-08-14T17:31:00Z', fileCount: 12, ...over });

const write = async (
  ran: ReadonlyArray<SourceRun>,
  options: { dryRun?: boolean; known?: ReadonlyArray<SyncedSource>; failWrite?: boolean; stopped?: string } = {}
): Promise<{ files: FilesFake; logger: LoggerFake; written: string | undefined; path: string | undefined }> => {
  const files = createFilesFake(options.failWrite === true ? { failWriteWith: { kind: 'write-failed', path: 'kb/_sync-report.md', message: 'read-only' } } : {});
  const logger = createLoggerFake();
  const writeGlobalReport = createWriteGlobalReport({
    files,
    clock: createClockFake('2026-08-27T21:00:00Z'),
    logger,
    listSyncedSources: async () => ok(options.known ?? []),
    kbRoot: 'kb',
  });
  const path = await writeGlobalReport({ ran, dryRun: options.dryRun ?? false, stopped: options.stopped });
  return { files, logger, path, written: files.written.get('kb/_sync-report.md') };
};

describe('one file naming what a whole run left behind', () => {
  it('a run over one source writes the file, so there is one place to look instead of one per source', async () => {
    const { written, path } = await write([contoso]);

    expect(path).toBe('kb/_sync-report.md');

    expect(written).toContain('## Espace Contoso');
    expect(written).toContain('4 converted, 0 moved, 0 archived, 1 skipped, 1 failed.');
    expect(written).toContain('- Projets/Findings.xlsx: read-failed: the source timed out');
  });

  it('a source already synced that this run did not touch is named with the date it last ran', async () => {
    const { written } = await write([contoso], { known: [synced({})] });

    expect(written).toContain('- Direction: last ran 2026-08-14T17:31:00Z');
  });

  it('a source this run did touch is never repeated in the tail, since the file already says what it did', async () => {
    const { written } = await write([contoso], { known: [synced({ id: 'site!contoso', name: 'Espace Contoso' })] });

    expect(written).not.toContain('last ran');
  });

  it('two sites sharing a display name are told apart by id, so the one that did not run still shows in the tail', async () => {
    const { written } = await write([contoso], { known: [synced({ id: 'site!twin', name: 'Espace Contoso', lastRun: '2026-08-01T09:00:00Z' })] });

    expect(written).toContain('- Espace Contoso: last ran 2026-08-01T09:00:00Z');
  });

  it('a run that stopped partway still reports the sources that did finish, and says it stopped', async () => {
    const { written } = await write([contoso], { stopped: 'enumerate: token expired' });

    expect(written).toContain('## Espace Contoso');
    expect(written).toContain('The run stopped early at enumerate: token expired.');
  });

  it('a dry run writes nothing, since nothing it reports actually happened', async () => {
    const { written } = await write([contoso], { dryRun: true });

    expect(written).toBeUndefined();
  });

  it('a run that synced no source at all writes nothing, so quitting the picker leaves the last report standing', async () => {
    const { written } = await write([]);

    expect(written).toBeUndefined();
  });

  it('a report that cannot be written is logged rather than failing the run, since the documents already landed', async () => {
    const { logger } = await write([contoso], { failWrite: true });

    expect(logger.calls.filter((entry) => entry.level === 'warn' && entry.event === 'global-report.failed')).toEqual([
      { level: 'warn', event: 'global-report.failed', meta: { cause: 'write-failed' } },
    ]);
  });

  it('a sources listing that cannot be read still writes the run itself, rather than losing the whole report', async () => {
    const files = createFilesFake();
    const writeGlobalReport = createWriteGlobalReport({
      files,
      clock: createClockFake('2026-08-27T21:00:00Z'),
      logger: createLoggerFake(),
      listSyncedSources: async () => ({ ok: false, error: { step: 'listSynced', cause: 'read-failed', message: 'gone' } }) as const,
      kbRoot: 'kb',
    });

    await writeGlobalReport({ ran: [contoso], dryRun: false });

    const written = files.written.get('kb/_sync-report.md');
    expect(written).toContain('## Espace Contoso');
    // No tail rather than a guessed one: an unreadable listing knows of no source, and inventing
    // entries here would name sources that may not exist.
    expect(written).not.toContain('Not rechecked');
  });
});

describe('where the file lands', () => {
  it('sits at the root of the knowledge base, one level above the per-source reports', () => {
    expect(GLOBAL_REPORT_PATH('kb')).toBe('kb/_sync-report.md');
  });
});
