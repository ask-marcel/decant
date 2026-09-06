import { describe, expect, it } from 'bun:test';
import type { DriveItem } from './drive-item.ts';
import type { RetryEntry } from './worklist.ts';
import { buildWorklist, forgetSwept, nextFailure } from './worklist.ts';

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

describe('bringing back a file whose conversion failed', () => {
  const failed = (over: Partial<DriveItem> = {}, attempts = 1): RetryEntry => ({ item: file(over), attempts, reason: 'transient: gateway timeout' });

  it('a file that failed last run is queued again although the sweep has nothing to say about it', () => {
    expect(buildWorklist([], {}, { '01ABC': failed() })).toEqual([{ kind: 'convert', item: file() }]);
  });

  it('a file the sweep returned again is converted from what the sweep holds, not from the copy that failed', () => {
    const edited = file({ cTag: 'c2' });

    expect(buildWorklist([edited], {}, { '01ABC': failed() })).toEqual([{ kind: 'convert', item: edited }]);
  });

  it('a file deleted at the source is not retried, even with tries left', () => {
    expect(buildWorklist([file({ kind: 'deleted' })], {}, { '01ABC': failed() })).toEqual([]);
  });

  it('a file that has failed three times is left alone', () => {
    expect(buildWorklist([], {}, { '01ABC': failed({}, 3) })).toEqual([]);
  });

  it('a retried file takes its place in the queue by the day it last changed', () => {
    const ledger = { b: failed({ id: 'b', path: 'b.docx', lastModified: '2026-05-02T00:00:00Z' }) };
    const swept = [file({ id: 'c', path: 'c.docx', lastModified: '2026-05-03T00:00:00Z' }), file({ id: 'a', path: 'a.docx', lastModified: '2026-05-01T00:00:00Z' })];

    expect(buildWorklist(swept, {}, ledger).map((work) => (work.kind === 'archive' ? work.itemId : work.item.id))).toEqual(['a', 'b', 'c']);
  });

  it('a second failure of the same version counts as a second try', () => {
    expect(nextFailure(failed(), file(), 'transient: gateway timeout')).toEqual({ item: file(), attempts: 2, reason: 'transient: gateway timeout' });
  });

  it('a failure of a version edited since starts the count again', () => {
    expect(nextFailure(failed({}, 2), file({ cTag: 'c2' }), 'permanent: locked').attempts).toBe(1);
  });

  it('a file failing for the first time is on its first try', () => {
    expect(nextFailure(undefined, file(), 'permanent: locked').attempts).toBe(1);
  });

  it('an item the sweep returned is dropped from the ledger, whatever it decided about it', () => {
    expect(forgetSwept({ '01ABC': failed() }, [file({ kind: 'deleted' })])).toEqual({});
  });

  it('an item the sweep said nothing about stays in the ledger', () => {
    const ledger = { '01ABC': failed() };

    expect(forgetSwept(ledger, [file({ id: 'other', path: 'other.docx' })])).toEqual(ledger);
  });
});
