import type { Result } from '../../domain/result.ts';
import type { ListColumn, ListItem, SharePointList } from '../../domain/sharepoint-list.ts';
import type { DriveReaderError } from './drive-reader.ts';

export type ListReaderError = DriveReaderError;

// A site's lists, and for one of them its columns and every row. The rows are followed to the end
// before they are handed back: half a list would be written as the whole of it.
export type ListReader = {
  readonly lists: (siteId: string) => Promise<Result<ReadonlyArray<SharePointList>, ListReaderError>>;
  readonly columns: (siteId: string, listId: string) => Promise<Result<ReadonlyArray<ListColumn>, ListReaderError>>;
  readonly rows: (siteId: string, listId: string) => Promise<Result<ReadonlyArray<ListItem>, ListReaderError>>;
};
