import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunFiles } from './files-bun.ts';

const root = mkdtempSync(join(tmpdir(), 'contoso-kb-'));
mkdirSync(join(root, 'Espace Contoso'));
writeFileSync(join(root, 'Espace Contoso', 'state.json'), '{"version":1}');
writeFileSync(join(root, 'loose.txt'), 'not a directory');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reading the knowledge base from disk', () => {
  it('a state file written by an earlier run is read back verbatim', async () => {
    expect(await createBunFiles().readText(join(root, 'Espace Contoso', 'state.json'))).toEqual({ ok: true, value: '{"version":1}' });
  });

  it('asking for a file that was never written reports it as missing', async () => {
    const read = await createBunFiles().readText(join(root, 'absent.json'));

    expect(read.ok === false && read.error.kind).toBe('not-found');
  });

  it('listing the knowledge base returns its source folders and ignores loose files', async () => {
    expect(await createBunFiles().listDirectoryNames(root)).toEqual({ ok: true, value: ['Espace Contoso'] });
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

  it('a knowledge base that cannot be written to is reported rather than thrown', async () => {
    const written = await createBunFiles().writeText(join(root, 'Espace Contoso', 'state.json', 'nested.md'), 'body');

    expect(written.ok === false && written.error.kind).toBe('write-failed');
  });
});
