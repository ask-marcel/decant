import { extensionOf } from './conversion-plan.ts';
import { MAX_CONVERSION_ATTEMPTS } from './retry-policy.ts';

export type ReportEntry = {
  readonly path: string;
  readonly reason: string;
};

// What one source left behind. Named here rather than beside the use-case that fills it, so both the
// per-source report and the global one draw the same four lists from the same shape.
export type ReportNotes = {
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
  // Held apart from `failed` because the two promise a reader different things, and one heading
  // covering both would go on saying "next run" about a file no run will pick up again.
  readonly givenUp: ReadonlyArray<ReportEntry>;
  // The part of `givenUp` that ran out of tries in this run, absent when none did. A source's own
  // report is a log of runs, so it names an item once, in the run that gave up on it. The report
  // of the whole run names every item still given up, from `givenUp`, so the list stays current.
  readonly gaveUp?: ReadonlyArray<ReportEntry>;
  readonly archived: ReadonlyArray<ReportEntry>;
};

export type ReportRun = ReportNotes & {
  readonly source: string;
  readonly at: string;
  readonly counts: string;
};

// Two different things were both reported as "a kind of file this tool does not read", and neither
// told a reader what to do about it. A sharing notification carries icons named by a machine id with
// no extension at all, so nothing could work out what they were; a recording is a kind we know and
// do not convert. The first is not worth chasing, the second might be, and the line has to say which.
export const unnamedTypeReason = (name: string): string => `no extension on "${name}", so nothing could tell what kind of file it is`;

export const unsupportedReason = (name: string): string => {
  const extension = extensionOf(name);
  return extension === undefined ? unnamedTypeReason(name) : `a .${extension} file, which this tool does not read`;
};

export const PROTECTED_REASON = 'locked with a password, so nothing could be read from it';

// The library reads the first members of a larger archive and leaves the rest in it; no run reads
// more, so the archive is said once, with what it left, rather than tried again.
export const cutArchiveReason = (read: number, total: number): string =>
  `${total - read} of its ${total} files ${total - read === 1 ? 'stays' : 'stay'} in the archive: the converter read the first ${read}`;

// How much of an archive the library read: the first `read` of its `total` files.
export type ArchiveCut = { readonly read: number; readonly total: number };

// The files after the first `read`: one file, or a range of them.
const keptBack = (cut: ArchiveCut): string => (cut.total === cut.read + 1 ? `file ${cut.total}` : `files ${cut.read + 1} to ${cut.total}`);

// The report line of such an archive, in the list of what was left in place with nothing written. It
// names the files that stay in the archive, and not the archive, whose first files were written.
export const cutArchiveEntry = (path: string, cut: ArchiveCut): ReportEntry => ({
  path: `${path}, ${keptBack(cut)}`,
  reason: `the converter reads the first ${cut.read} files of an archive`,
});

export const LOCK_FILE_REASON = 'a file Office leaves beside a document while it is open, holding no content of its own';

export const tooLargeReason = (maxBytes: number): string => `larger than the ${Math.round(maxBytes / 1024 / 1024)} MB cap`;

// Why a file was left out. Three of these are decided before a byte is read, from the name and the
// size; the last only once the source refused to open what it sent.
export type SkipReason = 'unsupported-type' | 'too-large' | 'protected' | 'lock-file';

const REASONS: Readonly<Record<Exclude<SkipReason, 'unsupported-type' | 'too-large'>, string>> = {
  protected: PROTECTED_REASON,
  'lock-file': LOCK_FILE_REASON,
};

export const skipReason = (reason: SkipReason, maxBytes: number, name: string): string => {
  if (reason === 'too-large') return tooLargeReason(maxBytes);
  if (reason === 'unsupported-type') return unsupportedReason(name);
  return REASONS[reason];
};

export const reportHeading = (source: string): string => `# What did not reach the knowledge base: ${source}`;

// Two inline images of one conversation can carry the same name and be left out for the same
// reason. Repeating the line tells the reader nothing the count above has not already said.
const list = (title: string, entries: ReadonlyArray<ReportEntry>): ReadonlyArray<string> => {
  const lines = [...new Set(entries.map((entry) => `- ${entry.path}: ${entry.reason}`))];
  return lines.length === 0 ? [] : ['', title, ...lines];
};

// Present only when something gave up in this run, so a run with nothing to say carries nothing.
export const withGaveUp = (notes: ReportNotes, gaveUp: ReadonlyArray<ReportEntry>): ReportNotes => (gaveUp.length === 0 ? notes : { ...notes, gaveUp });

// A run that converted everything writes nothing: the state file already records when it ran, and a
// report that repeats "all good" every night buries the runs that did leave something behind.
export const hasSomethingToReport = (run: ReportRun): boolean => run.skipped.length + run.failed.length + run.givenUp.length + run.archived.length > 0;

// The four lists, in the order a reader wants them: what was left out on purpose, what failed and is
// worth another run, what has run out of runs, then what the source no longer has. A failure can be
// a read, a conversion or a write, and each reason starts with the kind of error that stopped it.
// Shared with the global report, so the same entry reads the same way whichever file it is opened in.
export const renderNoteLists = (notes: ReportNotes): ReadonlyArray<string> => [
  ...list('Left in place, nothing was written for these:', notes.skipped),
  ...list('Failed, and will be tried again on the next run:', notes.failed),
  ...list(`Failed ${MAX_CONVERSION_ATTEMPTS} times, and will not be tried again unless the file changes:`, notes.givenUp),
  ...list('No longer at the source, moved aside:', notes.archived),
];

export const renderReportRun = (run: ReportRun): string => [`## ${run.at}`, '', run.counts, ...renderNoteLists(run), ''].join('\n');

// Newest run first, so the file opens on what happened last however long it grows.
export const appendReportRun = (existing: string | undefined, run: ReportRun): string => {
  const heading = reportHeading(run.source);
  const previous = (existing ?? '').replace(heading, '').trim();
  return [heading, '', renderReportRun(run), previous].join('\n').trimEnd().concat('\n');
};
