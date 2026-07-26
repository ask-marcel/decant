import { describe, expect, it } from 'bun:test';
import type { DriveItem } from '../domain/drive-item.ts';
import { serializeSiteState } from '../domain/site-state.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import { createConvertFile } from './convert-file.ts';
import { createSyncSite } from './sync-site.ts';
import type { RunSummary } from './sync-site.ts';

const site = { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' };
const drives = [{ id: 'b!one', name: 'Documents' }];
const STATE_PATH = 'kb/Espace Contoso/.sync-state.json';

const item = (over: Partial<DriveItem> = {}): DriveItem => ({
  id: '01ABC',
  name: 'Contrat.docx',
  kind: 'file',
  size: 4096,
  path: 'Projets/Contrat.docx',
  lastModified: '2026-05-12T09:31:00Z',
  cTag: 'c1',
  webUrl: 'https://tenant.sharepoint.com/sites/X/Contrat.docx',
  ...over,
});

const run = async (
  seeds: { reader?: DriveReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number } = {}
): Promise<{ summary: RunSummary; files: FilesFake; logger: LoggerFake; progress: ProgressFake; ok: boolean }> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createDriveReaderFake(seeds.reader);
  const clock = createClockFake();
  const syncSite = createSyncSite({
    reader,
    files,
    logger,
    progress,
    clock,
    kbRoot: 'kb',
    convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock }),
  });
  const result = await syncSite({ site, drives, maxBytes: 50 * 1024 * 1024, ocrLabel: 'paddleocr (en)', concurrency: seeds.concurrency ?? 1, dryRun: seeds.dryRun ?? false });
  return { summary: result.ok ? result.value : ({} as RunSummary), files, logger, progress, ok: result.ok };
};

const stateAfter = (
  files: FilesFake
): { drives: Record<string, { deltaLink?: string; pending: unknown[]; items: Record<string, { path: string; cTag: string; outputs: string[] }> }> } =>
  JSON.parse(files.written.get(STATE_PATH) ?? '{}');

const REPORT_PATH = 'kb/Espace Contoso/_sync-report.md';

describe('reporting what did not reach the knowledge base', () => {
  it('a document of a type this tool does not read is named in the report', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Films/Demo.mp4' })], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.get(REPORT_PATH)).toContain('- Films/Demo.mp4: a kind of file this tool does not read');
  });

  it('a document above the size cap is named with the cap it exceeded', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item({ size: 60 * 1024 * 1024 })], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.get(REPORT_PATH)).toContain('- Projets/Contrat.docx: larger than the 50 MB cap');
  });

  it('a document that could not be read is named with the reason and marked for retry', async () => {
    const { files } = await run({
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }], failItems: { '01ABC': { kind: 'permanent', status: 423, message: 'file is locked' } } },
    });
    const report = files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Could not be read, and will be tried again on the next run:');
    expect(report).toContain('- Projets/Contrat.docx: permanent: file is locked');
  });

  it('a document the source no longer has is named as moved aside', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'c1', pending: [], items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['x.md'] } } } },
    });
    const { files } = await run({ files: { texts: { [STATE_PATH]: known } }, reader: { pages: [{ items: [item({ kind: 'deleted' })], skipped: 0, deltaLink: 'c2' }] } });

    expect(files.written.get(REPORT_PATH)).toContain('- Projets/Contrat.docx: no longer at the source');
  });

  it('a run that converted everything writes no report at all', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.has(REPORT_PATH)).toBe(false);
  });

  it('a dry run writes no report either', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Demo.mp4' })], skipped: 0, deltaLink: 'c1' }] }, dryRun: true });

    expect(files.written.has(REPORT_PATH)).toBe(false);
  });

  it('a report that cannot be written is logged without failing the run, since the documents landed', async () => {
    const {
      summary,
      logger,
      ok: succeeded,
    } = await run({
      files: { failWritesMatching: '_sync-report.md' },
      reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Demo.mp4' })], skipped: 0, deltaLink: 'c1' }] },
    });

    expect(succeeded).toBe(true);
    expect(summary.skipped).toBe(1);
    expect(logger.calls.some((call) => call.event === 'report.failed')).toBe(true);
  });
});

