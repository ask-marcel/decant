import { describe, expect, it } from 'bun:test';
import { cellText, isPeopleList, isShownColumn, listFingerprint, parseListColumn, parseListItem, parseSharePointList, renderListTable } from './sharepoint-list.ts';
import type { ListColumn, ListItem } from './sharepoint-list.ts';

const graphList = {
  id: 'list-1',
  displayName: 'Projects',
  name: 'Projects',
  description: 'Every project we run',
  webUrl: 'https://tenant.sharepoint.com/sites/x/Lists/Projects',
  lastModifiedDateTime: '2026-09-10T10:00:00Z',
  list: { contentTypesEnabled: false, hidden: false, template: 'genericList' },
};

describe('reading a SharePoint list, its columns and its rows as Graph answers for them', () => {
  it('a list carries what names it, what it is for, where it opens, and what kind of list it is', () => {
    expect(parseSharePointList(graphList)).toEqual({
      id: 'list-1',
      name: 'Projects',
      description: 'Every project we run',
      webUrl: 'https://tenant.sharepoint.com/sites/x/Lists/Projects',
      template: 'genericList',
      hidden: false,
    });
    expect(parseSharePointList({ displayName: 'no id' })).toBeUndefined();
    expect(parseSharePointList({ id: 5 })).toBeUndefined();
    expect(parseSharePointList(null)).toBeUndefined();
    expect(parseSharePointList({ id: 'x' })).toEqual({ id: 'x', name: 'x', description: '', webUrl: '', template: '', hidden: false });
  });

  it('a list is called by the name it shows, or the one it is stored under, or its id, in that order; hidden is what Graph says it is', () => {
    expect(parseSharePointList({ id: 'x', name: 'Stored', displayName: 'Shown' })).toMatchObject({ name: 'Shown' });
    expect(parseSharePointList({ id: 'x', name: 'Stored' })).toMatchObject({ name: 'Stored' });
    expect(parseSharePointList({ id: 'x', list: { hidden: true } })).toMatchObject({ hidden: true });
    expect(parseSharePointList({ id: 'x', list: { hidden: 'yes' } })).toMatchObject({ hidden: false });
  });

  it('a list people fill in is synced; a document library, a hidden list and a system list are not', () => {
    for (const template of ['genericList', 'tasks', 'issueTracking', 'events', 'contacts', 'links', 'announcements', 'survey'])
      expect(isPeopleList({ id: 'a', name: 'a', description: '', webUrl: '', template, hidden: false })).toBe(true);
    expect(isPeopleList({ id: 'a', name: 'a', description: '', webUrl: '', template: 'documentLibrary', hidden: false })).toBe(false);
    expect(isPeopleList({ id: 'a', name: 'a', description: '', webUrl: '', template: 'genericList', hidden: true })).toBe(false);
    expect(isPeopleList({ id: 'a', name: 'a', description: '', webUrl: '', template: '851', hidden: false })).toBe(false);
  });

  it('a column carries its name as stored and as shown, and whether a person sees it', () => {
    expect(parseListColumn({ name: 'ProjectStatus', displayName: 'Status', hidden: false, readOnly: false, choice: { choices: ['Open'] } })).toEqual({
      name: 'ProjectStatus',
      label: 'Status',
      hidden: false,
      readOnly: false,
    });
    expect(parseListColumn({ name: '_ColorTag', displayName: 'Color Tag', hidden: false, readOnly: true, text: {} })).toEqual({
      name: '_ColorTag',
      label: 'Color Tag',
      hidden: false,
      readOnly: true,
    });
    expect(parseListColumn({ name: 'Secret', hidden: true })).toEqual({ name: 'Secret', label: 'Secret', hidden: true, readOnly: false });
    expect(parseListColumn({ name: 'PlannerPlan', displayName: 'Plan' })).toEqual({ name: 'PlannerPlan', label: 'Plan', hidden: false, readOnly: false });
    expect(parseListColumn({ displayName: 'no name' })).toBeUndefined();
  });

  it('a column SharePoint files under its own hidden group is hidden, whatever its flag says', () => {
    expect(parseListColumn({ name: 'ContentType', displayName: 'Content Type', hidden: false, readOnly: false, columnGroup: '_Hidden' })).toMatchObject({ hidden: true });
    expect(parseListColumn({ name: 'ProjectName', displayName: 'Project Name', columnGroup: 'Custom Columns' })).toMatchObject({ hidden: false });
  });

  it('a person sees the columns that are neither hidden nor read-only, and the title whatever its flags', () => {
    const column = (name: string, over: Partial<ListColumn> = {}): ListColumn => ({ name, label: name, hidden: false, readOnly: false, ...over });

    expect(isShownColumn(column('ProjectStatus'))).toBe(true);
    expect(isShownColumn(column('_ColorTag', { readOnly: true }))).toBe(false);
    expect(isShownColumn(column('Secret', { hidden: true }))).toBe(false);
    expect(isShownColumn(column('Title', { readOnly: true }))).toBe(true);
    expect(isShownColumn(column('Attachments'))).toBe(false);
  });

  it('a row carries its id, when it last changed, where it opens, and its cells as Graph gave them', () => {
    expect(
      parseListItem({ id: '7', lastModifiedDateTime: '2026-09-10T10:00:00Z', webUrl: 'https://tenant.sharepoint.com/x/7', fields: { Title: 'Falcon', Progress_x0025_: 40 } })
    ).toEqual({
      id: '7',
      lastModified: '2026-09-10T10:00:00Z',
      webUrl: 'https://tenant.sharepoint.com/x/7',
      fields: { Title: 'Falcon', Progress_x0025_: 40 },
    });
    expect(parseListItem({ id: '8' })).toEqual({ id: '8', lastModified: '', webUrl: '', fields: {} });
    expect(parseListItem({ fields: {} })).toBeUndefined();
  });
});

