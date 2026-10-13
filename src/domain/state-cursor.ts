import { parseJson } from './utilities/parse-json.ts';

// What a sync records changes only when the source does, except for two things that change on every
// run: when it ran, and the delta cursors Graph hands back. Kept in the same file, they rewrote it on
// every run, and a copy of the knowledge base (a backup, git, OneDrive) saw a change each time.
// They are kept apart, in a file beside the state, by name wherever they sit in it.
const MOVING_KEYS: ReadonlySet<string> = new Set(['lastRun', 'deltaLink']);

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export type SplitState = { readonly state: unknown; readonly cursor: Json };

// Lists are left whole: what is queued or held in one is a record of the source, not a cursor.
export const splitCursor = (raw: unknown): SplitState => {
  if (!isRecord(raw)) return { state: raw, cursor: {} };
  const state: Record<string, unknown> = {};
  const cursor: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MOVING_KEYS.has(key)) {
      cursor[key] = value;
      continue;
    }
    const inner = splitCursor(value);
    state[key] = inner.state;
    if (Object.keys(inner.cursor).length > 0) cursor[key] = inner.cursor;
  }
  return { state, cursor };
};

// Put back only where the state still holds the record a cursor was taken with. A cursor says what
// changed after it, so one beside a record the state lost would hide everything from before it.
export const mergeCursor = (state: unknown, cursor: unknown): unknown => {
  if (!isRecord(state) || !isRecord(cursor)) return state;
  const merged: Record<string, unknown> = { ...state };
  for (const [key, value] of Object.entries(cursor)) {
    if (MOVING_KEYS.has(key)) merged[key] = value;
    else if (isRecord(merged[key])) merged[key] = mergeCursor(merged[key], value);
  }
  return merged;
};

const stateHash = (stateText: string): string => new Bun.CryptoHasher('sha256').update(stateText).digest('hex');

// The cursor is saved with a hash of the state text it belongs to.
export const serializeCursor = (stateText: string, cursor: Json): string => `${JSON.stringify({ state: stateHash(stateText), cursor }, undefined, 2)}\n`;

// Read back only beside the state it was saved with. A state put back from a backup or from git is
// older than the cursor beside it, and a delta read on from that cursor would miss what changed in
// between. Such a cursor is none, and the source is read whole once.
export const cursorFor = (stateText: string, cursorText: string): Json | undefined => {
  const saved = parseJson(cursorText);
  if (!saved.ok || !isRecord(saved.value) || saved.value['state'] !== stateHash(stateText)) return undefined;
  const cursor = saved.value['cursor'];
  return isRecord(cursor) ? cursor : undefined;
};
