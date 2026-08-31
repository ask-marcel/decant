import { describe, expect, it } from 'bun:test';
import { isCalendar, renderCalendar } from './icalendar.ts';

// An Outlook invitation, trimmed to the shapes that matter: a timezone block of rules nobody reads,
// a description repeating the mail it rode in on, parameters on half the properties, and one folded
// line, which is how iCalendar wraps anything past 75 characters.
const INVITE = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Nina Alder:mailto:nina@example.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;CN=Vincent Delacourt:mailto:vincent@exa',
  ' mple.com',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;CN=Lim Wei Ming:mailto:lim@example.com',
  'DESCRIPTION:Everything the mail already said\\, at length',
  'SUMMARY;LANGUAGE=en-GB:smartRoute x Fabrikam',
  'DTSTART;TZID=W. Europe Standard Time:20260812T080000',
  'DTEND;TZID=W. Europe Standard Time:20260812T090000',
  'LOCATION;LANGUAGE=en-GB:Microsoft Teams Meeting',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('telling an invitation from anything else', () => {
  it('a calendar file says so on its first line', () => {
    expect(isCalendar(INVITE)).toBe(true);
  });

  it('a document that merely mentions a meeting is not one', () => {
    expect(isCalendar('We should put a VCALENDAR in the mail.')).toBe(false);
  });
});