describe('syncing a SharePoint library into the knowledge base', () => {
  it('a library never synced converts everything it holds and remembers what it produced', async () => {
    const { summary, files } = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(summary.converted).toBe(1);
    expect(files.written.has('kb/Espace Contoso/Documents/Projets/Contrat.docx.md')).toBe(true);
    expect(stateAfter(files).drives['b!one']?.items['01ABC']).toEqual({
      path: 'Projets/Contrat.docx',
      cTag: 'c1',
      outputs: ['kb/Espace Contoso/Documents/Projets/Contrat.docx.md'],
    });
  });

  it('the cursor Graph handed back is stored, so the next run reads only what changed', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(stateAfter(files).drives['b!one']?.deltaLink).toBe('cursor-1');
  });

  it('a library spanning several pages of changes converts every page', async () => {
    const pages = [
      { items: [item({ id: 'a', path: 'a.docx', lastModified: '2026-05-01T00:00:00Z' })], skipped: 0, nextLink: 'page-2' },
      { items: [item({ id: 'b', path: 'b.docx', lastModified: '2026-05-02T00:00:00Z' })], skipped: 0, deltaLink: 'cursor-2' },
    ];
    const { summary, files } = await run({ reader: { pages } });

    expect(summary.converted).toBe(2);
    expect(stateAfter(files).drives['b!one']?.deltaLink).toBe('cursor-2');
  });

  it('a second run over an unchanged library converts nothing', async () => {
    const first = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }] } });
    const carried = first.files.written.get(STATE_PATH) ?? '';

    const second = await run({ files: { texts: { [STATE_PATH]: carried } }, reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-2' }] } });

    expect(second.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 });
  });

  it('a run resumes at the document it was stopped on, without asking Graph again', async () => {
    const halfDone = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'cursor-1', pending: [{ kind: 'convert', item: item() }], items: {} } },
    });

    const { summary, files, logger } = await run({ files: { texts: { [STATE_PATH]: halfDone } } });

    expect(summary.converted).toBe(1);
    expect(files.written.has('kb/Espace Contoso/Documents/Projets/Contrat.docx.md')).toBe(true);
    expect(logger.calls.some((call) => call.event === 'sync.resuming')).toBe(true);
  });

  it('the queue shrinks as each document is finished, so a stop loses at most one document', async () => {
    const pages = [{ items: [item({ id: 'a', path: 'a.docx' }), item({ id: 'b', path: 'b.docx' })], skipped: 0, deltaLink: 'cursor-1' }];
    const { files } = await run({ reader: { pages } });

    expect(stateAfter(files).drives['b!one']?.pending).toEqual([]);
  });

  it('a document renamed in SharePoint has its files moved rather than converted again', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
        },
      },
    });
    const renamed = item({ path: 'Archive/Contrat signe.docx', name: 'Contrat signe.docx' });

    const { summary, files } = await run({ files: { texts: { [STATE_PATH]: known } }, reader: { pages: [{ items: [renamed], skipped: 0, deltaLink: 'cursor-2' }] } });

    expect(summary).toEqual({ converted: 0, moved: 1, archived: 0, skipped: 0, failed: 0, queued: 0 });
    expect(files.moves).toEqual([{ from: 'kb/Espace Contoso/Documents/Projets/Contrat.docx.md', to: 'kb/Espace Contoso/Documents/Archive/Contrat signe.docx.md' }]);
    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.path).toBe('Archive/Contrat signe.docx');
  });

  it('a document deleted in SharePoint has its files put aside and is forgotten', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
        },
      },
    });

    const { summary, files } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { pages: [{ items: [item({ kind: 'deleted' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary.archived).toBe(1);
    expect(files.moves).toEqual([{ from: 'kb/Espace Contoso/Documents/Projets/Contrat.docx.md', to: 'kb/_archive/Espace Contoso/Documents/Projets/Contrat.docx.md' }]);
    expect(stateAfter(files).drives['b!one']?.items).toEqual({});
  });

  it('a document that cannot be converted is counted and left for the next run, without stopping the others', async () => {
    const pages = [{ items: [item({ id: 'bad' }), item({ id: 'good', path: 'good.docx' })], skipped: 0, deltaLink: 'cursor-1' }];
    const { summary, files, logger } = await run({ reader: { pages, failItems: { bad: { kind: 'permanent', status: 423, message: 'locked' } } } });

    expect(summary).toEqual({ converted: 1, moved: 0, archived: 0, skipped: 0, failed: 1, queued: 0 });
    expect(stateAfter(files).drives['b!one']?.items['bad']).toBeUndefined();
    expect(logger.calls.some((call) => call.event === 'convert.failed')).toBe(true);
  });

  it('a document of a type this tool does not handle is recorded, so it is not looked at again', async () => {
    const { summary, files } = await run({ reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Demo.mp4' })], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(summary.skipped).toBe(1);
    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.outputs).toEqual([]);
  });

  it('a dry run reports what it would do and writes nothing at all', async () => {
    const { summary, files } = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }] }, dryRun: true });

    expect(summary.queued).toBe(1);
    expect(files.written.size).toBe(0);
  });

  it('a knowledge base holding an unreadable state file is synced from scratch rather than refused', async () => {
    const { summary, logger } = await run({ files: { texts: { [STATE_PATH]: 'not json' } }, reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(summary.converted).toBe(1);
    expect(logger.calls.some((call) => call.event === 'sync-state.unusable')).toBe(true);
  });

  it('every kind of work is counted separately, so the report says what really happened', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: {
            renamed: { path: 'old.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/old.docx.md'] },
            gone: { path: 'gone.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/gone.docx.md'] },
          },
        },
      },
    });
    const items = [
      item({ id: 'fresh', path: 'fresh.docx' }),
      item({ id: 'renamed', path: 'new.docx', name: 'new.docx' }),
      item({ id: 'gone', kind: 'deleted' }),
      item({ id: 'video', name: 'Demo.mp4', path: 'Demo.mp4' }),
      item({ id: 'broken', path: 'broken.docx' }),
    ];

    const { summary } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { pages: [{ items, skipped: 0, deltaLink: 'cursor-2' }], failItems: { broken: { kind: 'permanent', message: 'locked' } } },
    });

    expect(summary).toEqual({ converted: 1, moved: 1, archived: 1, skipped: 1, failed: 1, queued: 0 });
  });

  it('several libraries are synced in one run, each with its own folder', async () => {
    const files = createFilesFake();
    const logger = createLoggerFake();
    const reader = createDriveReaderFake({
      pages: [
        { items: [item({ name: 'a.docx', path: 'a.docx' })], skipped: 0, deltaLink: 'c1' },
        { items: [item({ id: 'other', name: 'b.docx', path: 'b.docx' })], skipped: 0, deltaLink: 'c2' },
      ],
    });
    const clock = createClockFake();
    const syncSite = createSyncSite({
      reader,
      files,
      logger,
      progress: createProgressFake(),
      clock,
      kbRoot: 'kb',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock }),
    });

    const result = await syncSite({
      site,
      drives: [
        { id: 'b!one', name: 'Documents' },
        { id: 'b!two', name: 'Site Assets' },
      ],
      maxBytes: 50 * 1024 * 1024,
      ocrLabel: 'paddleocr (en)',
      concurrency: 1,
      dryRun: false,
    });

    expect(result.ok && result.value.converted).toBe(2);
    expect(files.written.has('kb/Espace Contoso/Documents/a.docx.md')).toBe(true);
    expect(files.written.has('kb/Espace Contoso/Site Assets/b.docx.md')).toBe(true);
  });

  it('a file that cannot be moved is reported without losing what the manifest knows', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'old.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/old.docx.md'] } },
        },
      },
    });

    const { summary, logger } = await run({
      files: { texts: { [STATE_PATH]: known }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'read-only volume' } },
      reader: { pages: [{ items: [item({ path: 'new.docx', name: 'new.docx' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary.moved).toBe(1);
    expect(logger.calls.some((call) => call.event === 'move.failed')).toBe(true);
  });

  it('a file that cannot be put aside is reported rather than silently kept', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'gone.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/gone.docx.md'] } },
        },
      },
    });

    const { logger } = await run({
      files: { texts: { [STATE_PATH]: known }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'read-only volume' } },
      reader: { pages: [{ items: [item({ kind: 'deleted' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(logger.calls.some((call) => call.event === 'archive.failed')).toBe(true);
  });

  it('a knowledge base that cannot be written to stops the run rather than losing track of the queue', async () => {
    const { ok: succeeded } = await run({
      files: { failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }] },
    });

    expect(succeeded).toBe(false);
  });

  it('what a sweep could not read is logged with the count, so nothing is lost quietly', async () => {
    const { logger } = await run({ reader: { pages: [{ items: [item()], skipped: 3, deltaLink: 'cursor-1' }] } });
    const enumerated = logger.calls.find((call) => call.event === 'sync.enumerated');

    expect(enumerated?.meta).toEqual({ driveId: 'b!one', items: 1, skipped: 3 });
  });

  it('a library Graph refuses to list ends the run with the reason rather than a half-written state', async () => {
    const { ok } = await run({ reader: { failWith: { kind: 'auth', message: 'token expired' } } });

    expect(ok).toBe(false);
  });
});

describe('converting several items at once', () => {
  const threeItems: DriveReaderSeed = {
    pages: [
      {
        items: [item({ id: 'a', name: 'A.docx', path: 'A.docx' }), item({ id: 'b', name: 'B.docx', path: 'B.docx' }), item({ id: 'c', name: 'C.docx', path: 'C.docx' })],
        skipped: 0,
        deltaLink: 'c1',
      },
    ],
  };

  it('every item in a window is converted and recorded, whatever order they finish in', async () => {
    const { summary, files } = await run({ reader: threeItems, concurrency: 3 });

    expect(summary.converted).toBe(3);
    expect(Object.keys(stateAfter(files).drives['b!one']?.items ?? {}).sort((left, right) => left.localeCompare(right))).toEqual(['a', 'b', 'c']);
  });

  it('the progress counter shows the total up front and ticks once per item, named by its path', async () => {
    const { progress } = await run({ reader: threeItems, concurrency: 3 });

    expect(progress.started).toEqual([{ total: 3, what: 'Converting' }]);
    expect([...progress.steps].sort((left, right) => left.localeCompare(right))).toEqual(['A.docx', 'B.docx', 'C.docx']);
    expect(progress.dones).toHaveLength(1);
  });

  it('every item in the window announces itself as begun before any of them finish', async () => {
    const { progress } = await run({ reader: threeItems, concurrency: 3 });

    expect([...progress.begins].sort((left, right) => left.localeCompare(right))).toEqual(['A.docx', 'B.docx', 'C.docx']);
  });

  it('a window of items saves the state once, not once per item', async () => {
    const wide = await run({ reader: threeItems, concurrency: 3 });
    const narrow = await run({ reader: threeItems, concurrency: 1 });
    const savesAt = (files: FilesFake): number => files.writeLog.filter((path) => path === STATE_PATH).length;

    expect(savesAt(wide.files)).toBe(3);
    expect(savesAt(wide.files)).toBeLessThan(savesAt(narrow.files));
  });

  it('the same items converted at any width land the identical manifest', async () => {
    const wide = stateAfter((await run({ reader: threeItems, concurrency: 3 })).files).drives['b!one']?.items;
    const narrow = stateAfter((await run({ reader: threeItems, concurrency: 1 })).files).drives['b!one']?.items;

    expect(wide).toEqual(narrow);
  });

  it('an item that fails in a window leaves the ones converted beside it recorded', async () => {
    const reader: DriveReaderSeed = {
      pages: [{ items: [item({ id: 'ok', name: 'Ok.docx', path: 'Ok.docx' }), item({ id: 'bad', name: 'Bad.docx', path: 'Bad.docx' })], skipped: 0, deltaLink: 'c1' }],
      failItems: { bad: { kind: 'permanent', message: 'locked' } },
    };
    const { summary, files } = await run({ reader, concurrency: 2 });

    expect(summary).toMatchObject({ converted: 1, failed: 1 });
    expect(Object.keys(stateAfter(files).drives['b!one']?.items ?? {})).toEqual(['ok']);
  });
});

describe('naming the step, cause and payload behind every outcome', () => {
  it('a first sync of a library does not warn about an unusable state file', async () => {
    const { logger } = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }] } });

    expect(logger.calls.every((call) => call.event !== 'sync-state.unusable')).toBe(true);
  });

  it('an unusable state file is reported as invalid json, naming the site and the cause', async () => {
    const { logger } = await run({ files: { texts: { [STATE_PATH]: 'not json' } }, reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }] } });
    const unusable = logger.calls.find((call) => call.event === 'sync-state.unusable');

    expect(unusable?.meta).toEqual({ siteId: 'contoso,1,2', cause: 'invalid-json' });
  });

  it('a run whose finished state cannot be saved fails with the saveState reason', async () => {
    const files = createFilesFake({ failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } });
    const reader = createDriveReaderFake();
    const clock = createClockFake();
    const syncSite = createSyncSite({
      reader,
      files,
      logger: createLoggerFake(),
      progress: createProgressFake(),
      clock,
      kbRoot: 'kb',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock }),
    });

    const result = await syncSite({ site, drives: [], maxBytes: 50 * 1024 * 1024, ocrLabel: 'off', concurrency: 1, dryRun: false });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.step).toBe('saveState');
    expect(result.ok ? '' : result.error.cause).toBe('write-failed');
    expect(result.ok ? '' : result.error.message).toBe('disk full');
  });

  it('the report opens with a line counting what the run did', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Films/Demo.mp4' })], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.get(REPORT_PATH)).toContain('0 converted, 0 moved, 0 archived, 1 skipped, 0 failed.');
  });

  it('a report that cannot be written names the cause it failed with', async () => {
    const { logger } = await run({
      files: { failWritesMatching: '_sync-report.md' },
      reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Demo.mp4' })], skipped: 0, deltaLink: 'c1' }] },
    });
    const failed = logger.calls.find((call) => call.event === 'report.failed');

    expect(failed?.meta).toEqual({ cause: 'write-failed' });
  });

  it('a library Graph refuses to list ends the run naming the enumerate step and cause', async () => {
    const files = createFilesFake();
    const reader = createDriveReaderFake({ failWith: { kind: 'auth', message: 'token expired' } });
    const clock = createClockFake();
    const syncSite = createSyncSite({
      reader,
      files,
      logger: createLoggerFake(),
      progress: createProgressFake(),
      clock,
      kbRoot: 'kb',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock }),
    });

    const result = await syncSite({ site, drives, maxBytes: 50 * 1024 * 1024, ocrLabel: 'off', concurrency: 1, dryRun: false });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.step).toBe('enumerate');
    expect(result.ok ? '' : result.error.cause).toBe('auth');
    expect(result.ok ? '' : result.error.message).toBe('token expired');
  });

  it('resuming a run says which drive it is resuming and how much is left', async () => {
    const halfDone = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'cursor-1', pending: [{ kind: 'convert', item: item() }], items: {} } },
    });
    const { logger } = await run({ files: { texts: { [STATE_PATH]: halfDone } } });
    const resuming = logger.calls.find((call) => call.event === 'sync.resuming');

    expect(resuming?.meta).toEqual({ driveId: 'b!one', pending: 1 });
  });

  it('a document that cannot be converted is logged with its id', async () => {
    const { logger } = await run({
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }], failItems: { '01ABC': { kind: 'permanent', status: 423, message: 'locked' } } },
    });
    const failed = logger.calls.find((call) => call.event === 'convert.failed');

    expect(failed?.meta).toMatchObject({ itemId: '01ABC' });
  });

  it('a file that cannot be moved is logged with its id and the cause', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'old.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/old.docx.md'] } },
        },
      },
    });
    const { logger } = await run({
      files: { texts: { [STATE_PATH]: known }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'read-only volume' } },
      reader: { pages: [{ items: [item({ path: 'new.docx', name: 'new.docx' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });
    const failed = logger.calls.find((call) => call.event === 'move.failed');

    expect(failed?.meta).toMatchObject({ itemId: '01ABC', cause: 'write-failed' });
  });

  it('a file that cannot be put aside is logged with its id and the cause', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'gone.docx', cTag: 'c1', outputs: ['kb/Espace Contoso/Documents/gone.docx.md'] } },
        },
      },
    });
    const { logger } = await run({
      files: { texts: { [STATE_PATH]: known }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'read-only volume' } },
      reader: { pages: [{ items: [item({ kind: 'deleted' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });
    const failed = logger.calls.find((call) => call.event === 'archive.failed');

    expect(failed?.meta).toMatchObject({ itemId: '01ABC', cause: 'write-failed' });
  });

  it('a window whose state cannot be saved stops the run before the next window, losing at most one', async () => {
    const halfDone = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [
            { kind: 'convert', item: item({ id: 'a', path: 'a.docx' }) },
            { kind: 'convert', item: item({ id: 'b', path: 'b.docx' }) },
          ],
          items: {},
        },
      },
    });

    const { ok: succeeded, logger } = await run({ files: { texts: { [STATE_PATH]: halfDone }, failWriteWith: { kind: 'write-failed', path: 'kb', message: 'disk full' } } });

    expect(succeeded).toBe(false);
    expect(logger.calls.filter((call) => call.event === 'convert.failed')).toHaveLength(1);
  });
});

