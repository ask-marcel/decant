import { describe, expect, it } from 'bun:test';
import { freeSegment } from '../domain/kb-path.ts';
import { emptyListsState, serializeListsState, withList } from '../domain/lists-state.ts';
import { listFingerprint } from '../domain/sharepoint-list.ts';
import type { ListColumn, ListItem, SharePointList } from '../domain/sharepoint-list.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createListReaderFake } from '../test-helpers/list-reader-fake.ts';
import type { ListReaderFake, ListReaderSeed } from '../test-helpers/list-reader-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { StepError } from './ports/step-error.ts';
import { createSyncLists } from './sync-lists.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const SITE = { id: 'site-1', name: 'Espace Contoso' };
const ROOT = 'kb/SharePoint lists/Espace Contoso';
const STATE_PATH = `${ROOT}/.sync-state.json`;

const list = (id: string, name: string, template = 'genericList', hidden = false): SharePointList => ({
  id,
  name,
  description: '',
  webUrl: `https://tenant.sharepoint.com/Lists/${name}`,
  template,
  hidden,
});
const column = (name: string, label = name): ListColumn => ({ name, label, hidden: false, readOnly: false });
const row = (id: string, lastModified: string, title: string): ListItem => ({ id, lastModified, webUrl: '', fields: { Title: title } });

const LISTS = {
  'site-1': [list('projects', 'Projects'), list('docs', 'Documents', 'documentLibrary'), list('issues', 'Issues', 'issueTracking'), list('secret', 'Hidden', 'genericList', true)],
};
const COLUMNS = { projects: [column('Title'), column('ProjectStatus', 'Status'), { ...column('_ColorTag', 'Color Tag'), readOnly: true }], issues: [column('Title')] };
const ROWS = { projects: [row('1', '2026-09-10T10:00:00Z', 'Falcon'), row('2', '2026-09-11T10:00:00Z', 'Eagle')], issues: [row('7', '2026-09-01T10:00:00Z', 'Leak')] };

const run = async (
  seeds: { reader?: ListReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number } = {}
): Promise<{
  id: string;
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  reader: ListReaderFake;
  progress: ProgressFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const reader = createListReaderFake({ lists: LISTS, columns: COLUMNS, rows: ROWS, ...seeds.reader });
  const progress = createProgressFake();
  const syncLists = createSyncLists({ reader, files, clock: createClockFake('2026-09-12T14:00:00Z'), logger, progress, kbRoot: 'kb' });
  const outcome = await syncLists({ site: SITE, dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4 });
  const empty = {
    id: '',
    summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
    source: SITE.name,
    notes: { skipped: [], failed: [], givenUp: [], archived: [] },
  };
  return outcome.ok ? { ...outcome.value, files, logger, reader, progress, ok: true } : { ...empty, files, logger, reader, progress, ok: false, error: outcome.error };
};

