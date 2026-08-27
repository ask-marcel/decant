import type { Progress } from '../use-cases/ports/progress.ts';

// Draws a block that rewrites itself where it already stands: a header row carrying the count, then
// one row per item in flight. `\x1b[{n}A` climbs the cursor back over the rows the last draw covered,
// `\x1b[K` clears each row before it is rewritten, and `\x1b[J` wipes whatever the block no longer
// fills, so a window that shrinks leaves no ghost rows behind. The writer is injected: production
// hands it stderr, a test hands it an array. Nothing is written when there is nothing to count, so a
// run that converts everything from cache stays silent.
// A width and a height no terminal is smaller than, for when nothing else says.
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export const createProgressBar = (write: (text: string) => void, columns?: () => number, rows?: () => number): Progress => {
  // The screen to fit inside: whatever a caller names, else the terminal's own size, else a size no
  // terminal is smaller than. Read per write rather than once, since a terminal can be resized.
  const width = (): number => columns?.() ?? process.stderr.columns ?? DEFAULT_COLUMNS;
  const height = (): number => rows?.() ?? process.stderr.rows ?? DEFAULT_ROWS;
  let total = 0;
  let done = 0;
  let what = '';
  let running = new Set<string>();
  // What each running item last reported. Keyed by label so every row draws its own step, rather
  // than one file's step beside another file's name.
  let steps = new Map<string, string>();
  // How many rows the last draw covered, so the next one climbs back over exactly those. A climb of
  // zero is never written: a terminal reads `\x1b[0A` as `\x1b[1A`, which would walk the block up the
  // screen a row at a time.
  let drawn = 0;
  // A row wider than the screen wraps, and `\x1b[K` clears only the row the cursor sits on, so the
  // wrapped remainder stays behind and the block garbles. Cut by code point, so a character is never
  // left half-written.
  const fit = (line: string): string => {
    const shown = [...line];
    // One column short of the row, never the whole row. Filling the last column leaves the cursor in
    // a deferred-wrap state, and the `\r` that follows then returns to the start of the NEXT row, so
    // the block stacks instead of rewriting itself and the run reads as a wall of repeats.
    const room = width() - 1;
    if (shown.length <= room) return line;
    return `${shown.slice(0, Math.max(0, room - 1)).join('')}\u2026`;
  };

  const itemRow = (label: string): string => {
    const step = steps.get(label);
    return step === undefined ? `  ${label}` : `  ${label} \u00b7 ${step}`;
  };

  // The header, then a row per item in flight, kept to the rows the cursor can climb back over: a
  // block taller than the screen scrolls, and the climb then lands on rows that have moved. Reachable
  // rather than theoretical, since `--concurrency` takes any whole number.
  const block = (label: string): ReadonlyArray<string> => {
    // Falls back to the label just passed in when nothing is tracked as running, which is what a bare
    // `step()` call (no `begin()` first) relied on before this port grew a `begin`.
    const inFlight = running.size > 0 ? [...running] : [label];
    // Only worth counting when more than one is in flight: one running item is not news.
    const count = running.size > 1 ? ` (${running.size} running)` : '';
    const header = `${what} ${done}/${total}${count}`;
    const room = Math.max(1, height() - 1);
    if (inFlight.length <= room) return [header, ...inFlight.map(itemRow)];
    const shown = inFlight.slice(0, room - 1);
    return [header, ...shown.map(itemRow), `  \u2026and ${inFlight.length - shown.length} more`];
  };

  const render = (label: string): void => {
    if (total === 0) return;
    const lines = block(label);
    const climb = drawn > 1 ? `\x1b[${drawn - 1}A` : '';
    const body = lines.map((line) => `\x1b[K${fit(line)}`).join('\n');
    write(`${climb}\r${body}\x1b[J`);
    drawn = lines.length;
  };
  return {
    start: (count, label) => {
      total = count;
      done = 0;
      what = label;
      running = new Set();
      steps = new Map();
      drawn = 0;
    },
    begin: (label) => {
      running.add(label);
      steps.delete(label);
      render(label);
    },
    detail: (label, doing) => {
      steps.set(label, doing);
      render(label);
    },
    step: (label) => {
      running.delete(label);
      steps.delete(label);
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
  detail: () => undefined,
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
