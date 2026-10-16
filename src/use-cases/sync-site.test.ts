import { describe, expect, it } from 'bun:test';
import type { DriveItem } from '../domain/drive-item.ts';
import { parseSiteState, serializeSiteState } from '../domain/site-state.ts';
import type { DriveState } from '../domain/site-state.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderFake, DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import { createConvertFile } from './convert-file.ts';
import { createSyncSite } from './sync-site.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const site = { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' };
const drives = [{ id: 'b!one', name: 'Documents' }];
const STATE_PATH = 'kb/SharePoint sites/Espace Contoso/.sync-state.json';

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
  seeds: { reader?: DriveReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number; drives?: typeof drives; site?: typeof site; since?: string } = {}
): Promise<{ summary: RunSummary; notes?: RunNotes; files: FilesFake; logger: LoggerFake; progress: ProgressFake; reader: DriveReaderFake; ok: boolean }> => {
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
    timezone: 'UTC',
    convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock, logger: createLoggerFake(), progress: createProgressFake() }),
  });
  const result = await syncSite({
    site: seeds.site ?? site,
    drives: seeds.drives ?? drives,
    maxBytes: 50 * 1024 * 1024,
    concurrency: seeds.concurrency ?? 1,
    dryRun: seeds.dryRun ?? false,
    since: seeds.since,
  });
  return { summary: result.ok ? result.value.summary : ({} as RunSummary), notes: result.ok ? result.value.notes : undefined, files, logger, progress, reader, ok: result.ok };
};

const stateAfter = (
  files: FilesFake
): {
  drives: Record<
    string,
    {
      deltaLink?: string;
      pending: unknown[];
      items: Record<string, { path: string; cTag: string; outputs: string[]; modified?: string; modifiedBy?: string }>;
      retry: Record<string, { attempts: number; reason: string }>;
    }
  >;
} => JSON.parse(files.written.get(STATE_PATH) ?? '{}');

const REPORT_PATH = 'kb/SharePoint sites/Espace Contoso/_sync-report.md';

