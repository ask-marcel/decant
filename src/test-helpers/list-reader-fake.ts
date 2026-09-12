import { err, ok } from '../domain/result.ts';
import type { ListColumn, ListItem, SharePointList } from '../domain/sharepoint-list.ts';
import type { ListReader, ListReaderError } from '../use-cases/ports/list-reader.ts';

export type ListReaderSeed = {
  // Lists keyed by site id; columns and rows keyed by list id.
  readonly lists?: Readonly<Record<string, ReadonlyArray<SharePointList>>>;
  readonly columns?: Readonly<Record<string, ReadonlyArray<ListColumn>>>;
  readonly rows?: Readonly<Record<string, ReadonlyArray<ListItem>>>;
  readonly failLists?: ListReaderError;
  readonly failColumnsOf?: ReadonlyArray<string>;
  readonly failRowsOf?: ReadonlyArray<string>;
};

export type ListReaderFake = ListReader & { readonly calls: Array<string> };

export const createListReaderFake = (seed: ListReaderSeed = {}): ListReaderFake => {
  const calls: string[] = [];
  return {
    calls,
    lists: async (siteId) => {
      calls.push(`lists:${siteId}`);
      return seed.failLists === undefined ? ok(seed.lists?.[siteId] ?? []) : err(seed.failLists);
    },
    columns: async (siteId, listId) => {
      calls.push(`columns:${listId}`);
      if ((seed.failColumnsOf ?? []).includes(listId)) return err({ kind: 'transient', message: 'Graph is busy' });
      return ok(seed.columns?.[listId] ?? []);
    },
    rows: async (siteId, listId) => {
      calls.push(`rows:${listId}`);
      if ((seed.failRowsOf ?? []).includes(listId)) return err({ kind: 'transient', message: 'Graph is busy' });
      return ok(seed.rows?.[listId] ?? []);
    },
  };
};
