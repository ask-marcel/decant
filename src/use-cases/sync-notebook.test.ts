import { describe, expect, it } from 'bun:test';
import { emptyNotebookState, serializeNotebookState, withPage } from '../domain/notebook-state.ts';
import type { Notebook, NotebookPage } from '../domain/onenote.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createNotebookReaderFake } from '../test-helpers/notebook-reader-fake.ts';
import type { NotebookReaderFake, NotebookReaderSeed } from '../test-helpers/notebook-reader-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { StepError } from './ports/step-error.ts';
import { createSyncNotebook } from './sync-notebook.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const NOTEBOOK: Notebook = { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: 'https://tenant.sharepoint.com/nb', site: { id: 'site-1', name: 'Northwind Leadership' } };

const ROOT = 'kb/OneNote/Northwind Leadership Notebook';
const STATE_PATH = `${ROOT}/.sync-state.json`;

const page = (id: string, title: string, lastModified: string): NotebookPage => ({
  id,
  title,
  created: '2026-08-01T09:00:00Z',
  lastModified,
  webUrl: `https://tenant.sharepoint.com/${id}`,
});

const SECTIONS = {
  '1-nb': [
    { id: 'sec-m', name: 'Meetings', group: '' },
    { id: 'sec-b', name: 'Budget', group: '2026' },
  ],
};
const PAGES = { 'sec-m': [page('a', 'Kick-off', '2026-09-01T10:00:00Z'), page('b', 'Retro', '2026-09-02T10:00:00Z')], 'sec-b': [page('c', 'Q3', '2026-09-03T10:00:00Z')] };

const run = async (
  seeds: { reader?: NotebookReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number; since?: string } = {}
): Promise<{
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  reader: NotebookReaderFake;
  progress: ProgressFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createNotebookReaderFake({ sections: SECTIONS, pages: PAGES, ...seeds.reader });
  const syncNotebook = createSyncNotebook({ reader, files, clock: createClockFake('2026-09-12T14:00:00Z'), logger, progress, kbRoot: 'kb' });
  const outcome = await syncNotebook({ notebook: NOTEBOOK, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4, since: seeds.since });
  const empty = {
    summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
    source: NOTEBOOK.name,
    notes: { skipped: [], failed: [], givenUp: [], archived: [] },
  };
  return outcome.ok ? { ...outcome.value, files, logger, reader, progress, ok: true } : { ...empty, files, logger, reader, progress, ok: false, error: outcome.error };
};

