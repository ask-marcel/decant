import { describe, expect, it } from 'bun:test';
import { sameWrite, withLineFeeds } from './steady-write.ts';

const note = (syncedAt: string, body: string): string => `---\nsubject: Offsite\nsynced_at: "${syncedAt}"\n---\n\n${body}\n`;

describe('telling a note that changed from one that was only written again', () => {
  it('a note that differs only in when it was synced is the same note, and one that differs anywhere else is not', () => {
    expect(sameWrite(note('2026-10-12T08:00:00Z', 'Agenda.'), note('2026-10-13T08:00:00Z', 'Agenda.'))).toBe(true);
    expect(sameWrite(note('2026-10-12T08:00:00Z', 'Agenda.'), note('2026-10-13T08:00:00Z', 'Agenda, and budget.'))).toBe(false);
    expect(sameWrite(note('2026-10-12T08:00:00Z', 'Agenda.'), note('2026-10-12T08:00:00Z', 'Agenda.').replace('subject: Offsite', 'subject: Onsite'))).toBe(false);
    expect(sameWrite('---\nlast_synced_at: "a"\n---\n', '---\nlast_synced_at: "b"\n---\n')).toBe(false);
    expect(sameWrite('{"a":1}\n', '{"a":1}\n')).toBe(true);
    expect(sameWrite('{"a":1}\n', '{"a":2}\n')).toBe(false);
  });

  // Only the stamp in the front matter is the run's own. A line of the body that reads the same is
  // what the source said, and a change to it is a change.
  it('a line that looks like the stamp but sits in the body is text like any other', () => {
    expect(sameWrite('# Log\n\nsynced_at: "monday"\n', '# Log\n\nsynced_at: "tuesday"\n')).toBe(false);
    expect(sameWrite(`${note('a', 'x')}synced_at: "monday"\n`, `${note('a', 'x')}synced_at: "tuesday"\n`)).toBe(false);
    expect(sameWrite('---\nsynced_at: "monday"\n', '---\nsynced_at: "tuesday"\n')).toBe(false);
    expect(sameWrite('---\n---\nsynced_at: "monday"\n---\n', '---\n---\nsynced_at: "tuesday"\n---\n')).toBe(false);
    expect(sameWrite('synced_at: "monday"\nbody\n', 'synced_at: "tuesday"\nbody\n')).toBe(false);
    expect(sameWrite('# Log\nsynced_at: "monday"\n---\n', '# Log\nsynced_at: "tuesday"\n---\n')).toBe(false);
  });

  // A plain-text source can arrive with Windows line ends, and a note with both kinds reads as
  // changed on every line to a copy that keeps one kind.
  it('a note is written with line feeds alone', () => {
    expect(withLineFeeds('one\r\ntwo\rthree\n')).toBe('one\ntwo\nthree\n');
  });
});
