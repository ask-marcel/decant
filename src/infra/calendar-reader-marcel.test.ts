import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import { createCalendarReaderFromCall } from './calendar-reader-marcel.ts';
import type { GraphErrorShape } from './drive-reader-marcel.ts';

type Recorded = { readonly name: string; readonly params: Record<string, string> };

const readerFor = (
  answers: Readonly<Partial<Record<string, ReadonlyArray<Result<unknown, GraphErrorShape>>>>>
): { reader: ReturnType<typeof createCalendarReaderFromCall>; recorded: Recorded[] } => {
  const recorded: Recorded[] = [];
  const served: Record<string, number> = {};
  const reader = createCalendarReaderFromCall(async (name, params) => {
    recorded.push({ name, params });
    const at = served[name] ?? 0;
    served[name] = at + 1;
    const answer = answers[name]?.[at] ?? answers[name]?.[0] ?? ok({});
    return answer.ok ? ok(answer.value) : err({ kind: 'permanent', message: answer.error.message });
  });
  return { reader, recorded };
};

const CHANGE = { id: 'AAMkAGI-event', type: 'singleInstance', start: { dateTime: '2026-09-12T07:00:00.0000000', timeZone: 'UTC' }, end: {} };

describe('reading the calendar through the ask-marcel library', () => {
  it('a first read asks the delta for everything, fifty a page, and a later one follows the saved cursor', async () => {
    const { reader, recorded } = readerFor({
      'list-calendar-events-delta': [ok({ value: [CHANGE], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?%24deltatoken=abc' })],
      'next-page': [ok({ value: [{ id: 'gone', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?$deltatoken=def' })],
    });

    const fresh = await reader.eventsDelta(undefined);
    const later = await reader.eventsDelta('https://graph.microsoft.com/v1.0/me/events/delta?$deltatoken=abc');

    expect(fresh).toEqual({
      ok: true,
      value: { changes: [{ id: 'AAMkAGI-event', removed: false }], deltaLink: 'https://graph.microsoft.com/v1.0/me/events/delta?$deltatoken=abc' },
    });
    expect(recorded[0]).toEqual({ name: 'list-calendar-events-delta', params: { top: '50' } });
    expect(recorded[1]).toEqual({ name: 'next-page', params: { url: 'https://graph.microsoft.com/v1.0/me/events/delta?$deltatoken=abc' } });
    expect(later).toEqual({ ok: true, value: { changes: [{ id: 'gone', removed: true }], deltaLink: 'https://graph.microsoft.com/v1.0/x?$deltatoken=def' } });
  });

  it('a delta answered a page at a time is followed to its end, a cursor pointing at itself ends it, and a failing page fails the read', async () => {
    const paged = readerFor({
      'list-calendar-events-delta': [ok({ value: [CHANGE], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2?%24skiptoken=s' })],
      'next-page': [ok({ value: [{ ...CHANGE, id: '2' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x?$deltatoken=end' })],
    });
    const delta = await paged.reader.eventsDelta(undefined);
    expect(delta.ok && delta.value.changes.map((change) => change.id)).toEqual(['AAMkAGI-event', '2']);
    expect(delta.ok && delta.value.deltaLink).toBe('https://graph.microsoft.com/v1.0/x?$deltatoken=end');

    const looping = ok({ value: [CHANGE], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/loop' });
    const loop = readerFor({ 'list-calendar-events-delta': [looping], 'next-page': [looping] });
    expect((await loop.reader.eventsDelta(undefined)).ok).toBe(true);
    expect(loop.recorded.filter((entry) => entry.name === 'next-page')).toHaveLength(1);

    const failing = readerFor({
      'list-calendar-events-delta': [ok({ value: [CHANGE], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
      'next-page': [err({ type: 'api_error', status: 503, message: 'Graph is busy' })],
    });
    expect(await failing.reader.eventsDelta(undefined)).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph is busy' } });
  });

  it('an event is asked for with the fields a reader wants, and answers as an event; an answer that is not one fails the read', async () => {
    const { reader, recorded } = readerFor({
      'get-calendar-event': [ok({ id: 'AAMkAGI-event', subject: 'Offsite planning', start: { dateTime: '2026-09-12T07:00:00.0000000', timeZone: 'UTC' } })],
    });

    const event = await reader.event('AAMkAGI-event');

    expect(event.ok && event.value).toMatchObject({ id: 'AAMkAGI-event', subject: 'Offsite planning', start: '2026-09-12T07:00:00Z' });
    expect(recorded[0]?.params['eventId']).toBe('AAMkAGI-event');
    expect(recorded[0]?.params['select']).toContain('subject,body,start,end');

    const blank = readerFor({ 'get-calendar-event': [ok({ subject: 'no id' })] });
    expect(await blank.reader.event('x')).toEqual({ ok: false, error: { kind: 'permanent', message: 'Graph returned no event for x' } });
  });

  it('what an event carries is listed by name, kind and size, and one is converted through the library', async () => {
    const { reader, recorded } = readerFor({
      'list-calendar-event-attachments': [
        ok({
          value: [
            { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att-1', name: 'Venues.xlsx', contentType: 'application/vnd.ms-excel', size: 2048, isInline: false },
            { name: 'no id' },
          ],
        }),
      ],
      'convert-calendar-event-attachment-to-markdown': [ok({ contentType: 'text/markdown', size: 40, text: '| Venue | Cost |' })],
    });

    expect(await reader.attachments('AAMkAGI-event')).toEqual({ ok: true, value: [{ id: 'att-1', name: 'Venues.xlsx', contentType: 'application/vnd.ms-excel', size: 2048 }] });
    expect(await reader.attachmentMarkdown('AAMkAGI-event', 'att-1')).toEqual({ ok: true, value: '| Venue | Cost |' });
    expect(recorded[1]).toEqual({ name: 'convert-calendar-event-attachment-to-markdown', params: { eventId: 'AAMkAGI-event', attachmentId: 'att-1', includeMetadata: 'true' } });
  });
});
