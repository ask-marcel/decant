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
});
