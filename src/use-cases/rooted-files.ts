import { rootedState, withRoot } from '../domain/kb-root.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { STATE_FILE_NAME } from './list-synced-sources.ts';
import type { Files } from './ports/files.ts';

const asText = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

// The place of a state inside the knowledge base, `Calendar` for `kb/Calendar/.sync-state.json`, or
// none for a file that is not the state of a sync there.
const placeOf = (kbRoot: string, path: string): string | undefined =>
  path.startsWith(`${kbRoot}/`) && path.endsWith(`/${STATE_FILE_NAME}`) ? path.slice(kbRoot.length + 1, -STATE_FILE_NAME.length - 1) : undefined;

// Put between the syncs and the disk, this saves each state with the folder of the knowledge base it
// was written in, and reads it back with each path it records in the folder of this run. A copy of the
// knowledge base then follows its own paths, never those of the folder it was copied from. No sync
// needs to know: each still reads what it saved.
export const withKbRoot = (files: Files, kbRoot: string): Files => ({
  ...files,
  readText: async (path) => {
    const text = await files.readText(path);
    const place = placeOf(kbRoot, path);
    if (!text.ok || place === undefined) return text;
    const state = parseJson(text.value);
    return state.ok ? ok(asText(rootedState(state.value, place, kbRoot))) : text;
  },
  writeText: async (path, content) => {
    const state = placeOf(kbRoot, path) === undefined ? undefined : parseJson(content);
    return state === undefined || !state.ok ? files.writeText(path, content) : files.writeText(path, asText(withRoot(state.value, kbRoot)));
  },
});
