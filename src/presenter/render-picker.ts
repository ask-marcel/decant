import type { PickerRow } from '../domain/picker.ts';
import type { RunSummary } from '../use-cases/sync-site.ts';

const files = (count: number): string => (count === 1 ? '1 file' : `${count} files`);

const mark = (row: PickerRow): string => (row.synced === undefined ? 'new' : `synced ${row.synced.lastRun.slice(0, 10)}, ${files(row.synced.fileCount)}`);

const hint = (row: PickerRow): string => (row.hint === undefined ? '' : `  [${row.hint}]`);

const line = (row: PickerRow, index: number): string => `${String(index + 1).padStart(3)}) ${row.name}${hint(row)}  (${mark(row)})`;

export const renderSitePicker = (rows: ReadonlyArray<PickerRow>, mailbox: PickerRow): string =>
  [
    'SharePoint sites you can read:',
    '',
    ...rows.map(line),
    '',
    `  m) My mailbox  (${mark(mailbox)})`,
    '',
    'Choose one or more numbers (1,3), all for every site, m for your mailbox, or paste a site address.',
    'Taking more than one site takes every library in each, without asking.',
    'u = refresh everything already synced, q = quit.',
  ].join('\n');

export const renderLibraryPicker = (rows: ReadonlyArray<PickerRow>): string =>
  ['Libraries in this site:', '', ...rows.map(line), '', 'Choose one or more numbers (1,3), or all.'].join('\n');

export const renderSummary = (name: string, summary: RunSummary, dryRun: boolean): string =>
  dryRun
    ? `${name}: ${summary.queued} to do (nothing written, this was a dry run).`
    : `${name}: ${summary.converted} converted, ${summary.moved} moved, ${summary.archived} archived, ${summary.skipped} skipped, ${summary.failed} failed.`;

// Printed once at the end of a run that left something behind, so the report is found without being
// gone looking for. A run that left nothing behind prints nothing: the per-source counts above
// already said so, and a line pointing at an empty report wastes the last thing on screen.
export const renderReportPointer = (left: { readonly skipped: number; readonly failed: number }, path: string): string =>
  `${left.failed} could not be read, ${left.skipped} left out. See ${path}`;
