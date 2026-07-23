import { describe, expect, it } from 'bun:test';
import type { DriveItem } from './drive-item.ts';
import { buildWorklist } from './worklist.ts';

const file = (over: Partial<DriveItem> = {}): DriveItem => ({
  id: '01ABC',
  name: 'Roadmap.pptx',
  kind: 'file',
  size: 4096,
  path: 'Projets/Roadmap.pptx',
  lastModified: '2026-05-12T09:31:00Z',
  cTag: 'c1',
  webUrl: 'https://tenant.sharepoint.com/Roadmap.pptx',
  ...over,
});

describe('deciding what the next run has to do', () => {
  it('a file never seen before is queued for conversion', () => {
    expect(buildWorklist([file()], {})).toEqual([{ kind: 'convert', item: file() }]);
  });

  it('a file untouched since the last run is left alone', () => {
    const manifest = { '01ABC': { path: 'Projets/Roadmap.pptx', cTag: 'c1', outputs: ['Projets/Roadmap.pptx.md'] } };

    expect(buildWorklist([file()], manifest)).toEqual([]);
  });

  it('a file edited since the last run is queued for conversion again', () => {
    const manifest = { '01ABC': { path: 'Projets/Roadmap.pptx', cTag: 'c0', outputs: ['Projets/Roadmap.pptx.md'] } };

    expect(buildWorklist([file()], manifest)).toEqual([{ kind: 'convert', item: file() }]);
  });

  it('a file only renamed is moved on disk instead of being converted again', () => {
    const manifest = { '01ABC': { path: 'Projets/Ancien nom.pptx', cTag: 'c1', outputs: ['Projets/Ancien nom.pptx.md'] } };

    expect(buildWorklist([file()], manifest)).toEqual([{ kind: 'move', item: file(), from: 'Projets/Ancien nom.pptx', outputs: ['Projets/Ancien nom.pptx.md'] }]);
  });

  it('a file deleted in SharePoint has everything it produced archived', () => {
    const manifest = { '01ABC': { path: 'Projets/Roadmap.pptx', cTag: 'c1', outputs: ['Projets/Roadmap.pptx.md', 'Projets/Roadmap.pptx.pdf'] } };

    expect(buildWorklist([file({ kind: 'deleted' })], manifest)).toEqual([{ kind: 'archive', itemId: '01ABC', outputs: ['Projets/Roadmap.pptx.md', 'Projets/Roadmap.pptx.pdf'] }]);
  });

  it('a file deleted before it was ever synced needs no work', () => {
    expect(buildWorklist([file({ kind: 'deleted' })], {})).toEqual([]);
  });

  it('a new folder needs no work of its own, since writing a file creates its folders', () => {
    expect(buildWorklist([file({ kind: 'folder', name: 'Projets', path: 'Projets' })], {})).toEqual([]);
  });

  it('a folder restamped by SharePoint without moving needs no work, since a folder converts to nothing', () => {
    const folder = file({ id: '01F', kind: 'folder', name: 'Projets', path: 'Projets', cTag: 'c2' });
    const manifest = { '01F': { path: 'Projets', cTag: 'c1', outputs: [] } };

    expect(buildWorklist([folder], manifest)).toEqual([]);
  });

  it('a renamed folder is moved on disk so its whole subtree follows', () => {
    const folder = file({ id: '01F', kind: 'folder', name: 'Projets 2026', path: 'Projets 2026' });
    const manifest = { '01F': { path: 'Projets', cTag: 'c1', outputs: [] } };

    expect(buildWorklist([folder], manifest)).toEqual([{ kind: 'move', item: folder, from: 'Projets', outputs: [] }]);
  });

  it('the oldest change is queued first so an interrupted run resumes in order', () => {
    const items = [
      file({ id: 'c', path: 'c.docx', lastModified: '2026-05-03T00:00:00Z' }),
      file({ id: 'a', path: 'a.docx', lastModified: '2026-05-01T00:00:00Z' }),
      file({ id: 'b', path: 'b.docx', lastModified: '2026-05-02T00:00:00Z' }),
    ];

    expect(buildWorklist(items, {}).map((work) => (work.kind === 'archive' ? work.itemId : work.item.id))).toEqual(['a', 'b', 'c']);
  });

  it('two changes stamped at the same moment keep a stable order between runs', () => {
    const items = [file({ id: 'b', path: 'b.docx' }), file({ id: 'a', path: 'a.docx' })];

    expect(buildWorklist(items, {}).map((work) => (work.kind === 'archive' ? work.itemId : work.item.id))).toEqual(['a', 'b']);
  });
});
