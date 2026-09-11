import type { Attendee, CalendarEvent } from './calendar-event.ts';
import { renderFrontMatter, withFrontMatter, withoutFrontMatter } from './front-matter.ts';
import type { FrontMatterField } from './front-matter.ts';
import { htmlToText } from './html-text.ts';
import { linkDestination } from './markdown-link.ts';
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

const bodyOf = (input: RenderEventInput): string => {
  const said = htmlToText(input.event.body);
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

export const renderEventAttachment = (input: RenderEventAttachmentInput): string => withFrontMatter(renderFrontMatter(attachmentFields(input)), withoutFrontMatter(input.text));
