import type { CalendarEvent, EventChange } from '../../domain/calendar-event.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError } from './drive-reader.ts';

export type CalendarReaderError = DriveReaderError;

// What changed in the calendar since the cursor, or the whole calendar without one. Followed to its
// end before it is handed back, so the cursor that comes with it stands for all of it.
export type EventsDelta = { readonly changes: ReadonlyArray<EventChange>; readonly deltaLink?: string };

// A file an event carries, as far as it can be read: the library converts one to markdown and
// nothing fetches its bytes, so there is no PDF and no original the way a mail attachment has.
export type EventAttachment = { readonly id: string; readonly name: string; readonly contentType: string; readonly size: number };

// The delta lists what changed and no more, so an event is read in two steps the way a mail thread
// is: the delta says which, and one call per event says what.
export type CalendarReader = {
  readonly eventsDelta: (cursor: string | undefined) => Promise<Result<EventsDelta, CalendarReaderError>>;
  readonly event: (eventId: string) => Promise<Result<CalendarEvent, CalendarReaderError>>;
  readonly attachments: (eventId: string) => Promise<Result<ReadonlyArray<EventAttachment>, CalendarReaderError>>;
  readonly attachmentMarkdown: (eventId: string, attachmentId: string) => Promise<Result<string, CalendarReaderError>>;
};
