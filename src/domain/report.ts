export type ReportEntry = {
  readonly path: string;
  readonly reason: string;
};

// What one source left behind. Named here rather than beside the use-case that fills it, so both the
// per-source report and the global one draw the same three lists from the same shape.
export type ReportNotes = {
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
  readonly archived: ReadonlyArray<ReportEntry>;
};

export type ReportRun = ReportNotes & {
  readonly source: string;
  readonly at: string;
  readonly counts: string;
};

export const UNSUPPORTED_REASON = 'a kind of file this tool does not read';

export const PROTECTED_REASON = 'locked with a password, so nothing could be read from it';

export const tooLargeReason = (maxBytes: number): string => `larger than the ${Math.round(maxBytes / 1024 / 1024)} MB cap`;

// Why a file was left out. Two of these are decided before a byte is read, from the name and the
// size; the third only once the source refused to open what it sent.
export type SkipReason = 'unsupported-type' | 'too-large' | 'protected';

export const skipReason = (reason: SkipReason, maxBytes: number): string => {
  if (reason === 'too-large') return tooLargeReason(maxBytes);
  return reason === 'protected' ? PROTECTED_REASON : UNSUPPORTED_REASON;
};

export const reportHeading = (source: string): string => `# What did not reach the knowledge base: ${source}`;

// Two inline images of one conversation can carry the same name and be left out for the same
// reason. Repeating the line tells the reader nothing the count above has not already said.
const list = (title: string, entries: ReadonlyArray<ReportEntry>): ReadonlyArray<string> => {
  const lines = [...new Set(entries.map((entry) => `- ${entry.path}: ${entry.reason}`))];
  return lines.length === 0 ? [] : ['', title, ...lines];
};

// A run that converted everything writes nothing: the state file already records when it ran, and a
// report that repeats "all good" every night buries the runs that did leave something behind.
export const hasSomethingToReport = (run: ReportRun): boolean => run.skipped.length + run.failed.length + run.archived.length > 0;

// The three lists, in the order a reader wants them: what was left out on purpose, what could not be
// read and is worth another run, then what the source no longer has. Shared with the global report,
// so the same entry reads the same way whichever file it is opened in.
export const renderNoteLists = (notes: ReportNotes): ReadonlyArray<string> => [
  ...list('Left in place, nothing was written for these:', notes.skipped),
  ...list('Could not be read, and will be tried again on the next run:', notes.failed),
  ...list('No longer at the source, moved aside:', notes.archived),
];

export const renderReportRun = (run: ReportRun): string => [`## ${run.at}`, '', run.counts, ...renderNoteLists(run), ''].join('\n');

// Newest run first, so the file opens on what happened last however long it grows.
export const appendReportRun = (existing: string | undefined, run: ReportRun): string => {
  const heading = reportHeading(run.source);
  const previous = (existing ?? '').replace(heading, '').trim();
  return [heading, '', renderReportRun(run), previous].join('\n').trimEnd().concat('\n');
};
