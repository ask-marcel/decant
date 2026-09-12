import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { parseListColumn, parseListItem, parseSharePointList } from '../domain/sharepoint-list.ts';
import { canonicalCursor } from '../domain/utilities/graph-cursor.ts';
import type { ListReader, ListReaderError } from '../use-cases/ports/list-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// Three commands over the shared call. Lists and rows are ordinary collections, so a page size is
// safe and paging follows `@odata.nextLink` to the end with the guard every other sweep keeps; the
// columns come whole, Graph ignoring a page size there. The rows are asked for with their fields
// expanded, which is the only way the cells travel.
const PAGE_SIZE = '200';

const FIELDS = 'fields';

export const createListReaderFromCall = (call: MarcelCall): ListReader => {
  const pagesOf = async <T>(name: string, first: Record<string, string>, parse: (entry: unknown) => T | undefined): Promise<Result<ReadonlyArray<T>, ListReaderError>> => {
    const found: T[] = [];
    const seen = new Set<string>();
    let next: { readonly name: string; readonly params: Record<string, string> } | undefined = { name, params: first };
    while (next !== undefined) {
      const raw = await call(next.name, next.params);
      if (!raw.ok) return raw;
      found.push(
        ...listOf(raw.value).flatMap((entry: unknown) => {
          const parsed = parse(entry);
          return parsed === undefined ? [] : [parsed];
        })
      );
      const link = canonicalCursor(readString(raw.value, '@odata.nextLink'));
      next = link === undefined || seen.has(link) ? undefined : { name: 'next-page', params: { url: link } };
      if (link !== undefined) seen.add(link);
    }
    return ok(found);
  };

  return {
    lists: async (siteId) => pagesOf('list-sharepoint-site-lists', { siteId, top: PAGE_SIZE }, parseSharePointList),
    columns: async (siteId, listId) => {
      const raw = await call('list-sharepoint-list-columns', { siteId, listId });
      if (!raw.ok) return raw;
      return ok(
        listOf(raw.value).flatMap((entry: unknown) => {
          const column = parseListColumn(entry);
          return column === undefined ? [] : [column];
        })
      );
    },
    rows: async (siteId, listId) => pagesOf('list-sharepoint-site-list-items', { siteId, listId, expand: FIELDS, top: PAGE_SIZE }, parseListItem),
  };
};
