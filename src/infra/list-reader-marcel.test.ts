import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createListReaderFromCall } from './list-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createListReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createListReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

describe('reading a site`s lists through the ask-marcel library', () => {
  it('the lists of a site are read two hundred a page and followed to the end, libraries and all, the sorting left to the domain', async () => {
    const { reader, recorded } = readerFor({
      'list-sharepoint-site-lists': [
        ok({
          value: [{ id: 'a', displayName: 'Projects', list: { template: 'genericList', hidden: false } }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?%24skiptoken=s',
        }),
      ],
      'next-page': [ok({ value: [{ id: 'd', displayName: 'Documents', list: { template: 'documentLibrary', hidden: false } }] })],
    });

    const lists = await reader.lists('site-1');

    expect(lists.ok && lists.value.map((list) => [list.id, list.template])).toEqual([
      ['a', 'genericList'],
      ['d', 'documentLibrary'],
    ]);
    expect(recorded[0]).toEqual({ name: 'list-sharepoint-site-lists', params: { siteId: 'site-1', top: '200' } });
    expect(recorded[1]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/x?$skiptoken=s' } });
  });

  it('the columns of a list come as one answer, and the rows come with their fields expanded, paged to the end', async () => {
    const { reader, recorded } = readerFor({
      'list-sharepoint-list-columns': [ok({ value: [{ name: 'Title', displayName: 'Title', text: {} }, { displayName: 'no name' }] })],
      'list-sharepoint-site-list-items': [
        ok({ value: [{ id: '1', lastModifiedDateTime: 't', fields: { Title: 'Falcon' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/items?%24skiptoken=s' }),
      ],
      'next-page': [ok({ value: [{ id: '2', fields: { Title: 'Eagle' } }, { noId: true }] })],
    });

    const columns = await reader.columns('site-1', 'a');
    const rows = await reader.rows('site-1', 'a');

    expect(columns.ok && columns.value).toEqual([{ name: 'Title', label: 'Title', hidden: false, readOnly: false }]);
    expect(rows.ok && rows.value.map((row) => row.id)).toEqual(['1', '2']);
    expect(recorded[0]).toEqual({ name: 'list-sharepoint-list-columns', params: { siteId: 'site-1', listId: 'a' } });
    expect(recorded[1]).toEqual({ name: 'list-sharepoint-site-list-items', params: { siteId: 'site-1', listId: 'a', expand: 'fields', top: '200' } });
  });

  it('a cursor pointing at itself ends the paging, and a page that fails fails the read', async () => {
    const looping = ok({ value: [{ id: '1', fields: {} }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop' });
    const loop = readerFor({ 'list-sharepoint-site-list-items': [looping], 'next-page': [looping] });
    expect((await loop.reader.rows('s', 'a')).ok).toBe(true);
    expect(loop.recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);

    const failing = readerFor({
      'list-sharepoint-site-lists': [ok({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
      'next-page': [err({ type: 'api_error', status: 503, message: 'Graph is busy' })],
    });
    expect(await failing.reader.lists('s')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph is busy' } });
  });
});
