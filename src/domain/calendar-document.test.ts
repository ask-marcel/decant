import { describe, expect, it } from 'bun:test';
import { renderEventAttachment, renderEventDocument } from './calendar-document.ts';
import type { RenderEventInput } from './calendar-document.ts';
import type { CalendarEvent } from './calendar-event.ts';
import { NO_TEXT_NOTE } from './kb-document.ts';

const event: CalendarEvent = {
  id: 'AAMkAGI-event',
  subject: 'Offsite planning',
  kind: 'singleInstance',
  start: '2026-09-12T07:00:00Z',
  end: '2026-09-12T08:30:00Z',
  allDay: false,
  cancelled: false,
  organizer: { name: 'Valerie', address: 'me@example.com' },
  attendees: [
    { name: 'Jane Doe', address: 'jane@example.com', response: 'accepted', required: true },
    { name: 'Dana Farrow', address: 'dana@example.com', response: 'none', required: false },
    { name: 'Ann Lee', address: 'ann@example.com', response: 'tentativelyAccepted', required: true },
  ],
  location: 'Rotterdam, Room 3',
  joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
  webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAGI-event',
  recurrence: '',
  response: 'accepted',
  categories: ['Board'],
  hasAttachments: true,
  lastModified: '2026-09-10T15:30:00Z',
  body: '<div><p>Agenda:</p><ul><li>Venue</li><li>Budget</li></ul></div>',
};

const SAFELINK = 'https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fagenda&data=05%7C02%7Cx&reserved=0';

const rendered = (subject: CalendarEvent, attachments: ReadonlyArray<{ name: string; file: string }> = []): string =>
  renderEventDocument({ event: subject, zone: 'Asia/Shanghai', attachments, syncedAt: '2026-09-11T14:00:00Z' });

