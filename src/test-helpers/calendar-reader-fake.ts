import type { CalendarEvent, EventChange } from '../domain/calendar-event.ts';
import { err, ok } from '../domain/result.ts';
import type { CalendarReader, CalendarReaderError, EventAttachment } from '../use-cases/ports/calendar-reader.ts';

export type CalendarReaderSeed = {
  // What the delta answers, and the cursor it hands back.
  readonly changes?: ReadonlyArray<EventChange>;
  readonly deltaLink?: string;
  // Events keyed by id; one the delta names that is not here fails to read, the way one deleted
  // between the delta and the fetch does.
  readonly events?: Readonly<Record<string, CalendarEvent>>;
  readonly attachments?: Readonly<Record<string, ReadonlyArray<EventAttachment>>>;
  // The library's conversion of each attachment, keyed by attachment id.
  readonly markdown?: Readonly<Record<string, string>>;
  readonly failDelta?: CalendarReaderError;
  readonly failEvents?: ReadonlyArray<string>;
  readonly failAttachments?: ReadonlyArray<string>;
  // Events whose attachment listing itself cannot be read.
  readonly failListing?: ReadonlyArray<string>;
};

export type CalendarReaderFake = CalendarReader & { readonly calls: Array<string> };

export const createCalendarReaderFake = (seed: CalendarReaderSeed = {}): CalendarReaderFake => {
  const calls: string[] = [];
  return {
    calls,
    eventsDelta: async (cursor) => {
      calls.push(`eventsDelta:${cursor ?? 'fresh'}`);
      if (seed.failDelta !== undefined) return err(seed.failDelta);
      return ok(seed.deltaLink === undefined ? { changes: seed.changes ?? [] } : { changes: seed.changes ?? [], deltaLink: seed.deltaLink });
    },
    event: async (eventId) => {
      calls.push(`event:${eventId}`);
      const event = seed.events?.[eventId];
      if (event === undefined || (seed.failEvents ?? []).includes(eventId)) return err({ kind: 'permanent', message: `no such event: ${eventId}` });
      return ok(event);
    },
    attachments: async (eventId) => {
      calls.push(`attachments:${eventId}`);
      if ((seed.failListing ?? []).includes(eventId)) return err({ kind: 'transient', message: 'Graph is busy' });
      return ok(seed.attachments?.[eventId] ?? []);
    },
    attachmentMarkdown: async (eventId, attachmentId) => {
      calls.push(`attachmentMarkdown:${attachmentId}`);
      if ((seed.failAttachments ?? []).includes(attachmentId)) return err({ kind: 'unrenderable', message: `cannot convert ${attachmentId}` });
      return ok(seed.markdown?.[attachmentId] ?? `text of ${attachmentId}`);
    },
  };
};
