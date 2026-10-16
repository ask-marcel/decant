import { describe, expect, it } from 'bun:test';
import type { CalendarEvent } from './calendar-event.ts';
import {
  CALENDAR_ID,
  CALENDAR_NAME,
  emptyCalendarState,
  eventFileFor,
  parseCalendarState,
  serializeCalendarState,
  seriesLinksOf,
  staleSeriesLinks,
  withCursor,
  withEvent,
  withoutEvent,
} from './calendar-state.ts';

const event = (id: string, subject: string, start: string): CalendarEvent => ({
  id,
  subject,
  kind: 'singleInstance',
  start,
  end: start,
  allDay: false,
  cancelled: false,
  organizer: undefined,
  attendees: [],
  location: '',
  joinUrl: '',
  webLink: '',
  recurrence: '',
  response: '',
  categories: [],
  hasAttachments: false,
  lastModified: start,
  body: '',
});

const seeded = (): ReturnType<typeof emptyCalendarState> =>
  withEvent(withCursor(emptyCalendarState(), 'https://graph/delta?token=1'), 'a', {
    file: 'kb/Calendar/2026-09-01/Standup.md',
    lastModified: '2026-09-01T09:00:00Z',
    subject: 'Standup',
    outputs: ['kb/Calendar/2026-09-01/Standup.md'],
  });

