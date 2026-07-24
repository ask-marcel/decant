export type ReportEntry = {
  readonly path: string;
  readonly reason: string;
};

export type ReportRun = {
  readonly source: string;
  readonly at: string;
  readonly counts: string;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
  readonly archived: ReadonlyArray<ReportEntry>;
};

export const UNSUPPORTED_REASON = 'a kind of file this tool does not read';

export const tooLargeReason = (maxBytes: number): string => `larger than the ${Math.round(maxBytes / 1024 / 1024)} MB cap`;

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

export const renderReportRun = (run: ReportRun): string =>
  [
    `## ${run.at}`,
    '',
    run.counts,
    ...list('Left in place, nothing was written for these:', run.skipped),
    ...list('Could not be read, and will be tried again on the next run:', run.failed),
    ...list('No longer at the source, moved aside:', run.archived),
    '',
  ].join('\n');

// Newest run first, so the file opens on what happened last however long it grows.
export const appendReportRun = (existing: string | undefined, run: ReportRun): string => {
  const heading = reportHeading(run.source);
  const previous = (existing ?? '').replace(heading, '').trim();
  return [heading, '', renderReportRun(run), previous].join('\n').trimEnd().concat('\n');
};