const stateOf = (files: FilesFake): { lastRun: string; pages: Record<string, { file: string; lastModified: string; title: string; section: string }> } =>
  JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('syncing a OneNote notebook', () => {
  it('a first run walks every section, writes every page under its section and group, and remembers what it wrote', async () => {
    const done = await run();

    expect(done.summary.converted).toBe(3);
    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Meetings/Kick-off.md`, `${ROOT}/Meetings/Retro.md`, `${ROOT}/2026/Budget/Q3.md`]);
    expect(done.files.written.get(`${ROOT}/2026/Budget/Q3.md`)).toContain('section: Budget\ngroup: "2026"');
    expect(done.files.written.get(`${ROOT}/Meetings/Kick-off.md`)).toContain('text of a');
    expect(stateOf(done.files).pages['c']).toEqual({ file: `${ROOT}/2026/Budget/Q3.md`, lastModified: '2026-09-03T10:00:00Z', title: 'Q3', section: 'sec-b' });
  });

  it('a second run reads every page listing again and writes only the pages that changed', async () => {
    const state = withPage(
      withPage(
        withPage(emptyNotebookState(NOTEBOOK), 'a', {
          file: `${ROOT}/Meetings/Kick-off.md`,
          lastModified: '2026-09-01T10:00:00Z',
          title: 'Kick-off',
          section: 'sec-m',
        }),
        'b',
        { file: `${ROOT}/Meetings/Retro.md`, lastModified: 'stale', title: 'Retro', section: 'sec-m' }
      ),
      'c',
      {
        file: `${ROOT}/2026/Budget/Q3.md`,
        lastModified: '2026-09-03T10:00:00Z',
        title: 'Q3',
        section: 'sec-b',
      }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializeNotebookState(state) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.reader.calls.filter((call) => call.startsWith('pageMarkdown'))).toEqual(['pageMarkdown:b']);
  });

  it('a run where nothing changed writes nothing but its own state file, stamped', async () => {
    const state = withPage(
      withPage(
        withPage(emptyNotebookState(NOTEBOOK), 'a', {
          file: `${ROOT}/Meetings/Kick-off.md`,
          lastModified: '2026-09-01T10:00:00Z',
          title: 'Kick-off',
          section: 'sec-m',
        }),
        'b',
        { file: `${ROOT}/Meetings/Retro.md`, lastModified: '2026-09-02T10:00:00Z', title: 'Retro', section: 'sec-m' }
      ),
      'c',
      {
        file: `${ROOT}/2026/Budget/Q3.md`,
        lastModified: '2026-09-03T10:00:00Z',
        title: 'Q3',
        section: 'sec-b',
      }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializeNotebookState(state) } } });

    expect(done.files.writeLog).toEqual([STATE_PATH]);
    expect(stateOf(done.files).lastRun).toBe('2026-09-12T14:00:00Z');
  });

  it('a page renamed or moved to another section is written afresh, and the old copy put aside; a page gone from the notebook is put aside and named in the report', async () => {
    const state = withPage(
      withPage(emptyNotebookState(NOTEBOOK), 'a', { file: `${ROOT}/Old section/Kick-off.md`, lastModified: 'older', title: 'Kick-off', section: 'sec-m' }),
      'gone',
      { file: `${ROOT}/Meetings/Deleted.md`, lastModified: 'x', title: 'Deleted', section: 'sec-m' }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializeNotebookState(state) } } });

    expect(done.summary).toMatchObject({ converted: 3, archived: 1 });
    expect(done.files.moves.map((move) => move.to)).toEqual([
      'kb/_archive/OneNote/Northwind Leadership Notebook/Old section/Kick-off.md',
      'kb/_archive/OneNote/Northwind Leadership Notebook/Meetings/Deleted.md',
    ]);
    expect(done.notes.archived).toEqual([{ path: 'Deleted', reason: 'no longer in the notebook' }]);
    expect(done.files.written.get(`${ROOT}/_sync-report.md`)).toContain('Deleted');
  });

  it('a page retitled in the same run as a namesake puts only its own old copy aside, and the namesake is rewritten in the file its record names', async () => {
    const state = withPage(withPage(emptyNotebookState(NOTEBOOK), 'a', { file: `${ROOT}/Meetings/Kick-off.md`, lastModified: 'stale', title: 'Kick-off', section: 'sec-m' }), 'b', {
      file: `${ROOT}/Meetings/Kick-off-b.md`,
      lastModified: 'stale',
      title: 'Kick-off',
      section: 'sec-m',
    });
    const done = await run({
      reader: {
        pages: { 'sec-m': [page('a', 'Agenda', '2026-09-05T10:00:00Z'), page('b', 'Kick-off', '2026-09-06T10:00:00Z')], 'sec-b': [] },
        markdown: { b: 'the kick-off, moved to Monday' },
      },
      files: {
        texts: {
          [STATE_PATH]: serializeNotebookState(state),
          [`${ROOT}/Meetings/Kick-off.md`]: 'the page as it was',
          [`${ROOT}/Meetings/Kick-off-b.md`]: 'the namesake as it was',
        },
      },
    });

    const recorded = stateOf(done.files).pages['b']?.file ?? '';
    expect(done.files.written.get(recorded)).toContain('the kick-off, moved to Monday');
    expect(done.files.moves).toEqual([{ from: `${ROOT}/Meetings/Kick-off.md`, to: 'kb/_archive/OneNote/Northwind Leadership Notebook/Meetings/Kick-off.md' }]);
    expect(done.files.written.get('kb/_archive/OneNote/Northwind Leadership Notebook/Meetings/Kick-off.md')).toBe('the page as it was');
  });

  it('a page whose text cannot be read is reported as failed and kept where it was, and a section whose pages cannot be listed keeps its pages as they are', async () => {
    const unreadable = await run({ reader: { failMarkdownOf: ['b'] } });
    expect(unreadable.summary).toMatchObject({ converted: 2, failed: 1 });
    expect(unreadable.notes.failed).toEqual([{ path: 'Meetings/Retro', reason: 'cannot read b' }]);
    expect(stateOf(unreadable.files).pages['b']).toBeUndefined();

    const state = withPage(emptyNotebookState(NOTEBOOK), 'c', { file: `${ROOT}/2026/Budget/Q3.md`, lastModified: 'x', title: 'Q3', section: 'sec-b' });
    const unlisted = await run({ reader: { failPagesOf: ['sec-b'] }, files: { texts: { [STATE_PATH]: serializeNotebookState(state) } } });
    expect(unlisted.summary).toMatchObject({ converted: 2, archived: 0, failed: 1 });
    expect(unlisted.notes.failed).toEqual([{ path: '2026/Budget', reason: 'Graph is busy' }]);
    expect(stateOf(unlisted.files).pages['c']).toBeDefined();
  });

  it('a notebook whose sections cannot be listed ends the run naming the step', async () => {
    const done = await run({ reader: { failSections: { kind: 'auth', message: 'sign-in has lapsed' } } });

    expect(done.ok).toBe(false);
    expect(done.error).toEqual({ step: 'listSections', cause: 'auth', message: 'sign-in has lapsed' });
  });

  it('a dry run lists the notebook, says how many pages it would write, and writes nothing at all', async () => {
    const done = await run({ dryRun: true });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 3 });
    expect(done.files.writeLog).toHaveLength(0);
    expect(done.reader.calls.filter((call) => call.startsWith('pageMarkdown'))).toHaveLength(0);
  });

  it('a state file this version cannot read is started over, a state file that cannot be saved stops the run, and a page that will not write is reported', async () => {
    const restarted = await run({ files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"notebook","id":"1-nb","name":"N"}}' } } });
    expect(restarted.summary.converted).toBe(3);
    expect(restarted.logger.calls).toContainEqual({ level: 'warn', event: 'notebook-state.unreadable', meta: { notebook: '1-nb', cause: 'state is version 99, not 1' } });

    const unsaved = await run({ files: { failWritesMatching: '.sync-state.json' } });
    expect(unsaved.ok).toBe(false);
    expect(unsaved.error?.step).toBe('saveState');

    const unwritten = await run({ files: { failWritesMatching: 'Retro' } });
    expect(unwritten.summary).toMatchObject({ converted: 2, failed: 1 });
    expect(unwritten.notes.failed).toEqual([{ path: 'Meetings/Retro', reason: `cannot write ${ROOT}/Meetings/Retro.md` }]);
  });

  it('a notebook sharing its name with one already on the shelf takes a folder of its own, suffixed by its id', async () => {
    const other = serializeNotebookState(emptyNotebookState({ ...NOTEBOOK, id: 'other-nb' }));
    const done = await run({ files: { texts: { [STATE_PATH]: other } } });

    expect(done.summary.converted).toBe(3);
    expect(done.files.written.has(STATE_PATH)).toBe(true);
    expect(JSON.parse(done.files.written.get(STATE_PATH) ?? '{}').source.id).toBe('other-nb');
    expect([...done.files.written.keys()].some((path) => path.startsWith('kb/OneNote/Northwind Leadership Notebook-') && path.endsWith('.sync-state.json'))).toBe(true);
  });

  it('a page rewritten under the same file keeps it where it is, a file that will not move aside is logged, and the ledger drops a page whose file is gone', async () => {
    const same = withPage(emptyNotebookState(NOTEBOOK), 'a', { file: `${ROOT}/Meetings/Kick-off.md`, lastModified: 'older', title: 'Kick-off', section: 'sec-m' });
    const rewritten = await run({ files: { texts: { [STATE_PATH]: serializeNotebookState(same) } } });
    expect(rewritten.files.moves).toHaveLength(0);

    const held = withPage(withPage(emptyNotebookState(NOTEBOOK), 'a', { file: `${ROOT}/Old/Kick-off.md`, lastModified: 'older', title: 'Kick-off', section: 'sec-m' }), 'gone', {
      file: `${ROOT}/Meetings/Deleted.md`,
      lastModified: 'x',
      title: 'Deleted',
      section: 'sec-m',
    });
    const stuck = await run({ files: { texts: { [STATE_PATH]: serializeNotebookState(held) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } } });
    expect(stuck.ok).toBe(true);
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: `${ROOT}/Old/Kick-off.md`, cause: 'write-failed' } });
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: `${ROOT}/Meetings/Deleted.md`, cause: 'write-failed' } });
    expect(stateOf(stuck.files).pages['gone']).toBeUndefined();
  });

  it('pages are written a window at a time with the state saved once per window, and the run logs what it listed by counts', async () => {
    const done = await run({ concurrency: 1 });

    expect(done.files.writeLog.filter((path) => path === STATE_PATH)).toHaveLength(4);
    expect(done.logger.calls).toContainEqual({ level: 'info', event: 'notebook.listed', meta: { notebook: '1-nb', sections: 2, pages: 3, changed: 3 } });
    expect(done.logger.calls.filter((entry) => entry.event === 'page.failed')).toHaveLength(0);
  });

  it('a garbled state file starts the notebook over, and a page whose write fails is logged by id', async () => {
    const garbled = await run({ files: { texts: { [STATE_PATH]: 'not json at all' } } });
    expect(garbled.summary.converted).toBe(3);

    const unwritten = await run({ files: { failWritesMatching: 'Retro' } });
    expect(unwritten.logger.calls).toContainEqual({ level: 'warn', event: 'page.failed', meta: { page: 'b', cause: 'write-failed' } });
  });

  it('a notebook whose twin holds the plain folder reads its own suffixed state back on the next run', async () => {
    const twin = serializeNotebookState(emptyNotebookState({ ...NOTEBOOK, id: 'other-nb' }));
    const first = await run({ files: { texts: { [STATE_PATH]: twin } } });
    const own = [...first.files.written.keys()].find((path) => path.startsWith('kb/OneNote/Northwind Leadership Notebook-') && path.endsWith('.sync-state.json')) ?? '';

    const second = await run({ files: { texts: { [STATE_PATH]: twin, [own]: first.files.written.get(own) ?? '' } } });

    expect(second.summary.converted).toBe(0);
    expect(second.files.writeLog).toEqual([own]);
  });

  it('the log names the notebook and its pages by id and counts, never by title', async () => {
    const done = await run({ reader: { failMarkdownOf: ['b'] } });

    const logged = JSON.stringify(done.logger.calls);
    expect(logged).not.toContain('Retro');
    expect(logged).not.toContain('Kick-off');
  });
});

describe('reaching back only as far as the day', () => {
  const DATED = { 'sec-m': [page('a', 'Kick-off', '2024-05-01T10:00:00Z'), page('b', 'Retro', '2026-09-02T10:00:00Z')], 'sec-b': [] };

  it('pages last changed before the day are left out, and come in once the day moves earlier, without writing the rest again', async () => {
    const narrow = await run({ reader: { pages: DATED }, since: '2025-01-01' });

    expect(narrow.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Meetings/Retro.md`]);

    const wider = await run({ reader: { pages: DATED }, files: { texts: { [STATE_PATH]: narrow.files.written.get(STATE_PATH) ?? '' } }, since: '2024-01-01' });

    expect(wider.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Meetings/Kick-off.md`]);
  });
});

describe('telling the reader which page is being written', () => {
  it('the counter names each page by its title, and one with none as untitled', async () => {
    const pages = { 'sec-m': [page('a', 'Kick-off', '2026-09-01T10:00:00Z'), page('u', '', '2026-09-02T10:00:00Z')], 'sec-b': [] };

    const done = await run({ reader: { pages } });

    expect(done.progress.steps).toEqual(['Kick-off', '(untitled page)']);
  });
});
