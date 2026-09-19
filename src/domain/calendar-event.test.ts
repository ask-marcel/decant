import { describe, expect, it } from 'bun:test';
import { parseCalendarEvent, parseEventDelta, recurrenceText } from './calendar-event.ts';

const graphEvent = {
  '@odata.etag': 'W/"x"',
  id: 'AAMkAGI-event',
  createdDateTime: '2026-08-20T10:00:00.0000000Z',
  lastModifiedDateTime: '2026-09-10T15:30:00.0000000Z',
  categories: ['Board'],
  hasAttachments: true,
  subject: 'Offsite planning',
  bodyPreview: 'Agenda below',
  importance: 'normal',
  sensitivity: 'normal',
  isAllDay: false,
  isCancelled: false,
  seriesMasterId: null,
  showAs: 'busy',
  type: 'singleInstance',
  webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAGI-event&path=/calendar/item',
  isOnlineMeeting: true,
  responseStatus: { response: 'accepted', time: '2026-08-21T08:00:00.0000000Z' },
  body: { contentType: 'html', content: '<div><p>Agenda below</p></div>' },
  start: { dateTime: '2026-09-12T07:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-12T08:30:00.0000000', timeZone: 'UTC' },
  location: { displayName: 'Rotterdam, Room 3', locationType: 'default' },
  recurrence: null,
  attendees: [
    { type: 'required', status: { response: 'accepted', time: '2026-08-21T08:00:00Z' }, emailAddress: { name: 'Jane Doe', address: 'jane@example.com' } },
    { type: 'optional', status: { response: 'none', time: '0001-01-01T00:00:00Z' }, emailAddress: { name: 'Dana Farrow', address: 'dana@example.com' } },
  ],
  organizer: { emailAddress: { name: 'Vincent', address: 'me@example.com' } },
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
};

describe('reading a calendar event as Graph answers for it', () => {
  it('an event carries when it is, where, who called it, who was asked and what they answered, and how to join', () => {
    expect(parseCalendarEvent(graphEvent)).toEqual({
      id: 'AAMkAGI-event',
      subject: 'Offsite planning',
      kind: 'singleInstance',
      start: '2026-09-12T07:00:00Z',
      end: '2026-09-12T08:30:00Z',
      allDay: false,
      cancelled: false,
      organizer: { name: 'Vincent', address: 'me@example.com' },
      attendees: [
        { name: 'Jane Doe', address: 'jane@example.com', response: 'accepted', required: true },
        { name: 'Dana Farrow', address: 'dana@example.com', response: 'none', required: false },
      ],
      location: 'Rotterdam, Room 3',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAGI-event&path=/calendar/item',
      recurrence: '',
      response: 'accepted',
      categories: ['Board'],
      hasAttachments: true,
      lastModified: '2026-09-10T15:30:00.0000000Z',
      body: '<div><p>Agenda below</p></div>',
    });
  });

  it('a time Graph gives in UTC with a seven-digit fraction and no zone letter reads as the instant it names', () => {
    expect(parseCalendarEvent({ ...graphEvent, start: { dateTime: '2026-09-12T07:00:00.0000000', timeZone: 'UTC' } })?.start).toBe('2026-09-12T07:00:00Z');
  });

  it('a time in some other zone is kept as it came, since converting it needs a zone database this has no business owning', () => {
    expect(parseCalendarEvent({ ...graphEvent, start: { dateTime: '2026-09-12T09:00:00.0000000', timeZone: 'Europe/Amsterdam' } })?.start).toBe('2026-09-12T09:00:00.0000000');
  });

  it('a series master carries its rule in words, and a cancelled meeting says so', () => {
    const master = parseCalendarEvent({
      ...graphEvent,
      type: 'seriesMaster',
      isCancelled: true,
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'monday' },
        range: { type: 'endDate', startDate: '2026-01-05', endDate: '2026-12-31' },
      },
    });

    expect(master?.recurrence).toBe('every week on Monday, from 2026-01-05 until 2026-12-31');
    expect(master?.cancelled).toBe(true);
  });

  it('an event with no id is no event, and one with nothing but an id is an event with blanks', () => {
    expect(parseCalendarEvent({ subject: 'No id' })).toBeUndefined();
    expect(parseCalendarEvent('nope')).toBeUndefined();
    expect(parseCalendarEvent({ id: 'x' })).toEqual({
      id: 'x',
      subject: '',
      kind: '',
      start: '',
      end: '',
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
      lastModified: '',
      body: '',
    });
  });

  it('an attendee with no address is nobody, and one with no name is named by their address', () => {
    const parsed = parseCalendarEvent({
      ...graphEvent,
      attendees: [{ type: 'required', emailAddress: { name: 'Ghost' } }, { type: 'required', emailAddress: { address: 'x@example.com' } }, 'nope'],
    });

    expect(parsed?.attendees).toEqual([{ name: 'x@example.com', address: 'x@example.com', response: '', required: true }]);
  });
});

