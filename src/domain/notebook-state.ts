import { CATEGORY_FOLDER } from './kb-category.ts';
import { disambiguateSegment, safeRelPath, safeSegment } from './kb-path.ts';
import type { SafeRelPath } from './kb-path.ts';
import type { Notebook, NotebookPage, NotebookSection } from './onenote.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export const NOTEBOOK_STATE_VERSION = 1;

export const notebookRootName = (name: string): SafeRelPath => safeRelPath([CATEGORY_FOLDER.notebook, name]);

// One page already written. `lastModified` is what a later run compares against, since pages have
// no delta and the notebook is read whole every run; `file` is what moves aside when the page is
// renamed or gone; `title` is what is left to call it by once the notebook no longer has it; and
// `section` is what keeps the page where it is when its section could not be listed this run.
export type PageRecord = { readonly file: string; readonly lastModified: string; readonly title: string; readonly section: string };

// The notebook itself is kept whole beside the source line, since a site notebook is only
// reachable through its site and `update` has nothing but this file to find the site by.
export type NotebookState = {
  readonly version: typeof NOTEBOOK_STATE_VERSION;
  readonly source: { readonly kind: 'notebook'; readonly id: string; readonly name: string };
  readonly notebook: Notebook;
  readonly lastRun: string;
  readonly pages: Readonly<Record<string, PageRecord>>;
};

export type NotebookStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyNotebookState = (notebook: Notebook): NotebookState => ({
  version: NOTEBOOK_STATE_VERSION,
  source: { kind: 'notebook', id: notebook.id, name: notebook.name },
  notebook,
  lastRun: '',
  pages: {},
});

export const serializeNotebookState = (state: NotebookState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const recordOf = (entry: Record<string, unknown>): PageRecord => ({
  file: readString(entry, 'file') ?? '',
  lastModified: readString(entry, 'lastModified') ?? '',
  title: readString(entry, 'title') ?? '',
  section: readString(entry, 'section') ?? '',
});

const pagesOf = (raw: unknown): Readonly<Record<string, PageRecord>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, recordOf(entry)] as const] : [])));
};

const siteOf = (raw: unknown): Notebook['site'] => {
  const id = readString(isRecord(raw) ? raw : {}, 'id');
  return id === undefined ? undefined : { id, name: readString(isRecord(raw) ? raw : {}, 'name') ?? id };
};

// The notebook as it was recorded, falling back to the source line for a file written before the
// notebook travelled whole; such a notebook reads as the user's own until it is listed again.
const notebookOf = (raw: Record<string, unknown>, source: Record<string, unknown>): Notebook => {
  const held = isRecord(raw['notebook']) ? raw['notebook'] : {};
  const id = readString(held, 'id') ?? readString(source, 'id') ?? '';
  return { id, name: readString(held, 'name') ?? readString(source, 'name') ?? id, webUrl: readString(held, 'webUrl') ?? '', site: siteOf(held['site']) };
};

export const parseNotebookState = (raw: unknown): Result<NotebookState, NotebookStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'notebook') return err({ kind: 'malformed', message: 'state is not a notebook' });
  if (raw['version'] !== NOTEBOOK_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${NOTEBOOK_STATE_VERSION}` });
  const notebook = notebookOf(raw, source);
  return ok({
    version: NOTEBOOK_STATE_VERSION,
    source: { kind: 'notebook', id: notebook.id, name: notebook.name },
    notebook,
    lastRun: readString(raw, 'lastRun') ?? '',
    pages: pagesOf(raw['pages']),
  });
};

export const withPage = (state: NotebookState, id: string, record: PageRecord): NotebookState => ({ ...state, pages: { ...state.pages, [id]: record } });

export const withoutPage = (state: NotebookState, id: string): NotebookState => ({
  ...state,
  pages: Object.fromEntries(Object.entries(state.pages).filter(([held]) => held !== id)),
});

// A page with the section it was listed under, which is where it is filed.
export type ListedPage = { readonly page: NotebookPage; readonly section: NotebookSection };

export type NotebookWork = { readonly write: ReadonlyArray<ListedPage>; readonly archive: ReadonlyArray<{ readonly id: string; readonly record: PageRecord }> };

// What the run owes, from the whole listing against the ledger: a new page and a changed one are
// written, oldest change first so a stopped run leaves a prefix; an unchanged one is left alone;
// a page the notebook no longer lists is put aside, unless its section is one that could not be
// listed this run, in which case nothing says the page has gone.
export const notebookWorklist = (state: NotebookState, listed: ReadonlyArray<ListedPage>, unreadSections: ReadonlyArray<string> = []): NotebookWork => {
  const present = new Set(listed.map((entry) => entry.page.id));
  const unread = new Set(unreadSections);
  return {
    write: listed
      .filter((entry) => state.pages[entry.page.id]?.lastModified !== entry.page.lastModified)
      .sort((left, right) => left.page.lastModified.localeCompare(right.page.lastModified)),
    archive: Object.entries(state.pages).flatMap(([id, record]) => (present.has(id) || unread.has(record.section) ? [] : [{ id, record }])),
  };
};

export type PlannedPage = { readonly entry: ListedPage; readonly file: string };

const MARKDOWN = '.md';

const folderOf = (root: string, section: NotebookSection): string => `${root}/${safeRelPath([section.group, section.name])}`;

// Where each page about to be written goes: under its section, under the section's group when it
// sits in one, named by its title. Two pages can share a title in one section; the second takes a
// suffix from its own id. A file held by a page not being rewritten is taken.
export const planPageFiles = (root: string, listed: ReadonlyArray<ListedPage>, state: NotebookState): ReadonlyArray<PlannedPage> => {
  const rewriting = new Set(listed.map((entry) => entry.page.id));
  const taken = new Set(Object.entries(state.pages).flatMap(([id, record]) => (rewriting.has(id) ? [] : [record.file])));
  const planned: PlannedPage[] = [];
  for (const entry of listed) {
    const name = `${safeSegment(entry.page.title)}${MARKDOWN}`;
    const folder = folderOf(root, entry.section);
    const plain = `${folder}/${name}`;
    const file = taken.has(plain) ? `${folder}/${disambiguateSegment(name, entry.page.id)}` : plain;
    taken.add(file);
    planned.push({ entry, file });
  }
  return planned;
};
