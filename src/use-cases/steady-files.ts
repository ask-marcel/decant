import { ok } from '../domain/result.ts';
import { sameWrite, withLineFeeds } from '../domain/steady-write.ts';
import type { Files } from './ports/files.ts';

// Put between every sync and the disk. A note is written only when its text changed, not counting
// when it was synced, so it keeps the time of its last real change and a run that found nothing new
// changes no file. Markdown is written with line feeds alone, whatever the source sent.
export const withSteadyWrites = (files: Files): Files => ({
  ...files,
  writeText: async (path, content) => {
    const text = path.endsWith('.md') ? withLineFeeds(content) : content;
    const held = await files.readText(path);
    return held.ok && sameWrite(held.value, text) ? ok(undefined) : files.writeText(path, text);
  },
});
