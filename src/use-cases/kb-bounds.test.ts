import { describe, expect, it } from 'bun:test';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { withinKb } from './kb-bounds.ts';

const ORIGINAL = 'kb/People/Jane Doe.md';
const COPY = '/copy/kb/People/Jane Doe.md';

describe('keeping every file operation inside the knowledge base', () => {
  // A state copied with the knowledge base still names the folder it was written in. Followed from the
  // copy, a recorded path reached into the original, and a run moved its files away.
  it('a move from outside the knowledge base is refused, and the file stays where it is', async () => {
    const disk = createFilesFake({ texts: { [ORIGINAL]: 'Jane' } });
    const files = withinKb(disk, '/copy/kb');

    const moved = await files.move(ORIGINAL, '/copy/kb/_archive/2026-10-24/kb/People/Jane Doe.md');

    expect(moved).toEqual({ ok: false, error: { kind: 'write-failed', path: ORIGINAL, message: `outside the knowledge base /copy/kb: ${ORIGINAL}` } });
    expect(disk.moves).toStrictEqual([]);
    expect(disk.written.get(ORIGINAL)).toBe('Jane');
  });

  it('a move into a place outside the knowledge base is refused', async () => {
    const disk = createFilesFake({ texts: { [COPY]: 'Jane' } });
    const files = withinKb(disk, '/copy/kb');

    expect((await files.move(COPY, ORIGINAL)).ok).toBe(false);
    expect(disk.moves).toStrictEqual([]);
  });

  it('a write outside the knowledge base, of text or of bytes, is refused and lands nowhere', async () => {
    const disk = createFilesFake();
    const files = withinKb(disk, '/copy/kb');

    expect(await files.writeText('kb/Atlas.eml/Fwd.eml.md', 'x')).toEqual({
      ok: false,
      error: { kind: 'write-failed', path: 'kb/Atlas.eml/Fwd.eml.md', message: 'outside the knowledge base /copy/kb: kb/Atlas.eml/Fwd.eml.md' },
    });
    expect((await files.writeBytes('kb/logo.png', new Uint8Array([1]))).ok).toBe(false);
    expect(disk.writeLog).toStrictEqual([]);
    expect(disk.binary.size).toBe(0);
  });

  // A file outside reads as one that cannot be read, not as one that is gone: a one-time move takes a
  // file already gone from its old place as moved, and would then record the move as done.
  it('a file outside the knowledge base reads as unreadable, never as absent', async () => {
    const disk = createFilesFake({ texts: { [ORIGINAL]: 'Jane' }, directories: { kb: ['People'] } });
    const files = withinKb(disk, '/copy/kb');
    const refused = { kind: 'read-failed' as const, path: ORIGINAL, message: `outside the knowledge base /copy/kb: ${ORIGINAL}` };

    expect(await files.exists(ORIGINAL)).toEqual({ ok: false, error: refused });
    expect(await files.readText(ORIGINAL)).toEqual({ ok: false, error: refused });
    expect((await files.readBytes(ORIGINAL)).ok).toBe(false);
    expect((await files.listDirectoryNames('kb')).ok).toBe(false);
  });

  // `/copy/kb-old` starts with the text `/copy/kb`, but is a folder beside it; `..` climbs out of it.
  it('a path beside the knowledge base, or one that climbs out of it, is outside it', async () => {
    const disk = createFilesFake();
    const files = withinKb(disk, '/copy/kb');

    expect((await files.writeText('/copy/kb-old/note.md', 'x')).ok).toBe(false);
    expect((await files.writeText('/copy/kb/People/../../note.md', 'x')).ok).toBe(false);
    expect(disk.writeLog).toStrictEqual([]);
  });

  it('every operation inside the knowledge base, and on its folder itself, reaches the disk', async () => {
    const disk = createFilesFake({ texts: { [COPY]: 'Jane' }, directories: { '/copy/kb': ['People'] } });
    const files = withinKb(disk, '/copy/kb');

    expect(await files.readText(COPY)).toEqual({ ok: true, value: 'Jane' });
    expect(await files.exists(COPY)).toEqual({ ok: true, value: true });
    expect(await files.listDirectoryNames('/copy/kb')).toEqual({ ok: true, value: ['People'] });
    expect((await files.writeText('/copy/kb/People/Li Wei.md', 'Li')).ok).toBe(true);
    expect((await files.writeBytes('/copy/kb/People/logo.png', new Uint8Array([1]))).ok).toBe(true);
    expect((await files.move(COPY, '/copy/kb/_archive/2026-10-24/People/Jane Doe.md')).ok).toBe(true);
    expect((await files.readBytes('/copy/kb/People/logo.png')).ok).toBe(true);
  });
  // `--out ../kb-test` names the folder through `..` itself: only a `..` after it climbs out.
  it('a knowledge base named through a parent folder takes every path under it, and refuses one that climbs out of it', async () => {
    const disk = createFilesFake();
    const files = withinKb(disk, '../kb-test');

    expect((await files.writeText('../kb-test/People/Jane Doe.md', 'Jane')).ok).toBe(true);
    expect((await files.writeText('../kb-test/People/../../note.md', 'x')).ok).toBe(false);
    expect(disk.writeLog).toStrictEqual(['../kb-test/People/Jane Doe.md']);
  });
});