describe('writing one calendar event as a document', () => {
  it('an event opens with when, where, who and how to join, told in the zone the calendar lives in, then says what it is about', () => {
    expect(rendered(event, [{ name: 'Venues.xlsx', file: 'Offsite planning.attachments/Venues.xlsx.md' }])).toBe(
      [
        '---',
        'source: https://outlook.office365.com/owa/?itemid=AAMkAGI-event',
        'subject: Offsite planning',
        'start: "2026-09-12 15:00"',
        'end: "2026-09-12 16:30"',
        'timezone: Asia/Shanghai',
        'organizer: Valerie',
        'attendees:',
        '  - Jane Doe (accepted)',
        '  - Dana Farrow (optional, no answer)',
        '  - Ann Lee (tentative)',
        'location: Rotterdam, Room 3',
        'online_meeting: https://teams.microsoft.com/l/meetup-join/abc',
        'my_response: accepted',
        'categories:',
        '  - Board',
        'last_modified: "2026-09-10T15:30:00Z"',
        'synced_at: "2026-09-11T14:00:00Z"',
        '---',
        '',
        '# Offsite planning',
        '',
        'Agenda:',
        '- Venue',
        '- Budget',
        '',
        '## Attachments',
        '',
        '- [Venues.xlsx](<Offsite planning.attachments/Venues.xlsx.md>)',
        '',
      ].join('\n')
    );
  });

  it('a recurring series says its rule, an all-day event says so and gives days rather than times, and a cancelled meeting is marked', () => {
    const series = rendered({
      ...event,
      kind: 'seriesMaster',
      recurrence: 'every week on Monday, from 2026-01-05',
      allDay: true,
      cancelled: true,
      start: '2026-01-05T00:00:00Z',
      end: '2026-01-06T00:00:00Z',
    });

    expect(series).toContain('recurrence: every week on Monday, from 2026-01-05');
    expect(series).toContain('all_day: true');
    expect(series).toContain('start: "2026-01-05"\nend: "2026-01-06"');
    expect(series).toContain('cancelled: true');
  });

  it('an event with no body, no attendees and no attachments says only what it is called, and one with no address says where it came from in words', () => {
    const bare = rendered({ ...event, body: '', attendees: [], webLink: '', organizer: undefined, location: '', joinUrl: '', categories: [], response: '' });

    expect(bare).toContain('source: Outlook calendar');
    expect(bare).not.toContain('attendees:');
    expect(bare).not.toContain('## Attachments');
    expect(bare.endsWith('# Offsite planning\n')).toBe(true);
  });

  // A reference past Unicode in one body threw, and the calendar run stopped with it.
  it('an event whose body holds a character reference past Unicode is written, the reference read as the replacement character', () => {
    expect(rendered({ ...event, body: '<p>Room &#x110000;4</p>' })).toContain('Room \uFFFD4');
  });

  // The link to join is in `online_meeting:`, and the block Teams writes into every invitation says it
  // again among a meeting ID, a passcode, dial-in numbers and help.
  it('the join block of an invitation goes from the body', () => {
    const rule = `<div>${'_'.repeat(80)}</div>`;
    const block = `${rule}<div><span>Microsoft Teams</span> <a href="https://aka.ms/x">Need help?</a></div><div><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div><div>Passcode: aB3cD4</div>${rule}`;
    const written = rendered({ ...event, body: `<p>Bring the figures.</p>${block}` });

    expect(written).toEndWith('# Offsite planning\n\nBring the figures.\n');
    expect(written).not.toContain('Passcode');
    expect(written).not.toContain('Online meeting:');
    expect(written).toContain('online_meeting: https://teams.microsoft.com/l/meetup-join/abc');
  });

  // Graph gives the link to join only for a Teams or a Skype meeting, so the link of any other stays in
  // the body when its block goes.
  it('the link to join a meeting Graph gives no link for stays on one line where its block was', () => {
    const zoom = 'https://us02web.zoom.us/j/12345678901?pwd=abc';
    const block = `<p>Join Zoom Meeting<br><a href="${zoom}">${zoom}</a></p><p>Meeting ID: 123 4567 8901<br>Passcode: 123456</p><p>Find your local number: <a href="https://us02web.zoom.us/u/abc">https://us02web.zoom.us/u/abc</a></p>`;
    const written = rendered({ ...event, joinUrl: '', body: `<p>Agenda below.</p>${block}` });

    expect(written).toContain(`# Offsite planning\n\nAgenda below.\nOnline meeting: ${zoom}`);
    expect(written).not.toContain('Passcode');
    expect(written).not.toContain('online_meeting:');
  });

  // An event Graph gives a Teams link for can carry a second meeting's block too, a Zoom one an add-in
  // wrote: that link is the only one to the second meeting, so it stays where its block was.
  it('the link of a meeting other than the one Graph gives stays on one line where its block was', () => {
    const zoom = 'https://us02web.zoom.us/j/12345678901?pwd=abc';
    const zoomBlock = `<p>Join Zoom Meeting<br><a href="${zoom}">${zoom}</a></p><p>Find your local number: <a href="https://us02web.zoom.us/u/abc">https://us02web.zoom.us/u/abc</a></p>`;
    const rule = `<div>${'_'.repeat(80)}</div>`;
    const teamsBlock = `${rule}<div><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div><div>Meeting ID: 123</div>${rule}`;
    const written = rendered({ ...event, body: `<p>Agenda below.</p>${zoomBlock}${teamsBlock}` });

    expect(written).toContain(`# Offsite planning\n\nAgenda below.\nOnline meeting: ${zoom}\n`);
    expect(written).not.toContain('Online meeting: https://teams.microsoft.com');
  });

  // Outlook wraps each link of an invitation in a scanner of its own, as it does in mail.
  it('a link Outlook wrapped in an event body reads as where it goes', () => {
    const body = '<p>See the <a href="%s">agenda</a></p>'.replace('%s', SAFELINK.replaceAll('&', '&amp;'));

    expect(rendered({ ...event, body })).toContain('See the [agenda](https://example.com/agenda)');
  });

  it('a reference in an event body named for a property of every object, such as &constructor;, stays as it was written', () => {
    expect(rendered({ ...event, body: '<p>Bring &constructor; and &amp; more</p>' })).toContain('Bring &constructor; and & more');
  });
});

