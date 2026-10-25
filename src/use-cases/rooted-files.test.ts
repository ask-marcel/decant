import { describe, expect, it } from 'bun:test';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { withKbRoot } from './rooted-files.ts';

const STATE = 'kb/Calendar/.sync-state.json';
const COPIED = '/copy/kb/Calendar/.sync-state.json';

const asText = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

const calendar = {
  version: 1,
  source: { kind: 'calendar', id: 'me', name: 'Calendar', webUrl: 'https://outlook.example/calendar/Calendar/view' },
  events: {
    'AAMk-1': {
      subject: 'Offsite planning',
      file: 'kb/Calendar/2026-10-12/Offsite planning.md',
      attachments: ['kb/Calendar/2026-10-12/Offsite planning.attachments/Agenda.pdf.md'],
    },
  },
};

const readJson = async (files: ReturnType<typeof withKbRoot>, path: string): Promise<unknown> => {
  const read = await files.readText(path);
  return read.ok ? JSON.parse(read.value) : read.error;
};

describe('a state that names the folder of the knowledge base it was written in', () => {
  it('a saved state records the folder of the knowledge base, and reads back as the sync saved it', async () => {
    const disk = createFilesFake();
    const files = withKbRoot(disk, 'kb');

    await files.writeText(STATE, asText(calendar));

    expect(JSON.parse(disk.written.get(STATE) ?? '')).toEqual({ ...calendar, $kbRoot: 'kb' });
    expect(await readJson(files, STATE)).toEqual(calendar);
  });

  // A copy keeps every path its states recorded, and each one still names the original: followed from
  // the copy, the one-time moves reached into the original, and found nothing of the copy to move.
  it('a state copied with the knowledge base to another folder reads with each recorded path in the copy', async () => {
    const original = createFilesFake();
    await withKbRoot(original, 'kb').writeText(STATE, asText(calendar));
    const copy = withKbRoot(createFilesFake({ texts: { [COPIED]: original.written.get(STATE) ?? '' } }), '/copy/kb');

    expect(await readJson(copy, COPIED)).toEqual({
      ...calendar,
      events: {
        'AAMk-1': {
          subject: 'Offsite planning',
          file: '/copy/kb/Calendar/2026-10-12/Offsite planning.md',
          attachments: ['/copy/kb/Calendar/2026-10-12/Offsite planning.attachments/Agenda.pdf.md'],
        },
      },
    });
  });

  // A state saved before it recorded the folder still holds paths that start with it: the folder is
  // what comes before the place of the state itself, `Calendar/`, in the paths it holds. An address
  // that carries those words is not a path, and does not count.
  it('a state saved before the folder was recorded reads from the folder its own paths start with', async () => {
    const copy = withKbRoot(createFilesFake({ texts: { [COPIED]: asText(calendar) } }), '/copy/kb');

    const read = (await readJson(copy, COPIED)) as typeof calendar;

    expect(read.events['AAMk-1'].file).toBe('/copy/kb/Calendar/2026-10-12/Offsite planning.md');
    expect(read.source.webUrl).toBe(calendar.source.webUrl);
  });

  // A subject can hold the same words as a path. The folder that most paths start with wins.
  it('a state saved before the folder was recorded takes the folder that most of its paths start with', async () => {
    const quoted = { ...calendar, events: { ...calendar.events, 'AAMk-2': { subject: 'Notes/Calendar/archive', file: 'kb/Calendar/2026-10-13/Review.md', attachments: [] } } };
    const copy = withKbRoot(createFilesFake({ texts: { [COPIED]: asText(quoted) } }), '/copy/kb');

    const read = (await readJson(copy, COPIED)) as typeof quoted;

    expect(read.events['AAMk-2']).toEqual({ subject: 'Notes/Calendar/archive', file: '/copy/kb/Calendar/2026-10-13/Review.md', attachments: [] });
  });

  it('a map keyed by recorded paths takes the copy in its keys too', async () => {
    const keyed = { version: 1, files: { 'kb/Calendar/2026-10-12/Offsite planning.md': { hash: 'a1' } } };
    const copy = withKbRoot(createFilesFake({ texts: { [COPIED]: asText({ ...keyed, $kbRoot: 'kb' }) } }), '/copy/kb');

    expect(await readJson(copy, COPIED)).toEqual({ version: 1, files: { '/copy/kb/Calendar/2026-10-12/Offsite planning.md': { hash: 'a1' } } });
  });

  it('a state with no recorded path, or read in the folder it was written in, reads as it is', async () => {
    const people = { version: 1, people: { 'id-1': { name: 'Jane Doe', file: 'Jane Doe.md' } } };
    const disk = createFilesFake({ texts: { '/copy/kb/People/.sync-state.json': asText(people), [STATE]: asText(calendar) } });

    expect(await readJson(withKbRoot(disk, '/copy/kb'), '/copy/kb/People/.sync-state.json')).toEqual(people);
    expect(await readJson(withKbRoot(disk, 'kb'), STATE)).toEqual(calendar);
  });

  // Only the states record paths a run follows. A note that quotes `kb/` keeps its words, and a state
  // that does not read as JSON reaches the sync as it is, which says so itself.
  it('any other file, and a state that is not JSON, passes through as it is', async () => {
    const note = 'See kb/Calendar/2026-10-12/Offsite planning.md';
    const disk = createFilesFake({ texts: { '/copy/kb/Calendar/notes.md': note, [COPIED]: '{ not json' } });
    const files = withKbRoot(disk, '/copy/kb');

    expect(await files.readText('/copy/kb/Calendar/notes.md')).toEqual({ ok: true, value: note });
    expect(await files.readText(COPIED)).toEqual({ ok: true, value: '{ not json' });

    await files.writeText('/copy/kb/Calendar/notes.md', note);
    await files.writeText(COPIED, '{ not json');

    expect(disk.written.get('/copy/kb/Calendar/notes.md')).toBe(note);
    expect(disk.written.get(COPIED)).toBe('{ not json');
  });

  it('a state that will not read answers as the disk does', async () => {
    const files = withKbRoot(createFilesFake(), '/copy/kb');

    expect(await files.readText(COPIED)).toEqual({ ok: false, error: expect.objectContaining({ kind: 'not-found', path: COPIED }) });
  });
});
