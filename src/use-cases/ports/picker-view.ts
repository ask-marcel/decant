import type { PickerRow, StandingRows } from '../../domain/picker.ts';
import type { RunSummary } from '../../domain/run-summary.ts';

// The words a run shows the operator. The run decides what to show and when; how it reads is the
// presenter's, handed in through this port so the run never reaches for the presenter itself.
export type PickerView = {
  readonly sitePicker: (rows: ReadonlyArray<PickerRow>, standing: StandingRows) => string;
  readonly libraryPicker: (rows: ReadonlyArray<PickerRow>) => string;
  readonly channelPicker: (rows: ReadonlyArray<PickerRow>) => string;
  readonly summary: (name: string, summary: RunSummary, dryRun: boolean) => string;
  readonly reportPointer: (left: { readonly skipped: number; readonly failed: number }, path: string) => string;
  readonly sinceQuestion: () => string;
  readonly sinceRefused: (answer: string) => string;
};