describe('what a calendar run remembers between runs', () => {
  it('the calendar is one source, standing beside the mailbox, with no cursor and no event until a run', () => {
    expect(emptyCalendarState()).toEqual({ version: 1, source: { kind: 'calendar', id: CALENDAR_ID, name: CALENDAR_NAME }, lastRun: '', events: {} });
  });

  it('an event written once is found again by its id, with everything it wrote, and the cursor stands where the last delta ended', () => {
    expect(seeded().deltaLink).toBe('https://graph/delta?token=1');
    expect(seeded().events['a']).toEqual({
      file: 'kb/Calendar/2026-09-01/Standup.md',
      lastModified: '2026-09-01T09:00:00Z',
      subject: 'Standup',
      outputs: ['kb/Calendar/2026-09-01/Standup.md'],
    });
    expect(Object.keys(withoutEvent(seeded(), 'a').events)).toHaveLength(0);
  });

  it('a state written and read back is the state that was written', () => {
    expect(parseCalendarState(JSON.parse(serializeCalendarState(seeded())))).toEqual({ ok: true, value: seeded() });
  });

  it('a state written by another version, or for another kind of source, is refused rather than half understood', () => {
    expect(parseCalendarState({ version: 3, source: { kind: 'calendar', id: 'calendar', name: 'Calendar' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is version 3, not 1' },
    });
    expect(parseCalendarState({ version: 1, source: { kind: 'mailbox', id: 'me', name: 'Mailbox' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not the calendar' },
    });
    expect(parseCalendarState('nope')).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  it('an event written with an attachment owed reads back owing it, and a flag that is not true reads as none', () => {
    const owing = withEvent(emptyCalendarState(), 'a', { file: 'f', lastModified: 'v', subject: 's', outputs: ['f'], owed: true });
    const loose = parseCalendarState({ version: 1, source: { kind: 'calendar' }, events: { a: { file: 'f', owed: 'yes' } } });

    expect(parseCalendarState(JSON.parse(serializeCalendarState(owing)))).toEqual({ ok: true, value: owing });
    expect(loose.ok ? loose.value.events['a'] : undefined).toStrictEqual({ file: 'f', lastModified: '', subject: '', outputs: [] });
  });

  it('a state with fields missing reads back as blanks, never as holes', () => {
    expect(parseCalendarState({ version: 1, source: { kind: 'calendar' }, events: { a: { file: 'f' }, bad: 4 } })).toEqual({
      ok: true,
      value: {
        version: 1,
        source: { kind: 'calendar', id: CALENDAR_ID, name: CALENDAR_NAME },
        lastRun: '',
        events: { a: { file: 'f', lastModified: '', subject: '', outputs: [] } },
      },
    });
  });
});

describe('deciding where an event goes', () => {
  it('an event is filed under the day it starts, counted where the calendar lives, and named by its subject', () => {
    expect(eventFileFor('kb/Calendar', event('a', 'Offsite planning', '2026-09-12T23:30:00Z'), 'Asia/Shanghai', new Set())).toBe('kb/Calendar/2026-09-13/Offsite planning.md');
  });

  it('two events sharing a subject on one day take different files, and an event with no subject is named by its id', () => {
    const taken = new Set(['kb/Calendar/2026-09-12/Standup.md']);

    const second = eventFileFor('kb/Calendar', event('AAMkAGI-second', 'Standup', '2026-09-12T09:00:00Z'), 'UTC', taken);
    expect(second).not.toBe('kb/Calendar/2026-09-12/Standup.md');
    expect(second).toContain('Standup-');
    expect(eventFileFor('kb/Calendar', event('AAMkAGI-x', '', '2026-09-12T09:00:00Z'), 'UTC', new Set())).toBe('kb/Calendar/2026-09-12/event AAMkAGI-x.md');
  });

  it('an event whose subject changed only in letter case keeps the file it has, as it is', () => {
    const own = 'kb/Calendar/2026-09-12/Offsite Planning.md';

    expect(eventFileFor('kb/Calendar', event('a', 'Offsite planning', '2026-09-12T09:00:00Z'), 'UTC', new Set(), own)).toBe(own);
  });

  it('an event with no usable start still lands somewhere, under the undated day', () => {
    expect(eventFileFor('kb/Calendar', event('a', 'Someday', ''), 'UTC', new Set())).toBe('kb/Calendar/0000-00-00/Someday.md');
  });
});

// A series and its exceptions link to each other. Each record keeps what its note links to as it was
// written, so a run can tell which notes the state has moved on from.
describe('the notes of a series and its exceptions', () => {
  const MASTER = 'kb/Calendar/2026-01-05/Monthly review.md';
  const MARCH = 'kb/Calendar/2026-03-02/Monthly review.md';
  const JUNE = 'kb/Calendar/2026-06-01/Monthly review.md';
  const record = (file: string): { file: string; lastModified: string; subject: string; outputs: string[] } => ({
    file,
    lastModified: 'v',
    subject: 'Monthly review',
    outputs: [file],
  });
  const linked = withEvent(
    withEvent(withEvent(emptyCalendarState(), 'm', { ...record(MASTER), series: { exceptions: [MARCH, JUNE] } }), 'june', {
      ...record(JUNE),
      series: { master: 'm', linked: MASTER },
    }),
    'march',
    { ...record(MARCH), series: { master: 'm', linked: MASTER } }
  );

  it('a series and its exceptions read back with what each note links to, and a field of the wrong kind reads as absent', () => {
    const loose = parseCalendarState({
      version: 1,
      source: { kind: 'calendar' },
      events: { a: { file: 'f', series: { master: 4, linked: 'x', exceptions: 'y' } }, b: { file: 'g', series: 'z' } },
    });

    expect(parseCalendarState(JSON.parse(serializeCalendarState(linked)))).toEqual({ ok: true, value: linked });
    expect(loose.ok ? loose.value.events['a'] : undefined).toStrictEqual({ file: 'f', lastModified: '', subject: '', outputs: [], series: { linked: 'x' } });
    expect(loose.ok ? loose.value.events['b'] : undefined).toStrictEqual({ file: 'g', lastModified: '', subject: '', outputs: [] });
  });

  it('a series links to its exceptions, earliest first, an exception to its series, and an event of no series to nothing', () => {
    expect(seriesLinksOf(linked, 'm', undefined)).toStrictEqual({ exceptions: [MARCH, JUNE] });
    expect(seriesLinksOf(linked, 'march', 'm')).toStrictEqual({ exceptions: [], linked: MASTER });
    expect(seriesLinksOf(linked, 'lone', 'gone')).toStrictEqual({ exceptions: [] });
  });

  it('a series is stale when it gained or lost an exception, and an exception when its master was written after it', () => {
    const gained = withEvent(linked, 'sept', { ...record('kb/Calendar/2026-09-07/Monthly review.md'), series: { master: 'm', linked: MASTER } });

    expect(staleSeriesLinks(linked)).toStrictEqual([]);
    expect(staleSeriesLinks(gained)).toStrictEqual(['m']);
    expect(staleSeriesLinks(withoutEvent(linked, 'june'))).toStrictEqual(['m']);
  });

  // Written before its master, an exception links to nothing until the master is written.
  it('an exception written before its master is stale once the master is written, and an event of no series never is', () => {
    const alone = withEvent(withEvent(emptyCalendarState(), 'march', { ...record(MARCH), series: { master: 'm' } }), 'lunch', record('kb/Calendar/2026-02-01/Lunch.md'));

    expect(staleSeriesLinks(alone)).toStrictEqual([]);
    expect(staleSeriesLinks(withEvent(alone, 'm', { ...record(MASTER), series: { exceptions: [MARCH] } }))).toStrictEqual(['march']);
  });
});
