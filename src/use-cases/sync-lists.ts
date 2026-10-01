import { renderListDocument } from '../domain/list-document.ts';
import { LISTS_STATE_VERSION, emptyListsState, goneLists, listFileFor, listsRootName, parseListsState, serializeListsState, withList, withoutList } from '../domain/lists-state.ts';
import type { ListRecord, ListsState } from '../domain/lists-state.ts';
import { archivePath } from '../domain/output-paths.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { isPeopleList, isShownColumn, listFingerprint } from '../domain/sharepoint-list.ts';
import type { ListColumn, ListItem, SharePointList } from '../domain/sharepoint-list.ts';
import { sourceKey, sourceLabel } from '../domain/sync-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { ListReader } from './ports/list-reader.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const LISTS_STATE_FILE = '.sync-state.json';

export type SyncListsDeps = {
  readonly reader: ListReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncListsInput = { readonly site: { readonly id: string; readonly name: string }; readonly dryRun: boolean; readonly concurrency: number };

export type SyncLists = (input: SyncListsInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

type Roots = { readonly root: string; readonly archive: string };

// The run is keyed and named as a site's lists rather than as the site, so the picker's marks and
// the global report tell it from the same site's libraries.
const runOf = (site: SyncListsInput['site'], summary: RunSummary, notes: RunNotes): SourceRun => ({
  id: sourceKey({ kind: 'lists', id: site.id }),
  source: sourceLabel({ kind: 'lists', name: site.name }),
  summary,
  notes,
});

const rootsOf = (deps: SyncListsDeps, site: SyncListsInput['site']): Roots => ({
  root: `${deps.kbRoot}/${listsRootName(site.name)}`,
  archive: `${deps.kbRoot}/_archive/${listsRootName(site.name)}`,
});

// No state file is the first run; one that will not parse, as JSON or as a state, is started over
// with a warning, since the run then rewrites every table and a person should know why.
const loadState = async (deps: SyncListsDeps, roots: Roots, site: SyncListsInput['site']): Promise<ListsState> => {
  const text = await deps.files.readText(`${roots.root}/${LISTS_STATE_FILE}`);
  if (!text.ok) return emptyListsState(site.id, site.name);
  const parsed = parseJson(text.value);
  const state = parsed.ok ? parseListsState(parsed.value) : parsed;
  if (state.ok) return state.value;
  deps.logger.warn('lists-state.unreadable', { site: site.id, cause: state.error.message });
  return emptyListsState(site.id, site.name);
};

// A list read whole: its columns and every row, with the fingerprint that says whether the table on
// disk is behind. Either read failing costs the list and not the run.
type Table = { readonly columns: ReadonlyArray<ListColumn>; readonly rows: ReadonlyArray<ListItem>; readonly fingerprint: string };

type Read =
  { readonly list: SharePointList; readonly table: Table; readonly failed?: undefined } | { readonly list: SharePointList; readonly table?: undefined; readonly failed: string };

const readOne = async (deps: SyncListsDeps, siteId: string, list: SharePointList): Promise<Read> => {
  const columns = await deps.reader.columns(siteId, list.id);
  if (!columns.ok) return { list, failed: columns.error.message };
  const rows = await deps.reader.rows(siteId, list.id);
  if (!rows.ok) return { list, failed: rows.error.message };
  const shown = columns.value.filter(isShownColumn).map((column) => column.name);
  return { list, table: { columns: columns.value, rows: rows.value, fingerprint: listFingerprint(shown, rows.value) } };
};

type Done = { readonly apply: (state: ListsState) => ListsState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const moveAside = async (deps: SyncListsDeps, roots: Roots, output: string, what: string): Promise<void> => {
  const moved = await deps.files.move(output, archivePath(roots.archive, roots.root, output));
  if (!moved.ok) deps.logger.warn(`${what}.failed`, { path: output, cause: moved.error.kind });
};

const writeOne = async (deps: SyncListsDeps, input: SyncListsInput, roots: Roots, state: ListsState, read: Read, file: string): Promise<Done> => {
  if (read.table === undefined) return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: read.list.name, reason: read.failed }] } };
  const written = await deps.files.writeText(
    file,
    renderListDocument({ list: read.list, site: input.site.name, columns: read.table.columns, rows: read.table.rows, syncedAt: deps.clock.nowIso() })
  );
  if (!written.ok) {
    deps.logger.warn('list.failed', { list: read.list.id, cause: written.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: read.list.name, reason: written.error.message }] } };
  }
  const before = state.lists[read.list.id];
  if (before !== undefined && before.file !== file) await moveAside(deps, roots, before.file, 'supersede');
  const record: ListRecord = { file, fingerprint: read.table.fingerprint, name: read.list.name };
  return { apply: (carried) => withList(carried, read.list.id, record), counted: { converted: 1 }, notes: {} };
};