describe('reporting what did not reach the knowledge base', () => {
  it('a document of a type this tool does not read is named in the report', async () => {
    const { files } = await run({ reader: { pages: [{ items: [item({ name: 'Demo.mp4', path: 'Films/Demo.mp4' })], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.get(REPORT_PATH)).toContain('- Films/Demo.mp4: a .mp4 file, which this tool does not read');
  });

  it('the stub Office leaves beside an open workbook is named as one, rather than failing every run', async () => {
    const lock = item({ name: '~$Tracking log.xlsx', path: 'Logs/~$Tracking log.xlsx', size: 165 });
    const { files, summary } = await run({ reader: { pages: [{ items: [lock], skipped: 0, deltaLink: 'c1' }] } });

    expect(files.written.get(REPORT_PATH)).toContain('- Logs/~$Tracking log.xlsx: a file Office leaves beside a document while it is open, holding no content of its own');
    expect(summary).toMatchObject({ skipped: 1, failed: 0 });
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

    expect(report).toContain('Failed, and will be tried again on the next run:');
    expect(report).toContain('- Projets/Contrat.docx: permanent: file is locked');
  });

  it('a document locked with a password is left out for good, not queued again on the next run', async () => {
    const { files, summary } = await run({
      reader: {
        pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }],
        failItems: { '01ABC': { kind: 'protected', message: 'xlsx parse failed: File is password-protected' } },
      },
    });
    const report = files.written.get(REPORT_PATH) ?? '';

    expect(summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 1, failed: 0, queued: 0 });
    expect(report).toContain('- Projets/Contrat.docx: locked with a password, so nothing could be read from it');
    expect(stateAfter(files).drives['b!one']?.items['01ABC']).toEqual({ path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [], modified: '2026-05-12T09:31:00Z' });
  });

  it('a document the source no longer has is named as moved aside', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'c1', pending: [], items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['x.md'] } }, retry: {} } },
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
    expect(files.written.has('kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md')).toBe(true);
    expect(stateAfter(files).drives['b!one']?.items['01ABC']).toEqual({
      path: 'Projets/Contrat.docx',
      cTag: 'c1',
      outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'],
      modified: '2026-05-12T09:31:00Z',
    });
  });

  // The path stays, so the version before the edit is set aside first: the knowledge base keeps its old
  // versions without git.
  it('a document edited at the source is written again at its own path, and the version before it is put aside under the day of the run', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'c1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
          retry: {},
        },
      },
    });
    const { files } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { pages: [{ items: [item({ cTag: 'c2', lastModified: '2026-06-01T10:00:00Z' })], skipped: 0, deltaLink: 'c2' }] },
    });

    expect(files.written.has('kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md')).toBe(true);
    expect(files.moves).toEqual([
      {
        from: 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md',
        to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md',
      },
    ]);
  });

  it('an edit that does not convert puts the version before it back, so it stays the current one', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'c1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
          retry: {},
        },
      },
      layout: 2,
    });
    const held = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
    const { files } = await run({
      files: { texts: { [STATE_PATH]: known, [held]: 'the version before' } },
      reader: { pages: [{ items: [item({ cTag: 'c2' })], skipped: 0, deltaLink: 'c2' }], failItems: { '01ABC': { kind: 'transient', message: 'busy' } } },
    });

    expect(files.written.get(held)).toBe('the version before');
    expect(files.moves.map((move) => move.from)).toEqual([held, 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md']);
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
      drives: { 'b!one': { name: 'Documents', deltaLink: 'cursor-1', pending: [{ kind: 'convert', item: item() }], items: {}, retry: {} } },
    });

    const { summary, files, logger } = await run({ files: { texts: { [STATE_PATH]: halfDone } } });

    expect(summary.converted).toBe(1);
    expect(files.written.has('kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md')).toBe(true);
    expect(logger.calls.some((call) => call.event === 'sync.resuming')).toBe(true);
  });

  it('the queue shrinks as each document is finished, so a stop loses at most one document', async () => {
    const pages = [{ items: [item({ id: 'a', path: 'a.docx' }), item({ id: 'b', path: 'b.docx' })], skipped: 0, deltaLink: 'cursor-1' }];
    const { files } = await run({ reader: { pages } });

    expect(stateAfter(files).drives['b!one']?.pending).toStrictEqual([]);
  });

  it('a document renamed in SharePoint is converted again at its new place, with its earlier files put aside', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
          retry: {},
        },
      },
    });
    const renamed = item({ path: 'Archive/Contrat signe.docx', name: 'Contrat signe.docx' });

    const { summary, files } = await run({ files: { texts: { [STATE_PATH]: known } }, reader: { pages: [{ items: [renamed], skipped: 0, deltaLink: 'cursor-2' }] } });

    expect(summary).toEqual({ converted: 1, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 });
    expect(files.moves).toEqual([
      {
        from: 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md',
        to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md',
      },
    ]);
    expect(files.written.get('kb/SharePoint sites/Espace Contoso/Documents/Archive/Contrat signe.docx.md')).toContain('path: Archive/Contrat signe.docx');
    expect(stateAfter(files).drives['b!one']?.items['01ABC']).toMatchObject({
      path: 'Archive/Contrat signe.docx',
      outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Archive/Contrat signe.docx.md'],
    });
  });

  // The earlier files stay where they were, and the log names them: the document is recorded at the
  // files its new conversion wrote, which are the ones that say where it is now.
  it('a rename whose earlier files will not move aside still lands at the new place', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
          retry: {},
        },
      },
      layout: 2,
    });
    const renamed = item({ path: 'Archive/Contrat signe.docx', name: 'Contrat signe.docx' });
    const refused = { kind: 'write-failed' as const, path: 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md', message: 'held open' };

    const { files } = await run({ files: { texts: { [STATE_PATH]: known }, failMoveWith: refused }, reader: { pages: [{ items: [renamed], skipped: 0, deltaLink: 'cursor-2' }] } });

    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.outputs).toEqual(['kb/SharePoint sites/Espace Contoso/Documents/Archive/Contrat signe.docx.md']);
  });

  // A run of an earlier version queued a rename as a move of the files. The entry carries the document,
  // so the run that resumes the queue converts it at its new place, like any other rename.
  it('a move that an earlier version left in the queue is converted at the new place', async () => {
    const renamed = item({ path: 'Archive/Contrat signe.docx', name: 'Contrat signe.docx' });
    const before = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
    const queued = JSON.stringify({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [{ kind: 'move', item: renamed, from: 'Projets/Contrat.docx', outputs: [before] }],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [before] } },
          retry: {},
        },
      },
    });

    const { summary, files } = await run({ files: { texts: { [STATE_PATH]: queued, [before]: 'the contract' } } });

    expect(summary.converted).toBe(1);
    expect(files.written.has(before)).toBe(false);
    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.outputs).toEqual(['kb/SharePoint sites/Espace Contoso/Documents/Archive/Contrat signe.docx.md']);
  });

  // The document now at A.docx is converted first and writes A.docx.md. The record of the other one
  // still names A.docx.md when its turn comes, but the file is no longer its own to set aside.
  it('two documents that swap their names both keep their new files', async () => {
    const A_MD = 'kb/SharePoint sites/Espace Contoso/Documents/A.docx.md';
    const B_MD = 'kb/SharePoint sites/Espace Contoso/Documents/B.docx.md';
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01A': { path: 'A.docx', cTag: 'c1', outputs: [A_MD] }, '01B': { path: 'B.docx', cTag: 'c1', outputs: [B_MD] } },
          retry: {},
          folders: {},
        },
      },
    });
    const swapped = [
      item({ id: '01A', name: 'B.docx', path: 'B.docx', lastModified: '2026-05-13T09:00:00Z' }),
      item({ id: '01B', name: 'A.docx', path: 'A.docx', lastModified: '2026-05-12T09:00:00Z' }),
    ];

    const { files } = await run({
      files: { texts: { [STATE_PATH]: known, [A_MD]: 'a', [B_MD]: 'b' } },
      reader: { pages: [{ items: swapped, skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(files.written.has(A_MD)).toBe(true);
    expect(files.written.has(B_MD)).toBe(true);
    expect(stateAfter(files).drives['b!one']?.items['01A']?.outputs).toEqual([B_MD]);
    expect(stateAfter(files).drives['b!one']?.items['01B']?.outputs).toEqual([A_MD]);
  });

  // Graph can name one item twice in a delta, and says to use the last one.
  it('a document a delta lists twice is converted once, as it was listed last', async () => {
    const first = item({ cTag: 'c1' });
    const last = item({ cTag: 'c2', lastModified: '2026-05-13T09:31:00Z' });

    const { summary, files, reader } = await run({ reader: { pages: [{ items: [first, last], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(summary.converted).toBe(1);
    expect(reader.calls.filter((call) => call.startsWith('markdown:'))).toHaveLength(1);
    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.cTag).toBe('c2');
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
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
          retry: {},
        },
      },
    });

    const { summary, files } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { pages: [{ items: [item({ kind: 'deleted' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary.archived).toBe(1);
    expect(files.moves).toEqual([
      {
        from: 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md',
        to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md',
      },
    ]);
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
    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.outputs).toStrictEqual([]);
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
            renamed: { path: 'old.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/old.docx.md'] },
            gone: { path: 'gone.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/gone.docx.md'] },
          },
          retry: {},
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

    expect(summary).toEqual({ converted: 2, moved: 0, archived: 1, skipped: 1, failed: 1, queued: 0 });
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
      timezone: 'UTC',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock, logger: createLoggerFake(), progress: createProgressFake() }),
    });

    const result = await syncSite({
      site,
      drives: [
        { id: 'b!one', name: 'Documents' },
        { id: 'b!two', name: 'Site Assets' },
      ],
      maxBytes: 50 * 1024 * 1024,
      concurrency: 1,
      dryRun: false,
    });

    expect(result.ok && result.value.summary.converted).toBe(2);
    expect(files.written.has('kb/SharePoint sites/Espace Contoso/Documents/a.docx.md')).toBe(true);
    expect(files.written.has('kb/SharePoint sites/Espace Contoso/Site Assets/b.docx.md')).toBe(true);
  });

  it('a renamed file whose earlier version cannot be put aside is still converted, and the log says so', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'old.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/old.docx.md'] } },
          retry: {},
        },
      },
    });

    const { summary, logger } = await run({
      files: { texts: { [STATE_PATH]: known }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'read-only volume' } },
      reader: { pages: [{ items: [item({ path: 'new.docx', name: 'new.docx' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary.converted).toBe(1);
    expect(logger.calls.some((call) => call.event === 'supersede.failed')).toBe(true);
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
          items: { '01ABC': { path: 'gone.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/gone.docx.md'] } },
          retry: {},
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

    expect(progress.started).toEqual([{ total: 3, what: 'Espace Contoso / Documents' }]);
    expect([...progress.steps].sort((left, right) => left.localeCompare(right))).toEqual(['A.docx', 'B.docx', 'C.docx']);
    expect(progress.dones).toHaveLength(1);
  });

  it('the counter names the site and library it is working through, so one run of many is placeable', async () => {
    const { progress } = await run({
      reader: threeItems,
      drives: [
        { id: 'b!one', name: 'Documents' },
        { id: 'b!two', name: 'Site Assets' },
      ],
    });

    expect(progress.started.map((entry) => entry.what)).toEqual(['Espace Contoso / Documents', 'Espace Contoso / Site Assets']);
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
      timezone: 'UTC',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock, logger: createLoggerFake(), progress: createProgressFake() }),
    });

    const result = await syncSite({ site, drives: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });

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
      timezone: 'UTC',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock, logger: createLoggerFake(), progress: createProgressFake() }),
    });

    const result = await syncSite({ site, drives, maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });

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
      drives: { 'b!one': { name: 'Documents', deltaLink: 'cursor-1', pending: [{ kind: 'convert', item: item() }], items: {}, retry: {} } },
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

  it('an earlier version that cannot be put aside before a rename is logged with its path and the cause', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'old.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/old.docx.md'] } },
          retry: {},
        },
      },
    });
    const { logger } = await run({
      files: { texts: { [STATE_PATH]: known }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'read-only volume' } },
      reader: { pages: [{ items: [item({ path: 'new.docx', name: 'new.docx' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });
    const failed = logger.calls.find((call) => call.event === 'supersede.failed');

    expect(failed?.meta).toEqual({ path: 'kb/SharePoint sites/Espace Contoso/Documents/old.docx.md', cause: 'write-failed' });
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
          items: { '01ABC': { path: 'gone.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/gone.docx.md'] } },
          retry: {},
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
          retry: {},
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
    const files = createFilesFake({ texts: { 'kb/SharePoint sites/Team Site/.sync-state.json': existingText } });
    const reader = createDriveReaderFake({ pages: [{ items: [item({ path: 'A.docx' })], skipped: 0, deltaLink: 'c1' }] });
    const logger = createLoggerFake();
    const syncSite = createSyncSite({
      reader,
      files,
      logger,
      progress: createProgressFake(),
      clock: createClockFake(),
      kbRoot: 'kb',
      timezone: 'UTC',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock: createClockFake(), logger: createLoggerFake(), progress: createProgressFake() }),
    });

    await syncSite({ site: incoming, drives, maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });

    expect(files.written.get('kb/SharePoint sites/Team Site/.sync-state.json')).toBe(existingText);
    expect([...files.written.keys()].some((path) => path.startsWith('kb/SharePoint sites/Team Site-') && path.endsWith('.sync-state.json'))).toBe(true);
    expect(logger.calls.find((call) => call.event === 'sync.site-name-collision')?.meta).toEqual({ siteId: 'contoso,1,2', name: 'Team Site' });
  });
});

