import { contentHash } from './content-hash.ts';

// A SharePoint list, its columns and its rows, as Graph answers for them. A list here is the kind a
// person makes and fills in, a tracker; a document library is a list too in Graph's eyes and is
// the drive sync's business, so it is told apart by its template.
export type SharePointList = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly webUrl: string;
  readonly template: string;
  readonly hidden: boolean;
};

// A column as stored (`name`, what the row's fields are keyed by) and as shown (`label`), with the
// two flags that decide whether a person ever sees it. The kind Graph gives a column is not kept:
// a cell says what it holds by its shape, and nothing here reads a cell differently by column.
export type ListColumn = { readonly name: string; readonly label: string; readonly hidden: boolean; readonly readOnly: boolean };

export type ListItem = { readonly id: string; readonly lastModified: string; readonly webUrl: string; readonly fields: Readonly<Record<string, unknown>> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

export const parseSharePointList = (raw: unknown): SharePointList | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  const info = raw['list'];
  return {
    id,
    name: readString(raw, 'displayName') ?? readString(raw, 'name') ?? id,
    description: readString(raw, 'description') ?? '',
    webUrl: readString(raw, 'webUrl') ?? '',
    template: readString(info, 'template') ?? '',
    hidden: isRecord(info) && info['hidden'] === true,
  };
};

// The templates a person fills in. Everything else is a library, which the drive sync already
// mirrors, or a list SharePoint keeps for itself under a number.
const PEOPLE_TEMPLATES: ReadonlySet<string> = new Set(['genericList', 'tasks', 'issueTracking', 'events', 'contacts', 'links', 'announcements', 'survey']);

export const isPeopleList = (list: SharePointList): boolean => !list.hidden && PEOPLE_TEMPLATES.has(list.template);

// The content type column is flagged neither hidden nor read-only, and is filed under a group
// SharePoint keeps for what it does not show: the group is what says so.
const HIDDEN_GROUP = '_Hidden';

export const parseListColumn = (raw: unknown): ListColumn | undefined => {
  const name = readString(raw, 'name');
  if (!isRecord(raw) || name === undefined) return undefined;
  return {
    name,
    label: readString(raw, 'displayName') ?? name,
    hidden: raw['hidden'] === true || readString(raw, 'columnGroup') === HIDDEN_GROUP,
    readOnly: raw['readOnly'] === true,
  };
};

const TITLE = 'Title';

// Editable, unhidden, and still SharePoint's own: whether a row has files attached is a flag the
// list keeps, not a column anyone filled in.
const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(['Attachments']);

// The columns a person sees on the list: the title, and whatever is neither hidden nor read-only.
// The read-only ones are SharePoint's own bookkeeping (a colour tag, a compliance id, who edited
// last), which the row carries as fields but nobody put there.
export const isShownColumn = (column: ListColumn): boolean => column.name === TITLE || (!column.hidden && !column.readOnly && !SYSTEM_COLUMNS.has(column.name));

export const parseListItem = (raw: unknown): ListItem | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  const fields = raw['fields'];
  return { id, lastModified: readString(raw, 'lastModifiedDateTime') ?? '', webUrl: readString(raw, 'webUrl') ?? '', fields: isRecord(fields) ? fields : {} };
};

const A_MOMENT = /^\d{4}-\d{2}-\d{2}T/;
const DAY = 10;
const BAR = /\|/g;
// Any run of whitespace, a line break included, becomes one space: a table cell is one line.
const WHITESPACE = /\s+/g;

const folded = (text: string): string => text.replace(WHITESPACE, ' ').replace(BAR, '\\|').trim();

// A person or a lookup travels as a record naming what it points at; a link as a record with an
// address and a description.
const recordText = (value: Record<string, unknown>): string => {
  const looked = readString(value, 'LookupValue');
  if (looked !== undefined) return folded(looked);
  const url = readString(value, 'Url');
  if (url !== undefined) return `[${folded(readString(value, 'Description') ?? url)}](${url})`;
  return folded(JSON.stringify(value));
};

// What one cell says. A moment reads as its day, since a list column holds a date and Graph
// answers it as midnight UTC; a flag as yes or no; a list of people as their names; a number as
// itself, which is what the last line makes of it.
export const cellText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return A_MOMENT.test(value) ? value.slice(0, DAY) : folded(value);
  if (Array.isArray(value)) return value.map(cellText).join(', ');
  return isRecord(value) ? recordText(value) : folded(String(value));
};

const LOOKUP_ID = 'LookupId';

// A single person or lookup column has no cell under its own name: Graph answers `<Name>LookupId`
// alone, the display value not being in the fields, so the id is shown as an id rather than the
// column reading as empty.
// A column as the table shows it: what to key the cells by, and what to head them with.
type Shown = { readonly name: string; readonly label: string };

const cellOf = (row: ListItem, column: Shown): string => {
  const held = row.fields[column.name];
  if (held !== undefined) return cellText(held);
  const lookup = row.fields[`${column.name}${LOOKUP_ID}`];
  return lookup === undefined ? '' : `#${cellText(lookup)}`;
};

const NO_ROWS = '_No rows._';

// The title heads the table whether or not the columns listed it: a row without one is a row
// with nothing to call it by.
export const renderListTable = (columns: ReadonlyArray<ListColumn>, rows: ReadonlyArray<ListItem>): string => {
  const listed = columns.filter(isShownColumn);
  const shown: ReadonlyArray<Shown> = listed.some((column) => column.name === TITLE) ? listed : [{ name: TITLE, label: TITLE }, ...listed];
  const header = [`| ${shown.map((column) => column.label).join(' | ')} |`, `|${shown.map(() => '---').join('|')}|`];
  if (rows.length === 0) return [...header, '', NO_ROWS].join('\n');
  return [...header, ...rows.map((row) => `| ${shown.map((column) => cellOf(row, column)).join(' | ')} |`)].join('\n');
};

// What a list's table is made of, hashed: which rows at which times under which columns, so a run
// can tell a list that changed from one that did not without reading the table back.
export const listFingerprint = (columnNames: ReadonlyArray<string>, rows: ReadonlyArray<ListItem>): string => {
  const stamps = rows.map((row) => ({ id: row.id, at: row.lastModified })).sort((left, right) => left.id.localeCompare(right.id));
  return contentHash(new TextEncoder().encode(JSON.stringify([columnNames, stamps])));
};