// A series and its exceptions are one meeting: each note says where the others are.
describe('the notes of a series and of its exceptions', () => {
  const written = (subject: CalendarEvent, links: Pick<RenderEventInput, 'series' | 'exceptions'>): string =>
    renderEventDocument({
      event: subject,
      zone: 'Asia/Shanghai',
      attachments: [{ name: 'Venues.xlsx', file: 'Offsite planning.attachments/Venues.xlsx.md' }],
      syncedAt: '2026-09-11T14:00:00Z',
      ...links,
    });

  it('an exception names the series it belongs to, under its title', () => {
    const note = written({ ...event, kind: 'exception' }, { series: { name: 'Monthly review', file: '../2026-01-05/Monthly review.md' } });

    expect(note).toContain('# Offsite planning\n\nPart of the series [Monthly review](<../2026-01-05/Monthly review.md>).\n');
  });

  it('a series lists its exceptions, each by a link, before what it carried', () => {
    const exceptions = [
      { name: '2026-03-02 Monthly review', file: '../2026-03-02/Monthly review.md' },
      { name: '2026-06-01 Monthly review', file: '../2026-06-01/Monthly review.md' },
    ];
    const note = written({ ...event, kind: 'seriesMaster' }, { exceptions });

    expect(note).toContain(
      '## Exceptions\n\n- [2026-03-02 Monthly review](<../2026-03-02/Monthly review.md>)\n- [2026-06-01 Monthly review](<../2026-06-01/Monthly review.md>)\n\n## Attachments'
    );
  });

  it('a series with no exception has no heading for them', () => {
    expect(written({ ...event, kind: 'seriesMaster' }, { exceptions: [] })).not.toContain('## Exceptions');
  });
});

describe('writing what an event carried as a document of its own', () => {
  // The library passes an `.ics` through as text: a timezone block, vendor properties and the body
  // again in HTML, around a handful of fields worth keeping.
  it('an invitation an event carried is read for its fields, not kept as raw iCalendar', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'SUMMARY:Budget review',
      'DTSTART;TZID=Europe/Paris:20260915T100000',
      'DTEND;TZID=Europe/Paris:20260915T110000',
      'LOCATION:Room 2',
      'X-ALT-DESC;FMTTYPE=text/html:<p>Hello</p>',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const written = renderEventAttachment({ event, name: 'invite.ics', contentType: 'text/calendar', size: 300, text: ics, syncedAt: '2026-09-11T14:00:00Z' });

    expect(written).toContain('## Budget review');
    expect(written).toContain('- **When:** 2026-09-15 10:00 (Europe/Paris) to 11:00');
    expect(written).not.toContain('BEGIN:VCALENDAR');
    expect(written).not.toContain('<p>');
  });

  // A calendar file can hold a task, a free-busy block or only its time zones, and no meeting.
  it('an invitation an event carried that holds no meeting says that no text could be read', () => {
    const zonesAlone = ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'END:VTIMEZONE', 'END:VCALENDAR'].join('\r\n');
    const written = renderEventAttachment({ event, name: 'zones.ics', contentType: 'text/calendar', size: 90, text: zonesAlone, syncedAt: '2026-09-11T14:00:00Z' });

    expect(written).toContain(NO_TEXT_NOTE);
  });

  it('a link Outlook wrapped in what an attachment says reads as where it goes', () => {
    const written = renderEventAttachment({ event, name: 'Notes.docx', contentType: '', size: 10, text: `See ${SAFELINK} first.`, syncedAt: '2026-09-11T14:00:00Z' });

    expect(written).toContain('See https://example.com/agenda first.');
  });

  it('an attachment opens with what it is and which meeting it came with, then carries the text the library read out of it, its own stamp stripped', () => {
    const written = renderEventAttachment({
      event,
      name: 'Venues.xlsx',
      contentType: 'application/vnd.ms-excel',
      size: 2048,
      text: '---\nname: Venues.xlsx\n---\n\n| Venue | Cost |\n|---|---|\n',
      syncedAt: '2026-09-11T14:00:00Z',
    });

    expect(written).toBe(
      [
        '---',
        'source: https://outlook.office365.com/owa/?itemid=AAMkAGI-event',
        'event: Offsite planning',
        'name: Venues.xlsx',
        'content_type: application/vnd.ms-excel',
        'size: 2048',
        'synced_at: "2026-09-11T14:00:00Z"',
        '---',
        '',
        '| Venue | Cost |',
        '|---|---|',
        '',
      ].join('\n')
    );
  });
});