describe('saying what a cell holds', () => {
  it('text as itself with its line breaks and bars folded, a number as a number, a day for a moment, yes or no for a flag', () => {
    expect(cellText('Two\nlines | with a bar')).toBe('Two lines \\| with a bar');
    expect(cellText('  Two\n   lines  ')).toBe('Two lines');
    expect(cellText(42.5)).toBe('42.5');
    expect(cellText('2026-09-10T10:00:00Z')).toBe('2026-09-10');
    expect(cellText('Due 2026-09-10T10:00:00Z')).toBe('Due 2026-09-10T10:00:00Z');
    expect(cellText(true)).toBe('yes');
    expect(cellText(false)).toBe('no');
    expect(cellText(undefined)).toBe('');
    expect(cellText(null)).toBe('');
  });

  it('people and lookups by their names, a link as a markdown link, and anything else as what it holds', () => {
    expect(
      cellText([
        { LookupId: 3, LookupValue: 'Jane Doe', Email: 'jane@example.com' },
        { LookupId: 4, LookupValue: 'Dana Farrow' },
      ])
    ).toBe('Jane Doe, Dana Farrow');
    expect(cellText({ LookupId: 3, LookupValue: 'Jane Doe' })).toBe('Jane Doe');
    expect(cellText({ Description: 'Plan', Url: 'https://tasks.office.com/plan/1' })).toBe('[Plan](https://tasks.office.com/plan/1)');
    expect(cellText({ Url: 'https://example.com' })).toBe('[https://example.com](https://example.com)');
    expect(cellText(['a', 'b'])).toBe('a, b');
    expect(cellText({ odd: 'shape' })).toBe('{"odd":"shape"}');
  });
});

describe('writing a list as a table', () => {
  const columns: ReadonlyArray<ListColumn> = [
    { name: 'Title', label: 'Title', hidden: false, readOnly: false },
    { name: 'ProjectStatus', label: 'Status', hidden: false, readOnly: false },
    { name: 'ProjectOwners', label: 'Owners', hidden: false, readOnly: false },
    { name: 'ProjectSponsor', label: 'Sponsor', hidden: false, readOnly: false },
    { name: '_ColorTag', label: 'Color Tag', hidden: false, readOnly: true },
  ];
  const rows: ReadonlyArray<ListItem> = [
    {
      id: '1',
      lastModified: '2026-09-10T10:00:00Z',
      webUrl: 'https://x/1',
      fields: { Title: 'Falcon', ProjectStatus: 'Open', ProjectOwners: [{ LookupValue: 'Jane Doe' }], ProjectSponsorLookupId: '12' },
    },
    { id: '2', lastModified: '2026-09-11T10:00:00Z', webUrl: 'https://x/2', fields: { Title: 'Eagle', ProjectStatus: 'Done' } },
  ];

  it('one row per item under the columns a person sees, a person cell by name and a lone lookup by its id, in the order Graph gave the rows', () => {
    expect(renderListTable(columns, rows)).toBe(
      ['| Title | Status | Owners | Sponsor |', '|---|---|---|---|', '| Falcon | Open | Jane Doe | #12 |', '| Eagle | Done |  |  |'].join('\n')
    );
  });

  it('a list with no rows is a header and nothing under it, said so', () => {
    expect(renderListTable(columns, [])).toBe(['| Title | Status | Owners | Sponsor |', '|---|---|---|---|', '', '_No rows._'].join('\n'));
  });

  it('a list with no columns a person sees still shows its titles, and one that lists the title shows it once', () => {
    expect(renderListTable([], rows)).toBe(['| Title |', '|---|', '| Falcon |', '| Eagle |'].join('\n'));
    expect(renderListTable(columns.slice(0, 1), rows)).toBe(['| Title |', '|---|', '| Falcon |', '| Eagle |'].join('\n'));
  });

  it('a list whose columns leave the title out is headed by it all the same, ahead of the columns a person sees', () => {
    expect(renderListTable(columns.slice(1), rows)).toBe(
      ['| Title | Status | Owners | Sponsor |', '|---|---|---|---|', '| Falcon | Open | Jane Doe | #12 |', '| Eagle | Done |  |  |'].join('\n')
    );
  });
});

describe('telling whether a list has changed since it was written', () => {
  it('the same rows at the same times under the same columns fingerprint the same, in any row order; a changed row, a new row or a new column changes it', () => {
    const rows = (over: ReadonlyArray<ListItem>): ReadonlyArray<ListItem> => over;
    const a: ListItem = { id: '1', lastModified: 't1', webUrl: '', fields: {} };
    const b: ListItem = { id: '2', lastModified: 't2', webUrl: '', fields: {} };
    const base = listFingerprint(['Title', 'Status'], rows([a, b]));

    expect(listFingerprint(['Title', 'Status'], rows([b, a]))).toBe(base);
    expect(listFingerprint(['Title', 'Status'], rows([a, { ...b, lastModified: 't3' }]))).not.toBe(base);
    expect(listFingerprint(['Title', 'Status'], rows([a]))).not.toBe(base);
    expect(listFingerprint(['Title'], rows([a, b]))).not.toBe(base);
  });
});
