import { describe, expect, it } from 'bun:test';
import type { Notebook } from '../domain/onenote.ts';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';
import { createNotebookReaderFromCall } from './notebook-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createNotebookReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createNotebookReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const NB = { id: '1-nb', displayName: 'Northwind Leadership Notebook', links: { oneNoteWebUrl: { href: 'https://tenant.sharepoint.com/nb' } } };
const MINE: Notebook = { id: 'me-nb', name: 'My notes', webUrl: '', site: undefined };
const ON_SITE: Notebook = { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: 'https://tenant.sharepoint.com/nb', site: { id: 'site-1', name: 'Northwind Leadership' } };

describe('reading OneNote through the ask-marcel library', () => {
  it('the notebooks are the signed-in user`s own and every site`s, each site asked in turn, and a site that refuses costs its own notebooks and not the listing', async () => {
    const { reader, recorded } = readerFor({
      'list-onenote-notebooks': [ok({ value: [{ id: 'me-nb', displayName: 'My notes' }] })],
      'list-sharepoint-site-onenote-notebooks': [ok({ value: [NB] }), err({ type: 'api_error', status: 403, message: 'OneNote read blocked' })],
    });

    const listed = await reader.listNotebooks([
      { id: 'site-1', name: 'Northwind Leadership' },
      { id: 'site-2', name: 'Blocked' },
    ]);

    expect(listed).toEqual({
      ok: true,
      value: [
        { id: 'me-nb', name: 'My notes', webUrl: '', site: undefined },
        { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: 'https://tenant.sharepoint.com/nb', site: { id: 'site-1', name: 'Northwind Leadership' } },
      ],
    });
    expect(recorded.filter((entry) => entry.name === 'list-sharepoint-site-onenote-notebooks').map((entry) => entry.params['siteId'])).toEqual(['site-1', 'site-2']);
  });

  it('the user`s own listing failing fails the read, since that one is not one site among many', async () => {
    const { reader } = readerFor({ 'list-onenote-notebooks': [err({ type: 'auth_failed', message: 'sign-in has lapsed' })] });

    expect(await reader.listNotebooks([])).toEqual({ ok: false, error: { kind: 'permanent', message: 'sign-in has lapsed' } });
  });

  it('a site notebook`s sections and pages are read through the site`s route, paged to the end, and the user`s own through the user`s', async () => {
    const { reader, recorded } = readerFor({
      'list-sharepoint-site-onenote-notebook-sections': [ok({ value: [{ id: 'sec-1', displayName: 'Meetings', parentSectionGroup: null }] })],
      'list-sharepoint-site-onenote-section-pages': [ok({ value: [{ id: 'p1', title: 'Kick-off' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?%24skiptoken=s' })],
      'next-page': [ok({ value: [{ id: 'p2', title: 'Retro' }] })],
      'list-onenote-notebook-sections': [ok({ value: [{ id: 'sec-me', displayName: 'Ideas', parentSectionGroup: null }] })],
      'list-onenote-section-pages': [ok({ value: [{ id: 'p3', title: 'Idea' }] })],
    });

    const sections = await reader.sections(ON_SITE);
    const pages = await reader.pages(ON_SITE, 'sec-1');
    const mine = await reader.sections(MINE);
    const minePages = await reader.pages(MINE, 'sec-me');

    expect(sections.ok && sections.value).toEqual([{ id: 'sec-1', name: 'Meetings', group: '' }]);
    expect(pages.ok && pages.value.map((page) => page.id)).toEqual(['p1', 'p2']);
    expect(recorded[0]).toEqual({ name: 'list-sharepoint-site-onenote-notebook-sections', params: { siteId: 'site-1', notebookId: '1-nb' } });
    expect(recorded[1]).toEqual({ name: 'list-sharepoint-site-onenote-section-pages', params: { siteId: 'site-1', onenoteSectionId: 'sec-1', top: '100' } });
    expect(recorded[2]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/x?$skiptoken=s' } });
    expect(mine.ok && mine.value.map((section) => section.name)).toEqual(['Ideas']);
    expect(minePages.ok && minePages.value.map((page) => page.id)).toEqual(['p3']);
    expect(recorded[3]).toEqual({ name: 'list-onenote-notebook-sections', params: { notebookId: 'me-nb' } });
    expect(recorded[4]).toEqual({ name: 'list-onenote-section-pages', params: { onenoteSectionId: 'sec-me', top: '100' } });
  });

  it('a page of the user`s own renders through the library, and a site page`s HTML is read to text here since the library has no renderer for it', async () => {
    const { reader, recorded } = readerFor({
      'get-onenote-page-as-markdown': [ok({ contentType: 'text/markdown', size: 10, text: '# Idea\n\ntext' })],
      'get-sharepoint-site-onenote-page-content': [
        ok({ contentType: 'text/html; charset=utf-8', size: 60, text: '<html><body><div><p>Agenda</p><ul><li>one</li></ul></div></body></html>' }),
      ],
    });

    expect(await reader.pageMarkdown(MINE, 'p3')).toEqual({ ok: true, value: '# Idea\n\ntext' });
    expect(await reader.pageMarkdown(ON_SITE, 'p1')).toEqual({ ok: true, value: 'Agenda\n- one' });
    expect(recorded[0]).toEqual({ name: 'get-onenote-page-as-markdown', params: { onenotePageId: 'p3' } });
    expect(recorded[1]).toEqual({ name: 'get-sharepoint-site-onenote-page-content', params: { siteId: 'site-1', onenotePageId: 'p1' } });
  });
});
