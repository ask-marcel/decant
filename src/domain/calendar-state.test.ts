import { describe, expect, it } from 'bun:test';
import type { CalendarEvent } from './calendar-event.ts';
import { CALENDAR_ID, CALENDAR_NAME, emptyCalendarState, eventFileFor, parseCalendarState, serializeCalendarState, withCursor, withEvent, withoutEvent } from './calendar-state.ts';

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

  it('an event with no usable start still lands somewhere, under the undated day', () => {
    expect(eventFileFor('kb/Calendar', event('a', 'Someday', ''), 'UTC', new Set())).toBe('kb/Calendar/0000-00-00/Someday.md');
  });
});
