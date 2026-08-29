// The day a message belongs to, counted where the mailbox lives rather than where the export runs.
// Every timestamp Graph returns is UTC, so a message received at 2026-06-10T16:40Z is the 11th in a
// UTC+8 tenant: formatting the raw value files the thread under a day it never had. Machine time
// would look right until an export ran from a laptop in another country, and since the day is part
// of a folder name that is never rebuilt, the drift would leave a second folder behind.

// Fixed width on purpose. The day is the leading segment of every thread folder name, so a reader
// and a parser can both take it by position, whether or not the message carried a usable time.
export const UNDATED_DAY = '0000-00-00';

// `en-CA` is the locale that formats as YYYY-MM-DD, which is the shape the folder name wants.
const AS_DAY = 'en-CA';

const PARTS = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;

// Built once. `Intl.supportedValuesOf` allocates a fresh array of some four hundred names on every
// call, and this is asked per message.
const KNOWN_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

// Checked where a run is configured, so a mailbox never starts counting days in a zone that will
// turn out not to exist. A tenant reports its zone in Windows spelling ("China Standard Time")
// unless it is set to IANA, and that spelling is not one of these.
export const isKnownZone = (zone: string): boolean => KNOWN_ZONES.has(zone);

// Total by construction rather than by catching: `Intl` throws a RangeError both on a zone it does
// not know and on a time that is not one, and neither belongs in a domain module. A message with no
// usable timestamp still needs somewhere to go, and a zone that slipped past `isKnownZone` should
// cost a wrong label rather than the whole run.
export const dayIn = (instantIso: string, zone: string): string => {
  const at = Date.parse(instantIso);
  if (Number.isNaN(at)) return UNDATED_DAY;
  return new Intl.DateTimeFormat(AS_DAY, { ...PARTS, timeZone: isKnownZone(zone) ? zone : 'UTC' }).format(at);
};
