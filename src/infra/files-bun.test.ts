import { afterAll, describe, expect, it } from 'bun:test';
import { linkSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunFiles } from './files-bun.ts';

const root = mkdtempSync(join(tmpdir(), 'contoso-kb-'));
mkdirSync(join(root, 'Espace Contoso'));
writeFileSync(join(root, 'Espace Contoso', 'state.json'), '{"version":1}');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reading the knowledge base from disk', () => {
  it('a state file written by an earlier run is read back verbatim', async () => {
    expect(await createBunFiles().readText(join(root, 'Espace Contoso', 'state.json'))).toEqual({ ok: true, value: '{"version":1}' });
  });

  it('a picture written by an earlier run is read back as the bytes it was, and one never written is missing', async () => {
    const path = join(root, 'Espace Contoso', 'logo.png');
    writeFileSync(path, new Uint8Array([137, 80, 78, 71]));

    expect(await createBunFiles().readBytes(path)).toEqual({ ok: true, value: new Uint8Array([137, 80, 78, 71]) });

    const missing = await createBunFiles().readBytes(join(root, 'absent.png'));

    expect(missing.ok === false && missing.error.kind).toBe('not-found');
  });

  it('asking for a file that was never written reports it as missing', async () => {
    const read = await createBunFiles().readText(join(root, 'absent.json'));

    expect(read.ok === false && read.error.kind).toBe('not-found');
  });

  it('listing the knowledge base returns its source folders and ignores loose files', async () => {
    // A folder of its own: the tests below write `Site/` and `Archive/` into root, and in a random
    // order they can run first.
    const kb = join(root, 'listed');
    mkdirSync(join(kb, 'Espace Contoso'), { recursive: true });
    writeFileSync(join(kb, 'loose.txt'), 'not a directory');

    expect(await createBunFiles().listDirectoryNames(kb)).toEqual({ ok: true, value: ['Espace Contoso'] });
  });

  it('listing a knowledge base that does not exist yet reports it as missing', async () => {
    const listed = await createBunFiles().listDirectoryNames(join(root, 'nope'));

    expect(listed.ok === false && listed.error.kind).toBe('not-found');
  });

  it('a converted document is written into folders that did not exist yet', async () => {
    const path = join(root, 'Site', 'Documents', 'Projets', 'Contrat.docx.md');

    expect(await createBunFiles().writeText(path, '# Contrat')).toEqual({ ok: true, value: undefined });
    expect(await Bun.file(path).text()).toBe('# Contrat');
  });

  it('a downloaded PDF is written as the bytes it came as', async () => {
    const path = join(root, 'Site', 'Documents', 'Contrat.pdf');

    expect(await createBunFiles().writeBytes(path, new TextEncoder().encode('%PDF-1.7'))).toEqual({ ok: true, value: undefined });
    expect(await Bun.file(path).text()).toBe('%PDF-1.7');
  });

  it('a renamed document is moved into folders that did not exist yet', async () => {
    const files = createBunFiles();
    const from = join(root, 'move-me.md');
    const to = join(root, 'Archive', '2026', 'moved.md');
    await files.writeText(from, 'body');

    expect(await files.move(from, to)).toEqual({ ok: true, value: undefined });
    expect(await files.exists(from)).toEqual({ ok: true, value: false });
    expect(await Bun.file(to).text()).toBe('body');
  });

  it('moving a document that is no longer there is reported rather than thrown', async () => {
    const moved = await createBunFiles().move(join(root, 'absent.md'), join(root, 'target.md'));

    expect(moved.ok === false && moved.error.kind).toBe('write-failed');
  });

  // A run stopped halfway through a write leaves the old file or the new one, never half of one, so
  // each file is written beside its place first and then renamed over it.
  it('a write over a file replaces it whole and leaves nothing beside it, text or bytes', async () => {
    const folder = join(root, 'Replaced');
    await createBunFiles().writeText(join(folder, 'state.json'), 'first');

    expect(await createBunFiles().writeText(join(folder, 'state.json'), 'second')).toEqual({ ok: true, value: undefined });
    expect(await createBunFiles().writeBytes(join(folder, 'logo.png'), new Uint8Array([1, 2]))).toEqual({ ok: true, value: undefined });
    expect(await Bun.file(join(folder, 'state.json')).text()).toBe('second');
    expect(new Set(readdirSync(folder))).toEqual(new Set(['logo.png', 'state.json']));
  });

  // A second name for the same file sees what happens to the file itself: written where it lies, both
  // names would show the new text, half written for as long as the write took.
  it('a write puts a new file in place of the old one rather than writing into the old one', async () => {
    const folder = join(root, 'Linked');
    mkdirSync(folder);
    writeFileSync(join(folder, 'state.json'), 'old');
    linkSync(join(folder, 'state.json'), join(folder, 'held.json'));

    await createBunFiles().writeText(join(folder, 'state.json'), 'new');

    expect(await Bun.file(join(folder, 'state.json')).text()).toBe('new');
    expect(await Bun.file(join(folder, 'held.json')).text()).toBe('old');
  });

  it('a write that fails leaves nothing of itself behind', async () => {
    const folder = join(root, 'Refused');
    mkdirSync(folder);
    writeFileSync(join(folder, 'state.json'), '{"version":1}');

    await createBunFiles().writeText(join(folder, 'state.json', 'nested.md'), 'body');

    expect(readdirSync(folder)).toEqual(['state.json']);
  });

  // OneDrive or a virus scanner holds a file open for a moment, and Windows refuses a rename over it
  // meanwhile.
  it('a rename refused while another program holds the file is tried again, a little later each time, and lands once the file is free', async () => {
    const waits: number[] = [];
    let refusals = 2;
    const holding = {
      rename: async (from: string, to: string): Promise<void> => {
        refusals -= 1;
        if (refusals >= 0) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
        await rename(from, to);
      },
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
    };
    const path = join(root, 'Held', 'state.json');

    expect(await createBunFiles('win32', holding).writeText(path, 'saved')).toEqual({ ok: true, value: undefined });
    expect(await Bun.file(path).text()).toBe('saved');
    expect(waits).toEqual([50, 100]);
  });

  it('a file held for good fails its write after five tries, and leaves nothing beside it', async () => {
    let tries = 0;
    const holding = {
      rename: async (): Promise<void> => {
        tries += 1;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
      sleep: async (): Promise<void> => undefined,
    };
    const folder = join(root, 'HeldForGood');

    const written = await createBunFiles('win32', holding).writeText(join(folder, 'state.json'), 'saved');

    expect(written.ok === false && written.error.kind).toBe('write-failed');
    expect(tries).toBe(5);
    expect(readdirSync(folder)).toHaveLength(0);
  });

  it('a rename refused for a reason other than a held file fails at once', async () => {
    let tries = 0;
    const refusing = {
      rename: async (): Promise<void> => {
        tries += 1;
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
      sleep: async (): Promise<void> => undefined,
    };

    expect((await createBunFiles('linux', refusing).writeText(join(root, 'Full', 'state.json'), 'saved')).ok).toBe(false);
    expect(tries).toBe(1);
  });

  it('a knowledge base that cannot be written to is reported rather than thrown', async () => {
    const written = await createBunFiles().writeText(join(root, 'Espace Contoso', 'state.json', 'nested.md'), 'body');

    expect(written.ok === false && written.error.kind).toBe('write-failed');
  });

  // Windows answers a path that is too long with `ENOENT: no such file or directory`, which sent the
  // reader of the report looking for a folder that was never missing.
  it('on Windows, a write that fails on a path past what Windows accepts says how long the path is', async () => {
    const tooLong = join(root, `${'x'.repeat(300)}.md`);

    const onWindows = await createBunFiles('win32').writeText(tooLong, 'body');
    const elsewhere = await createBunFiles('linux').writeText(tooLong, 'body');
    const moved = await createBunFiles('win32').move(join(root, 'absent.md'), tooLong);

    expect(onWindows.ok === false && onWindows.error.message).toContain(`the path has ${tooLong.length} characters, and Windows accepts at most 259`);
    expect(elsewhere.ok === false && elsewhere.error.message).not.toContain('Windows accepts');
    expect(moved.ok === false && moved.error.message).toContain('Windows accepts at most 259');
  });

  it('on Windows, a write that fails on a short path says nothing of its length', async () => {
    const written = await createBunFiles('win32').writeText(join(root, 'Espace Contoso', 'state.json', 'nested.md'), 'body');

    expect(written.ok === false && written.error.message).not.toContain('Windows accepts');
  });
});
