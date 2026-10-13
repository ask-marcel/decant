import { describe, expect, it } from 'bun:test';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { putAside } from './put-aside.ts';

const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const PICTURE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.media/image-01.png';

describe('putting aside what an item held', () => {
  // Under the day the run put it aside, at the path it had in the knowledge base, so an old copy is
  // found by the same path one level down, and the day says when it stopped being current.
  it('a file goes under the archive, in a folder named for the day of the run, at the path it had', async () => {
    const files = createFilesFake({ texts: { [NOTE]: 'old' } });

    expect(await putAside({ files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' }, [NOTE])).toHaveLength(0);
    expect(files.moves).toEqual([{ from: NOTE, to: 'kb/_archive/2026-10-13/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md' }]);
  });

  // Two edits put aside on one day would otherwise write the second over the first. The whole set
  // moves to the next free folder, so a document stays beside its pictures and its links still work.
  it('a day that already holds one of the paths sends the whole set to the next free folder, and nothing is written over', async () => {
    const files = createFilesFake({
      texts: { [NOTE]: 'second', [PICTURE]: 'p', 'kb/_archive/2026-10-13/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md': 'first' },
    });

    await putAside({ files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' }, [NOTE, PICTURE]);

    expect(files.moves.map((move) => move.to)).toEqual([
      'kb/_archive/2026-10-13-2/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md',
      'kb/_archive/2026-10-13-2/SharePoint sites/Espace Contoso/Documents/Contrat.docx.media/image-01.png',
    ]);
    expect(files.written.get('kb/_archive/2026-10-13/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md')).toBe('first');
  });

  it('a file that will not move is named with why, the others still move, and nothing at all asks for nothing', async () => {
    const refusing = createFilesFake({ failMoveWith: { kind: 'write-failed', path: NOTE, message: 'locked' } });

    expect(await putAside({ files: refusing, clock: createClockFake(), kbRoot: 'kb' }, [NOTE])).toEqual([
      { path: NOTE, error: { kind: 'write-failed', path: NOTE, message: 'locked' } },
    ]);
    expect(await putAside({ files: refusing, clock: createClockFake(), kbRoot: 'kb' }, [])).toHaveLength(0);
  });

  it('a path outside the knowledge base keeps its whole path under the archive', async () => {
    const files = createFilesFake();

    await putAside({ files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' }, ['elsewhere/Old.md']);

    expect(files.moves).toEqual([{ from: 'elsewhere/Old.md', to: 'kb/_archive/2026-10-13/elsewhere/Old.md' }]);
  });
});