describe('reading a meeting invitation', () => {
  it('is the meeting and nothing else: the timezone rules, the vendor properties and the description all go', () => {
    expect(renderCalendar(INVITE)).toBe(
      [
        '## smartRoute x Fabrikam',
        '',
        '- **When:** 2026-08-12 08:00 (W. Europe Standard Time) to 09:00',
        '- **Where:** Microsoft Teams Meeting',
        '- **Organiser:** Nina Alder',
        '- **Attendees:** Vincent Delacourt, Lim Wei Ming',
      ].join('\n')
    );
  });

  it('a cancellation reads as one rather than as another meeting', () => {
    expect(renderCalendar(INVITE.replace('METHOD:REQUEST', 'METHOD:CANCEL'))).toContain('- **Status:** cancelled');
  });

  it('a meeting that repeats says how often, semicolons in the rule and all', () => {
    const weekly = INVITE.replace('END:VEVENT', 'RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT');

    expect(renderCalendar(weekly)).toContain('- **Repeats:** FREQ=WEEKLY;BYDAY=MO');
  });

  it('a time given in UTC says so rather than naming a zone it does not have', () => {
    const utc = INVITE.replace('DTSTART;TZID=W. Europe Standard Time:20260812T080000', 'DTSTART:20260812T060000Z');

    expect(renderCalendar(utc)).toContain('- **When:** 2026-08-12 06:00 (UTC) to 09:00 (W. Europe Standard Time)');
  });

  it('a meeting ending on another day says which day it ends', () => {
    const overnight = INVITE.replace('DTEND;TZID=W. Europe Standard Time:20260812T090000', 'DTEND;TZID=W. Europe Standard Time:20260813T090000');

    expect(renderCalendar(overnight)).toContain('- **When:** 2026-08-12 08:00 (W. Europe Standard Time) to 2026-08-13 09:00');
  });

  it('a meeting with no end says only when it starts', () => {
    const open = INVITE.replace('DTEND;TZID=W. Europe Standard Time:20260812T090000\r\n', '');

    expect(renderCalendar(open)).toContain('- **When:** 2026-08-12 08:00 (W. Europe Standard Time)\n');
  });

  it('a date the invitation writes in no shape we know is shown exactly as it wrote it', () => {
    const odd = INVITE.replace('DTSTART;TZID=W. Europe Standard Time:20260812T080000', 'DTSTART;VALUE=DATE:20260812');

    expect(renderCalendar(odd)).toContain('- **When:** 20260812 to 2026-08-12 09:00 (W. Europe Standard Time)');
  });

  it('someone the invitation names only by address is named by it', () => {
    const bare = INVITE.replace('ATTENDEE;ROLE=OPT-PARTICIPANT;CN=Lim Wei Ming:mailto:lim@example.com', 'ATTENDEE;ROLE=OPT-PARTICIPANT:MAILTO:lim@example.com');

    expect(renderCalendar(bare)).toContain('- **Attendees:** Vincent Delacourt, lim@example.com');
  });

  it('a line continued after a tab is joined like any other', () => {
    const tabbed = INVITE.replace('SUMMARY;LANGUAGE=en-GB:smartRoute x Fabrikam', 'SUMMARY:smartRoute x\r\n\t Fabrikam');

    expect(renderCalendar(tabbed)).toContain('## smartRoute x Fabrikam');
  });

  it('an escaped comma is read as the comma it stands for, and an escaped break as a break', () => {
    const escaped = INVITE.replace('LOCATION;LANGUAGE=en-GB:Microsoft Teams Meeting', 'LOCATION:Fabrikam\\, Neckarsulm\\nRoom 2');

    expect(renderCalendar(escaped)).toContain('- **Where:** Fabrikam, Neckarsulm\nRoom 2');
  });

  it('a meeting with nothing but a name is still a record', () => {
    expect(renderCalendar('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Retro\r\nEND:VEVENT\r\nEND:VCALENDAR')).toBe('## Retro\n');
  });

  it('a meeting the invitation does not even name is still a record', () => {
    expect(renderCalendar('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nLOCATION:Teams\r\nEND:VEVENT\r\nEND:VCALENDAR')).toBe('## Meeting\n\n- **Where:** Teams');
  });

  it('an exported calendar of two meetings renders both, in the order it holds them', () => {
    const second = ['BEGIN:VEVENT', 'SUMMARY:Retro', 'DTSTART:20260813T090000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const rendered = renderCalendar(INVITE.replace('END:VCALENDAR', second));

    expect(rendered.indexOf('## smartRoute x Fabrikam')).toBeLessThan(rendered.indexOf('## Retro'));
    expect(rendered).toContain('\n\n## Retro');
  });

  it('a property named in lower case is the property it names', () => {
    const shouty = INVITE.replace('SUMMARY;LANGUAGE=en-GB:smartRoute x Fabrikam', 'summary;language=en-GB:smartRoute x Fabrikam');

    expect(renderCalendar(shouty)).toContain('## smartRoute x Fabrikam');
  });

  it('a parameter named in lower case is read too, zones being where that shows', () => {
    const lower = INVITE.replace('DTSTART;TZID=W. Europe Standard Time:', 'DTSTART;tzid=W. Europe Standard Time:');

    expect(renderCalendar(lower)).toContain('- **When:** 2026-08-12 08:00 (W. Europe Standard Time) to 09:00');
  });

  it('a line carrying no colon at all is passed over rather than read as a property', () => {
    const noise = INVITE.replace('BEGIN:VEVENT\r\n', 'BEGIN:VEVENT\r\nGARBAGE\r\n');

    expect(renderCalendar(noise)).toContain('## smartRoute x Fabrikam');
  });

  it('a property with an empty name is passed over as well', () => {
    const empty = INVITE.replace('BEGIN:VEVENT\r\n', 'BEGIN:VEVENT\r\n:orphan\r\n');

    expect(renderCalendar(empty)).toContain('## smartRoute x Fabrikam');
  });

  it('an escaped backslash is read as the one backslash it stands for', () => {
    const escaped = INVITE.replace('LOCATION;LANGUAGE=en-GB:Microsoft Teams Meeting', 'LOCATION:Room A\\\\B');

    expect(renderCalendar(escaped)).toContain('- **Where:** Room A\\B');
  });

  it('a time whose date is not eight digits is shown as it was written', () => {
    const odd = INVITE.replace('DTSTART;TZID=W. Europe Standard Time:20260812T080000', 'DTSTART;TZID=W. Europe Standard Time:2026812T080000');

    expect(renderCalendar(odd)).toContain('- **When:** 2026812T080000 (W. Europe Standard Time) to 2026-08-12 09:00');
  });

  it('a calendar opening after a blank line is still a calendar', () => {
    expect(isCalendar('\r\n\r\nBEGIN:VCALENDAR')).toBe(true);
  });

  it('a file holding no meeting at all renders nothing', () => {
    expect(renderCalendar('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBe('');
  });
});
