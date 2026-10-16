import type { Attendee, CalendarEvent } from './calendar-event.ts';
import { renderFrontMatter, withFrontMatter, withoutFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { htmlToText } from './html-text.ts';
import { isCalendar, renderCalendar } from './icalendar.ts';
import { withoutJoinBlocks } from './join-block.ts';
import { NO_TEXT_NOTE } from './kb-document.ts';
import { linkDestination } from './markdown-link.ts';
import { unwrapSafelinks } from './safelink.ts';
import { dayIn, timeIn } from './zoned-day.ts';

export type EventAttachmentLink = { readonly name: string; readonly file: string };

export type RenderEventInput = {
  readonly event: CalendarEvent;
  // The zone the calendar is read in, which is the zone the meeting was accepted in.
  readonly zone: string;
  readonly attachments: ReadonlyArray<EventAttachmentLink>;
  readonly syncedAt: string;
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

// An event with no subject is headed by its id, the same name its file gets.
const titleOf = (event: CalendarEvent): string => (event.subject.length > 0 ? event.subject : `event ${event.id}`);

// Outlook wraps each link of an invitation in a scanner of its own, as it does in mail, and the
// wrapper comes off the same way. The join block goes whole: `online_meeting:` holds the link to join.
const bodyOf = (input: RenderEventInput): string => {
  const said = withoutJoinBlocks(unwrapSafelinks(htmlToText(input.event.body)));
  return [
    `# ${titleOf(input.event)}`,
    ...(said.length === 0 ? [] : ['', said]),
    ...(input.attachments.length === 0 ? [] : ['', '## Attachments', '', ...input.attachments.map(attachmentLine)]),
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
