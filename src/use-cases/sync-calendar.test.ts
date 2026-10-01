import { describe, expect, it } from 'bun:test';
import { basename } from 'node:path';
import type { CalendarEvent } from '../domain/calendar-event.ts';
import { emptyCalendarState, serializeCalendarState, withCursor, withEvent } from '../domain/calendar-state.ts';
import { freeSegment } from '../domain/kb-path.ts';
import { createCalendarReaderFake } from '../test-helpers/calendar-reader-fake.ts';
import type { CalendarReaderFake, CalendarReaderSeed } from '../test-helpers/calendar-reader-fake.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createProgressFake } from '../test-helpers/progress-fake.ts';
import type { ProgressFake } from '../test-helpers/progress-fake.ts';
import type { EventAttachment } from './ports/calendar-reader.ts';
import type { StepError } from './ports/step-error.ts';
import { createSyncCalendar } from './sync-calendar.ts';
import type { RunNotes, RunSummary } from './sync-site.ts';

const ROOT = 'kb/Calendar';
const STATE_PATH = `${ROOT}/.sync-state.json`;

const event = (id: string, subject: string, start: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  subject,
  kind: 'singleInstance',
  start,
  end: start,
  allDay: false,
  cancelled: false,
  organizer: { name: 'Valerie', address: 'me@example.com' },
  attendees: [{ name: 'Jane Doe', address: 'jane@example.com', response: 'accepted', required: true }],
  location: '',
  joinUrl: '',
  webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
  recurrence: '',
  response: 'organizer',
  categories: [],
  hasAttachments: false,
  lastModified: start,
  body: '<p>Agenda</p>',
  ...over,
});

const OFFSITE = event('a', 'Offsite planning', '2026-09-12T07:00:00Z', { hasAttachments: true });
const STANDUP = event('b', 'Standup', '2026-09-10T08:00:00Z');

const run = async (
  seeds: { reader?: CalendarReaderSeed; files?: FilesFakeSeed; dryRun?: boolean; concurrency?: number; since?: string } = {}
): Promise<{
  summary: RunSummary;
  source: string;
  notes: RunNotes;
  files: FilesFake;
  logger: LoggerFake;
  reader: CalendarReaderFake;
  progress: ProgressFake;
  ok: boolean;
  error?: StepError;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const progress = createProgressFake();
  const reader = createCalendarReaderFake({
    changes: [
      { id: 'a', removed: false },
      { id: 'b', removed: false },
    ],
    deltaLink: 'https://graph/delta?token=next',
    events: { a: OFFSITE, b: STANDUP },
    attachments: { a: [{ id: 'att-1', name: 'Venues.xlsx', contentType: 'application/vnd.ms-excel', size: 2048 }] },
    markdown: { 'att-1': '---\nname: Venues.xlsx\n---\n\n| Venue | Cost |\n' },
    ...seeds.reader,
  });
  const syncCalendar = createSyncCalendar({ reader, files, clock: createClockFake('2026-09-12T14:00:00Z'), logger, progress, kbRoot: 'kb', timezone: 'UTC' });
  const outcome = await syncCalendar({ dryRun: seeds.dryRun ?? false, concurrency: seeds.concurrency ?? 4, since: seeds.since });
  const empty = {
    summary: { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 },
    source: 'Calendar',
    notes: { skipped: [], failed: [], givenUp: [], archived: [] },
  };
  return outcome.ok ? { ...outcome.value, files, logger, reader, progress, ok: true } : { ...empty, files, logger, reader, progress, ok: false, error: outcome.error };
};

type StoredState = { lastRun: string; deltaLink?: string; events: Record<string, { file: string; lastModified: string; subject: string; outputs: string[] }> };

const stateOf = (files: FilesFake): StoredState => JSON.parse(files.written.get(STATE_PATH) ?? '{}');

