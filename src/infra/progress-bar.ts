import type { Progress } from '../use-cases/ports/progress.ts';

// `\r` returns the cursor to the start of the line and `\x1b[K` clears to its end, so each write
// rewrites the same line rather than stacking up. The writer is injected: production hands it
// stderr, a test hands it an array. Nothing is written when there is nothing to count, so a run that
// converts everything from cache stays silent.
// A width no terminal is narrower than, for when nothing else says.
const DEFAULT_COLUMNS = 80;

export const createProgressBar = (write: (text: string) => void, columns?: () => number): Progress => {
  // The row to fit inside: whatever a caller names, else the terminal's own width, else a width no
  // terminal is narrower than. Read per write rather than once, since a terminal can be resized.
  const width = (): number => columns?.() ?? process.stderr.columns ?? DEFAULT_COLUMNS;
  let total = 0;
  let done = 0;
  let what = '';
  let running = new Set<string>();
  // Names the oldest still-running item, never a joined list: several real paths joined with ", "
  // routinely outgrow one terminal row, and `\r\x1b[K` only clears the row the cursor sits on, so a
  // wrapped write leaves the previous row's tail on screen and the display garbles. The oldest entry
  // is also the one actually worth naming, it is the straggler holding the window back. Falls back to
  // the label just passed in when nothing is tracked as running, which is what a bare `step()` call
  // (no `begin()` first) relied on before this port grew a `begin`.
  // The tail is cut, never the head: `what` names the source, which is the part a path cannot tell
  // you, and one run of `all` works through twenty-odd of them. A line wider than the row wraps, and
  // `\r\x1b[K` clears only the row the cursor sits on, so the wrapped remainder stays on screen and
  // the display garbles. Cut by code point, so a character is never left half-written.
  const fit = (line: string): string => {
    const shown = [...line];
    // One column short of the row, never the whole row. Filling the last column leaves the cursor in
    // a deferred-wrap state, and the `\r` that follows then returns to the start of the NEXT row, so
    // the line stacks instead of rewriting itself and the run reads as a wall of repeats.
    const room = width() - 1;
    if (shown.length <= room) return line;
    return `${shown.slice(0, Math.max(0, room - 1)).join('')}\u2026`;
  };

  const render = (label: string): void => {
    if (total === 0) return;
    const [oldest] = running;
    const line = `${what} ${done}/${total}  ${oldest ?? label}`;
    write(`\r\x1b[K${fit(line)}`);
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

// The same one-line rewrite the counter uses, for a wait that has no count to show: finding the
// sites you can read takes three listings and a lookup each for the ones the index did not name,
// which is the better part of a minute against a blank screen. An empty message clears the line so
// whatever prints next starts on a clean row.
export type StatusLine = (what: string) => void;

export const createStatusLine =
  (write: (text: string) => void): StatusLine =>
  (what) =>
    write(`\r\x1b[K${what}`);

// Silent when there is no terminal to draw on, matching the counter: a piped or scheduled run wants
// its output to be the command's own, not a line that rewrote itself forty times.
export const createNoStatus = (): StatusLine => () => undefined;

export const createStderrStatus = (): StatusLine => (process.stderr.isTTY ? createStatusLine((text) => process.stderr.write(text)) : createNoStatus());