const archiveGone = async (deps: SyncListsDeps, roots: Roots, gone: { readonly id: string; readonly record: ListRecord }): Promise<Done> => {
  await moveAside(deps, roots, gone.record.file, 'archive');
  return { apply: (carried) => withoutList(carried, gone.id), counted: { archived: 1 }, notes: { archived: [{ path: gone.record.name, reason: 'no longer on the site' }] } };
};

const counted = (summary: RunSummary, results: ReadonlyArray<Done>): RunSummary =>
  results.reduce(
    (carried, done) => ({
      ...carried,
      converted: carried.converted + (done.counted.converted ?? 0),
      archived: carried.archived + (done.counted.archived ?? 0),
      failed: carried.failed + (done.counted.failed ?? 0),
    }),
    summary
  );

const noted = (notes: RunNotes, results: ReadonlyArray<Done>): RunNotes => ({
  ...notes,
  failed: [...notes.failed, ...results.flatMap((done) => done.notes.failed ?? [])],
  archived: [...notes.archived, ...results.flatMap((done) => done.notes.archived ?? [])],
});

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: ListsState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

const save = async (deps: SyncListsDeps, roots: Roots, state: ListsState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${roots.root}/${LISTS_STATE_FILE}`, serializeListsState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

// A list is worth writing when its fingerprint moved or it was never written; one that could not
// be read is carried through so it is reported, and one unchanged is dropped here.
const owed = (state: ListsState, reads: ReadonlyArray<Read>): ReadonlyArray<Read> =>
  reads.filter((read) => read.table === undefined || state.lists[read.list.id]?.fingerprint !== read.table.fingerprint);

// Every table a list other than this one holds, rewritten in this run or not. A rewritten list still
// holds its old table until its own write lands and puts it aside; handed to a namesake, that file
// would be put aside after the namesake's write, taking the namesake's fresh table with it.
const heldByOthers = (state: ListsState, id: string): ReadonlyArray<string> =>
  Object.entries(state.lists)
    .filter(([held]) => held !== id)
    .map(([, record]) => record.file);

// Paths settled one list at a time before the window's writes run side by side: two lists sharing a
// name must not both be handed the same file.
const planned = (roots: Roots, state: ListsState, reads: ReadonlyArray<Read>): ReadonlyArray<{ readonly read: Read; readonly file: string }> => {
  const handedOut = new Set<string>();
  return reads.map((read) => {
    const file = listFileFor(roots.root, read.list, new Set([...heldByOthers(state, read.list.id), ...handedOut]));
    handedOut.add(file);
    return { read, file };
  });
};

const writeTables = async (deps: SyncListsDeps, input: SyncListsInput, roots: Roots, carried: Progressing, reads: ReadonlyArray<Read>): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  const plan = planned(roots, carried.state, reads);
  for (let at = 0; at < plan.length; at += input.concurrency) {
    const window = plan.slice(at, at + input.concurrency);
    const results = await Promise.all(window.map((entry) => writeOne(deps, input, roots, progressing.state, entry.read, entry.file)));
    for (const entry of window) deps.progress.step(entry.read.list.name);
    progressing = fold(progressing, results);
    const saved = await save(deps, roots, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

export const createSyncLists =
  (deps: SyncListsDeps): SyncLists =>
  async (input) => {
    const roots = rootsOf(deps, input.site);
    const state: ListsState = { ...(await loadState(deps, roots, input.site)), version: LISTS_STATE_VERSION };
    const listed = await deps.reader.lists(input.site.id);
    if (!listed.ok) return failed('listLists', listed.error.kind, listed.error.message);
    const lists = listed.value.filter(isPeopleList);
    deps.logger.info('lists.listed', { site: input.site.id, lists: lists.length, passedOver: listed.value.length - lists.length });
    const reads: Read[] = [];
    for (const list of lists) reads.push(await readOne(deps, input.site.id, list));
    const work = owed(state, reads);
    if (input.dryRun) return ok(runOf(input.site, { ...EMPTY, queued: work.filter((read) => read.table !== undefined).length }, NO_NOTES));
    deps.progress.start(work.length, input.site.name);
    const written = await writeTables(deps, input, roots, { summary: EMPTY, notes: NO_NOTES, state }, work);
    deps.progress.done();
    if (!written.ok) return written;
    const done = fold(written.value, await Promise.all(goneLists(state, lists).map((entry) => archiveGone(deps, roots, entry))));
    const saved = await save(deps, roots, done.state);
    if (!saved.ok) return saved;
    await writeReport(deps, input, roots.root, sourceLabel({ kind: 'lists', name: input.site.name }), done.summary, done.notes);
    return ok(runOf(input.site, done.summary, done.notes));
  };
