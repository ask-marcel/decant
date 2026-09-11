import type { Notebook, NotebookPage, NotebookSection } from '../domain/onenote.ts';
import { err, ok } from '../domain/result.ts';
import type { NotebookReader, NotebookReaderError } from '../use-cases/ports/notebook-reader.ts';

export type NotebookReaderSeed = {
  readonly notebooks?: ReadonlyArray<Notebook>;
  // Sections keyed by notebook id, pages keyed by section id, markdown keyed by page id.
  readonly sections?: Readonly<Record<string, ReadonlyArray<NotebookSection>>>;
  readonly pages?: Readonly<Record<string, ReadonlyArray<NotebookPage>>>;
  readonly markdown?: Readonly<Record<string, string>>;
  readonly failNotebooks?: NotebookReaderError;
  readonly failSections?: NotebookReaderError;
  readonly failPagesOf?: ReadonlyArray<string>;
  readonly failMarkdownOf?: ReadonlyArray<string>;
};

export type NotebookReaderFake = NotebookReader & { readonly calls: Array<string> };

export const createNotebookReaderFake = (seed: NotebookReaderSeed = {}): NotebookReaderFake => {
  const calls: string[] = [];
  return {
    calls,
    listNotebooks: async (sites) => {
      calls.push(`listNotebooks:${sites.map((site) => site.id).join(',')}`);
      return seed.failNotebooks === undefined ? ok(seed.notebooks ?? []) : err(seed.failNotebooks);
    },
    sections: async (notebook) => {
      calls.push(`sections:${notebook.id}`);
      return seed.failSections === undefined ? ok(seed.sections?.[notebook.id] ?? []) : err(seed.failSections);
    },
    pages: async (notebook, sectionId) => {
      calls.push(`pages:${sectionId}`);
      if ((seed.failPagesOf ?? []).includes(sectionId)) return err({ kind: 'transient', message: 'Graph is busy' });
      return ok(seed.pages?.[sectionId] ?? []);
    },
    pageMarkdown: async (notebook, pageId) => {
      calls.push(`pageMarkdown:${pageId}`);
      if ((seed.failMarkdownOf ?? []).includes(pageId)) return err({ kind: 'permanent', message: `cannot read ${pageId}` });
      return ok(seed.markdown?.[pageId] ?? `text of ${pageId}`);
    },
  };
};
