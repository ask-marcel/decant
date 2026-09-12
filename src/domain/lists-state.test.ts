import { describe, expect, it } from 'bun:test';
import { renderListDocument } from './list-document.ts';
import { emptyListsState, goneLists, listFileFor, parseListsState, serializeListsState, withList, withoutList } from './lists-state.ts';
import type { SharePointList } from './sharepoint-list.ts';

const list = (id: string, name: string): SharePointList => ({
  id,
  name,
  description: '',
  webUrl: `https://tenant.sharepoint.com/sites/x/Lists/${name}`,
  template: 'genericList',
  hidden: false,
});

const seeded = (): ReturnType<typeof emptyListsState> =>
  withList(withList(emptyListsState('site-1', 'Espace Contoso'), 'a', { file: 'kb/SharePoint lists/Espace Contoso/Projects.md', fingerprint: 'f-a', name: 'Projects' }), 'b', {
    file: 'kb/SharePoint lists/Espace Contoso/Issues.md',
    fingerprint: 'f-b',
    name: 'Issues',
  });

describe('what a lists run remembers between runs', () => {
  it('a state names the site, records each list with its file and fingerprint, and can forget one', () => {
    expect(emptyListsState('site-1', 'Espace Contoso')).toEqual({ version: 1, source: { kind: 'lists', id: 'site-1', name: 'Espace Contoso' }, lastRun: '', lists: {} });
    expect(seeded().lists['a']).toEqual({ file: 'kb/SharePoint lists/Espace Contoso/Projects.md', fingerprint: 'f-a', name: 'Projects' });
    expect(Object.keys(withoutList(seeded(), 'a').lists)).toEqual(['b']);
  });

  it('a state written and read back is the state that was written, one of another version or kind is refused, and missing fields read as blanks', () => {
    expect(parseListsState(JSON.parse(serializeListsState(seeded())))).toEqual({ ok: true, value: seeded() });
    expect(parseListsState({ version: 5, source: { kind: 'lists', id: 'x', name: 'y' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is version 5, not 1' },
    });
    expect(parseListsState({ version: 1, source: { kind: 'site', id: 'x', name: 'y' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not a set of lists' },
    });
    expect(parseListsState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
    expect(parseListsState(null)).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
    expect(
      parseListsState({ version: 1, source: { kind: 'lists', id: 5 }, lastRun: '2026-09-11T09:00:00Z', lists: { a: { file: 'f' }, b: { fingerprint: 'g' }, bad: 1 } })
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        source: { kind: 'lists', id: '', name: '' },
        lastRun: '2026-09-11T09:00:00Z',
        lists: { a: { file: 'f', fingerprint: '', name: '' }, b: { file: '', fingerprint: 'g', name: '' } },
      },
    });
    expect(parseListsState({ version: 1, source: { kind: 'lists' }, lists: null })).toMatchObject({ ok: true, value: { lastRun: '', lists: {} } });
  });

  it('a list the site no longer has is what gets put aside', () => {
    expect(goneLists(seeded(), [list('a', 'Projects')])).toEqual([
      { id: 'b', record: { file: 'kb/SharePoint lists/Espace Contoso/Issues.md', fingerprint: 'f-b', name: 'Issues' } },
    ]);
  });

  it('a list is filed under its site by its name, and a namesake takes a suffix from its id', () => {
    expect(listFileFor('kb/SharePoint lists/Espace Contoso', list('a', 'Projects'), new Set())).toBe('kb/SharePoint lists/Espace Contoso/Projects.md');
    const second = listFileFor('kb/SharePoint lists/Espace Contoso', list('list-2', 'Projects'), new Set(['kb/SharePoint lists/Espace Contoso/Projects.md']));
    expect(second).not.toBe('kb/SharePoint lists/Espace Contoso/Projects.md');
    expect(second).toContain('Projects-');
  });
});

describe('writing a list as a document', () => {
  it('a list opens with where it came from and how much it holds, then its description and its table', () => {
    const written = renderListDocument({
      list: { ...list('a', 'Projects'), description: 'Every project we run' },
      site: 'Espace Contoso',
      columns: [
        { name: 'Title', label: 'Title', hidden: false, readOnly: false },
        { name: 'ProjectStatus', label: 'Status', hidden: false, readOnly: false },
      ],
      // The newest row first, so the last change reported is the newest and not the last.
      rows: [
        { id: '2', lastModified: '2026-09-11T10:00:00Z', webUrl: '', fields: { Title: 'Eagle', ProjectStatus: 'Done' } },
        { id: '1', lastModified: '2026-09-10T10:00:00Z', webUrl: '', fields: { Title: 'Falcon', ProjectStatus: 'Open' } },
      ],
      syncedAt: '2026-09-12T14:00:00Z',
    });

    expect(written).toBe(
      [
        '---',
        'source: https://tenant.sharepoint.com/sites/x/Lists/Projects',
        'site: Espace Contoso',
        'list: Projects',
        'description: Every project we run',
        'rows: 2',
        'last_modified: "2026-09-11T10:00:00Z"',
        'synced_at: "2026-09-12T14:00:00Z"',
        '---',
        '',
        '# Projects',
        '',
        'Every project we run',
        '',
        '| Title | Status |',
        '|---|---|',
        '| Eagle | Done |',
        '| Falcon | Open |',
        '',
      ].join('\n')
    );
  });

  it('an empty list with no description says so and nothing more, and one with no address is sourced by its name', () => {
    const written = renderListDocument({ list: { ...list('a', 'Projects'), webUrl: '' }, site: 'S', columns: [], rows: [], syncedAt: 'now' });

    expect(written).toContain('source: SharePoint list Projects');
    expect(written).not.toContain('description:');
    expect(written).not.toContain('last_modified:');
    expect(written).toContain('rows: 0');
    expect(written).toContain('# Projects\n\n| Title |');
    expect(written).toContain('_No rows._');

    const undated = renderListDocument({ list: list('a', 'P'), site: 'S', columns: [], rows: [{ id: '1', lastModified: '', webUrl: '', fields: {} }], syncedAt: 'now' });
    expect(undated).not.toContain('last_modified:');

    const dated = (at: string): { id: string; lastModified: string; webUrl: string; fields: Record<string, unknown> } => ({ id: at, lastModified: at, webUrl: '', fields: {} });
    const shuffled = renderListDocument({ list: list('a', 'P'), site: 'S', columns: [], rows: ['2026-09-10', '2026-09-12', '2026-09-11'].map(dated), syncedAt: 'now' });
    expect(shuffled).toContain('last_modified: "2026-09-12"');
  });
});
