import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { parseJson } from './utilities/parse-json.ts';

// How far back a run reaches: everything, or what happened on or after one day. Asked once, on the
// first run that has work to do, and kept beside the knowledge base, so every run after reaches back
// to the same place without anyone repeating it; `--since` is the one way to move it.
export const ALL = 'all';

// What a person is told a reach looks like, wherever they typed one that is not.
export const SINCE_SHAPE = 'a day like 2026-01-31, or all';

export type SinceError = { readonly kind: 'bad-since' };

// A real day, not only its shape: 2025-02-30 has the shape and names no day. Read back through the
// date it parses to, so a day the calendar does not have, a month past twelve, or a moment rather
// than a day all come back as something other than what was typed.
const isDay = (text: string): boolean => {
  const at = Date.parse(text);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === text;
};

export const parseSince = (text: string): Result<string, SinceError> => {
  const since = text.toLowerCase();
  return since === ALL || isDay(since) ? ok(since) : err({ kind: 'bad-since' });
};

// The day a source is handed, or none for everything: the shape each source takes its window in. No
// reach named at all is everything too.
export const dayOf = (since: string | undefined): string | undefined => (since === ALL ? undefined : since);

// Whether something last touched at `moment` falls before the day. Compared as text, which is exact
// for Graph's UTC timestamps: `2024-12-31T23:59:59Z` sorts before `2025-01-01` and
// `2025-01-01T00:00:00Z` after it, so the day is counted in UTC, as the mailbox always counted it.
// No day reaches everything, and nothing sorts before the empty string; neither does a thing with no
// time at all, which is kept, since nothing says it is old.
export const isBefore = (moment: string, day: string | undefined): boolean => moment !== '' && moment < (day ?? '');

// Whether a run reaching back to `day` reaches further than the one a cursor was taken under. A
// delta reports only what changed after its cursor, so what a narrower run passed over never comes
// back through it: the cursor is dropped and the source read again from the start. A cursor with no
// day recorded was taken reaching everything, which nothing can widen.
export const widens = (recorded: string | undefined, day: string | undefined): boolean => recorded !== undefined && (day === undefined || day < recorded);

// What a cursor read out and a whole read say together: one entry per id, the whole read's where both
// have it, since it is the later of the two. What only the cursor saw, a deletion, stays.
export const latestById = <T extends { readonly id: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> => [...new Map(items.map((item) => [item.id, item])).values()];

export const serializeSettings = (since: string): string => `${JSON.stringify({ since }, undefined, 2)}\n`;

// Refused rather than read as everything: a day mistyped by hand would otherwise sync the whole
// history on the next `update`, which is the one thing the day was set to stop.
export const parseSettings = (text: string): Result<string, SinceError> => {
  const raw = parseJson(text);
  const since = raw.ok && typeof raw.value === 'object' && raw.value !== null && 'since' in raw.value ? raw.value.since : undefined;
  return typeof since === 'string' ? parseSince(since) : err({ kind: 'bad-since' });
};
