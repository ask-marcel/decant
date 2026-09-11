import { parseCalendarEvent, parseEventDelta } from '../domain/calendar-event.ts';
import type { EventChange, EventDeltaPage } from '../domain/calendar-event.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { CalendarReader, CalendarReaderError, EventAttachment, EventsDelta } from '../use-cases/ports/calendar-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { listOf, readString } from './mail-reader-marcel.ts';

// The delta takes a page size and nothing else, and answers `id, type, start, end` per event, so
// the event itself is fetched afterwards with the fields a reader wants named, the way a mail thread
// is fetched after the folder delta names it.
const PAGE_SIZE = '50';

const EVENT_FIELDS =
  'id,subject,body,start,end,isAllDay,isCancelled,type,seriesMasterId,recurrence,organizer,attendees,location,webLink,onlineMeeting,isOnlineMeeting,hasAttachments,lastModifiedDateTime,responseStatus,categories';

const readNumber = (value: unknown, key: string): number => {
  const found = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === 'number' ? found : 0;
};

const attachmentOf = (raw: unknown): EventAttachment | undefined => {
  const id = readString(raw, 'id');
  return id === undefined ? undefined : { id, name: readString(raw, 'name') ?? id, contentType: readString(raw, 'contentType') ?? '', size: readNumber(raw, 'size') };
};

export const createCalendarReaderFromCall = (call: MarcelCall): CalendarReader => {
  const page = async (name: string, params: Record<string, string>): Promise<Result<EventDeltaPage, CalendarReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? ok(parseEventDelta(raw.value)) : raw;
  };

  return {
    // Followed to its end before anything is handed back: a delta cut short would hand over a cursor
    // standing past events nobody has read. The `seen` set is the guard the other sweeps keep.
    eventsDelta: async (cursor) => {
      const changes: EventChange[] = [];
      const seen = new Set<string>();
      let deltaLink: string | undefined;
      let next: { readonly name: string; readonly params: Record<string, string> } | undefined =
        cursor === undefined ? { name: 'list-calendar-events-delta', params: { top: PAGE_SIZE } } : { name: 'next-page', params: { url: cursor } };
      while (next !== undefined) {
        const answered: Result<EventDeltaPage, CalendarReaderError> = await page(next.name, next.params);
        if (!answered.ok) return answered;
        changes.push(...answered.value.changes);
        deltaLink = answered.value.deltaLink ?? deltaLink;
        const link = answered.value.nextLink;
        next = link === undefined || seen.has(link) ? undefined : { name: 'next-page', params: { url: link } };
        if (link !== undefined) seen.add(link);
      }
      const delta: EventsDelta = deltaLink === undefined ? { changes } : { changes, deltaLink };
      return ok(delta);
    },
    event: async (eventId) => {
      const raw = await call('get-calendar-event', { eventId, select: EVENT_FIELDS });
      if (!raw.ok) return raw;
      const event = parseCalendarEvent(raw.value);
      return event === undefined ? err({ kind: 'permanent', message: `Graph returned no event for ${eventId}` }) : ok(event);
    },
    attachments: async (eventId) => {
      const raw = await call('list-calendar-event-attachments', { eventId });
      if (!raw.ok) return raw;
      return ok(
        listOf(raw.value).flatMap((entry: unknown) => {
          const attachment = attachmentOf(entry);
          return attachment === undefined ? [] : [attachment];
        })
      );
    },
    // With its metadata, the way a mail attachment is converted, so the library's own stamp on the
    // text says what it converted; the document drops that stamp for one of its own.
    attachmentMarkdown: async (eventId, attachmentId) => {
      const raw = await call('convert-calendar-event-attachment-to-markdown', { eventId, attachmentId, includeMetadata: 'true' });
      return raw.ok ? ok(readString(raw.value, 'text') ?? '') : raw;
    },
  };
};