describe('a document the source would not hand over', () => {
  const APPENDIX = item({ name: 'appendix_9.1.pdf', path: 'Annexes/appendix_9.1.pdf' });
  const REFUSED: DriveReaderSeed['failItems'] = { '01ABC': { kind: 'transient', message: 'gateway timeout' } };
  // What the second run and every one after it sees: the cursor moved on when the first run swept, so
  // Graph reports nothing at all. Only what the last run wrote down can bring the document back.
  const NOTHING_CHANGED = { pages: [{ items: [], skipped: 0, deltaLink: 'cursor-2' }] };

  const swept = async (): Promise<string> => {
    const first = await run({ reader: { pages: [{ items: [APPENDIX], skipped: 0, deltaLink: 'cursor-1' }], failItems: REFUSED } });
    return first.files.written.get(STATE_PATH) ?? '';
  };

  const again = async (carried: string, failing: boolean): Promise<Awaited<ReturnType<typeof run>>> =>
    run({ files: { texts: { [STATE_PATH]: carried } }, reader: { ...NOTHING_CHANGED, ...(failing ? { failItems: REFUSED } : {}) } });

  it('a document that could not be read is remembered against the run that failed it', async () => {
    const first = await run({ reader: { pages: [{ items: [APPENDIX], skipped: 0, deltaLink: 'cursor-1' }], failItems: REFUSED } });

    expect(first.summary).toMatchObject({ converted: 0, failed: 1 });
    expect(stateAfter(first.files).drives['b!one']?.retry['01ABC']).toMatchObject({ attempts: 1, reason: 'transient: gateway timeout' });
  });

  it('a document that could not be read is converted on the next run, although the delta reports nothing', async () => {
    const second = await again(await swept(), false);

    expect(second.summary).toMatchObject({ converted: 1, failed: 0 });
    expect(Object.keys(stateAfter(second.files).drives['b!one']?.items ?? {})).toEqual(['01ABC']);
  });

  it('a document that converts on its second try leaves nothing behind to try a third time', async () => {
    const second = await again(await swept(), false);

    expect(stateAfter(second.files).drives['b!one']?.retry).toEqual({});
  });

  it('a document that fails three runs running is left alone by the fourth', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const fourth = await again(third.files.written.get(STATE_PATH) ?? '', true);

    expect(third.summary).toMatchObject({ failed: 1 });
    expect(fourth.summary).toMatchObject({ converted: 0, failed: 0 });
    expect(fourth.reader.calls.some((call) => call.endsWith(':01ABC'))).toBe(false);
    expect(stateAfter(fourth.files).drives['b!one']?.retry['01ABC']).toMatchObject({ attempts: 3 });
  });

  it('a document out of tries is named once, under the heading that says it will not be tried again', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const report = third.files.written.get(REPORT_PATH) ?? '';

    expect(report).toContain('Failed 3 times, and will not be tried again unless the file changes:');
    expect(report).toContain('- Annexes/appendix_9.1.pdf: transient: gateway timeout');
    expect(report).not.toContain('will be tried again on the next run');
  });

  // The library's own report is a log of runs, so it names the document once, in the run that gave
  // up on it. Every run after still hands it on to the report of the whole run, which lists what is
  // given up now.
  it('a document still out of tries is not named again in the library report, and every run after still hands it on', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const fourth = await again(third.files.written.get(STATE_PATH) ?? '', true);
    const appendix = [{ path: 'Annexes/appendix_9.1.pdf', reason: 'transient: gateway timeout' }];

    expect(third.notes?.gaveUp).toEqual(appendix);
    expect(fourth.files.written.has(REPORT_PATH)).toBe(false);
    expect(fourth.notes?.gaveUp).toBeUndefined();
    expect(fourth.notes?.givenUp).toEqual(appendix);
  });

  it('a document edited at the source after it was given up on is tried again from scratch', async () => {
    const second = await again(await swept(), true);
    const third = await again(second.files.written.get(STATE_PATH) ?? '', true);
    const edited = await run({
      files: { texts: { [STATE_PATH]: third.files.written.get(STATE_PATH) ?? '' } },
      reader: { pages: [{ items: [item({ ...APPENDIX, cTag: 'c2' })], skipped: 0, deltaLink: 'cursor-3' }] },
    });

    expect(edited.summary).toMatchObject({ converted: 1 });
    expect(stateAfter(edited.files).drives['b!one']?.retry).toEqual({});
  });
});

// The vault is grouped the way the picker is: a source is found again under the heading it was
// chosen under, which the address is what settles, not the display name.
describe('filing a source under the category it was chosen from', () => {
  const converted = { reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'c1' }] } };

  it('a team site lands under the SharePoint sites folder', async () => {
    const { files } = await run(converted);

    expect(files.written.has('kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md')).toBe(true);
  });

  it('a Loop workspace lands under the Loop workspaces folder, apart from the sites', async () => {
    const workspace = { id: 'w,1,2', name: 'Plans produit', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_abc' };

    const { files } = await run({ ...converted, site: workspace });

    expect(files.written.has('kb/Loop workspaces/Plans produit/Documents/Projets/Contrat.docx.md')).toBe(true);
  });

  it('a personal OneDrive lands under the OneDrive folder', async () => {
    const personal = { id: 'p,1,2', name: 'Camille Roy', webUrl: 'https://tenant-my.sharepoint.com/personal/camille_roy' };

    const { files } = await run({ ...converted, site: personal });

    expect(files.written.has('kb/OneDrive/Camille Roy/Documents/Projets/Contrat.docx.md')).toBe(true);
  });
});

describe('reaching back only as far as the day', () => {
  const OLD = item({ id: '01OLD', name: 'Old.docx', path: 'Old.docx', lastModified: '2024-02-01T09:00:00Z' });
  const MID = item({ id: '01MID', name: 'Mid.docx', path: 'Mid.docx', lastModified: '2025-03-01T09:00:00Z' });
  const NEW = item({ id: '01NEW', name: 'New.docx', path: 'New.docx', lastModified: '2026-05-12T09:31:00Z' });
  const filedUnder = (since: string, items: Record<string, { path: string; cTag: string; outputs: string[] }>): string =>
    serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'c1', since, pending: [], items, retry: {} } },
    });

  it('files last edited before the day are left out, and a file already filed still follows its moves', async () => {
    const known = filedUnder('2025-01-01', { '01OLD': { path: 'Archive/Old.docx', cTag: 'c1', outputs: ['kb/x/Old.docx.md'] } });

    const { summary } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { pages: [{ items: [OLD, MID, NEW, item({ id: '01OLDER', lastModified: '2023-01-01T00:00:00Z' })], skipped: 0, deltaLink: 'c2' }] },
      since: '2025-01-01',
    });

    expect(summary).toMatchObject({ converted: 3, moved: 0 });
  });

  it('moving the day earlier reads the old cursor out first, then the library whole, converting only what it had left out and still putting aside what was deleted', async () => {
    const known = filedUnder('2025-06-01', {
      '01NEW': { path: 'New.docx', cTag: 'c1', outputs: ['kb/x/New.docx.md'] },
      '01GONE': { path: 'Gone.docx', cTag: 'c1', outputs: ['kb/x/Gone.docx.md'] },
    });
    const pages = [
      { items: [item({ id: '01GONE', kind: 'deleted' })], skipped: 1, deltaLink: 'c2' },
      { items: [NEW, MID, OLD], skipped: 2, deltaLink: 'c3' },
    ];

    const { summary, reader, files, logger } = await run({ files: { texts: { [STATE_PATH]: known } }, reader: { pages }, since: '2025-01-01' });

    expect(reader.calls.filter((call) => call === 'delta' || call.startsWith('deltaFrom'))).toEqual(['deltaFrom:c1', 'delta']);
    expect(summary).toMatchObject({ converted: 1, archived: 1 });
    expect(stateAfter(files).drives['b!one']).toMatchObject({ deltaLink: 'c3', since: '2025-01-01' });
    expect(logger.calls).toContainEqual({ level: 'info', event: 'sync.enumerated', meta: { driveId: 'b!one', items: 4, skipped: 3 } });
  });

  it('a whole read that breaks off stops the library the way any sweep does, and keeps the cursor and the day it had', async () => {
    const known = filedUnder('2025-06-01', {});
    const pages = [
      { items: [], skipped: 0, deltaLink: 'c2' },
      { items: [MID], skipped: 0, nextLink: 'page-2' },
    ];

    const { ok, files } = await run({
      files: { texts: { [STATE_PATH]: known } },
      reader: { pages, failFrom: { kind: 'transient', message: 'Graph is busy' } },
      since: '2025-01-01',
    });

    expect(ok).toBe(false);
    expect(files.written.get(STATE_PATH)).toBe(known);
  });

  it('the same day, or a later one, follows the cursor; all reads the library whole again, and keeps no day', async () => {
    const known = { [STATE_PATH]: filedUnder('2025-06-01', {}) };

    for (const since of ['2025-06-01', '2025-09-01']) {
      const kept = await run({ files: { texts: known }, reader: { pages: [{ items: [], skipped: 0, deltaLink: 'c2' }] }, since });

      expect(kept.reader.calls).not.toContain('delta');
      expect(stateAfter(kept.files).drives['b!one']).toMatchObject({ since });
    }

    const everything = await run({ files: { texts: known }, reader: { pages: [{ items: [], skipped: 0, deltaLink: 'c2' }] } });

    expect(everything.reader.calls).toContain('delta');
    expect('since' in (stateAfter(everything.files).drives['b!one'] ?? {})).toBe(false);
  });
});

