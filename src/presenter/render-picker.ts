import type { PickerRow, StandingRows } from '../domain/picker.ts';
import type { AddressKind } from '../domain/address-kind.ts';
import { kindOf } from '../domain/address-kind.ts';
import { CATEGORY_FOLDER } from '../domain/kb-category.ts';
import { SINCE_SHAPE } from '../domain/sync-window.ts';
import type { RunSummary } from '../domain/run-summary.ts';

const files = (count: number): string => (count === 1 ? '1 file' : `${count} files`);

const mark = (row: PickerRow): string => (row.synced === undefined ? 'new' : `synced ${row.synced.lastRun.slice(0, 10)}, ${files(row.synced.fileCount)}`);

const hint = (row: PickerRow): string => (row.hint === undefined ? '' : `  [${row.hint}]`);

const line = (row: PickerRow, index: number): string => `${String(index + 1).padStart(3)}) ${row.name}${hint(row)}  (${mark(row)})`;

// The heading and the folder a choice lands in are the same word, taken from the same table, so the
// picker cannot promise one shelf and the vault deliver another.
const headingOf = (kind: AddressKind): string => `${CATEGORY_FOLDER[kind]}:`;

// A heading is opened whenever the kind changes, so a kind nobody has never gets an empty one. The
// rows arrive already ordered by kind (`orderByKind`, applied where the picker and the choice share
// one array), which is what keeps this to a single pass and the numbering to a single run.
const headed = (rows: ReadonlyArray<PickerRow>): ReadonlyArray<string> => {
  const lines: string[] = [];
  let open: AddressKind | undefined;
  for (const [index, row] of rows.entries()) {
    const kind = kindOf(row);
    if (kind !== open) {
      if (open !== undefined) lines.push('');
      lines.push(headingOf(kind));
      open = kind;
    }
    lines.push(line(row, index));
  }
  return lines;
};

export const renderSitePicker = (rows: ReadonlyArray<PickerRow>, standing: StandingRows): string =>
  [
    'Sources you can read:',
    '',
    ...headed(rows),
    '',
    `  m) My mailbox  (${mark(standing.mailbox)})`,
    `  c) My calendar  (${mark(standing.calendar)})`,
    `  p) People, everyone in your Teams  (${mark(standing.people)})`,
    '',
    'Choose one or more numbers (1,3), all for every site, m for your mailbox, c for your calendar, p for the people, or paste a site address.',
    'Taking more than one site takes every library in each, without asking.',
    'u = refresh everything already synced, q = quit.',
  ].join('\n');

export const renderLibraryPicker = (rows: ReadonlyArray<PickerRow>): string =>
  ['Libraries in this site:', '', ...rows.map(line), '', 'Choose one or more numbers (1,3), or all.'].join('\n');

// A team's channels are chosen the way a site's libraries are: one question, once, for one team.
export const renderChannelPicker = (rows: ReadonlyArray<PickerRow>): string =>
  ['Channels in this team:', '', ...rows.map(line), '', 'Choose one or more numbers (1,3), or all.'].join('\n');

export const renderSummary = (name: string, summary: RunSummary, dryRun: boolean): string =>
  dryRun
    ? `${name}: ${summary.queued} to do (nothing written, this was a dry run).`
    : `${name}: ${summary.converted} converted, ${summary.moved} moved, ${summary.archived} archived, ${summary.skipped} skipped, ${summary.failed} failed.`;

// Printed once at the end of a run that left something behind, so the report is found without being
// gone looking for. A run that left nothing behind prints nothing: the per-source counts above
// already said so, and a line pointing at an empty report wastes the last thing on screen.
export const renderReportPointer = (left: { readonly skipped: number; readonly failed: number }, path: string): string =>
  `${left.failed} could not be read, ${left.skipped} left out. See ${path}`;

// Asked once, by the first run that has work to do, and kept for every run after it: the text says
// what the day leaves out and how to move it, since nothing will ask again.
export const renderSinceQuestion = (): string =>
  [
    '',
    'How far back should decant reach? From this day on it syncs mail, group inboxes, Teams posts,',
    'the calendar, library files and OneNote pages; To Do, Planner, lists and people always come whole.',
    'The answer is kept for every later run; run with --since <day|all> to change it.',
  ].join('\n');

export const renderSinceRefused = (answer: string): string => `Not a day: ${answer}. Answer with ${SINCE_SHAPE}.`;
