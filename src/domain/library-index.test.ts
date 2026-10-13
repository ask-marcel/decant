import { describe, expect, it } from 'bun:test';
import { libraryIndexPage } from './library-index.ts';
import type { DriveState } from './site-state.ts';

const ROOT = 'kb/SharePoint sites/Site/Documents';

const drive = (items: DriveState['items']): DriveState => ({ name: 'Documents', deltaLink: undefined, pending: [], items, retry: {} });

const lines = (page: string): ReadonlyArray<string> => page.split('\n').filter((line) => line.startsWith('- '));

describe('the page a reader scans a library by', () => {
  // A tie keeps the order of the paths, so the page reads the same on every run.
  it('two documents changed at one moment keep the order of their paths, and one kept without a date or an author comes last, bare', () => {
    const page = libraryIndexPage(
      'Documents',
      ROOT,
      drive({
        b: { path: 'b.docx', cTag: 'c', outputs: [`${ROOT}/b.docx.md`], modified: '2026-05-12T09:00:00Z' },
        a: { path: 'a.docx', cTag: 'c', outputs: [`${ROOT}/a.docx.md`], modified: '2026-05-12T09:00:00Z' },
        old: { path: 'old.docx', cTag: 'c', outputs: [`${ROOT}/old.docx.md`] },
      }),
      'UTC'
    );

    expect(lines(page)).toEqual(['- 2026-05-12 · [a.docx](a.docx.md)', '- 2026-05-12 · [b.docx](b.docx.md)', '- [old.docx](old.docx.md)']);
  });

  // A name cut to fit a path on Windows is not the one the document's own name gives.
  it('a document is linked to the note named after it, else the first note it produced, else the first file', () => {
    const page = libraryIndexPage(
      'Documents',
      ROOT,
      drive({
        deck: { path: 'Deck.pptx', cTag: 'c', outputs: [`${ROOT}/Deck.pptx.pdf`, `${ROOT}/Deck.pptx.md`], modified: '2026-05-03T09:00:00Z' },
        cut: { path: 'Long.docx', cTag: 'c', outputs: [`${ROOT}/Lo-1a2b3c4d.docx.media/image-01.png`, `${ROOT}/Lo-1a2b3c4d.docx.md`], modified: '2026-05-02T09:00:00Z' },
        bare: { path: 'Scan.tiff', cTag: 'c', outputs: [`${ROOT}/Scan.tiff`], modified: '2026-05-01T09:00:00Z' },
      }),
      'UTC'
    );

    expect(lines(page)).toEqual(['- 2026-05-03 · [Deck.pptx](Deck.pptx.md)', '- 2026-05-02 · [Long.docx](Lo-1a2b3c4d.docx.md)', '- 2026-05-01 · [Scan.tiff](Scan.tiff)']);
  });
});
