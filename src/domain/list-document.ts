import { renderFrontMatter, withFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { renderListTable } from './sharepoint-list.ts';
import type { ListColumn, ListItem, SharePointList } from './sharepoint-list.ts';

export type RenderListInput = {
  readonly list: SharePointList;
  readonly site: string;
  readonly columns: ReadonlyArray<ListColumn>;
  readonly rows: ReadonlyArray<ListItem>;
  readonly syncedAt: string;
};

const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

// The newest change across the rows, which is what the list's own `lastModifiedDateTime` would say
// if Graph moved it for a row edit, and it does not always. The moments are UTC in one shape, so
// the greatest string is the latest moment.
const newestOf = (rows: ReadonlyArray<ListItem>): string | undefined =>
  stated(
    rows
      .map((row) => row.lastModified)
      .toSorted((left, right) => left.localeCompare(right))
      .at(-1) ?? ''
  );

const fieldsOf = (input: RenderListInput): ReadonlyArray<FrontMatterField> => [
  ['source', input.list.webUrl.length > 0 ? input.list.webUrl : `SharePoint list ${input.list.name}`],
  ['site', input.site],
  ['list', input.list.name],
  ['description', stated(input.list.description)],
  ['rows', input.rows.length],
  ['last_modified', newestOf(input.rows)],
  ['synced_at', input.syncedAt],
];

// One table, the columns a person sees, the rows in the order Graph gave them. The description
// stands above the table where the list's own page shows it.
const bodyOf = (input: RenderListInput): string =>
  [`# ${input.list.name}`, ...(input.list.description.length === 0 ? [] : ['', input.list.description]), '', renderListTable(input.columns, input.rows)].join('\n');

export const renderListDocument = (input: RenderListInput): string => withFrontMatter(renderFrontMatter(fieldsOf(input)), bodyOf(input));