describe('a site name that collides with another site already on disk', () => {
  it('a colliding site is synced under a disambiguated folder, leaving the other site untouched', async () => {
    const existing = { id: 'contoso,9,9', name: 'Team Site', webUrl: 'https://tenant.sharepoint.com' };
    const incoming = { id: 'contoso,1,2', name: 'Team Site', webUrl: 'https://tenant.sharepoint.com/sites/X' };
    const existingText = serializeSiteState({ version: 1, source: { kind: 'site', ...existing }, lastRun: '2026-07-20T00:00:00Z', drives: {} });
    const files = createFilesFake({ texts: { 'kb/Team Site/.sync-state.json': existingText } });
    const reader = createDriveReaderFake({ pages: [{ items: [item({ path: 'A.docx' })], skipped: 0, deltaLink: 'c1' }] });
    const logger = createLoggerFake();
    const syncSite = createSyncSite({
      reader,
      files,
      logger,
      progress: createProgressFake(),
      clock: createClockFake(),
      kbRoot: 'kb',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock: createClockFake() }),
    });

    await syncSite({ site: incoming, drives, maxBytes: 50 * 1024 * 1024, ocrLabel: 'paddleocr (en)', concurrency: 1, dryRun: false });

    expect(files.written.get('kb/Team Site/.sync-state.json')).toBe(existingText);
    expect([...files.written.keys()].some((path) => path.startsWith('kb/Team Site-') && path.endsWith('.sync-state.json'))).toBe(true);
    expect(logger.calls.find((call) => call.event === 'sync.site-name-collision')?.meta).toEqual({ siteId: 'contoso,1,2', name: 'Team Site' });
  });
});
