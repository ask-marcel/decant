import { describe, expect, it } from 'bun:test';
import { emptyNotebookState, notebookRootName, notebookWorklist, parseNotebookState, planPageFiles, serializeNotebookState, withPage, withoutPage } from './notebook-state.ts';
import type { ListedPage } from './notebook-state.ts';
import { renderNotebookPage } from './notebook-document.ts';
import type { Notebook } from './onenote.ts';

const NOTEBOOK: Notebook = { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: 'https://tenant.sharepoint.com/nb', site: { id: 'site-1', name: 'Northwind Leadership' } };

const OTHER: Notebook = { id: '1-nb', name: 'N', webUrl: '', site: undefined };

const listed = (id: string, title: string, lastModified: string, section = 'Meetings', group = ''): ListedPage => ({
  page: { id, title, created: '2026-08-01T09:00:00Z', lastModified, webUrl: `https://tenant.sharepoint.com/${id}` },
  section: { id: `sec-${section}`, name: section, group },
});

const seeded = (): ReturnType<typeof emptyNotebookState> =>
  withPage(
    withPage(emptyNotebookState(NOTEBOOK), 'a', {
      file: 'kb/OneNote/Northwind Leadership Notebook/Meetings/Kick-off.md',
      lastModified: '2026-09-01T10:00:00Z',
      title: 'Kick-off',
      section: 'sec-Meetings',
    }),
    'b',
    {
      file: 'kb/OneNote/Northwind Leadership Notebook/Meetings/Retro.md',
      lastModified: '2026-09-02T10:00:00Z',
      title: 'Retro',
      section: 'sec-Meetings',
    }
  );

