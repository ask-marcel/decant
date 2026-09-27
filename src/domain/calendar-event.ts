import { canonicalCursor } from './utilities/graph-cursor.ts';

// One event in the signed-in user's calendar, as `get-calendar-event` answers for it. A single
// meeting, a recurring series (one event carrying its rule) or an exception to one, each of which
// the delta reports as its own thing and each of which is filed as its own document.
export type Attendee = { readonly name: string; readonly address: string; readonly response: string; readonly required: boolean };

export type CalendarEvent = {
  readonly id: string;
  readonly subject: string;
  readonly kind: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  // A cancelled meeting is still a fact, so it is kept and marked rather than put aside.
  readonly cancelled: boolean;
  readonly organizer: { readonly name: string; readonly address: string } | undefined;
  readonly attendees: ReadonlyArray<Attendee>;
  readonly location: string;
  readonly joinUrl: string;
  readonly webLink: string;
  // The rule in words, empty for anything that is not a series master.
  readonly recurrence: string;
  readonly response: string;
  readonly categories: ReadonlyArray<string>;
  readonly hasAttachments: boolean;
  readonly lastModified: string;
  readonly body: string;
};

// What the delta says about one event: that it changed, or that it is gone. Nothing else, since
// the delta answers `id, type, start, end` and the event itself is fetched afterwards.
export type EventChange = { readonly id: string; readonly removed: boolean };

export type EventDeltaPage = { readonly changes: ReadonlyArray<EventChange>; readonly nextLink?: string; readonly deltaLink?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

// A text field, or the empty string where the event carries none.
const textOf = (value: unknown, key: string): string => readString(value, key) ?? '';

const readNumber = (value: unknown, key: string): number | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'number' ? found : undefined;
};

const listOf = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const strings = (value: unknown): ReadonlyArray<string> => listOf(value).filter((entry): entry is string => typeof entry === 'string');

// Graph pairs a time with the zone it is stated in and gives it a seven-digit fraction and no zone
// letter. In UTC, which is what every read here asks for, that is the instant with a `Z` on it. In
// any other zone it is kept as it came: turning it into an instant needs a zone database, and a
// wrong instant filed under a wrong day is worse than a time stated in the zone it was given.
const UTC = 'UTC';
const SECONDS = 19;

const instantOf = (pair: unknown): string => {
  const stated = readString(pair, 'dateTime') ?? '';
  const inUtc = readString(pair, 'timeZone') === UTC && stated.length >= SECONDS;
  return inUtc ? stated.slice(0, SECONDS).concat('Z') : stated;
};

// The organizer and each attendee carry their person under `emailAddress`; one with no address
// is nobody, since nothing could be written to them or filed under them.
const personOf = (raw: unknown): { readonly name: string; readonly address: string } | undefined => {
  const holder = isRecord(raw) ? raw['emailAddress'] : undefined;
  const address = readString(holder, 'address');
  return address === undefined ? undefined : { name: readString(holder, 'name') ?? address, address };
};

const attendeeOf = (raw: unknown): Attendee | undefined => {
  const person = personOf(raw);
  if (person === undefined || !isRecord(raw)) return undefined;
  return { ...person, response: readString(raw['status'], 'response') ?? '', required: readString(raw, 'type') !== 'optional' };
};

const DAY_NAMES: Readonly<Record<string, string>> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const dayList = (pattern: Record<string, unknown>): string => {
  const days = strings(pattern['daysOfWeek']).map((day) => DAY_NAMES[day] ?? day);
  return days.length <= 1 ? (days[0] ?? '') : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
};

const monthName = (pattern: Record<string, unknown>): string => MONTH_NAMES[readNumber(pattern, 'month') ?? 0] ?? '';

const every = (pattern: Record<string, unknown>, unit: string): string => {
  const interval = readNumber(pattern, 'interval') ?? 1;
  return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
};

// One sentence per shape Graph has, dispatched on the pattern's type; a type this has no words for
// is named as Graph names it rather than dropped.
const PATTERNS: Readonly<Record<string, (pattern: Record<string, unknown>) => string>> = {
  daily: (pattern) => every(pattern, 'day'),
  weekly: (pattern) => `${every(pattern, 'week')} on ${dayList(pattern)}`,
  absoluteMonthly: (pattern) => `${every(pattern, 'month')} on day ${readNumber(pattern, 'dayOfMonth') ?? ''}`,
  relativeMonthly: (pattern) => `${every(pattern, 'month')} on the ${readString(pattern, 'index') ?? 'first'} ${dayList(pattern)}`,
  absoluteYearly: (pattern) => `${every(pattern, 'year')} on ${readNumber(pattern, 'dayOfMonth') ?? ''} ${monthName(pattern)}`,
  relativeYearly: (pattern) => `${every(pattern, 'year')} on the ${readString(pattern, 'index') ?? 'first'} ${dayList(pattern)} of ${monthName(pattern)}`,
};

const RANGES: Readonly<Record<string, (range: Record<string, unknown>) => string>> = {
  endDate: (range) => `from ${readString(range, 'startDate') ?? ''} until ${readString(range, 'endDate') ?? ''}`,
  numbered: (range) => `${readNumber(range, 'numberOfOccurrences') ?? ''} times from ${readString(range, 'startDate') ?? ''}`,
};

const rangeText = (range: Record<string, unknown>): string => (RANGES[readString(range, 'type') ?? ''] ?? ((held) => `from ${readString(held, 'startDate') ?? ''}`))(range);

export const recurrenceText = (raw: unknown): string => {
  if (!isRecord(raw) || !isRecord(raw['pattern']) || !isRecord(raw['range'])) return '';
  const type = readString(raw['pattern'], 'type') ?? '';
  const said = (PATTERNS[type] ?? (() => type))(raw['pattern']);
  return `${said}, ${rangeText(raw['range'])}`;
};

export const parseCalendarEvent = (raw: unknown): CalendarEvent | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  return {
    id,
    subject: textOf(raw, 'subject'),
    kind: textOf(raw, 'type'),
    start: instantOf(raw['start']),
    end: instantOf(raw['end']),
    allDay: raw['isAllDay'] === true,
    cancelled: raw['isCancelled'] === true,
    organizer: personOf(raw['organizer']),
    attendees: listOf(raw['attendees']).flatMap((entry) => {
      const attendee = attendeeOf(entry);
      return attendee === undefined ? [] : [attendee];
    }),
    location: textOf(raw['location'], 'displayName'),
    joinUrl: textOf(raw['onlineMeeting'], 'joinUrl'),
    webLink: textOf(raw, 'webLink'),
    recurrence: recurrenceText(raw['recurrence']),
    response: textOf(raw['responseStatus'], 'response'),
    categories: strings(raw['categories']),
    hasAttachments: raw['hasAttachments'] === true,
    lastModified: textOf(raw, 'lastModifiedDateTime'),
    body: textOf(raw['body'], 'content'),
  };
};

const pageOf = (value: unknown): ReadonlyArray<unknown> => (isRecord(value) && Array.isArray(value['value']) ? value['value'] : []);

export const parseEventDelta = (raw: unknown): EventDeltaPage => {
  const changes = pageOf(raw).flatMap((entry) => {
    const id = readString(entry, 'id');
    return id === undefined ? [] : [{ id, removed: isRecord(entry) && entry['@removed'] !== undefined }];
  });
  const nextLink = canonicalCursor(readString(raw, '@odata.nextLink'));
  const deltaLink = canonicalCursor(readString(raw, '@odata.deltaLink'));
  return { changes, ...(nextLink === undefined ? {} : { nextLink }), ...(deltaLink === undefined ? {} : { deltaLink }) };
};
