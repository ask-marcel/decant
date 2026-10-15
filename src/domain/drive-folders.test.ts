import { describe, expect, it } from 'bun:test';
import type { DriveItem } from './drive-item.ts';
import { sweptFolders } from './drive-folders.ts';

const folder = (id: string, path: string): DriveItem => ({
  id,
  name: path.split('/').at(-1) ?? path,
  kind: 'folder',
  size: 0,
  path,
  lastModified: '2026-05-12T09:31:00Z',
  cTag: '',
  webUrl: `https://tenant.sharepoint.com/sites/X/${path}`,
});

const file = (id: string, path: string): DriveItem => ({ ...folder(id, path), kind: 'file' });

describe('keeping the folders of a library by id', () => {
  it('each folder a sweep reports is recorded at its path, and a file is not a folder', () => {
    expect(sweptFolders({}, [folder('01F', 'Projets'), file('01ABC', 'Projets/Contrat.docx')])).toEqual({ folders: { '01F': 'Projets' }, moves: [] });
  });

  // Graph reports a renamed folder alone: nothing under it comes back, so the move is the only sign
  // that the documents under the old path now sit somewhere else.
  it('a folder reported at another path is a move from the path it had, and is recorded at the new one', () => {
    expect(sweptFolders({ '01F': 'Projets' }, [folder('01F', 'Archive/Projets 2026')])).toEqual({
      folders: { '01F': 'Archive/Projets 2026' },
      moves: [{ from: 'Projets', to: 'Archive/Projets 2026' }],
    });
  });

  // A delta also returns the folders above each document that changed, so most folders it reports are
  // where they were.
  it('a folder reported at the path it has is no move', () => {
    expect(sweptFolders({ '01F': 'Projets' }, [folder('01F', 'Projets')])).toEqual({ folders: { '01F': 'Projets' }, moves: [] });
  });

  it('a folder the sweep says nothing of keeps its path, unless a folder it sits in moved', () => {
    const known = { '01A': 'Projets', '01B': 'Projets/2026', '01C': 'Projets/2026/Contrats', '01D': 'Projets 2025', '01E': 'Budget' };

    expect(sweptFolders(known, [folder('01A', 'Archive')]).folders).toEqual({
      '01A': 'Archive',
      '01B': 'Archive/2026',
      '01C': 'Archive/2026/Contrats',
      '01D': 'Projets 2025',
      '01E': 'Budget',
    });
  });

  it('a folder under two moved folders takes its place from the deeper one', () => {
    const known = { '01A': 'Projets', '01B': 'Projets/2026', '01C': 'Projets/2026/Contrats' };

    expect(sweptFolders(known, [folder('01A', 'Archive'), folder('01B', 'Clos/2026')]).folders).toEqual({ '01A': 'Archive', '01B': 'Clos/2026', '01C': 'Clos/2026/Contrats' });
  });

  it('a folder deleted at the source is forgotten', () => {
    const deleted = { ...folder('01F', ''), kind: 'deleted' as const };

    expect(sweptFolders({ '01F': 'Projets', '01G': 'Budget' }, [deleted])).toEqual({ folders: { '01G': 'Budget' }, moves: [] });
  });

  // The order is the ids', so a sweep that reports a folder only because something in it changed
  // writes the state as it was.
  it('the folders are kept in the order of their ids, whatever order the sweep reports them in', () => {
    expect(Object.keys(sweptFolders({ '01C': 'C', '01A': 'A' }, [folder('01B', 'B')]).folders)).toEqual(['01A', '01B', '01C']);
  });
});