describe('what a notebook run remembers between runs', () => {
  it('a notebook is shelved under the same heading the picker offered it under', () => {
    expect(String(notebookRootName('Northwind Leadership Notebook'))).toBe('OneNote/Northwind Leadership Notebook');
  });

  it('an empty state names the notebook and holds no page; a page written once is found again by its id and can be forgotten', () => {
    expect(emptyNotebookState(OTHER)).toEqual({ version: 1, source: { kind: 'notebook', id: '1-nb', name: 'N' }, notebook: OTHER, lastRun: '', pages: {} });
    expect(seeded().pages['a']).toEqual({
      file: 'kb/OneNote/Northwind Leadership Notebook/Meetings/Kick-off.md',
      lastModified: '2026-09-01T10:00:00Z',
      title: 'Kick-off',
      section: 'sec-Meetings',
    });
    expect(Object.keys(withoutPage(seeded(), 'a').pages)).toEqual(['b']);
  });

  it('a state written and read back is the state that was written, and one another version or kind wrote is refused', () => {
    expect(parseNotebookState(JSON.parse(serializeNotebookState(seeded())))).toEqual({ ok: true, value: seeded() });
    expect(parseNotebookState({ version: 2, source: { kind: 'notebook', id: 'x', name: 'y' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is version 2, not 1' },
    });
    expect(parseNotebookState({ version: 1, source: { kind: 'site', id: 'x', name: 'y' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not a notebook' },
    });
    expect(parseNotebookState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  it('a state with fields missing reads back as blanks, never as holes', () => {
    expect(parseNotebookState({ version: 1, source: { kind: 'notebook', id: 'x', name: 'Old' }, pages: { a: { file: 'f' }, bad: 'x' } })).toEqual({
      ok: true,
      value: {
        version: 1,
        source: { kind: 'notebook', id: 'x', name: 'Old' },
        notebook: { id: 'x', name: 'Old', webUrl: '', site: undefined },
        lastRun: '',
        pages: { a: { file: 'f', lastModified: '', title: '', section: '' } },
      },
    });
    expect(parseNotebookState({ version: 1, source: { kind: 'notebook' } })).toMatchObject({ ok: true, value: { notebook: { id: '', name: '', site: undefined } } });
  });
});

describe('deciding what a notebook run owes', () => {
  it('a new page is written, an unchanged one left alone, a changed one written again oldest change first, and a page gone from the notebook put aside', () => {
    const work = notebookWorklist(seeded(), [
      listed('b', 'Retro', '2026-09-05T10:00:00Z'),
      listed('a', 'Kick-off', '2026-09-01T10:00:00Z'),
      listed('c', 'Budget', '2026-09-03T10:00:00Z'),
    ]);

    expect(work.write.map((entry) => entry.page.id)).toEqual(['c', 'b']);
    expect(work.archive).toHaveLength(0);
    expect(notebookWorklist(seeded(), [listed('a', 'Kick-off', '2026-09-01T10:00:00Z')]).archive).toEqual([
      { id: 'b', record: { file: 'kb/OneNote/Northwind Leadership Notebook/Meetings/Retro.md', lastModified: '2026-09-02T10:00:00Z', title: 'Retro', section: 'sec-Meetings' } },
    ]);
  });

  it('a page whose section could not be listed this run is kept where it is, since nothing says it has gone', () => {
    expect(notebookWorklist(seeded(), [], ['sec-Meetings']).archive).toHaveLength(0);
  });
});

describe('deciding where each page goes', () => {
  it('a page is filed under its section, under its group when the section sits in one, named by its title', () => {
    const plain = planPageFiles('kb/OneNote/N', [listed('a', 'Kick-off', 'x')], emptyNotebookState(OTHER));
    const grouped = planPageFiles('kb/OneNote/N', [listed('a', 'Kick-off', 'x', 'Meetings', '2026')], emptyNotebookState(OTHER));

    expect(plain[0]?.file).toBe('kb/OneNote/N/Meetings/Kick-off.md');
    expect(grouped[0]?.file).toBe('kb/OneNote/N/2026/Meetings/Kick-off.md');
  });

  it('two pages sharing a title in one section take different files, and a file held by a page nobody is rewriting is not handed out', () => {
    const files = planPageFiles('kb/OneNote/N', [listed('one', 'Notes', 'x'), listed('two', 'Notes', 'x')], emptyNotebookState(OTHER)).map((entry) => entry.file);
    expect(files[0]).toBe('kb/OneNote/N/Meetings/Notes.md');
    expect(files[1]).not.toBe(files[0]);

    const held = withPage(emptyNotebookState(OTHER), 'sitting', { file: 'kb/OneNote/N/Meetings/Notes.md', lastModified: 'x', title: 'Notes', section: 'sec-Meetings' });
    expect(planPageFiles('kb/OneNote/N', [listed('newcomer', 'Notes', 'x')], held)[0]?.file).not.toBe('kb/OneNote/N/Meetings/Notes.md');
  });
});

describe('writing one notebook page as a document', () => {
  it('a page opens with where it came from and where it sits, then carries the text the page holds', () => {
    const written = renderNotebookPage({
      entry: listed('a', 'Kick-off', '2026-09-01T10:00:00Z', 'Meetings', '2026'),
      notebook: 'Northwind Leadership Notebook',
      markdown: 'Agenda\n- one\n',
      syncedAt: '2026-09-12T14:00:00Z',
    });

    expect(written).toBe(
      [
        '---',
        'source: https://tenant.sharepoint.com/a',
        'notebook: Northwind Leadership Notebook',
        'section: Meetings',
        'group: "2026"',
        'title: Kick-off',
        'created: "2026-08-01T09:00:00Z"',
        'last_modified: "2026-09-01T10:00:00Z"',
        'synced_at: "2026-09-12T14:00:00Z"',
        '---',
        '',
        '# Kick-off',
        '',
        'Agenda',
        '- one',
        '',
      ].join('\n')
    );
  });

  it('a page with no group and no text says only what it is called, and one with no address says where it came from in words', () => {
    const written = renderNotebookPage({
      entry: { ...listed('a', 'Empty', 'x'), page: { ...listed('a', 'Empty', 'x').page, webUrl: '' } },
      notebook: 'N',
      markdown: '',
      syncedAt: 'now',
    });

    expect(written).toContain('source: OneNote notebook N');
    expect(written).not.toContain('group:');
    expect(written.endsWith('# Empty\n')).toBe(true);
  });
});
