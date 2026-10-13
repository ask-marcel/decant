import { ok } from '../domain/result.ts';
import { cursorFor, mergeCursor, serializeCursor, splitCursor } from '../domain/state-cursor.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { STATE_FILE_NAME } from './list-synced-sources.ts';
import type { Files } from './ports/files.ts';

export const CURSOR_FILE_NAME = '.sync-cursor.json';

const isState = (path: string): boolean => path.endsWith(`/${STATE_FILE_NAME}`);

const cursorPathOf = (statePath: string): string => `${statePath.slice(0, -STATE_FILE_NAME.length)}${CURSOR_FILE_NAME}`;

const asText = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

// Every sync saves its state whole, run time and delta cursors in it, and reads it back whole. Put
// between the syncs and the disk, this keeps those two in a file beside the state, so the state
// changes only when the source does. No sync needs to know: each still reads what it saved.
export const withCursorFiles = (files: Files): Files => ({
  ...files,
  readText: async (path) => {
    const text = await files.readText(path);
    if (!text.ok || !isState(path)) return text;
    const state = parseJson(text.value);
    const saved = await files.readText(cursorPathOf(path));
    const cursor = saved.ok ? cursorFor(text.value, saved.value) : undefined;
    return state.ok && cursor !== undefined ? ok(asText(mergeCursor(state.value, cursor))) : text;
  },
  // The state first: a cursor saved beside a state that failed to save would read on past what the
  // state holds. A failed cursor costs one full listing, the next run.
  writeText: async (path, content) => {
    const parsed = isState(path) ? parseJson(content) : undefined;
    if (parsed === undefined || !parsed.ok) return files.writeText(path, content);
    const split = splitCursor(parsed.value);
    const stateText = asText(split.state);
    const written = await files.writeText(path, stateText);
    return written.ok ? files.writeText(cursorPathOf(path), serializeCursor(stateText, split.cursor)) : written;
  },
});
