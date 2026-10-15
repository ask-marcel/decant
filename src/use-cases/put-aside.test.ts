import { describe, expect, it } from 'bun:test';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { heldInPlace, letGo, putAside, putBack, setAside } from './put-aside.ts';

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

  it('the day and its second folder both holding a path send the set to the third', async () => {
    const at = (folder: string): string => `kb/_archive/${folder}/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md`;
    const files = createFilesFake({ texts: { [NOTE]: 'third', [at('2026-10-13')]: 'first', [at('2026-10-13-2')]: 'second' } });

    await putAside({ files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' }, [NOTE]);

    expect(files.moves.map((move) => move.to)).toEqual([at('2026-10-13-3')]);
  });

  // Past a hundred folders in one day the search stops, and the move itself refuses to write over
  // what is there.
  it('a day whose hundred folders all hold the path tries the last of them, and the move refuses to write over it', async () => {
    const at = (folder: string): string => `kb/_archive/${folder}/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md`;
    const folders = ['2026-10-13', ...Array.from({ length: 99 }, (_, index) => `2026-10-13-${index + 2}`)];
    const files = createFilesFake({ texts: { [NOTE]: 'latest', ...Object.fromEntries(folders.map((folder) => [at(folder), 'older'])) } });
    const last = at('2026-10-13-100');

    const failed = await putAside({ files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' }, [NOTE]);

    expect(failed).toEqual([{ path: NOTE, error: { kind: 'write-failed', path: last, message: `a file is already at ${last}` } }]);
    expect(files.written.get(last)).toBe('older');
    expect(files.written.get(NOTE)).toBe('latest');
  });

  it('an empty set moves nothing and names nothing', async () => {
    expect(await setAside({ files: createFilesFake(), clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' }, [])).toStrictEqual({ moved: [], failed: [] });
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

  // Set aside before an edit writes over it, and put back when the edit does not land, so a failed
  // conversion leaves the version before it where it was.
  it('a set put aside goes back where it was, and a file that will not go back is named', async () => {
    const files = createFilesFake({ texts: { [NOTE]: 'old', [PICTURE]: 'p' } });
    const deps = { files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb' };
    const aside = await setAside(deps, [NOTE, PICTURE]);

    expect(aside.moved.map((move) => move.to)).toEqual([
      'kb/_archive/2026-10-13/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md',
      'kb/_archive/2026-10-13/SharePoint sites/Espace Contoso/Documents/Contrat.docx.media/image-01.png',
    ]);
    expect(await putBack(deps, aside)).toHaveLength(0);
    expect(files.written.get(NOTE)).toBe('old');
    expect(files.written.has(aside.moved[0]?.to ?? '')).toBe(false);

    const stuck = createFilesFake({ failMoveWith: { kind: 'write-failed', path: NOTE, message: 'locked' } });

    expect(await putBack({ files: stuck }, aside)).toEqual([
      { path: NOTE, error: { kind: 'write-failed', path: NOTE, message: 'locked' } },
      { path: PICTURE, error: { kind: 'write-failed', path: NOTE, message: 'locked' } },
    ]);
  });
});

// A file that would not move aside and is still on disk would be written over by the write that
// asked for the move: the write waits, and the reason says why.
describe('telling whether a file that would not move aside still stands in the way', () => {
  const deps = (files: ReturnType<typeof createFilesFake>): { files: typeof files; clock: ReturnType<typeof createClockFake>; kbRoot: string } => ({
    files,
    clock: createClockFake('2026-10-13T08:00:00Z'),
    kbRoot: 'kb',
  });

  it('a file still on disk that would not move gives the reason the write waits', async () => {
    const files = createFilesFake({ texts: { [NOTE]: 'old' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'EBUSY' } });

    const aside = await setAside(deps(files), [NOTE]);

    expect(await heldInPlace(deps(files), aside)).toBe('its earlier version would not move to _archive/: write-failed: EBUSY');
  });

  it('nothing stands in the way of a write when the set moved, or when the file that would not move is gone', async () => {
    const moved = createFilesFake({ texts: { [NOTE]: 'old' } });
    const gone = createFilesFake({ failMoveWith: { kind: 'write-failed', path: NOTE, message: 'ENOENT' } });

    expect(await heldInPlace(deps(moved), await setAside(deps(moved), [NOTE]))).toBeUndefined();
    expect(await heldInPlace(deps(gone), await setAside(deps(gone), [NOTE]))).toBeUndefined();
  });
});

// No record names a file a source lets go, so what would not move is handed on to be written down,
// and a later run moves it.
describe('handing on the files a source lets go that would not move', () => {
  const handing = (): { handed: string[]; writeDown: (missed: ReadonlyArray<{ readonly path: string }>) => Promise<void> } => {
    const handed: string[] = [];
    const writeDown = async (missed: ReadonlyArray<{ readonly path: string }>): Promise<void> => {
      handed.push(...missed.map((entry) => entry.path));
    };
    return { handed, writeDown };
  };

  it('a file put aside for good that would not move is handed on, and one that moved is not', async () => {
    const locked = handing();
    const free = handing();
    const held = createFilesFake({ texts: { [NOTE]: 'old' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'EBUSY' } });
    const loose = createFilesFake({ texts: { [NOTE]: 'old' } });

    await putAside({ files: held, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb', writeDown: locked.writeDown }, [NOTE]);
    await putAside({ files: loose, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb', writeDown: free.writeDown }, [NOTE]);

    expect(locked.handed).toEqual([NOTE]);
    expect(free.handed).toStrictEqual([]);
  });

  it('a set a source lets go after its write landed hands on what would not move', async () => {
    const { handed, writeDown } = handing();
    const files = createFilesFake({ texts: { [NOTE]: 'old', [PICTURE]: 'p' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'EBUSY' } });
    const deps = { files, clock: createClockFake('2026-10-13T08:00:00Z'), kbRoot: 'kb', writeDown };

    await letGo(deps, await setAside(deps, [NOTE, PICTURE]));

    expect(handed).toEqual([NOTE, PICTURE]);
  });
});