describe('writing down who can open a site', () => {
  const MEMBERS_PATH = 'kb/SharePoint sites/Espace Contoso/_members.md';
  const people = {
    group: { name: 'Contoso Team', mail: '' },
    owners: [{ id: 'u-1', name: 'Jane Doe', mail: 'jane@example.com', guest: false }],
    members: [],
    sharePointGroups: [],
    sharingLinks: [],
    note: '',
  };

  it('a SharePoint site gets one page naming who can open it, beside its libraries', async () => {
    const { files } = await run({ reader: { members: { [site.id]: people } } });

    expect(files.written.get(MEMBERS_PATH)).toContain('# Who can open Espace Contoso\n\n## Owners\n\n- Jane Doe (jane@example.com)\n');
  });

  it('a page that would not change is not written again', async () => {
    const first = await run({ reader: { members: { [site.id]: people } } });
    const again = await run({ reader: { members: { [site.id]: people } }, files: { texts: { [MEMBERS_PATH]: first.files.written.get(MEMBERS_PATH) ?? '' } } });

    expect(again.files.writeLog).not.toContain(MEMBERS_PATH);
  });

  it('a page that no longer says who can open the site is written again', async () => {
    const { files } = await run({ reader: { members: { [site.id]: people } }, files: { texts: { [MEMBERS_PATH]: 'an older page' } } });

    expect(files.written.get(MEMBERS_PATH)).toContain('- Jane Doe (jane@example.com)');
  });

  it('a site that answers with nobody gets no page', async () => {
    const { files } = await run();

    expect(files.written.has(MEMBERS_PATH)).toBe(false);
  });

  it('a refused read is logged with its cause and costs nothing else', async () => {
    const { files, logger, ok } = await run({ reader: { failMembers: { kind: 'permanent', status: 403, message: 'Access denied' } } });

    expect(ok).toBe(true);
    expect(files.written.has(MEMBERS_PATH)).toBe(false);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'members.unavailable', meta: { siteId: site.id, cause: 'permanent' } });
  });

  it('a page that cannot be written is logged rather than failing the run, since the documents landed', async () => {
    const { ok, logger } = await run({ reader: { members: { [site.id]: people } }, files: { failWritesMatching: '_members.md' } });

    expect(ok).toBe(true);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'members.failed', meta: { siteId: site.id, cause: 'write-failed' } });
  });

  it('a Loop workspace and a OneDrive are not asked, since no group of people owns them', async () => {
    const loop = await run({ site: { ...site, webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_1' }, reader: { members: { [site.id]: people } } });
    const drive = await run({ site: { ...site, webUrl: 'https://tenant-my.sharepoint.com/personal/jane' }, reader: { members: { [site.id]: people } } });

    expect(loop.reader.calls).not.toContain(`members:${site.id}`);
    expect(drive.reader.calls).not.toContain(`members:${site.id}`);
  });

  it('a person the People sync filed is linked to their page', async () => {
    const directory = JSON.stringify({
      version: 1,
      source: { kind: 'people', id: 'people', name: 'People' },
      lastRun: '',
      people: { 'u-1': { file: 'kb/People/Jane Doe.md', name: 'Jane Doe', fingerprint: 'f' } },
    });
    const { files } = await run({ reader: { members: { [site.id]: people } }, files: { texts: { 'kb/People/.sync-state.json': directory } } });

    expect(files.written.get(MEMBERS_PATH)).toContain('- [Jane Doe](<../../People/Jane Doe.md>) (jane@example.com)\n');
  });

  it('an unreadable People state costs the links and nothing else', async () => {
    const { files } = await run({ reader: { members: { [site.id]: people } }, files: { texts: { 'kb/People/.sync-state.json': 'not json' } } });

    expect(files.written.get(MEMBERS_PATH)).toContain('- Jane Doe (jane@example.com)\n');
  });

  it('a page whose site now answers with nobody is put aside, since it no longer says who can open the site', async () => {
    const { files } = await run({ files: { texts: { [MEMBERS_PATH]: 'an older page' } } });

    expect(files.moves).toContainEqual({ from: MEMBERS_PATH, to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/_members.md' });
  });

  it('a page that cannot be put aside is logged with its cause', async () => {
    const { logger } = await run({ files: { texts: { [MEMBERS_PATH]: 'an older page' }, failMoveWith: { kind: 'write-failed', path: MEMBERS_PATH, message: 'locked' } } });

    expect(logger.calls).toContainEqual({ level: 'warn', event: 'members.archive-failed', meta: { siteId: site.id, cause: 'write-failed' } });
  });

  it('a refused read keeps the page it had, since a refusal says nothing about who can open the site', async () => {
    const { files } = await run({ reader: { failMembers: { kind: 'transient', message: 'timeout' } }, files: { texts: { [MEMBERS_PATH]: 'an older page' } } });

    expect(files.moves).toHaveLength(0);
  });

  it('a dry run neither asks nor writes', async () => {
    const { files, reader } = await run({ dryRun: true, reader: { members: { [site.id]: people } } });

    expect(reader.calls).not.toContain(`members:${site.id}`);
    expect(files.written.has(MEMBERS_PATH)).toBe(false);
  });
});

// The first layout filed each document under the day it last changed, so every edit moved it and
// broke every link into the knowledge base. The first run of this layout files them by their folders.
describe('the page a reader scans a library by', () => {
  it('the library page lists every document on disk, the one changed last first, with who changed it, and leaves out what produced no file', async () => {
    const pages = [
      {
        items: [
          item({ id: '01OLD', name: 'Budget.xlsx', path: 'Finance/Budget.xlsx', lastModified: '2026-04-01T08:00:00Z', modifiedBy: 'Valerie FAIRBANKS' }),
          item({ id: '01ABC', modifiedBy: 'Jane Doe' }),
          item({ id: '01BIG', name: 'Video.mp4', path: 'Video.mp4', size: 900_000_000 }),
        ],
        skipped: 0,
        deltaLink: 'c1',
      },
    ];
    const { files } = await run({ reader: { pages } });

    expect(files.written.get('kb/SharePoint sites/Espace Contoso/Documents/_index.md')).toBe(
      [
        '# Documents',
        '',
        '## By last change',
        '',
        '- 2026-05-12 · [Projets/Contrat.docx](Projets/Contrat.docx.md) · Jane Doe',
        '- 2026-04-01 · [Finance/Budget.xlsx](Finance/Budget.xlsx.md) · Valerie FAIRBANKS',
        '',
      ].join('\n')
    );
  });

  it('a dry run writes no library page, and a page that will not write leaves the run standing', async () => {
    const dry = await run({ dryRun: true });

    expect(dry.files.written.has('kb/SharePoint sites/Espace Contoso/Documents/_index.md')).toBe(false);

    const refused = await run({ files: { failWritesMatching: '_index.md' } });

    expect(refused.ok).toBe(true);
    expect(refused.logger.calls).toContainEqual({
      level: 'warn',
      event: 'index.failed',
      meta: { path: 'kb/SharePoint sites/Espace Contoso/Documents/_index.md', cause: 'write-failed' },
    });
  });
});

describe('moving a library out of the day folders once', () => {
  const dated = (outputs: ReadonlyArray<string>, retry = {}): string =>
    serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'c1', pending: [], items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs } }, retry, folders: {} } },
    });
  const OLD = 'kb/SharePoint sites/Espace Contoso/Documents/2026-05-12/Projets/Contrat.docx.md';
  const NEW = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
  const NOTHING_NEW = { pages: [{ items: [], skipped: 0, deltaLink: 'c2' }] };

  it('the first run moves each document out of its day folder, puts nothing aside, and does it once', async () => {
    const first = await run({ files: { texts: { [STATE_PATH]: dated([OLD]), [OLD]: 'the contract' } }, reader: NOTHING_NEW });

    expect(first.files.moves).toEqual([{ from: OLD, to: NEW }]);
    expect(first.files.written.get(NEW)).toBe('the contract');
    expect(stateAfter(first.files).drives['b!one']?.items['01ABC']?.outputs).toEqual([NEW]);
    expect(JSON.parse(first.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);

    const second = await run({ files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '', [NEW]: 'the contract' } }, reader: NOTHING_NEW });

    expect(second.files.moves).toHaveLength(0);
  });

  // The queue a stopped run left holds the paths of the earlier layout, so it is worked through first,
  // and the run after it moves the library.
  it('a run that resumes the work a stopped run queued leaves the move to the run after it', async () => {
    const GONE = 'kb/SharePoint sites/Espace Contoso/Documents/2026-05-10/Old.docx.md';
    const queued = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'c1',
          pending: [{ kind: 'archive', itemId: '01OLD', outputs: [GONE] }],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [OLD] }, '01OLD': { path: 'Old.docx', cTag: 'c1', outputs: [GONE] } },
          retry: {},
          folders: {},
        },
      },
    });
    const resumed = await run({ files: { texts: { [STATE_PATH]: queued, [OLD]: 'the contract', [GONE]: 'the old one' } }, reader: NOTHING_NEW });

    expect(resumed.files.moves).toEqual([{ from: GONE, to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/2026-05-10/Old.docx.md' }]);
    expect(JSON.parse(resumed.files.written.get(STATE_PATH) ?? '{}').layout).toBeUndefined();

    const next = await run({ files: { texts: { [STATE_PATH]: resumed.files.written.get(STATE_PATH) ?? '', [OLD]: 'the contract' } }, reader: NOTHING_NEW });

    expect(next.files.moves).toEqual([{ from: OLD, to: NEW }]);
    expect(JSON.parse(next.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);
  });

  // A path one character too long for Windows failed as a write, and the day folder was part of it.
  it('a document given up on because it could not be written is tried again by the run that moves the library', async () => {
    const LONG = item({ id: '01LONG', name: 'Long report.docx', path: 'Long report.docx' });
    const done = await run({
      files: { texts: { [STATE_PATH]: dated([], { '01LONG': { item: LONG, attempts: 3, reason: 'write-failed: ENOENT' } }) } },
      reader: NOTHING_NEW,
    });

    expect(done.summary.converted).toBe(1);
    expect(done.files.written.has('kb/SharePoint sites/Espace Contoso/Documents/Long report.docx.md')).toBe(true);
  });

  it('a dry run moves nothing, and a file that will not move is logged and the run goes on', async () => {
    const dry = await run({ files: { texts: { [STATE_PATH]: dated([OLD]), [OLD]: 'the contract' } }, reader: NOTHING_NEW, dryRun: true });

    expect(dry.files.moves).toHaveLength(0);

    const stuck = await run({ files: { texts: { [STATE_PATH]: dated([OLD]) }, failMoveWith: { kind: 'write-failed', path: OLD, message: 'locked' } }, reader: NOTHING_NEW });

    expect(stuck.ok).toBe(true);
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'refile.failed', meta: { path: OLD, cause: 'write-failed' } });
  });

  // Recorded at its new place, the file left behind would never be found again, and the place would
  // name a file that is not there.
  it('a document that will not move stays recorded where it is, and the next run moves it', async () => {
    const stuck = await run({
      files: { texts: { [STATE_PATH]: dated([OLD]), [OLD]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NEW, message: 'locked' } },
      reader: NOTHING_NEW,
    });

    expect(stateAfter(stuck.files).drives['b!one']?.items['01ABC']?.outputs).toEqual([OLD]);
    expect(JSON.parse(stuck.files.written.get(STATE_PATH) ?? '{}').layout).toBeUndefined();

    const next = await run({ files: { texts: { [STATE_PATH]: stuck.files.written.get(STATE_PATH) ?? '', [OLD]: 'the contract' } }, reader: NOTHING_NEW });

    expect(next.files.moves).toEqual([{ from: OLD, to: NEW }]);
    expect(stateAfter(next.files).drives['b!one']?.items['01ABC']?.outputs).toEqual([NEW]);
    expect(JSON.parse(next.files.written.get(STATE_PATH) ?? '{}').layout).toBe(2);
  });
});