describe('saying a recurrence rule in words', () => {
  const rule = (pattern: Record<string, unknown>, range: Record<string, unknown> = { type: 'noEnd', startDate: '2026-01-05' }): string => recurrenceText({ pattern, range });

  it('every day, every other day, and every week on some days', () => {
    expect(rule({ type: 'daily', interval: 1 })).toBe('every day, from 2026-01-05');
    expect(rule({ type: 'daily', interval: 2 })).toBe('every 2 days, from 2026-01-05');
    expect(rule({ type: 'weekly', interval: 2, daysOfWeek: ['tuesday', 'thursday'] })).toBe('every 2 weeks on Tuesday and Thursday, from 2026-01-05');
  });

  it('a day of the month, the first Monday of the month, a day of the year, and the last Friday of a month of the year', () => {
    expect(rule({ type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 })).toBe('every month on day 15, from 2026-01-05');
    expect(rule({ type: 'relativeMonthly', interval: 1, index: 'first', daysOfWeek: ['monday'] })).toBe('every month on the first Monday, from 2026-01-05');
    expect(rule({ type: 'absoluteYearly', interval: 1, month: 5, dayOfMonth: 12 })).toBe('every year on 12 May, from 2026-01-05');
    expect(rule({ type: 'relativeYearly', interval: 1, index: 'last', daysOfWeek: ['friday'], month: 5 })).toBe('every year on the last Friday of May, from 2026-01-05');
  });

  it('a rule that ends on a day, one that runs a number of times, and one Graph describes in words this has none for', () => {
    expect(rule({ type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, { type: 'endDate', startDate: '2026-01-05', endDate: '2026-12-31' })).toBe(
      'every week on Monday, from 2026-01-05 until 2026-12-31'
    );
    expect(rule({ type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, { type: 'numbered', startDate: '2026-01-05', numberOfOccurrences: 10 })).toBe(
      'every week on Monday, 10 times from 2026-01-05'
    );
    expect(rule({ type: 'lunar' })).toBe('lunar, from 2026-01-05');
    expect(recurrenceText({ pattern: 'nope', range: 'nope' })).toBe('');
  });
});

describe('reading a page of the calendar delta', () => {
  it('a page names what changed and what was removed, with whichever cursor Graph put on it', () => {
    const page = parseEventDelta({
      value: [{ id: 'a', type: 'singleInstance', start: {}, end: {} }, { id: 'b', '@removed': { reason: 'deleted' } }, { noId: true }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/events/delta?%24skiptoken=s',
    });

    expect(page.changes).toEqual([
      { id: 'a', removed: false },
      { id: 'b', removed: true },
    ]);
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/me/events/delta?$skiptoken=s');
    expect(page.deltaLink).toBeUndefined();
  });

  it('a final page carries the cursor to ask later with, and a page with no value array holds nothing', () => {
    expect(parseEventDelta({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?%24deltatoken=z' }).deltaLink).toBe(
      'https://graph.microsoft.com/v1.0/x?$deltatoken=z'
    );
    expect(parseEventDelta('nope').changes).toHaveLength(0);
  });
});
