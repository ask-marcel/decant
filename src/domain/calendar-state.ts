import type { CalendarEvent } from './calendar-event.ts';
import { freePath, safeSegment } from './kb-path.ts';
import { stringList } from './mail-state.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { dayIn } from './zoned-day.ts';

export const CALENDAR_STATE_VERSION = 1;

// One source, the way the mailbox is one: there is one calendar, and it stands beside the mailbox
// in the picker rather than under a heading it would be the only thing under.
export const CALENDAR_ID = 'calendar';
export const CALENDAR_NAME = 'Calendar';

// One event already written. `outputs` is the document and every attachment beside it, which is
// what moves aside when the event is refiled under a later day or deleted; `lastModified` is what
// a re-read delta is compared against; `subject` is what is left to call it by once it is gone.
export type EventRecord = { readonly file: string; readonly lastModified: string; readonly subject: string; readonly outputs: ReadonlyArray<string> };

export type CalendarState = {
  readonly version: typeof CALENDAR_STATE_VERSION;
  readonly source: { readonly kind: 'calendar'; readonly id: typeof CALENDAR_ID; readonly name: typeof CALENDAR_NAME };
  readonly lastRun: string;
  readonly deltaLink?: string;
  // The day the cursor was taken reaching back to, absent when it reached everything. A run reaching
  // further back than this reads the delta whole again. A file written before this reached everything.
  readonly since?: string;
  readonly events: Readonly<Record<string, EventRecord>>;
};

export type CalendarStateError = { readonly kind: 'malformed'; readonly message: string };

export const emptyCalendarState = (): CalendarState => ({
  version: CALENDAR_STATE_VERSION,
  source: { kind: 'calendar', id: CALENDAR_ID, name: CALENDAR_NAME },
  lastRun: '',
  events: {},
});

export const serializeCalendarState = (state: CalendarState): string => `${JSON.stringify(state, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const recordOf = (entry: Record<string, unknown>): EventRecord => ({
  file: readString(entry, 'file') ?? '',
  lastModified: readString(entry, 'lastModified') ?? '',
  subject: readString(entry, 'subject') ?? '',
  outputs: stringList(entry['outputs']),
});

const eventsOf = (raw: unknown): Readonly<Record<string, EventRecord>> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, entry]) => (isRecord(entry) ? [[key, recordOf(entry)] as const] : [])));
};

export const parseCalendarState = (raw: unknown): Result<CalendarState, CalendarStateError> => {
  if (!isRecord(raw)) return err({ kind: 'malformed', message: 'state is not an object' });
  const source = raw['source'];
  if (!isRecord(source) || readString(source, 'kind') !== 'calendar') return err({ kind: 'malformed', message: 'state is not the calendar' });
  if (raw['version'] !== CALENDAR_STATE_VERSION) return err({ kind: 'malformed', message: `state is version ${String(raw['version'])}, not ${CALENDAR_STATE_VERSION}` });
  const deltaLink = readString(raw, 'deltaLink');
  return ok({
    ...emptyCalendarState(),
    lastRun: readString(raw, 'lastRun') ?? '',
    ...(deltaLink === undefined ? {} : { deltaLink }),
    since: readString(raw, 'since'),
    events: eventsOf(raw['events']),
  });
};

export const withCursor = (state: CalendarState, deltaLink: string | undefined): CalendarState => ({ ...state, ...(deltaLink === undefined ? {} : { deltaLink }) });

export const withEvent = (state: CalendarState, id: string, record: EventRecord): CalendarState => ({ ...state, events: { ...state.events, [id]: record } });

export const withoutEvent = (state: CalendarState, id: string): CalendarState => ({
  ...state,
  events: Object.fromEntries(Object.entries(state.events).filter(([held]) => held !== id)),
});

const MARKDOWN = '.md';

const nameOf = (event: CalendarEvent): string => (event.subject.length > 0 ? event.subject : `event ${event.id}`);

// Where an event goes: under the day it starts, counted where the calendar lives, named by its
// subject. Two events can share a subject and a day (a standup and its exception, two calls named
// alike); the second takes a suffix from its own id, the way a document sharing a name in one
// library does. `taken` is every path some other event holds, on disk or planned this run.
export const eventFileFor = (root: string, event: CalendarEvent, zone: string, taken: ReadonlySet<string>): string => {
  const name = `${safeSegment(nameOf(event))}${MARKDOWN}`;
  return freePath(`${root}/${dayIn(event.start, zone)}`, name, event.id, taken);
};
