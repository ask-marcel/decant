import type { Progress } from '../use-cases/ports/progress.ts';

// `\r` returns the cursor to the start of the line and `\x1b[K` clears to its end, so each write
// rewrites the same line rather than stacking up. The writer is injected: production hands it
// stderr, a test hands it an array. Nothing is written when there is nothing to count, so a run that
// converts everything from cache stays silent.
export const createProgressBar = (write: (text: string) => void): Progress => {
  let total = 0;
  let done = 0;
  let what = '';
  let running = new Set<string>();
  // While anything else is still running, the line names all of it, so a slow item stays visible
  // after its faster window-siblings have each stepped past it. Falls back to the label just passed
  // in when nothing is tracked as running, which is what a bare `step()` call (no `begin()` first)
  // relied on before this port grew a `begin`.
  const render = (label: string): void => {
    if (total === 0) return;
    const current = running.size > 0 ? [...running].join(', ') : label;
    write(`\r\x1b[K${what} ${done}/${total}  ${current}`);
  };
  return {
    start: (count, label) => {
      total = count;
      done = 0;
      what = label;
      running = new Set();
    },
    begin: (label) => {
      running.add(label);
      render(label);
    },
    step: (label) => {
      running.delete(label);
      done += 1;
      render(label);
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
  begin: () => undefined,
  step: () => undefined,
  done: () => undefined,
});

// What the real command wires in: a moving counter on stderr when that is a terminal, and silence
// when it is not, so a piped or headless run stays clean. The platform read lives here, in infra,
// rather than in the composition root.
export const createStderrProgress = (): Progress => (process.stderr.isTTY ? createProgressBar((text) => process.stderr.write(text)) : createNoProgress());
