import { disambiguateSegment, idHash } from '../domain/kb-path.ts';
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
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { NotebookReader } from './ports/notebook-reader.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunNotes, RunSummary, SourceRun } from './sync-site.ts';
import { writeReport } from './sync-site.ts';
import { clearAttempt, gaveUpNotes, givenUpNotes, heldAttempts, isGivenUp, nextAttempt, recordAttempt, triedReads } from '../domain/retry-ledger.ts';
import type { Unread } from '../domain/retry-ledger.ts';
import { withGaveUp } from '../domain/report.ts';
import { putAside } from './put-aside.ts';
import type { WriteDown } from './put-aside.ts';

export const NOTEBOOK_STATE_FILE = '.sync-state.json';

export type SyncNotebookDeps = {
  readonly reader: NotebookReader;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
  // How long a path may be as decant writes it: Windows' limit less what stands in front of the
  // knowledge base on disk. Absent, names are not cut for length.
  readonly pathBudget?: number;
  // Where the files this sync lets go that would not move under the archive are written down, so a
  // later run moves them. Absent, such a file is only logged.
  readonly writeDown?: WriteDown;
};

// Only pages last changed on or after `since` are written; absent, every page is.
export type SyncNotebookInput = { readonly notebook: Notebook; readonly dryRun: boolean; readonly concurrency: number; readonly since?: string };

export type SyncNotebook = (input: SyncNotebookInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const failed = (step: string, cause: string, message: string): Result<never, StepError> => ({ ok: false, error: { step, cause, message } });

type Roots = { readonly root: string };

const rootsFor = (kbRoot: string, segment: string): Roots => ({ root: `${kbRoot}/${segment}` });

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
    const own = rootsFor(deps.kbRoot, notebookRootName(disambiguateSegment(notebook.name, idHash(notebook.id))));
    const state = await readState(deps, own.root);
    return { roots: own, state: state?.ok === true ? state.value : emptyNotebookState(notebook) };
  }
  deps.logger.warn('notebook-state.unreadable', { notebook: notebook.id, cause: held.error.message });
  return { roots: plain, state: emptyNotebookState(notebook) };
};

type Listing = {
  readonly pages: ReadonlyArray<ListedPage>;
  readonly unreadSections: ReadonlyArray<string>;
  readonly listed: ReadonlyArray<string>;
  readonly unread: ReadonlyArray<Unread>;
};

// A section has no version to tell an edit by, and its key sits apart from every page id.
const sectionKey = (section: NotebookSection): string => `section:${section.id}`;

const placeOf = (section: NotebookSection): string => [section.group, section.name].filter((part) => part.length > 0).join('/');

// Every section, every page in it. A section whose pages cannot be listed costs that section and
// not the run: it is named as failed and its pages on disk are left where they are.
const listPages = async (deps: SyncNotebookDeps, notebook: Notebook, sections: ReadonlyArray<NotebookSection>): Promise<Listing> => {
  const pages: ListedPage[] = [];
  const unreadSections: string[] = [];
  const listed: string[] = [];
  const unread: Unread[] = [];
  for (const section of sections) {
    const answer = await deps.reader.pages(notebook, section.id);
    if (!answer.ok) {
      unreadSections.push(section.id);
      unread.push({ id: sectionKey(section), name: placeOf(section), reason: answer.error.message });
      continue;
    }
    listed.push(sectionKey(section));
    pages.push(...answer.value.map((page) => ({ page, section })));
  }
  return { pages, unreadSections, listed, unread };
};

type Done = { readonly apply: (state: NotebookState) => NotebookState; readonly counted: Partial<RunSummary>; readonly notes: Partial<RunNotes> };

const moveAside = async (deps: SyncNotebookDeps, roots: Roots, output: string, what: string): Promise<void> => {
  for (const missed of await putAside(deps, [output])) deps.logger.warn(`${what}.failed`, { path: missed.path, cause: missed.error.kind });
};