describe('following the folders of a library', () => {
  const folder = (id: string, path: string): DriveItem => item({ id, kind: 'folder', name: path.split('/').at(-1) ?? path, path, cTag: '' });
  const reads = (reader: DriveReaderFake): ReadonlyArray<string> => reader.calls.filter((call) => call === 'delta' || call.startsWith('deltaFrom'));
  const libraryAfter = (files: FilesFake): DriveState | undefined => {
    const saved = parseSiteState(JSON.parse(files.written.get(STATE_PATH) ?? '{}'));
    return saved.ok ? saved.value.drives['b!one'] : undefined;
  };
  const recorded = (drive: Partial<DriveState> = {}): string =>
    serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md'] } },
          retry: {},
          ...drive,
        },
      },
    });

  it('a library read for the first time records each of its folders by id', async () => {
    const { files, logger } = await run({ reader: { pages: [{ items: [folder('01F', 'Projets'), item()], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(libraryAfter(files)?.folders).toEqual({ '01F': 'Projets' });
    expect(logger.calls.some((call) => call.event === 'sync.folders-moved')).toBe(false);
  });

  // A library filed before its folders were kept holds documents whose folders were never reported.
  // Read whole once, the library records every folder, and the runs after it follow the cursor.
  it('a library recorded before its folders were kept is read whole once to record them, then follows its cursor', async () => {
    const pages = [
      { items: [], skipped: 0, deltaLink: 'cursor-2' },
      { items: [folder('01F', 'Projets'), item()], skipped: 0, deltaLink: 'cursor-3' },
    ];

    const first = await run({ files: { texts: { [STATE_PATH]: recorded() } }, reader: { pages } });
    const after = first.files.written.get(STATE_PATH) ?? '';
    const second = await run({ files: { texts: { [STATE_PATH]: after } }, reader: { pages: [{ items: [], skipped: 0, deltaLink: 'cursor-4' }] } });

    expect(reads(first.reader)).toEqual(['deltaFrom:cursor-1', 'delta']);
    expect(first.summary.converted).toBe(0);
    expect(libraryAfter(first.files)).toMatchObject({ deltaLink: 'cursor-3', folders: { '01F': 'Projets' } });
    expect(reads(second.reader)).toEqual(['deltaFrom:cursor-3']);
  });

  const BEFORE = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
  const MOVED = item({ path: 'Contrats 2026/Contrat.docx', webUrl: 'https://tenant.sharepoint.com/sites/X/Contrats 2026/Contrat.docx' });

  // Graph reports the renamed folder and nothing under it. The documents recorded under the path it
  // left are read again by id, and each one is converted at the place it has now.
  it('a folder renamed at the source brings its documents along, each read again by id and converted at its new place', async () => {
    const { summary, files, reader, logger } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets' } }), [BEFORE]: 'the contract' } },
      reader: { pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }], items: { '01ABC': MOVED } },
    });

    expect(reader.calls).toContain('item:01ABC');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'sync.folders-moved', meta: { driveId: 'b!one', folders: 1, documents: 1 } });
    expect(summary).toMatchObject({ converted: 1, archived: 0, failed: 0 });
    expect(files.written.get('kb/SharePoint sites/Espace Contoso/Documents/Contrats 2026/Contrat.docx.md')).toContain('path: Contrats 2026/Contrat.docx');
    expect(files.written.has(BEFORE)).toBe(false);
    expect(libraryAfter(files)?.folders).toEqual({ '01F': 'Contrats 2026' });
    expect(libraryAfter(files)?.items['01ABC']?.path).toBe('Contrats 2026/Contrat.docx');
  });

  it('a document the sweep reports itself is not read again, and one outside the moved folder stays as it is', async () => {
    const elsewhere = { path: 'Budget/Plan.docx', cTag: 'c1', outputs: ['kb/SharePoint sites/Espace Contoso/Documents/Budget/Plan.docx.md'] };
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01PLAN': elsewhere };

    const { summary, reader } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets', '01G': 'Budget' }, items }) } },
      reader: { pages: [{ items: [folder('01F', 'Contrats 2026'), MOVED], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(reader.calls.filter((call) => call.startsWith('item:'))).toStrictEqual([]);
    expect(summary.converted).toBe(1);
  });

  it('a document left waiting on a retry under a moved folder is read again by id as well', async () => {
    const retry = { '01ABC': { item: item(), attempts: 1, reason: 'transient: Graph is busy' } };

    const { reader, files } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets' }, items: {}, retry }) } },
      reader: { pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }], items: { '01ABC': MOVED } },
    });

    expect(reader.calls).toContain('item:01ABC');
    expect(libraryAfter(files)?.items['01ABC']?.path).toBe('Contrats 2026/Contrat.docx');
  });

  it('a document under a moved folder that the source no longer has is put aside', async () => {
    const { summary, notes } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets' } }), [BEFORE]: 'the contract' } },
      reader: { pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary.archived).toBe(1);
    expect(notes?.archived).toEqual([{ path: 'Projets/Contrat.docx', reason: 'no longer at the source' }]);
  });

  // Only Graph's 404 says that the document is gone. Another refusal, or an answer that cannot be read,
  // says nothing of where the document is, so it stays where it is recorded, named in the log.
  it('a document under a moved folder that Graph will not describe stays where it is recorded, and the log names it', async () => {
    const { summary, files, logger } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets' } }), [BEFORE]: 'the contract' } },
      reader: {
        pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }],
        failItemReads: { '01ABC': { kind: 'permanent', status: 400, message: 'invalidRequest' } },
      },
    });

    expect(summary).toMatchObject({ converted: 0, archived: 0 });
    expect(files.written.has(BEFORE)).toBe(true);
    expect(libraryAfter(files)?.items['01ABC']?.path).toBe('Projets/Contrat.docx');
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'sync.reread-failed', meta: { driveId: 'b!one', itemId: '01ABC', cause: 'permanent' } });
  });

  // The cursor stays where it was, so the next run reads the same changes, the moved folder with them.
  it('a document under a moved folder that cannot be read for now stops the library, keeping the state it had', async () => {
    const before = recorded({ folders: { '01F': 'Projets' } });

    const { ok, files } = await run({
      files: { texts: { [STATE_PATH]: before } },
      reader: {
        pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }],
        items: { '01ABC': MOVED },
        failItemReads: { '01ABC': { kind: 'transient', message: 'Graph is busy' } },
      },
    });

    expect(ok).toBe(false);
    expect(files.written.get(STATE_PATH)).toBe(before);
  });

  // A whole read lists every document the library holds: one recorded that it does not list was deleted
  // at a time no delta told of, as a deletion Graph sent without a name was before.
  it('the first whole read of a library recorded before its folders were kept puts aside what it no longer lists', async () => {
    const GONE = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Old.docx.md';
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01GONE': { path: 'Projets/Old.docx', cTag: 'c1', outputs: [GONE] } };
    const pages = [
      { items: [], skipped: 0, deltaLink: 'cursor-2' },
      { items: [item()], skipped: 0, deltaLink: 'cursor-3' },
    ];

    const { summary, notes, files } = await run({ files: { texts: { [STATE_PATH]: recorded({ items }), [GONE]: 'the old one' } }, reader: { pages } });

    expect(summary).toMatchObject({ converted: 0, archived: 1 });
    expect(notes?.archived).toEqual([{ path: 'Projets/Old.docx', reason: 'no longer at the source' }]);
    expect(files.moves).toEqual([{ from: GONE, to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Old.docx.md' }]);
    expect(Object.keys(libraryAfter(files)?.items ?? {})).toEqual(['01ABC']);
  });

  // The sweep stops when Graph hands back a page it already gave: what it holds then is part of the
  // library, and the documents on the pages it never reached are not gone for that.
  it('a whole read that stops short of the end of the library puts nothing aside, keeps no cursor, and is read whole again next time', async () => {
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01LATER': { path: 'Later.docx', cTag: 'c1', outputs: ['kb/x/Later.docx.md'] } };
    const pages = [
      { items: [], skipped: 0, deltaLink: 'cursor-2' },
      { items: [item()], skipped: 0, nextLink: 'page-2' },
      { items: [], skipped: 0, nextLink: 'page-2' },
    ];

    const { summary, files } = await run({ files: { texts: { [STATE_PATH]: recorded({ items }) } }, reader: { pages } });

    expect(summary.archived).toBe(0);
    expect(libraryAfter(files)?.deltaLink).toBeUndefined();
    expect(libraryAfter(files)?.folders).toBeUndefined();
  });

  // The day is kept with the run, so a cursor kept from the drain would hide, on the next run, what the
  // short read did not reach: the documents between the two days that were never filed.
  it('a wider day whose whole read stops short has the library read from the root on the next run', async () => {
    const pages = [
      { items: [], skipped: 0, deltaLink: 'cursor-2' },
      { items: [item()], skipped: 0, nextLink: 'page-2' },
      { items: [], skipped: 0, nextLink: 'page-2' },
    ];

    const first = await run({ files: { texts: { [STATE_PATH]: recorded({ since: '2026-01-01', folders: {} }) } }, reader: { pages }, since: '2025-01-01' });
    const second = await run({
      files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-9' }] },
      since: '2025-01-01',
    });

    expect(reads(second.reader)).toEqual(['delta']);
  });

  // Without its cursor, the run reads the library from the root, which lists it whole: once, and
  // compared with what is recorded.
  it('a library whose cursor was lost is read whole once, and puts aside what that read no longer lists', async () => {
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01GONE': { path: 'Old.docx', cTag: 'c1', outputs: ['kb/x/Old.docx.md'] } };

    const { summary, reader } = await run({
      files: { texts: { [STATE_PATH]: recorded({ deltaLink: undefined, items }) } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-9' }] },
    });

    expect(reads(reader)).toEqual(['delta']);
    expect(summary.archived).toBe(1);
  });

  it('a wider day puts aside what the whole read no longer lists, and drops a retry the read does not list', async () => {
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01GONE': { path: 'Old.docx', cTag: 'c1', outputs: ['kb/x/Old.docx.md'] } };
    const retry = { '01LOST': { item: item({ id: '01LOST', name: 'Lost.pdf', path: 'Lost.pdf' }), attempts: 1, reason: 'transient: Graph is busy' } };
    const pages = [
      { items: [], skipped: 0, deltaLink: 'cursor-2' },
      { items: [item()], skipped: 0, deltaLink: 'cursor-3' },
    ];

    const { summary, files } = await run({
      files: { texts: { [STATE_PATH]: recorded({ since: '2026-01-01', folders: {}, items, retry }) } },
      reader: { pages },
      since: '2025-01-01',
    });

    expect(summary).toMatchObject({ converted: 0, archived: 1, failed: 0 });
    expect(libraryAfter(files)?.retry).toEqual({});
  });

  it('a read that follows the cursor puts nothing aside for what it does not list', async () => {
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01PLAN': { path: 'Plan.docx', cTag: 'c1', outputs: ['kb/x/Plan.docx.md'] } };

    const { summary } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: {}, items }) } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary.archived).toBe(0);
  });

  // Graph answers 410 to a cursor whose sync state it no longer keeps, and asks for a read from the
  // start compared with what is held.
  it('a library whose cursor Graph has expired is read whole again, puts aside what it no longer lists, and keeps the new cursor', async () => {
    const items = { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [BEFORE] }, '01GONE': { path: 'Old.docx', cTag: 'c1', outputs: ['kb/x/Old.docx.md'] } };
    const expired = { kind: 'permanent' as const, status: 410, message: 'resyncRequired: the sync state is not found' };

    const { summary, files, reader, logger } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: {}, items }) } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-9' }], failCursors: { 'cursor-1': expired } },
    });

    expect(reads(reader)).toEqual(['deltaFrom:cursor-1', 'delta']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'sync.cursor-expired', meta: { driveId: 'b!one' } });
    expect(summary).toMatchObject({ converted: 0, archived: 1 });
    expect(libraryAfter(files)?.deltaLink).toBe('cursor-9');
  });

  it('a cursor Graph refuses for a while stops the library without reading it whole', async () => {
    const { ok, reader } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: {} }) } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-9' }], failCursors: { 'cursor-1': { kind: 'transient', message: 'Graph is busy' } } },
    });

    expect(ok).toBe(false);
    expect(reads(reader)).toEqual(['deltaFrom:cursor-1']);
  });

  it('a cursor Graph refuses for another reason stops the library, keeping the state it had', async () => {
    const before = recorded({ folders: {} });

    const { ok, files, reader } = await run({
      files: { texts: { [STATE_PATH]: before } },
      reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-9' }], failCursors: { 'cursor-1': { kind: 'permanent', status: 403, message: 'accessDenied' } } },
    });

    expect(ok).toBe(false);
    expect(reads(reader)).toEqual(['deltaFrom:cursor-1']);
    expect(files.written.get(STATE_PATH)).toBe(before);
  });

  it('a failed read by id under a moved folder ends the library with the step, the cause and the message', async () => {
    const files = createFilesFake({ texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets' } }) } });
    const reader = createDriveReaderFake({
      pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }],
      failItemReads: { '01ABC': { kind: 'transient', message: 'Graph is busy' } },
    });
    const clock = createClockFake();
    const syncSite = createSyncSite({
      reader,
      files,
      logger: createLoggerFake(),
      progress: createProgressFake(),
      clock,
      kbRoot: 'kb',
      timezone: 'UTC',
      convertFile: createConvertFile({ reader, files, ocr: createOcrFake(), clock, logger: createLoggerFake(), progress: createProgressFake() }),
    });

    const result = await syncSite({ site, drives, maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });

    expect(result).toEqual({ ok: false, error: { step: 'enumerate', cause: 'transient', message: 'Graph is busy' } });
  });

  it('each document under a moved folder is read again once, also when several are read at a time', async () => {
    const items = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { path: `Projets/${id}.docx`, cTag: 'c1', outputs: [`kb/x/${id}.docx.md`] }]));
    const moved = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, item({ id, name: `${id}.docx`, path: `Contrats 2026/${id}.docx` })]));

    const { reader, summary } = await run({
      files: { texts: { [STATE_PATH]: recorded({ folders: { '01F': 'Projets' }, items }) } },
      reader: { pages: [{ items: [folder('01F', 'Contrats 2026')], skipped: 0, deltaLink: 'cursor-2' }], items: moved },
      concurrency: 2,
    });

    expect(reader.calls.filter((call) => call.startsWith('item:'))).toEqual(['item:a', 'item:b', 'item:c']);
    expect(summary.converted).toBe(3);
  });
});

