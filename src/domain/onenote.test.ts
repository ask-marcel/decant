import { describe, expect, it } from 'bun:test';
import { parseNotebook, parseNotebookPage, parseNotebookSection } from './onenote.ts';

describe('reading a OneNote notebook, a section and a page as Graph answers for them', () => {
  it('a notebook carries what names it and where it opens, and says which site it came from when it came from one', () => {
    const raw = {
      id: '1-nb',
      displayName: 'Northwind Leadership Notebook',
      isDefault: false,
      lastModifiedDateTime: '2026-09-01T10:00:00Z',
      links: { oneNoteWebUrl: { href: 'https://tenant.sharepoint.com/sites/lead/SiteAssets/Notebook' } },
    };

    expect(parseNotebook(raw, { id: 'site-1', name: 'Northwind Leadership' })).toEqual({
      id: '1-nb',
      name: 'Northwind Leadership Notebook',
      webUrl: 'https://tenant.sharepoint.com/sites/lead/SiteAssets/Notebook',
      site: { id: 'site-1', name: 'Northwind Leadership' },
    });
    expect(parseNotebook(raw, undefined)).toMatchObject({ id: '1-nb', site: undefined });
  });

  it('a notebook with no id is no notebook, and one named with nothing is named by its id', () => {
    expect(parseNotebook({ displayName: 'No id' }, undefined)).toBeUndefined();
    expect(parseNotebook({ id: '1-nb' }, undefined)).toEqual({ id: '1-nb', name: '1-nb', webUrl: '', site: undefined });
  });

  it('a section carries its name and the group it sits in, if any, so its pages can be filed under both', () => {
    expect(parseNotebookSection({ id: '1-sec', displayName: 'Meetings', parentSectionGroup: { id: 'g', displayName: '2026' } })).toEqual({
      id: '1-sec',
      name: 'Meetings',
      group: '2026',
    });
    expect(parseNotebookSection({ id: '1-sec', displayName: 'Meetings', parentSectionGroup: null })).toEqual({ id: '1-sec', name: 'Meetings', group: '' });
    expect(parseNotebookSection({ displayName: 'no id' })).toBeUndefined();
  });

  it('a page carries its title, when it last changed and where it opens, and one with no title is named untitled', () => {
    expect(
      parseNotebookPage({
        id: '1-page',
        title: 'Kick-off',
        createdDateTime: '2026-08-01T09:00:00Z',
        lastModifiedDateTime: '2026-09-01T10:00:00Z',
        links: { oneNoteWebUrl: { href: 'https://tenant.sharepoint.com/x' } },
      })
    ).toEqual({
      id: '1-page',
      title: 'Kick-off',
      created: '2026-08-01T09:00:00Z',
      lastModified: '2026-09-01T10:00:00Z',
      webUrl: 'https://tenant.sharepoint.com/x',
    });
    expect(parseNotebookPage({ id: '2-page', title: '' })?.title).toBe('Untitled page');
    expect(parseNotebookPage('nope')).toBeUndefined();
  });
});
