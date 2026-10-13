import { describe, expect, it } from 'bun:test';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { withSteadyWrites } from './steady-files.ts';

const NOTE = 'kb/Calendar/2026-10-12/Offsite.md';

const note = (syncedAt: string, body: string): string => `---\nsubject: Offsite\nsynced_at: "${syncedAt}"\n---\n\n${body}\n`;

describe('writing only what changed', () => {
  // The note then keeps the time it last changed, and a run that found nothing new changes no file.
  it('a note whose text did not change is not written again, and one whose text changed is', async () => {
    const disk = createFilesFake({ texts: { [NOTE]: note('2026-10-12T08:00:00Z', 'Agenda.') } });
    const files = withSteadyWrites(disk);

    expect(await files.writeText(NOTE, note('2026-10-13T08:00:00Z', 'Agenda.'))).toEqual({ ok: true, value: undefined });
    expect(disk.writeLog).toHaveLength(0);
    expect(disk.written.get(NOTE)).toBe(note('2026-10-12T08:00:00Z', 'Agenda.'));

    await files.writeText(NOTE, note('2026-10-13T08:00:00Z', 'Agenda, and budget.'));

    expect(disk.written.get(NOTE)).toBe(note('2026-10-13T08:00:00Z', 'Agenda, and budget.'));

    await files.writeText('kb/Calendar/new.md', note('2026-10-13T08:00:00Z', 'New.'));

    expect(disk.writeLog).toEqual([NOTE, 'kb/Calendar/new.md']);
  });

  it('markdown that arrives with Windows line ends is written with line feeds, and any other file as given', async () => {
    const disk = createFilesFake();
    const files = withSteadyWrites(disk);

    await files.writeText('kb/Docs/notes.txt.md', 'one\r\ntwo\r\n');
    await files.writeText('kb/Mailbox/_meta/raw.txt', 'one\r\ntwo\r\n');

    expect(disk.written.get('kb/Docs/notes.txt.md')).toBe('one\ntwo\n');
    expect(disk.written.get('kb/Mailbox/_meta/raw.txt')).toBe('one\r\ntwo\r\n');
  });

  // A picture or an original fetched again holds the same bytes, and writing them again would change
  // nothing but the time on the file, which a copy of the knowledge base still takes as news.
  it('a file whose bytes did not change is not written again, and one whose bytes changed is', async () => {
    const disk = createFilesFake();
    const files = withSteadyWrites(disk);
    const picture = 'kb/Docs/Plan.docx.media/image-01.png';
    await files.writeBytes(picture, new Uint8Array([1, 2, 3]));
    const first = disk.binary.get(picture);

    await files.writeBytes(picture, new Uint8Array([1, 2, 3]));

    expect(disk.binary.get(picture)).toBe(first);

    await files.writeBytes(picture, new Uint8Array([1, 2, 4]));
    await files.writeBytes(picture, new Uint8Array([1, 2]));

    expect(disk.binary.get(picture)).toEqual(new Uint8Array([1, 2]));
  });
});