const stateOf = (files: FilesFake): { lastRun: string; lists: Record<string, { file: string; fingerprint: string; name: string }> } =>
  JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('syncing the lists of a SharePoint site', () => {
  it('a first run reads every list a person fills in, its columns and every row, and writes one table per list; libraries and hidden lists are passed over', async () => {
    const done = await run();

    expect(done.summary.converted).toBe(2);
    expect({ id: done.id, source: done.source }).toEqual({ id: 'lists:site-1', source: 'Espace Contoso (lists)' });
    expect(done.reader.calls.filter((call) => call.startsWith('rows:')).toSorted((left, right) => left.localeCompare(right))).toEqual(['rows:issues', 'rows:projects']);
    expect(new Set(done.files.written.keys())).toEqual(new Set([STATE_PATH, `${ROOT}/Projects.md`, `${ROOT}/Issues.md`]));
    expect(done.files.written.get(`${ROOT}/Projects.md`)).toContain('| Title | Status |\n|---|---|\n| Falcon |  |\n| Eagle |  |');
    expect(stateOf(done.files).lists['projects']).toMatchObject({ file: `${ROOT}/Projects.md`, name: 'Projects' });
    expect(done.logger.calls).toContainEqual({ level: 'info', event: 'lists.listed', meta: { site: 'site-1', lists: 2, passedOver: 2 } });
    expect(done.logger.calls.every((entry) => entry.event !== 'lists-state.unreadable')).toBe(true);
  });

  it('the lists are written a window at a time, each stepped once, the state saved after every window', async () => {
    const done = await run({ concurrency: 1 });

    expect(done.progress.started).toEqual([{ total: 2, what: 'Espace Contoso' }]);
    expect(done.progress.steps).toEqual(['Projects', 'Issues']);
    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Projects.md`, `${ROOT}/Issues.md`]);
    expect(done.files.writeLog.filter((path) => path === STATE_PATH)).toHaveLength(3);
  });

  it('a second run reads every row again and rewrites only the lists whose rows or columns changed', async () => {
    const state = withList(
      withList(emptyListsState(SITE.id, SITE.name), 'projects', {
        file: `${ROOT}/Projects.md`,
        fingerprint: listFingerprint(['Title', 'ProjectStatus'], ROWS.projects),
        name: 'Projects',
      }),
      'issues',
      { file: `${ROOT}/Issues.md`, fingerprint: 'stale', name: 'Issues' }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializeListsState(state) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Issues.md`]);
    expect(done.files.moves).toStrictEqual([]);
    expect(stateOf(done.files).lists['issues']?.file).toBe(`${ROOT}/Issues.md`);
  });

  it('a run where nothing changed writes nothing but its own state file, stamped', async () => {
    const state = withList(
      withList(emptyListsState(SITE.id, SITE.name), 'projects', {
        file: `${ROOT}/Projects.md`,
        fingerprint: listFingerprint(['Title', 'ProjectStatus'], ROWS.projects),
        name: 'Projects',
      }),
      'issues',
      { file: `${ROOT}/Issues.md`, fingerprint: listFingerprint(['Title'], ROWS.issues), name: 'Issues' }
    );
    const done = await run({ files: { texts: { [STATE_PATH]: serializeListsState(state) } } });

    expect(done.files.writeLog).toEqual([STATE_PATH]);
    expect(stateOf(done.files).lastRun).toBe('2026-09-12T14:00:00Z');
  });

  it('a list renamed is written under the new name with the old table put aside, and a list gone from the site is put aside and named in the report', async () => {
    const state = withList(withList(emptyListsState(SITE.id, SITE.name), 'projects', { file: `${ROOT}/Old name.md`, fingerprint: 'stale', name: 'Old name' }), 'gone', {
      file: `${ROOT}/Retired.md`,
      fingerprint: 'x',
      name: 'Retired',
    });
    const done = await run({ files: { texts: { [STATE_PATH]: serializeListsState(state) } } });

    expect(done.summary).toMatchObject({ converted: 2, archived: 1 });
    expect(done.files.moves.map((move) => move.to)).toEqual(['kb/_archive/SharePoint lists/Espace Contoso/Old name.md', 'kb/_archive/SharePoint lists/Espace Contoso/Retired.md']);
    expect(done.notes.archived).toEqual([{ path: 'Retired', reason: 'no longer on the site' }]);
    expect(done.files.written.get(`${ROOT}/_sync-report.md`)).toContain('Retired');
    expect(done.files.written.get(`${ROOT}/_sync-report.md`)).toContain('Espace Contoso (lists)');
    expect(new Set(Object.keys(stateOf(done.files).lists))).toEqual(new Set(['issues', 'projects']));

    const stuck = await run({ files: { texts: { [STATE_PATH]: serializeListsState(state) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } } });
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: `${ROOT}/Old name.md`, cause: 'write-failed' } });
  });

  it('a list renamed in the same run as a namesake puts only its own old table aside, and the namesake is rewritten in the file its record names', async () => {
    // Where the namesake was put while the renamed list held the plain name.
    const namesakeFile = `${ROOT}/${freeSegment('Projects.md', 'twin', (name) => name === 'Projects.md')}`;
    const state = withList(withList(emptyListsState(SITE.id, SITE.name), 'projects', { file: `${ROOT}/Projects.md`, fingerprint: 'stale', name: 'Projects' }), 'twin', {
      file: namesakeFile,
      fingerprint: 'stale',
      name: 'Projects',
    });
    const done = await run({
      reader: {
        lists: { 'site-1': [list('projects', 'Programs'), list('twin', 'Projects')] },
        columns: { ...COLUMNS, twin: [column('Title')] },
        rows: { ...ROWS, twin: [row('9', '2026-09-11T10:00:00Z', 'Osprey')] },
      },
      files: { texts: { [STATE_PATH]: serializeListsState(state), [`${ROOT}/Projects.md`]: 'the table as it was', [namesakeFile]: 'the namesake as it was' } },
    });

    const recorded = stateOf(done.files).lists['twin']?.file ?? '';
    expect(done.files.written.get(recorded)).toContain('Osprey');
    expect(done.files.moves).toEqual([{ from: `${ROOT}/Projects.md`, to: 'kb/_archive/SharePoint lists/Espace Contoso/Projects.md' }]);
    expect(done.files.written.get('kb/_archive/SharePoint lists/Espace Contoso/Projects.md')).toBe('the table as it was');
  });

  it('a list whose columns or rows cannot be read is reported as failed and kept as it was', async () => {
    const state = withList(emptyListsState(SITE.id, SITE.name), 'issues', { file: `${ROOT}/Issues.md`, fingerprint: 'old', name: 'Issues' });
    const done = await run({ reader: { failRowsOf: ['issues'], failColumnsOf: ['projects'] }, files: { texts: { [STATE_PATH]: serializeListsState(state) } } });

    expect(done.summary).toMatchObject({ converted: 0, failed: 2, archived: 0 });
    expect(done.notes.failed).toEqual([
      { path: 'Projects', reason: 'Graph is busy' },
      { path: 'Issues', reason: 'Graph is busy' },
    ]);
    expect(stateOf(done.files).lists['issues']).toBeDefined();
  });

  it('a site whose lists cannot be listed ends the run naming the step', async () => {
    const done = await run({ reader: { failLists: { kind: 'auth', message: 'sign-in has lapsed' } } });

    expect(done.ok).toBe(false);
    expect(done.error).toEqual({ step: 'listLists', cause: 'auth', message: 'sign-in has lapsed' });
  });

  it('a dry run lists the site, reads every row, says how many tables it would write, and writes nothing', async () => {
    const done = await run({ dryRun: true });
    const oneUnreadable = await run({ dryRun: true, reader: { failRowsOf: ['issues'] } });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 2 });
    expect(done.files.writeLog).toHaveLength(0);
    expect(oneUnreadable.summary.queued).toBe(1);
  });

  it('a state file this version cannot read is started over, one that cannot be saved stops the run, and a table that will not write is reported', async () => {
    const restarted = await run({ files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"lists","id":"site-1","name":"S"}}' } } });
    expect(restarted.summary.converted).toBe(2);
    expect(restarted.logger.calls).toContainEqual({ level: 'warn', event: 'lists-state.unreadable', meta: { site: 'site-1', cause: 'state is version 99, not 1' } });

    const garbled = await run({ files: { texts: { [STATE_PATH]: '{not json' } } });
    expect(garbled.summary.converted).toBe(2);
    expect(garbled.logger.calls.filter((entry) => entry.event === 'lists-state.unreadable')).toHaveLength(1);

    const unsaved = await run({ concurrency: 1, files: { failWritesMatching: '.sync-state.json' } });
    expect(unsaved.ok).toBe(false);
    expect(unsaved.error?.step).toBe('saveState');
    expect(unsaved.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/Projects.md`]);

    const settled = withList(
      withList(emptyListsState(SITE.id, SITE.name), 'projects', {
        file: `${ROOT}/Projects.md`,
        fingerprint: listFingerprint(['Title', 'ProjectStatus'], ROWS.projects),
        name: 'Projects',
      }),
      'issues',
      { file: `${ROOT}/Issues.md`, fingerprint: listFingerprint(['Title'], ROWS.issues), name: 'Issues' }
    );
    const unstamped = await run({ files: { texts: { [STATE_PATH]: serializeListsState(settled) }, failWritesMatching: '.sync-state.json' } });
    expect(unstamped.ok).toBe(false);
    expect(unstamped.error?.step).toBe('saveState');
    expect(unstamped.files.written.has(`${ROOT}/_sync-report.md`)).toBe(false);

    const unwritten = await run({ files: { failWritesMatching: 'Issues' } });
    expect(unwritten.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(unwritten.notes.failed).toEqual([{ path: 'Issues', reason: `cannot write ${ROOT}/Issues.md` }]);
    expect(unwritten.logger.calls).toContainEqual({ level: 'warn', event: 'list.failed', meta: { list: 'issues', cause: 'write-failed' } });
    expect(Object.keys(stateOf(unwritten.files).lists)).toEqual(['projects']);
  });

  it('two lists sharing a name on one site take different files, and a file that will not move aside is logged', async () => {
    const twins = { 'site-1': [list('one', 'Tracker'), list('two', 'Tracker')] };
    const done = await run({ reader: { lists: twins, columns: {}, rows: {} } });
    const files = Object.values(stateOf(done.files).lists).map((record) => record.file);
    expect(new Set(files).size).toBe(2);

    // A namesake already on disk and unchanged keeps its file; the newcomer is the one to step aside.
    const kept = withList(emptyListsState(SITE.id, SITE.name), 'one', { file: `${ROOT}/Tracker.md`, fingerprint: listFingerprint([], []), name: 'Tracker' });
    const later = await run({ reader: { lists: twins, columns: {}, rows: {} }, files: { texts: { [STATE_PATH]: serializeListsState(kept) } } });
    expect(later.summary.converted).toBe(1);
    expect(stateOf(later.files).lists['one']?.file).toBe(`${ROOT}/Tracker.md`);
    expect(stateOf(later.files).lists['two']?.file).toContain('Tracker-');

    const state = withList(emptyListsState(SITE.id, SITE.name), 'gone', { file: `${ROOT}/Retired.md`, fingerprint: 'x', name: 'Retired' });
    const stuck = await run({ files: { texts: { [STATE_PATH]: serializeListsState(state) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } } });
    expect(stuck.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: `${ROOT}/Retired.md`, cause: 'write-failed' } });
  });

  it('three lists sharing a name on one site land in three files, even when their ids open alike', async () => {
    const done = await run({ reader: { lists: { 'site-1': ['tracker-1', 'tracker-2', 'tracker-3'].map((id) => list(id, 'Tracker')) }, columns: {}, rows: {} } });

    expect(new Set(Object.values(stateOf(done.files).lists).map((record) => record.file)).size).toBe(3);
  });
});
