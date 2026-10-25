import { rootedState, withRoot } from '../domain/kb-root.ts';
import { ok } from '../domain/result.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { STATE_FILE_NAME } from './list-synced-sources.ts';
import type { Files } from './ports/files.ts';

const asText = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

// A file that is the state of a sync in the knowledge base.
const isState = (kbRoot: string, path: string): boolean => path.startsWith(`${kbRoot}/`) && path.endsWith(`/${STATE_FILE_NAME}`);

// Put between the syncs and the disk, this saves each state with the folder of the knowledge base it
// was written in, and reads it back with each path it records in the folder of this run. A copy of the
// knowledge base then follows its own paths, never those of the folder it was copied from. No sync
// needs to know: each still reads what it saved.
export const withKbRoot = (files: Files, kbRoot: string): Files => ({
  ...files,
  readText: async (path) => {
    const text = await files.readText(path);
    if (!text.ok || !isState(kbRoot, path)) return text;
    const state = parseJson(text.value);
    return state.ok ? ok(asText(rootedState(state.value, kbRoot))) : text;
  },
  writeText: async (path, content) => {
    const state = isState(kbRoot, path) ? parseJson(content) : undefined;
    return state === undefined || !state.ok ? files.writeText(path, content) : files.writeText(path, asText(withRoot(state.value, kbRoot)));
  },
});
