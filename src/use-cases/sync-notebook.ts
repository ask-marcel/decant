import { disambiguateSegment } from '../domain/kb-path.ts';
import { renderNotebookPage } from '../domain/notebook-document.ts';
import {
  NOTEBOOK_STATE_VERSION,
  emptyNotebookState,
  notebookRootName,
  notebookWorklist,
  parseNotebookState,
  planPageFiles,
  serializeNotebookState,
  withPage,
  withoutPage,
} from '../domain/notebook-state.ts';
import type { ListedPage, NotebookState, PageRecord, PlannedPage } from '../domain/notebook-state.ts';
import type { Notebook, NotebookSection } from '../domain/onenote.ts';
import { archivePath } from '../domain/output-paths.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { siteIdHash } from '../domain/site-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { NotebookReader } from './ports/notebook-reader.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';

export const NOTEBOOK_STATE_FILE = '.sync-state.json';

export type SyncNotebookDeps = {
  readonly reader: NotebookReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncNotebookInput = { readonly notebook: Notebook; readonly dryRun: boolean; readonly concurrency: number };

export type SyncNotebook = (input: SyncNotebookInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

type Roots = { readonly root: string; readonly archive: string };

const rootsFor = (kbRoot: string, segment: string): Roots => ({ root: `${kbRoot}/${segment}`, archive: `${kbRoot}/_archive/${segment}` });

const readState = async (deps: SyncNotebookDeps, root: string): Promise<Result<NotebookState, StepError> | undefined> => {
  const text = await deps.files.readText(`${root}/${NOTEBOOK_STATE_FILE}`);
  if (!text.ok) return undefined;
  const parsed = parseJson(text.value);
  if (!parsed.ok) return undefined;
  const state = parseNotebookState(parsed.value);
  return state.ok ? state : failed('parseState', state.error.kind, state.error.message);
};

type Resolved = { readonly roots: Roots; readonly state: NotebookState };

// Two notebooks can carry one name (every site's default notebook is named after the site, and two
// sites can share a name), so a folder already claimed by another notebook's state is left to it
// and this one takes the id-suffixed folder a site does in the same case. A state this code cannot
// read is left where it is and started over in memory, never written back over.
const resolve = async (deps: SyncNotebookDeps, notebook: Notebook): Promise<Resolved> => {
  const plain = rootsFor(deps.kbRoot, notebookRootName(notebook.name));
  const held = await readState(deps, plain.root);
  if (held === undefined) return { roots: plain, state: emptyNotebookState(notebook) };
  if (held.ok && held.value.source.id === notebook.id) return { roots: plain, state: held.value };
  if (held.ok) {
    const own = rootsFor(deps.kbRoot, notebookRootName(disambiguateSegment(notebook.name, siteIdHash(notebook.id))));
    const state = await readState(deps, own.root);
    return { roots: own, state: state?.ok === true ? state.value : emptyNotebookState(notebook) };
  }
  deps.logger.warn('notebook-state.unreadable', { notebook: notebook.id, cause: held.error.message });
  return { roots: plain, state: emptyNotebookState(notebook) };
};

type Listing = { readonly pages: ReadonlyArray<ListedPage>; readonly unreadSections: ReadonlyArray<string>; readonly failed: RunNotes['failed'] };

const placeOf = (section: NotebookSection): string => [section.group, section.name].filter((part) => part.length > 0).join('/');

// Every section, every page in it. A section whose pages cannot be listed costs that section and
// not the run: it is named as failed and its pages on disk are left where they are.
const listPages = async (deps: SyncNotebookDeps, notebook: Notebook, sections: ReadonlyArray<NotebookSection>): Promise<Listing> => {
  const pages: ListedPage[] = [];
  const unreadSections: string[] = [];
  const failures: RunNotes['failed'][number][] = [];
  for (const section of sections) {
    const listed = await deps.reader.pages(notebook, section.id);
    if (!listed.ok) {
      unreadSections.push(section.id);
      failures.push({ path: placeOf(section), reason: listed.error.message });
      continue;
    }
    pages.push(...listed.value.map((page) => ({ page, section })));
  }
  return { pages, unreadSections, failed: failures };
};

type Done = { readonly apply: (state: NotebookState) => NotebookState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const moveAside = async (deps: SyncNotebookDeps, roots: Roots, output: string, what: string): Promise<void> => {
  const moved = await deps.files.move(output, archivePath(roots.archive, roots.root, output));
  if (!moved.ok) deps.logger.warn(`${what}.failed`, { path: output, cause: moved.error.kind });
};

const reportName = (entry: ListedPage): string => `${placeOf(entry.section)}/${entry.page.title}`;

const writeOne = async (deps: SyncNotebookDeps, input: SyncNotebookInput, roots: Roots, state: NotebookState, planned: PlannedPage): Promise<Done> => {
  const { entry, file } = planned;
  const markdown = await deps.reader.pageMarkdown(input.notebook, entry.page.id);
  const written = markdown.ok
    ? await deps.files.writeText(file, renderNotebookPage({ entry, notebook: input.notebook.name, markdown: markdown.value, syncedAt: deps.clock.nowIso() }))
    : markdown;
  if (!written.ok) {
    deps.logger.warn('page.failed', { page: entry.page.id, cause: written.error.kind });
    return { apply: (carried) => carried, counted: { failed: 1 }, notes: { failed: [{ path: reportName(entry), reason: written.error.message }] } };
  }
  const before = state.pages[entry.page.id];
  if (before !== undefined && before.file !== file) await moveAside(deps, roots, before.file, 'supersede');
  const record: PageRecord = { file, lastModified: entry.page.lastModified, title: entry.page.title, section: entry.section.id };
  return { apply: (carried) => withPage(carried, entry.page.id, record), counted: { converted: 1 }, notes: {} };
};

const archiveGone = async (deps: SyncNotebookDeps, roots: Roots, gone: { readonly id: string; readonly record: PageRecord }): Promise<Done> => {
  await moveAside(deps, roots, gone.record.file, 'archive');
  return { apply: (carried) => withoutPage(carried, gone.id), counted: { archived: 1 }, notes: { archived: [{ path: gone.record.title, reason: 'no longer in the notebook' }] } };
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

type Progressing = { readonly summary: RunSummary; readonly notes: RunNotes; readonly state: NotebookState };

const fold = (carried: Progressing, results: ReadonlyArray<Done>): Progressing => ({
  summary: counted(carried.summary, results),
  notes: noted(carried.notes, results),
  state: results.reduce((state, done) => done.apply(state), carried.state),
});

const save = async (deps: SyncNotebookDeps, roots: Roots, state: NotebookState): Promise<Result<undefined, StepError>> => {
  const written = await deps.files.writeText(`${roots.root}/${NOTEBOOK_STATE_FILE}`, serializeNotebookState({ ...state, lastRun: deps.clock.nowIso() }));
  return written.ok ? ok(undefined) : failed('saveState', written.error.kind, written.error.message);
};

const writePages = async (
  deps: SyncNotebookDeps,
  input: SyncNotebookInput,
  roots: Roots,
  carried: Progressing,
  planned: ReadonlyArray<PlannedPage>
): Promise<Result<Progressing, StepError>> => {
  let progressing = carried;
  for (let at = 0; at < planned.length; at += input.concurrency) {
    const window = planned.slice(at, at + input.concurrency);
    const results = await Promise.all(window.map((entry) => writeOne(deps, input, roots, progressing.state, entry)));
    for (const entry of window) deps.progress.step(entry.entry.page.id);
    progressing = fold(progressing, results);
    const saved = await save(deps, roots, progressing.state);
    if (!saved.ok) return saved;
  }
  return ok(progressing);
};

export const createSyncNotebook =
  (deps: SyncNotebookDeps): SyncNotebook =>
  async (input) => {
    const { roots, state } = await resolve(deps, input.notebook);
    const sections = await deps.reader.sections(input.notebook);
    if (!sections.ok) return failed('listSections', sections.error.kind, sections.error.message);
    const listing = await listPages(deps, input.notebook, sections.value);
    const work = notebookWorklist({ ...state, version: NOTEBOOK_STATE_VERSION }, listing.pages, listing.unreadSections);
    deps.logger.info('notebook.listed', { notebook: input.notebook.id, sections: sections.value.length, pages: listing.pages.length, changed: work.write.length });
    if (input.dryRun) return ok({ id: input.notebook.id, source: input.notebook.name, summary: { ...EMPTY, queued: work.write.length }, notes: NO_NOTES });
    deps.progress.start(work.write.length, input.notebook.name);
    const opening: Progressing = { summary: { ...EMPTY, failed: listing.failed.length }, notes: { ...NO_NOTES, failed: listing.failed }, state };
    const written = await writePages(deps, input, roots, opening, planPageFiles(roots.root, work.write, state));
    deps.progress.done();
    if (!written.ok) return written;
    const done = fold(written.value, await Promise.all(work.archive.map((entry) => archiveGone(deps, roots, entry))));
    const saved = await save(deps, roots, done.state);
    if (!saved.ok) return saved;
    await writeReport(deps, input, roots.root, input.notebook.name, done.summary, done.notes);
    return ok({ id: input.notebook.id, source: input.notebook.name, summary: done.summary, notes: done.notes });
  };
