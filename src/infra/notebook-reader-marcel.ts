import { htmlToText } from '../domain/html-text.ts';
import { parseNotebook, parseNotebookPage, parseNotebookSection } from '../domain/onenote.ts';
import type { Notebook, NotebookPage, NotebookSection, NotebookSite } from '../domain/onenote.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { canonicalCursor } from '../domain/utilities/graph-cursor.ts';
import type { NotebookReader, NotebookReaderError } from '../use-cases/ports/notebook-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// A notebook lives under the signed-in user or under a SharePoint site, and the library has one
// family of commands for each: the same shapes, a `siteId` apart. The one gap is the rendering: a
// page of the user's own renders to markdown through the library, and a site page is answered as
// HTML only, which is read to text here with the same pass a calendar event's body gets.

const PAGE_SIZE = '100';

const routeOf = (notebook: Notebook): { readonly prefix: string; readonly scope: Record<string, string> } =>
  notebook.site === undefined ? { prefix: '', scope: {} } : { prefix: 'sharepoint-site-', scope: { siteId: notebook.site.id } };

const asSection = (entry: unknown): NotebookSection[] => {
  const section = parseNotebookSection(entry);
  return section === undefined ? [] : [section];
};

export const createNotebookReaderFromCall = (call: MarcelCall): NotebookReader => {
  const pagesOf = async (name: string, first: Record<string, string>): Promise<Result<ReadonlyArray<NotebookPage>, NotebookReaderError>> => {
    const found: NotebookPage[] = [];
    const seen = new Set<string>();
    let next: { readonly name: string; readonly params: Record<string, string> } | undefined = { name, params: first };
    while (next !== undefined) {
      const raw = await call(next.name, next.params);
      if (!raw.ok) return raw;
      found.push(
        ...listOf(raw.value).flatMap((entry: unknown) => {
          const page = parseNotebookPage(entry);
          return page === undefined ? [] : [page];
        })
      );
      const link = canonicalCursor(readString(raw.value, '@odata.nextLink'));
      next = link === undefined || seen.has(link) ? undefined : { name: 'next-page', params: { url: link } };
      if (link !== undefined) seen.add(link);
    }
    return ok(found);
  };

  // One site's notebooks. A site that refuses (a tenant that has hit OneNote's item limit answers
  // every read with a refusal) costs its own notebooks and not the listing, which is what a picker
  // drawn short is for.
  const siteNotebooks = async (site: NotebookSite): Promise<ReadonlyArray<Notebook>> => {
    const raw = await call('list-sharepoint-site-onenote-notebooks', { siteId: site.id });
    if (!raw.ok) return [];
    return listOf(raw.value).flatMap((entry: unknown) => {
      const notebook = parseNotebook(entry, site);
      return notebook === undefined ? [] : [notebook];
    });
  };

  return {
    listNotebooks: async (sites) => {
      const mine = await call('list-onenote-notebooks', {});
      if (!mine.ok) return mine;
      const own = listOf(mine.value).flatMap((entry: unknown) => {
        const notebook = parseNotebook(entry, undefined);
        return notebook === undefined ? [] : [notebook];
      });
      const theirs = await Promise.all(sites.map(siteNotebooks));
      return ok([...own, ...theirs.flat()]);
    },
    sections: async (notebook) => {
      const route = routeOf(notebook);
      const raw = await call(`list-${route.prefix}onenote-notebook-sections`, { ...route.scope, notebookId: notebook.id });
      return raw.ok ? ok(listOf(raw.value).flatMap(asSection)) : raw;
    },
    pages: async (notebook, sectionId) => {
      const route = routeOf(notebook);
      return pagesOf(`list-${route.prefix}onenote-section-pages`, { ...route.scope, onenoteSectionId: sectionId, top: PAGE_SIZE });
    },
    pageMarkdown: async (notebook, pageId) => {
      if (notebook.site === undefined) {
        const raw = await call('get-onenote-page-as-markdown', { onenotePageId: pageId });
        return raw.ok ? ok(readString(raw.value, 'text') ?? '') : raw;
      }
      const raw = await call('get-sharepoint-site-onenote-page-content', { siteId: notebook.site.id, onenotePageId: pageId });
      return raw.ok ? ok(htmlToText(readString(raw.value, 'text') ?? '')) : raw;
    },
  };
};
