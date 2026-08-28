// A meeting invitation, read down to the handful of fields worth keeping. The rest of an Outlook
// `.ics` is a timezone block of daylight-saving rules, vendor `X-` properties, and a description
// repeating the mail it rode in on, none of which a reader of the knowledge base has any use for.
// No timezone arithmetic happens here: there is no zone database to do it with, so a time is shown
// exactly as the invitation states it, the zone it names included.

export const isCalendar = (text: string): boolean => text.trimStart().startsWith('BEGIN:VCALENDAR');

// iCalendar wraps anything past 75 octets, continuing it on a line that opens with a space or a tab.
const unfold = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).reduce<string[]>((lines, line) => {
    const previous = lines[lines.length - 1];
    const continues = (line.startsWith(' ') || line.startsWith('\t')) && previous !== undefined;
    if (continues) lines[lines.length - 1] = `${previous ?? ''}${line.slice(1)}`;
    if (!continues) lines.push(line);
    return lines;
  }, []);

type Property = { readonly name: string; readonly params: string; readonly value: string };

const unescape = (value: string): string => value.replace(/\\([nN,;\\])/g, (_, char: string) => (char.toLowerCase() === 'n' ? '\n' : char));

// A property is `NAME;PARAM=VALUE:the value`, and the first colon ends the head however many
// parameters carried one of their own before it.
const propertyOf = (line: string): Property | undefined => {
  const colon = line.indexOf(':');
  if (colon <= 0) return undefined;
  const head = line.slice(0, colon);
  const semicolon = head.indexOf(';');
  const name = semicolon === -1 ? head : head.slice(0, semicolon);
  return { name: name.toUpperCase(), params: semicolon === -1 ? '' : head.slice(semicolon + 1), value: unescape(line.slice(colon + 1)) };
};

const paramOf = (params: string, name: string): string | undefined =>
  params.split(';').flatMap((pair) => (pair.toUpperCase().startsWith(`${name}=`) ? [pair.slice(name.length + 1)] : []))[0];

// A person is named by their common name where the invitation gives one, and by their address
// otherwise, which is all a `mailto:` holds.
const personOf = (property: Property): string => paramOf(property.params, 'CN') ?? property.value.replace(/^mailto:/i, '');

type Stamp = { readonly date: string; readonly time: string; readonly zone?: string };

const STAMP = /^\d{8}T\d{6}/;

const stampOf = (property: Property): Stamp => {
  const raw = property.value;
  const zone = raw.endsWith('Z') ? 'UTC' : paramOf(property.params, 'TZID');
  if (!STAMP.test(raw)) return { date: raw, time: '', zone };
  return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, time: `${raw.slice(9, 11)}:${raw.slice(11, 13)}`, zone };
};

const withZone = (when: string, zone: string | undefined): string => (zone === undefined ? when : `${when} (${zone})`);

// The end repeats neither the day nor the zone the start already gave: a meeting almost always ends
// on the day it began, and a range saying the same zone twice reads as two different ones.
const tailOf = (from: Stamp, to: Stamp): string => withZone(to.date === from.date ? to.time : `${to.date} ${to.time}`.trim(), to.zone === from.zone ? undefined : to.zone);

const whenOf = (from: Stamp | undefined, to: Stamp | undefined): string | undefined => {
  if (from === undefined) return undefined;
  const opened = withZone(`${from.date} ${from.time}`.trim(), from.zone);
  return to === undefined ? opened : `${opened} to ${tailOf(from, to)}`;
};

const eventsOf = (lines: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<Property>> => {
  const events: Property[][] = [];
  let open: Property[] | undefined;
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      open = [];
      events.push(open);
    }
    if (line.startsWith('END:VEVENT')) open = undefined;
    const property = open === undefined ? undefined : propertyOf(line);
    if (open !== undefined && property !== undefined) open.push(property);
  }
  return events;
};

const firstOf = (properties: ReadonlyArray<Property>, name: string): Property | undefined => properties.find((property) => property.name === name);

const row = (label: string, value: string | undefined): ReadonlyArray<string> => (value === undefined || value.length === 0 ? [] : [`- **${label}:** ${value}`]);

const stampFor = (properties: ReadonlyArray<Property>, name: string): Stamp | undefined => {
  const found = firstOf(properties, name);
  return found === undefined ? undefined : stampOf(found);
};

const renderEvent = (properties: ReadonlyArray<Property>, method: string | undefined): string => {
  const attendees = properties.filter((property) => property.name === 'ATTENDEE').map(personOf);
  const organiser = firstOf(properties, 'ORGANIZER');
  const rows = [
    ...row('When', whenOf(stampFor(properties, 'DTSTART'), stampFor(properties, 'DTEND'))),
    ...row('Where', firstOf(properties, 'LOCATION')?.value),
    ...row('Organiser', organiser === undefined ? undefined : personOf(organiser)),
    ...row('Attendees', attendees.join(', ')),
    ...row('Repeats', firstOf(properties, 'RRULE')?.value),
    ...row('Status', method === 'CANCEL' ? 'cancelled' : undefined),
  ];
  return [`## ${firstOf(properties, 'SUMMARY')?.value ?? 'Meeting'}`, '', ...rows].join('\n');
};

export const renderCalendar = (text: string): string => {
  const lines = unfold(text);
  const method = lines.flatMap((line) => (line.startsWith('METHOD:') ? [line.slice('METHOD:'.length).trim()] : []))[0];
  return eventsOf(lines)
    .map((properties) => renderEvent(properties, method))
    .join('\n\n');
};