describe('syncing the calendar', () => {
  it('a first run reads the delta whole, fetches each event, writes it under the day it starts with what it carried beside it, and keeps the cursor', async () => {
    const done = await run();

    expect(done.summary.converted).toBe(2);
    expect(done.reader.calls).toContain('eventsDelta:fresh');
    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([
      `${ROOT}/2026-09-10/Standup.md`,
      `${ROOT}/2026-09-12/Offsite planning.attachments/Venues.xlsx.md`,
      `${ROOT}/2026-09-12/Offsite planning.md`,
    ]);
    expect(done.files.written.get(`${ROOT}/2026-09-12/Offsite planning.md`)).toContain('- [Venues.xlsx](<Offsite planning.attachments/Venues.xlsx.md>)');
    expect(done.files.written.get(`${ROOT}/2026-09-12/Offsite planning.attachments/Venues.xlsx.md`)).toContain('event: Offsite planning\nname: Venues.xlsx');
    expect(stateOf(done.files)).toMatchObject({
      deltaLink: 'https://graph/delta?token=next',
      events: {
        a: {
          file: `${ROOT}/2026-09-12/Offsite planning.md`,
          subject: 'Offsite planning',
          outputs: [`${ROOT}/2026-09-12/Offsite planning.md`, `${ROOT}/2026-09-12/Offsite planning.attachments/Venues.xlsx.md`],
        },
      },
    });
  });

  it('a second run asks for what changed since the cursor, and fetches only what the delta named', async () => {
    const state = withEvent(withCursor(emptyCalendarState(), 'https://graph/delta?token=1'), 'b', {
      file: `${ROOT}/2026-09-10/Standup.md`,
      lastModified: STANDUP.lastModified,
      subject: 'Standup',
      outputs: [`${ROOT}/2026-09-10/Standup.md`],
    });
    const done = await run({ reader: { changes: [{ id: 'a', removed: false }] }, files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    expect(done.reader.calls).toContain('eventsDelta:https://graph/delta?token=1');
    expect(done.reader.calls.filter((call) => call.startsWith('event:'))).toEqual(['event:a']);
    expect(done.summary.converted).toBe(1);
  });

  it('an event the delta named that has not changed since it was written is fetched and left alone, which is what a re-read after a stopped run costs', async () => {
    const state = withEvent(emptyCalendarState(), 'b', {
      file: `${ROOT}/2026-09-10/Standup.md`,
      lastModified: STANDUP.lastModified,
      subject: 'Standup',
      outputs: [`${ROOT}/2026-09-10/Standup.md`],
    });
    const done = await run({ reader: { changes: [{ id: 'b', removed: false }] }, files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    expect(done.summary.converted).toBe(0);
    expect(done.files.writeLog).toEqual([STATE_PATH]);
  });

  it('an event moved to another day is written under the new day, and the copy under the old day and what it carried go to the archive', async () => {
    const state = withEvent(emptyCalendarState(), 'a', {
      file: `${ROOT}/2026-09-05/Offsite planning.md`,
      lastModified: '2026-09-01T00:00:00Z',
      subject: 'Offsite planning',
      outputs: [`${ROOT}/2026-09-05/Offsite planning.md`, `${ROOT}/2026-09-05/Offsite planning.attachments/Old.docx.md`],
    });
    const done = await run({ reader: { changes: [{ id: 'a', removed: false }] }, files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.moves.map((move) => move.to)).toEqual([
      'kb/_archive/Calendar/2026-09-05/Offsite planning.md',
      'kb/_archive/Calendar/2026-09-05/Offsite planning.attachments/Old.docx.md',
    ]);
  });

  it('an event deleted at the source is put aside with what it carried, and named in the report', async () => {
    const state = withEvent(emptyCalendarState(), 'gone', {
      file: `${ROOT}/2026-09-01/Cancelled call.md`,
      lastModified: 'x',
      subject: 'Cancelled call',
      outputs: [`${ROOT}/2026-09-01/Cancelled call.md`],
    });
    const done = await run({ reader: { changes: [{ id: 'gone', removed: true }] }, files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    expect(done.summary.archived).toBe(1);
    expect(done.notes.archived).toEqual([{ path: 'Cancelled call', reason: 'deleted from the calendar' }]);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/2026-09-01/Cancelled call.md`, to: 'kb/_archive/Calendar/2026-09-01/Cancelled call.md' }]);
    expect(stateOf(done.files).events).toEqual({});
    expect(done.files.written.get(`${ROOT}/_sync-report.md`)).toContain('Cancelled call');
  });

  it('a removal the ledger never held is nothing, and a cancelled meeting stays, marked', async () => {
    const done = await run({
      reader: {
        changes: [
          { id: 'never', removed: true },
          { id: 'b', removed: false },
        ],
        events: { b: { ...STANDUP, cancelled: true } },
      },
    });

    expect(done.summary).toMatchObject({ converted: 1, archived: 0 });
    expect(done.files.written.get(`${ROOT}/2026-09-10/Standup.md`)).toContain('cancelled: true');
  });

  it('an event that cannot be fetched is reported as failed, and the cursor is kept where it was so the next run asks for it again', async () => {
    const done = await run({ reader: { failEvents: ['a'] } });

    expect(done.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'a', reason: 'no such event: a' }]);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'event.unread', meta: { event: 'a', cause: 'permanent' } });
    expect(stateOf(done.files).deltaLink).toBeUndefined();
  });

  it('an attachment the library will not render, a picture, is left out and said to be, and the event lands without it with its cursor kept', async () => {
    const done = await run({ reader: { failAttachments: ['att-1'] } });

    expect(done.summary).toMatchObject({ converted: 2, skipped: 1, failed: 0 });
    expect(done.notes.skipped).toEqual([{ path: 'Offsite planning/Venues.xlsx', reason: 'cannot convert att-1' }]);
    expect(done.files.written.get(`${ROOT}/2026-09-12/Offsite planning.md`)).not.toContain('## Attachments');
    expect(stateOf(done.files).events['a']?.outputs).toEqual([`${ROOT}/2026-09-12/Offsite planning.md`]);
    expect(stateOf(done.files).deltaLink).toBe('https://graph/delta?token=next');
  });

  it('an attachment that fails for any other reason is a failure to try again, and holds the cursor back', async () => {
    const done = await run({ files: { failWritesMatching: 'Venues.xlsx' } });

    expect(done.summary).toMatchObject({ converted: 2, skipped: 0, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'Offsite planning/Venues.xlsx', reason: `cannot write ${ROOT}/2026-09-12/Offsite planning.attachments/Venues.xlsx.md` }]);
    expect(stateOf(done.files).deltaLink).toBeUndefined();
  });

  it('an event without attachments carries no attachment section and records only its own file', async () => {
    const done = await run();

    expect(done.files.written.get(`${ROOT}/2026-09-10/Standup.md`)).not.toContain('## Attachments');
    expect(stateOf(done.files).events['b']?.outputs).toEqual([`${ROOT}/2026-09-10/Standup.md`]);
  });

  it('an event whose attachments cannot be listed lands without them, and the listing is named as failed', async () => {
    const done = await run({ reader: { failListing: ['a'] } });

    expect(done.summary).toMatchObject({ converted: 2, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'Offsite planning/attachments', reason: 'Graph is busy' }]);
    expect(done.files.written.has(`${ROOT}/2026-09-12/Offsite planning.md`)).toBe(true);
  });

  it('an event whose file and attachment both fail to write counts both, and is logged by id', async () => {
    const done = await run({ files: { failWritesMatching: 'Offsite planning' } });

    expect(done.summary).toMatchObject({ converted: 1, failed: 2 });
    expect(done.notes.failed.map((note) => note.path)).toEqual(['Offsite planning/Venues.xlsx', 'a']);
  });

  it('an event rewritten under the same day keeps its file where it is, with nothing moved aside', async () => {
    const state = withEvent(emptyCalendarState(), 'b', {
      file: `${ROOT}/2026-09-10/Standup.md`,
      lastModified: 'older',
      subject: 'Standup',
      outputs: [`${ROOT}/2026-09-10/Standup.md`],
    });
    const done = await run({ reader: { changes: [{ id: 'b', removed: false }] }, files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    expect(done.summary.converted).toBe(1);
    expect(done.files.moves).toHaveLength(0);
  });

  it('a file that will not move aside is logged with its path and the run carries on, for a refile and for a deletion alike', async () => {
    const refiled = withEvent(emptyCalendarState(), 'a', {
      file: `${ROOT}/2026-09-05/Offsite planning.md`,
      lastModified: 'older',
      subject: 'Offsite planning',
      outputs: [`${ROOT}/2026-09-05/Offsite planning.md`],
    });
    const state = withEvent(refiled, 'gone', {
      file: `${ROOT}/2026-09-01/Cancelled call.md`,
      lastModified: 'x',
      subject: 'Cancelled call',
      outputs: [`${ROOT}/2026-09-01/Cancelled call.md`],
    });
    const done = await run({
      reader: {
        changes: [
          { id: 'a', removed: false },
          { id: 'gone', removed: true },
        ],
      },
      files: { texts: { [STATE_PATH]: serializeCalendarState(state) }, failMoveWith: { kind: 'write-failed', path: 'x', message: 'disk is read-only' } },
    });

    expect(done.ok).toBe(true);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'supersede.failed', meta: { path: `${ROOT}/2026-09-05/Offsite planning.md`, cause: 'write-failed' } });
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'archive.failed', meta: { path: `${ROOT}/2026-09-01/Cancelled call.md`, cause: 'write-failed' } });
  });

  it('an event starting on the --since day itself is written, since the day is included', async () => {
    const done = await run({ since: '2026-09-10' });

    expect(done.summary.converted).toBe(2);
  });

  it('a new event sharing a subject and a day with one the ledger already holds takes a file of its own', async () => {
    const state = withEvent(emptyCalendarState(), 'older', {
      file: `${ROOT}/2026-09-10/Standup.md`,
      lastModified: 'x',
      subject: 'Standup',
      outputs: [`${ROOT}/2026-09-10/Standup.md`],
    });
    const done = await run({ reader: { changes: [{ id: 'b', removed: false }] }, files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    const file = stateOf(done.files).events['b']?.file ?? '';
    expect(file).not.toBe(`${ROOT}/2026-09-10/Standup.md`);
    expect(file).toContain(`${ROOT}/2026-09-10/Standup-`);
  });

  it('two new events sharing a subject and a day, written in one window, each take a file of their own', async () => {
    const done = await run({ reader: { events: { a: event('a', 'Standup', '2026-09-10T08:00:00Z'), b: event('b', 'Standup', '2026-09-10T09:00:00Z') } } });

    const events = stateOf(done.files).events;
    expect(events['a']?.file).toBe(`${ROOT}/2026-09-10/Standup.md`);
    expect(events['b']?.file).toStartWith(`${ROOT}/2026-09-10/Standup-`);
  });

  it('an event renamed in the same window as its namesake puts only its own old document aside, and the namesake is rewritten in the file its record names', async () => {
    const renamed = { file: `${ROOT}/2026-09-10/Call.md`, lastModified: 'older', subject: 'Call', outputs: [`${ROOT}/2026-09-10/Call.md`] };
    // Where the namesake was put while the renamed event held the plain name.
    const namesakeFile = `${ROOT}/2026-09-10/${freeSegment('Call.md', 'b', (name) => name === 'Call.md')}`;
    const namesake = { file: namesakeFile, lastModified: 'older', subject: 'Call', outputs: [namesakeFile] };
    const state = withEvent(withEvent(emptyCalendarState(), 'a', renamed), 'b', namesake);
    const done = await run({
      reader: { events: { a: event('a', 'Meeting', '2026-09-10T08:00:00Z'), b: event('b', 'Call', '2026-09-10T09:00:00Z', { body: '<p>Bring the contract</p>' }) } },
      files: { texts: { [STATE_PATH]: serializeCalendarState(state), [renamed.file]: 'the call as it was', [namesake.file]: 'the namesake as it was' } },
    });

    const recorded = stateOf(done.files).events['b']?.file ?? '';
    expect(done.files.written.get(recorded)).toContain('Bring the contract');
    expect(done.files.moves).toEqual([{ from: renamed.file, to: 'kb/_archive/Calendar/2026-09-10/Call.md' }]);
    expect(done.files.written.get('kb/_archive/Calendar/2026-09-10/Call.md')).toBe('the call as it was');
  });

  it('three events sharing a subject and a day land in three files, though Graph opens all their ids alike', async () => {
    const ids = ['AAMkADU3-one', 'AAMkADU3-two', 'AAMkADU3-three'];
    const done = await run({
      reader: { changes: ids.map((id) => ({ id, removed: false })), events: Object.fromEntries(ids.map((id) => [id, event(id, 'Standup', '2026-09-10T08:00:00Z')])) },
    });

    expect(new Set(Object.values(stateOf(done.files).events).map((record) => record.file)).size).toBe(3);
  });

  it('an event the delta named twice is fetched once', async () => {
    const done = await run({
      reader: {
        changes: [
          { id: 'a', removed: false },
          { id: 'a', removed: false },
        ],
      },
      dryRun: true,
    });

    expect(done.summary.queued).toBe(1);
  });

  it('an event whose file will not write is reported as failed with whatever it carried, and the cursor is kept', async () => {
    const done = await run({ files: { failWritesMatching: 'Offsite planning.md' } });

    expect(done.summary).toMatchObject({ converted: 1, failed: 1 });
    expect(done.notes.failed).toEqual([{ path: 'a', reason: `cannot write ${ROOT}/2026-09-12/Offsite planning.md` }]);
    expect(done.logger.calls).toContainEqual({ level: 'warn', event: 'event.failed', meta: { event: 'a', cause: 'write-failed' } });
    expect(stateOf(done.files).events['a']).toBeUndefined();
    expect(stateOf(done.files).deltaLink).toBeUndefined();
  });

  it('events starting before --since are listed and not written, and the cursor moves past them', async () => {
    const done = await run({ since: '2026-09-11' });

    expect(done.summary.converted).toBe(1);
    expect(done.files.written.has(`${ROOT}/2026-09-10/Standup.md`)).toBe(false);
    expect(stateOf(done.files).deltaLink).toBe('https://graph/delta?token=next');
  });

  // A cursor reports only what changed after it, so a day moved earlier would otherwise never see
  // the events the narrower read passed over.
  it('a day moved earlier than the one the cursor was taken under reads the delta whole again, and writes only what it had left out', async () => {
    const filed = {
      file: `${ROOT}/2026-09-12/Offsite planning.md`,
      lastModified: OFFSITE.lastModified,
      subject: 'Offsite planning',
      outputs: [`${ROOT}/2026-09-12/Offsite planning.md`],
    };
    const state = withEvent({ ...withCursor(emptyCalendarState(), 'https://graph/delta?token=1'), since: '2026-09-11' }, 'a', filed);

    const done = await run({ since: '2026-09-01', files: { texts: { [STATE_PATH]: serializeCalendarState(state) } } });

    expect(done.reader.calls).toContain('eventsDelta:fresh');
    expect(done.summary.converted).toBe(1);
    expect(done.files.written.has(`${ROOT}/2026-09-10/Standup.md`)).toBe(true);
    expect(stateOf(done.files)).toMatchObject({ since: '2026-09-01', deltaLink: 'https://graph/delta?token=next' });
  });

  it('moving the day earlier reads the old cursor out first, so an event removed since the last run is still put aside', async () => {
    const gone = {
      file: `${ROOT}/2026-09-11/Cancelled call.md`,
      lastModified: '2026-09-01T00:00:00Z',
      subject: 'Cancelled call',
      outputs: [`${ROOT}/2026-09-11/Cancelled call.md`],
    };
    const state = withEvent({ ...withCursor(emptyCalendarState(), 'https://graph/delta?token=1'), since: '2026-09-11' }, 'gone', gone);

    const done = await run({
      since: '2026-09-01',
      reader: { changesFrom: { 'https://graph/delta?token=1': [{ id: 'gone', removed: true }] } },
      files: { texts: { [STATE_PATH]: serializeCalendarState(state) } },
    });

    expect(done.reader.calls.filter((call) => call.startsWith('eventsDelta'))).toEqual(['eventsDelta:https://graph/delta?token=1', 'eventsDelta:fresh']);
    expect(done.files.moves).toEqual([{ from: `${ROOT}/2026-09-11/Cancelled call.md`, to: 'kb/_archive/Calendar/2026-09-11/Cancelled call.md' }]);
    expect(done.summary).toMatchObject({ converted: 2, archived: 1 });
  });

  it('the same day, or a later one, keeps following the cursor; all widens it, and keeps no day', async () => {
    const texts = { [STATE_PATH]: serializeCalendarState({ ...withCursor(emptyCalendarState(), 'https://graph/delta?token=1'), since: '2026-09-11' }) };

    for (const since of ['2026-09-11', '2026-09-12']) {
      const kept = await run({ since, files: { texts } });

      expect(kept.reader.calls).toContain('eventsDelta:https://graph/delta?token=1');
      expect(kept.reader.calls).not.toContain('eventsDelta:fresh');
      expect(stateOf(kept.files)).toMatchObject({ since });
    }

    const everything = await run({ files: { texts } });

    expect(everything.reader.calls).toContain('eventsDelta:fresh');
    expect('since' in stateOf(everything.files)).toBe(false);
  });

  it('a recurring series that began before the day is kept, since it may be running still; a single event before it is not', async () => {
    const series = event('s', 'Weekly sync', '2024-01-08T09:00:00Z', { kind: 'seriesMaster', recurrence: 'every week on Monday' });

    const done = await run({
      since: '2026-09-11',
      reader: {
        changes: [
          { id: 's', removed: false },
          { id: 'b', removed: false },
        ],
        events: { s: series, b: STANDUP },
      },
    });

    expect(done.files.writeLog.filter((path) => path.endsWith('.md'))).toEqual([`${ROOT}/2024-01-08/Weekly sync.md`]);
  });

  it('a dry run reads the delta, says how many events it would write, and writes nothing at all', async () => {
    const done = await run({ dryRun: true });

    expect(done.summary).toEqual({ converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 2 });
    expect(done.files.writeLog).toHaveLength(0);
    expect(done.reader.calls.filter((call) => call.startsWith('event:'))).toHaveLength(0);
  });

  it('a delta that cannot be read ends the run naming the step', async () => {
    const done = await run({ reader: { failDelta: { kind: 'auth', message: 'sign-in has lapsed' } } });

    expect(done.ok).toBe(false);
    expect(done.error).toEqual({ step: 'eventsDelta', cause: 'auth', message: 'sign-in has lapsed' });
  });

  it('a state file this version cannot read is started over, and a run that found nothing still stamps its own', async () => {
    const restarted = await run({ files: { texts: { [STATE_PATH]: '{"version":99,"source":{"kind":"calendar","id":"calendar","name":"Calendar"}}' } } });
    expect(restarted.summary.converted).toBe(2);
    expect(restarted.logger.calls).toContainEqual({ level: 'warn', event: 'calendar-state.unreadable', meta: { cause: 'state is version 99, not 1' } });

    const garbled = await run({ files: { texts: { [STATE_PATH]: 'not json at all' } } });
    expect(garbled.summary.converted).toBe(2);

    const idle = await run({ reader: { changes: [] } });
    expect(idle.summary.converted).toBe(0);
    expect(stateOf(idle.files).lastRun).toBe('2026-09-12T14:00:00Z');
  });

  it('a state file that cannot be saved stops the run, whether or not there was anything to write', async () => {
    const busy = await run({ files: { failWritesMatching: '.sync-state.json' } });
    expect(busy.ok).toBe(false);
    expect(busy.error?.step).toBe('saveState');

    const idle = await run({ reader: { changes: [] }, files: { failWritesMatching: '.sync-state.json' } });
    expect(idle.ok).toBe(false);
    expect(idle.error?.step).toBe('saveState');
  });

  it('the log names events by id and counts, never by subject, attendee or body', async () => {
    const done = await run({ reader: { failEvents: ['a'] } });

    const logged = JSON.stringify(done.logger.calls);
    expect(logged).not.toContain('Offsite');
    expect(logged).not.toContain('Jane');
    expect(logged).not.toContain('example.com');
  });
});

describe('telling the reader which event is being written', () => {
  it('the counter names each event by its subject, one with none as such, and one it could not read as that', async () => {
    const untitled = event('c', '', '2026-09-11T09:00:00Z');
    const done = await run({
      reader: {
        changes: [
          { id: 'a', removed: false },
          { id: 'b', removed: false },
          { id: 'c', removed: false },
          { id: 'x', removed: false },
        ],
        events: { a: OFFSITE, b: STANDUP, c: untitled },
      },
    });

    expect([...done.progress.steps].sort((left, right) => left.localeCompare(right))).toEqual(['(no subject)', 'an event that could not be read', 'Offsite planning', 'Standup']);
  });
});

// Graph's ids open on the same long run for every attachment an event carries: the mailbox, then
// the event itself. Only the last characters differ. Synthetic, laid out the way Graph lays them.
const GRAPH_PREFIX = 'AAMkADFkNGMyZjdlLTViOGEtNGMzZC05ZTZmLTJhN2I4YzlkMGUxZgBGAAAAAACwcvLpCwN7fRwWojnDQijDaUNxbMFh4btl8KY62myHchIAEA';

const agenda = (tail: string): EventAttachment => ({
  id: `${GRAPH_PREFIX}${tail}`,
  name: 'Agenda.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 4096,
});

const FIRST = agenda('Cnk3tkuMqljwNyG7a6z1x4');
const SECOND = agenda('AWNnqstnpKAXyNqKuVaCzL');
const THIRD = agenda('Cx6ZMkUFvTLaDh-F3PXhmg');

const ATTACHED = `${ROOT}/2026-09-12/Offsite planning.attachments/`;

// How many files in the event's attachment folder hold each attachment's text: one each means every
// attachment landed in a file of its own and none was written over.
const filesHolding = (files: FilesFake, attachments: ReadonlyArray<EventAttachment>): ReadonlyArray<number> => {
  const texts = [...files.written].filter(([path]) => path.startsWith(ATTACHED)).map(([, text]) => text);
  return attachments.map(({ id }) => texts.filter((text) => text.includes(`text of ${id}`)).length);
};

describe('naming the files an event carries', () => {
  it('three attachments named alike on one event land as three files, none written over another', async () => {
    const done = await run({ reader: { attachments: { a: [FIRST, SECOND, THIRD] } } });

    expect(filesHolding(done.files, [FIRST, SECOND, THIRD])).toEqual([1, 1, 1]);
  });

  // The lookalike's name is read off a first run rather than worked out here, so it is the name the
  // namesake really takes, whatever the suffix is made of.
  it('an attachment named the way its namesake would be suffixed keeps its file, and the namesake lands in another', async () => {
    const probe = await run({ reader: { attachments: { a: [FIRST, SECOND] } } });
    const suffixed = basename(stateOf(probe.files).events['a']?.outputs.at(-1) ?? '', '.md');
    const lookalike = { ...THIRD, name: suffixed };

    const done = await run({ reader: { attachments: { a: [FIRST, lookalike, SECOND] } } });

    expect(suffixed).toStartWith('Agenda.docx-');
    expect(filesHolding(done.files, [FIRST, lookalike, SECOND])).toEqual([1, 1, 1]);
  });

  it('an attachment taken off the event goes to the archive, and a namesake listed after it keeps its file', async () => {
    const before = await run({ reader: { attachments: { a: [FIRST, SECOND, THIRD] } } });
    const [eventFile = '', firstFile = '', secondFile = '', thirdFile = ''] = stateOf(before.files).events['a']?.outputs ?? [];

    const after = await run({
      reader: { changes: [{ id: 'a', removed: false }], events: { a: { ...OFFSITE, lastModified: '2026-09-13T08:00:00Z' } }, attachments: { a: [FIRST, THIRD] } },
      files: { texts: { [STATE_PATH]: before.files.written.get(STATE_PATH) ?? '' } },
    });

    expect(after.files.moves.map(({ from }) => from)).toStrictEqual([secondFile]);
    expect(stateOf(after.files).events['a']?.outputs).toStrictEqual([eventFile, firstFile, thirdFile]);
  });
});
