import type { Attendee, CalendarEvent } from './calendar-event.ts';
import { renderFrontMatter, withFrontMatter, withoutFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { htmlToText } from './html-text.ts';
import { isCalendar, renderCalendar } from './icalendar.ts';
import { joinLine, withoutJoinBlocks } from './join-block.ts';
import { NO_TEXT_NOTE } from './kb-document.ts';
import { linkDestination } from './markdown-link.ts';
import { unwrapSafelinks } from './safelink.ts';
import { dayIn, timeIn } from './zoned-day.ts';

export type EventAttachmentLink = { readonly name: string; readonly file: string };

// Another note of the calendar, by the words its link reads as and its path from this note's folder.
export type EventLink = { readonly name: string; readonly file: string };

export type RenderEventInput = {
  readonly event: CalendarEvent;
  // The zone the calendar is read in, which is the zone the meeting was accepted in.
  readonly zone: string;
  readonly attachments: ReadonlyArray<EventAttachmentLink>;
  readonly syncedAt: string;
  // The note of the series an exception belongs to, and the notes of a series' exceptions.
  readonly series?: EventLink;
  readonly exceptions?: ReadonlyArray<EventLink>;
};

// Graph's answer words, said the way a person says them.
const ANSWERS: Readonly<Record<string, string>> = {
  accepted: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
  organizer: 'organizer',
  none: 'no answer',
  notResponded: 'no answer',
};

const answerOf = (attendee: Attendee): string =>
  [attendee.required ? '' : 'optional', ANSWERS[attendee.response] ?? attendee.response].filter((part) => part.length > 0).join(', ');

const attendeeLine = (attendee: Attendee): string => `${attendee.name} (${answerOf(attendee)})`;

const stated = (value: string): string | undefined => (value.length > 0 ? value : undefined);

// An all-day event is a day, not a moment, so it is given as one; anything else is the clock in
// the calendar's own zone, the way the mailbox heads a message.
const whenOf = (event: CalendarEvent, instant: string, zone: string): string => (event.allDay ? dayIn(instant, zone) : timeIn(instant, zone));

const fieldsOf = (input: RenderEventInput): ReadonlyArray<FrontMatterField> => [
  ['source', input.event.webLink.length > 0 ? input.event.webLink : 'Outlook calendar'],
  ['subject', input.event.subject],
  ['start', whenOf(input.event, input.event.start, input.zone)],
  ['end', whenOf(input.event, input.event.end, input.zone)],
  // The zone the two times above are told in, so they read the same from any other zone.
  ['timezone', input.zone],
  ['all_day', input.event.allDay ? true : undefined],
  ['organizer', input.event.organizer?.name],
  ['attendees', input.event.attendees.map(attendeeLine)],
  ['location', stated(input.event.location)],
  ['online_meeting', stated(input.event.joinUrl)],
  ['recurrence', stated(input.event.recurrence)],
  ['cancelled', input.event.cancelled ? true : undefined],
  ['my_response', stated(input.event.response)],
  ['categories', input.event.categories],
  ['last_modified', stated(input.event.lastModified)],
  ['synced_at', input.syncedAt],
];

const attachmentLine = (attachment: EventAttachmentLink): string => `- [${attachment.name}](${linkDestination(attachment.file)})`;

const linkLine = (link: EventLink): string => `- [${link.name}](${linkDestination(link.file)})`;

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => (lines.length === 0 ? [] : ['', `## ${heading}`, '', ...lines]);

// A series and its exceptions are one meeting: an exception says which series it is part of.
const seriesLine = (series: EventLink | undefined): ReadonlyArray<string> =>
  series === undefined ? [] : ['', `Part of the series [${series.name}](${linkDestination(series.file)}).`];

// An event with no subject is headed by its id, the same name its file gets.
const titleOf = (event: CalendarEvent): string => (event.subject.length > 0 ? event.subject : `event ${event.id}`);

// Outlook wraps each link of an invitation in a scanner of its own, as it does in mail, and the
// wrapper comes off the same way. The join block goes. Graph gives the link to join of a Teams or a
// Skype meeting, and `online_meeting:` holds it. A block with any other link (a Zoom or Meet meeting,
// a Teams block pasted into an appointment, a second meeting's block) leaves that link on one line.
const bodyOf = (input: RenderEventInput): string => {
  const said = withoutJoinBlocks(unwrapSafelinks(htmlToText(input.event.body)), (joinUrl) => (joinUrl === input.event.joinUrl ? '' : joinLine(joinUrl)));
  return [
    `# ${titleOf(input.event)}`,
    ...seriesLine(input.series),
    ...(said.length === 0 ? [] : ['', said]),
    ...section('Exceptions', (input.exceptions ?? []).map(linkLine)),
    ...section('Attachments', input.attachments.map(attachmentLine)),
  ].join('\n');
};

export const renderEventDocument = (input: RenderEventInput): string => withFrontMatter(renderFrontMatter(fieldsOf(input)), bodyOf(input));

export type RenderEventAttachmentInput = {
  readonly event: CalendarEvent;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  // The library's conversion, which opens with a stamp of its own when asked for metadata; that
  // stamp is dropped here so the document carries one, this one.
  readonly text: string;
  readonly syncedAt: string;
};

const attachmentFields = (input: RenderEventAttachmentInput): ReadonlyArray<FrontMatterField> => [
  ['source', input.event.webLink.length > 0 ? input.event.webLink : 'Outlook calendar'],
  ['event', input.event.subject],
  ['name', input.name],
  ['content_type', stated(input.contentType)],
  ['size', input.size],
  ['synced_at', input.syncedAt],
];

// An invitation an event carried is read, as one a mail carried is: the library passes an `.ics`
// through as text, a timezone block, vendor properties and the body again in HTML, around a handful
// of fields worth keeping. A calendar file that holds no meeting says so, as the mail side does.
const invitationOf = (text: string): string => {
  const read = renderCalendar(text);
  return read.length === 0 ? NO_TEXT_NOTE : read;
};

const saidBy = (text: string): string => (isCalendar(text) ? invitationOf(text) : text);

export const renderEventAttachment = (input: RenderEventAttachmentInput): string =>
  withFrontMatter(renderFrontMatter(attachmentFields(input)), unwrapSafelinks(saidBy(withoutFrontMatter(input.text))));