// The document is the point, and it lands without the part that would not read. The run counts it as
// failed as well, and the next run converts it again for the rest, three times in all.
describe('a document converted without a part of it', () => {
  const BUSY = { kind: 'transient' as const, message: 'Graph is busy' };
  const LOST = 'the pictures could not be read: transient: Graph is busy';
  const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
  const NOTHING_CHANGED = { pages: [{ items: [], skipped: 0, deltaLink: 'cursor-2' }] };

  it('a document whose pictures could not be read lands, is counted as failed, and the next run tries it again for them', async () => {
    const first = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }], failImages: BUSY } });
    const second = await run({ files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '' } }, reader: NOTHING_CHANGED });

    expect(first.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(first.notes?.failed).toEqual([{ path: 'Projets/Contrat.docx', reason: LOST }]);
    expect(stateAfter(first.files).drives['b!one']?.items['01ABC']?.outputs).toEqual([NOTE]);
    expect(stateAfter(first.files).drives['b!one']?.retry['01ABC']).toMatchObject({ attempts: 1, reason: LOST });
    expect(second.summary).toMatchObject({ converted: 1, failed: 0 });
    expect(stateAfter(second.files).drives['b!one']?.retry).toEqual({});
  });

  // The retry converts the version that is already recorded, so it writes over its own files: a copy
  // of the same version under _archive/ for each try would keep nothing worth keeping.
  it('a document converted again for its pictures writes over its own files, with no copy of the same version put aside', async () => {
    const first = await run({ reader: { pages: [{ items: [item()], skipped: 0, deltaLink: 'cursor-1' }], failImages: BUSY } });
    const second = await run({ files: { texts: { [STATE_PATH]: first.files.written.get(STATE_PATH) ?? '', [NOTE]: 'without its pictures' } }, reader: NOTHING_CHANGED });

    expect(second.files.moves).toStrictEqual([]);
    expect(second.files.written.get(NOTE)).toContain('converted 01ABC');
  });

  const owing = (outputs: ReadonlyArray<string>, retried = item()): string =>
    serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs, modified: '2026-05-12T09:31:00Z' } },
          retry: { '01ABC': { item: retried, attempts: 1, reason: LOST } },
          folders: {},
        },
      },
    });

  it('a retry of the version on record that writes fewer files puts the others aside', async () => {
    const MEDIA = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.media/image-01.png';

    const done = await run({
      files: { texts: { [STATE_PATH]: owing([NOTE, MEDIA]), [NOTE]: 'the contract', [MEDIA]: 'a picture' } },
      reader: { ...NOTHING_CHANGED, failImages: BUSY },
    });

    expect(done.files.moves).toEqual([{ from: MEDIA, to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.media/image-01.png' }]);
    expect(stateAfter(done.files).drives['b!one']?.items['01ABC']?.outputs).toEqual([NOTE]);
  });

  it('a retry of the version on record that is now left out puts its files aside, and says where they went', async () => {
    const done = await run({ files: { texts: { [STATE_PATH]: owing([NOTE], item({ size: 60 * 1024 * 1024 })), [NOTE]: 'the contract' } }, reader: NOTHING_CHANGED });

    expect(done.files.moves).toEqual([{ from: NOTE, to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md' }]);
    expect(done.notes?.skipped).toEqual([{ path: 'Projets/Contrat.docx', reason: 'larger than the 50 MB cap. Its earlier version is in _archive/2026-07-23/.' }]);
  });

  // A whole read lists the document as it was, and the retry it is owed stays with it.
  it('a document still owed its pictures is converted again when a whole read lists it unchanged', async () => {
    const owed = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          since: '2026-01-01',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [NOTE] } },
          retry: { '01ABC': { item: item(), attempts: 1, reason: LOST } },
          folders: {},
        },
      },
    });
    const pages = [
      { items: [], skipped: 0, deltaLink: 'cursor-2' },
      { items: [item()], skipped: 0, deltaLink: 'cursor-3' },
    ];

    const done = await run({ files: { texts: { [STATE_PATH]: owed } }, reader: { pages }, since: '2025-01-01' });

    expect(done.summary).toMatchObject({ converted: 1, failed: 0 });
    expect(stateAfter(done.files).drives['b!one']?.retry).toEqual({});
  });

  it('a document still without its pictures on its third try is named once as given up, and keeps what it wrote', async () => {
    const twice = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [NOTE] } },
          retry: { '01ABC': { item: item(), attempts: 2, reason: LOST } },
          folders: {},
        },
      },
    });

    const third = await run({ files: { texts: { [STATE_PATH]: twice } }, reader: { ...NOTHING_CHANGED, failImages: BUSY } });

    expect(third.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(third.notes?.failed).toStrictEqual([]);
    expect(third.notes?.gaveUp).toEqual([{ path: 'Projets/Contrat.docx', reason: LOST }]);
    expect(stateAfter(third.files).drives['b!one']?.items['01ABC']?.outputs).toEqual([NOTE]);
  });
});

