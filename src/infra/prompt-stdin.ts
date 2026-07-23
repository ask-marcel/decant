import { printLine } from '../presenter/output.ts';
import type { Prompt } from '../use-cases/ports/prompt.ts';

// Where a typed answer comes from. Required rather than defaulted, so the terminal is named at the
// composition root (`() => console`) and the prompt itself can be exercised without one.
export type LineSource = () => AsyncIterable<string>;

export const createStdinPrompt = (lines: LineSource): Prompt => ({
  show: printLine,
  ask: async (question) => {
    process.stdout.write(`${question} `);
    for await (const line of lines()) return line.trim();
    return '';
  },
});
