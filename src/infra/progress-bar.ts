import type { Progress } from '../use-cases/ports/progress.ts';

// `\r` returns the cursor to the start of the line and `\x1b[K` clears to its end, so each write
// rewrites the same line rather than stacking up. The writer is injected: production hands it
// stderr, a test hands it an array. Nothing is written when there is nothing to count, so a run that
// converts everything from cache stays silent.
export const createProgressBar = (write: (text: string) => void): Progress => {
  let total = 0;
  let done = 0;
  let what = '';
  return {
    start: (count, label) => {
      total = count;
      done = 0;
      what = label;
    },
    step: (label) => {
      done += 1;
      if (total > 0) write(`\r\x1b[K${what} ${done}/${total}  ${label}`);
    },
    done: () => {
      if (total > 0 && done > 0) write('\n');
    },
  };
};

// Chosen when the run has no terminal to draw on (output piped to a file, a scheduled `update`): the
// counter would only litter the log, so every call does nothing.
export const createNoProgress = (): Progress => ({
  start: () => undefined,
  step: () => undefined,
  done: () => undefined,
});

// What the real command wires in: a moving counter on stderr when that is a terminal, and silence
// when it is not, so a piped or headless run stays clean. The platform read lives here, in infra,
// rather than in the composition root.
export const createStderrProgress = (): Progress => (process.stderr.isTTY ? createProgressBar((text) => process.stderr.write(text)) : createNoProgress());