describe('a changed document that is now left out', () => {
  const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';

  // Its earlier files no longer match the source, so they go under the archive before the decision
  // to leave it out. The report says so, since the document is no longer where it was.
  it('a document edited past the size cap is left out, and the report says its earlier version was moved aside', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [NOTE] } },
          retry: {},
          folders: {},
        },
      },
    });
    const grown = item({ cTag: 'c2', size: 60 * 1024 * 1024 });

    const { summary, notes, files } = await run({
      files: { texts: { [STATE_PATH]: known, [NOTE]: 'the contract' } },
      reader: { pages: [{ items: [grown], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary).toMatchObject({ converted: 0, skipped: 1 });
    expect(notes?.skipped).toEqual([{ path: 'Projets/Contrat.docx', reason: 'larger than the 50 MB cap. Its earlier version is in _archive/2026-07-23/.' }]);
    expect(files.moves).toEqual([{ from: NOTE, to: 'kb/_archive/2026-07-23/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md' }]);
  });

  it('a changed document left out whose earlier files will not move aside says only why', async () => {
    const known = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [NOTE] } },
          retry: {},
          folders: {},
        },
      },
    });
    const grown = item({ cTag: 'c2', size: 60 * 1024 * 1024 });

    const { notes } = await run({
      files: { texts: { [STATE_PATH]: known, [NOTE]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'held open' } },
      reader: { pages: [{ items: [grown], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(notes?.skipped).toEqual([{ path: 'Projets/Contrat.docx', reason: 'larger than the 50 MB cap' }]);
  });

  it('a document left out the first time it is seen says only why', async () => {
    const { notes } = await run({ reader: { pages: [{ items: [item({ size: 60 * 1024 * 1024 })], skipped: 0, deltaLink: 'cursor-1' }] } });

    expect(notes?.skipped).toEqual([{ path: 'Projets/Contrat.docx', reason: 'larger than the 50 MB cap' }]);
  });
});

// Written over, the version before would be lost: the conversion waits for a run that can move it,
// three runs in all, and the version on disk stays the current one.
describe('an edited document whose earlier version will not move aside', () => {
  const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
  const HELD = 'its earlier version would not move to _archive/: write-failed';
  const known = serializeSiteState({
    version: 1,
    source: { kind: 'site', ...site },
    lastRun: '2026-07-22T09:00:00Z',
    layout: 2,
    drives: {
      'b!one': {
        name: 'Documents',
        deltaLink: 'cursor-1',
        pending: [],
        items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [NOTE] } },
        retry: {},
        folders: {},
      },
    },
  });

  it('is not written over, keeps its record, and is tried again on the next run', async () => {
    const { summary, notes, files } = await run({
      files: { texts: { [STATE_PATH]: known, [NOTE]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'held open' } },
      reader: { pages: [{ items: [item({ cTag: 'c2' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary).toMatchObject({ converted: 0, failed: 1 });
    expect(notes?.failed).toEqual([{ path: 'Projets/Contrat.docx', reason: HELD }]);
    expect(files.written.get(NOTE)).toBe('the contract');
    expect(stateAfter(files).drives['b!one']?.items['01ABC']?.cTag).toBe('c1');
    expect(stateAfter(files).drives['b!one']?.retry['01ABC']).toMatchObject({ attempts: 1, reason: HELD });
  });

  it('still held on its third try, it is named once as given up, and its version on disk stays', async () => {
    const twice = JSON.stringify({
      ...JSON.parse(known),
      drives: { 'b!one': { ...JSON.parse(known).drives['b!one'], retry: { '01ABC': { item: item({ cTag: 'c2' }), attempts: 2, reason: HELD } } } },
    });

    const { notes, files } = await run({
      files: { texts: { [STATE_PATH]: twice, [NOTE]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'held open' } },
      reader: { pages: [{ items: [], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(notes?.failed).toStrictEqual([]);
    expect(notes?.gaveUp).toEqual([{ path: 'Projets/Contrat.docx', reason: HELD }]);
    expect(files.written.get(NOTE)).toBe('the contract');
  });

  // Windows and macOS read a path in any letter case as the same file, so a rename in case alone would
  // write over the earlier version it could not move.
  it('renamed in letter case alone, it waits as an edit in place does', async () => {
    const { summary, files } = await run({
      files: { texts: { [STATE_PATH]: known, [NOTE]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'held open' } },
      reader: { pages: [{ items: [item({ cTag: 'c2', name: 'contrat.docx', path: 'Projets/contrat.docx' })], skipped: 0, deltaLink: 'cursor-2' }] },
    });

    expect(summary).toMatchObject({ converted: 0, failed: 1 });
    expect(files.written.get(NOTE)).toBe('the contract');
  });

  // Moved, the document no longer holds its earlier note, so a note that would not move is handed on
  // to be written down. Held in place, the document keeps it, and hands on nothing.
  const handing = async (texts: Record<string, string>, seed: DriveReaderSeed): Promise<ReadonlyArray<string>> => {
    const handed: string[] = [];
    const files = createFilesFake({ texts, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'held open' } });
    const reader = createDriveReaderFake(seed);
    const clock = createClockFake();
    const convertFile = createConvertFile({ reader, files, ocr: createOcrFake(), clock, logger: createLoggerFake(), progress: createProgressFake() });
    const writeDown = async (missed: ReadonlyArray<{ readonly path: string }>): Promise<void> => {
      handed.push(...missed.map((entry) => entry.path));
    };
    const syncSite = createSyncSite({ reader, files, logger: createLoggerFake(), progress: createProgressFake(), clock, kbRoot: 'kb', timezone: 'UTC', convertFile, writeDown });
    await syncSite({ site, drives, maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });
    return handed;
  };
  const edited = (over: Partial<DriveItem>): DriveReaderSeed => ({ pages: [{ items: [item({ cTag: 'c2', ...over })], skipped: 0, deltaLink: 'cursor-2' }] });

  it('moved to another folder, it lands there and hands on its earlier note; held in place, it hands on nothing', async () => {
    expect(await handing({ [STATE_PATH]: known, [NOTE]: 'the contract' }, edited({ path: 'Archives/Contrat.docx' }))).toEqual([NOTE]);
    expect(await handing({ [STATE_PATH]: known, [NOTE]: 'the contract' }, edited({}))).toStrictEqual([]);
  });

  it('converted again at the version on record, it hands on a file it no longer writes', async () => {
    const MEDIA = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.media/image-01.png';
    const owed = serializeSiteState({
      version: 1,
      source: { kind: 'site', ...site },
      lastRun: '2026-07-22T09:00:00Z',
      layout: 2,
      drives: {
        'b!one': {
          name: 'Documents',
          deltaLink: 'cursor-1',
          pending: [],
          items: { '01ABC': { path: 'Projets/Contrat.docx', cTag: 'c1', outputs: [NOTE, MEDIA], modified: '2026-05-12T09:31:00Z' } },
          retry: { '01ABC': { item: item(), attempts: 1, reason: 'the pictures could not be read' } },
          folders: {},
        },
      },
    });
    const seed = { pages: [{ items: [], skipped: 0, deltaLink: 'cursor-2' }], failImages: { kind: 'transient' as const, message: 'Graph is busy' } };

    expect(await handing({ [STATE_PATH]: owed, [NOTE]: 'the contract', [MEDIA]: 'a picture' }, seed)).toEqual([MEDIA]);
  });
});