const reportName = (entry: ListedPage): string => `${placeOf(entry.section)}/${entry.page.title}`;

const writeOne = async (deps: SyncNotebookDeps, input: SyncNotebookInput, roots: Roots, state: NotebookState, planned: PlannedPage): Promise<Done> => {
  const { entry, file } = planned;
  const markdown = await deps.reader.pageMarkdown(input.notebook, entry.page.id);
  const written = markdown.ok
    ? await deps.files.writeText(file, renderNotebookPage({ entry, notebook: input.notebook.name, markdown: markdown.value, syncedAt: deps.clock.nowIso() }))
    : markdown;
  const id = entry.page.id;
  if (!written.ok) {
    deps.logger.warn('page.failed', { page: id, cause: written.error.kind });
    const attempt = nextAttempt(state.retry?.[id], entry.page.lastModified, reportName(entry), written.error.message);
    // Out of tries now: named under its own heading, not as a failure the next run will try again.
    const notes = isGivenUp(attempt, entry.page.lastModified) ? {} : { failed: [{ path: reportName(entry), reason: written.error.message }] };
    return { apply: (carried) => ({ ...carried, retry: recordAttempt(carried.retry, id, attempt) }), counted: { failed: 1 }, notes };
  }
  const before = state.pages[id];
  if (before !== undefined && before.file !== file) await moveAside(deps, roots, before.file, 'supersede');
  const record: PageRecord = { file, lastModified: entry.page.lastModified, title: entry.page.title, section: entry.section.id };
  return { apply: (carried) => ({ ...withPage(carried, id, record), retry: clearAttempt(carried.retry, id) }), counted: { converted: 1 }, notes: {} };
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
    for (const entry of window) deps.progress.step(entry.entry.page.title.length > 0 ? entry.entry.page.title : '(untitled page)');
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
    const work = notebookWorklist({ ...state, version: NOTEBOOK_STATE_VERSION }, listing.pages, listing.unreadSections, input.since);
    deps.logger.info('notebook.listed', { notebook: input.notebook.id, sections: sections.value.length, pages: listing.pages.length, changed: work.write.length });
    if (input.dryRun) return ok({ id: input.notebook.id, source: input.notebook.name, summary: { ...EMPTY, queued: work.write.length }, notes: NO_NOTES });
    deps.progress.start(work.write.length, input.notebook.name);
    // A section whose pages cannot be listed is asked for on every run: named as a failure for three
    // runs, then given up on.
    const tried = triedReads(state.retry, listing.listed, listing.unread);
    const opening: Progressing = { summary: { ...EMPTY, failed: tried.tried }, notes: { ...NO_NOTES, failed: tried.failed }, state: { ...state, retry: tried.retry } };
    const written = await writePages(deps, input, roots, opening, planPageFiles(roots.root, work.write, state, deps.pathBudget));
    deps.progress.done();
    if (!written.ok) return written;
    const folded = fold(written.value, await Promise.all(work.archive.map((entry) => archiveGone(deps, roots, entry))));
    // A page or a section the notebook no longer holds leaves the ledger too: given up on, it would be
    // named in every report. A page in a section that could not be listed is tried again once its
    // section lists, which costs a try and loses nothing.
    const held = new Set([...listing.pages.map((entry) => entry.page.id), ...sections.value.map(sectionKey)]);
    const done = { ...folded, state: { ...folded.state, retry: heldAttempts(folded.state.retry, held) } };
    const saved = await save(deps, roots, done.state);
    if (!saved.ok) return saved;
    const notes = withGaveUp({ ...done.notes, givenUp: givenUpNotes(done.state.retry) }, gaveUpNotes(state.retry, done.state.retry));
    await writeReport(deps, input, roots.root, input.notebook.name, done.summary, notes);
    return ok({ id: input.notebook.id, source: input.notebook.name, summary: done.summary, notes });
  };
