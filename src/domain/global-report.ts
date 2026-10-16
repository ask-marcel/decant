import type { ReportEntry, ReportNotes } from './report.ts';
import { renderNoteLists } from './report.ts';

// One source as this run left it. The timestamp is not here but at the top of the file: every section
// belongs to the same run, and repeating the time under each heading would say nothing new.
export type SourceSection = ReportNotes & { readonly source: string; readonly counts: string };

// A source already in `kb/` that this run did not touch. It carries a date and nothing else: what it
// left behind last time is in its own `_sync-report.md`, and repeating an unrechecked answer here
// would read as current.
export type StaleSource = { readonly name: string; readonly lastRun: string };

// Everything one rendering needs. A record rather than a parameter list: `stopped` was the fourth
// thing to pass, and the next reader of a four-argument call cannot tell which list is which.
export type GlobalRun = {
  readonly at: string;
  readonly ran: ReadonlyArray<SourceSection>;
  readonly stale: ReadonlyArray<StaleSource>;
  // Absent when the run finished; what it stopped at when it did not.
  readonly stopped?: string;
  // The files that would not move under the archive, which no source names any more.
  readonly stuck?: ReadonlyArray<ReportEntry>;
  // Why the ledger of those files would not read, when it would not: then `stuck` holds only what this
  // run let go.
  readonly stuckUnread?: string;
};

export const GLOBAL_REPORT_HEADING = '# What did not reach the knowledge base';

const STALE_HEADING = '## Not rechecked by this run';

const STUCK_HEADING = '## Could not be moved to the archive';

const STUCK_NOTE = 'Each run tries to move these again before it starts.';

const NOTHING_LEFT = 'Nothing was left behind.';

// A run that stopped says so at the top, because the rest of the file cannot: a report naming two
// sources looks the same whether the run covered two or died on the third. The tail below names the
// ones it did not reach, but with their old dates, which reads as ordinary staleness rather than as
// work this run still owes.
const stoppedLine = (stopped: string): string => `The run stopped early at ${stopped}. The sources after it were not reached.`;

// A clean source says so in a line rather than showing three empty lists: the reader is scanning for
// what went wrong, and a heading with nothing under it makes them stop and check why.
const section = (source: SourceSection): ReadonlyArray<string> => {
  const lists = renderNoteLists(source);
  return [`## ${source.source}`, '', source.counts, ...(lists.length === 0 ? ['', NOTHING_LEFT] : lists), ''];
};

// Named, never silently absent: a source missing from a report that claims to cover everything reads
// as a source with nothing wrong, which is the one thing this file must not say by accident.
const staleTail = (stale: ReadonlyArray<StaleSource>): ReadonlyArray<string> =>
  stale.length === 0 ? [] : [STALE_HEADING, '', ...stale.map((source) => `- ${source.name}: last ran ${source.lastRun}`), ''];

// When the ledger would not read, no run moves what it lists or adds to it, so the note says that in
// place of the retry it cannot promise.
const unreadNote = (cause: string): string =>
  `The list of these files, .sync-aside.json, could not be read (${cause}). No run moves them, or adds to the list, until it is repaired or deleted. Below are the files of this run alone.`;

// The sources have let these files go, so this is the one place that still names them.
const stuckSection = (stuck: ReadonlyArray<ReportEntry>, unread: string | undefined): ReadonlyArray<string> => {
  if (stuck.length === 0 && unread === undefined) return [];
  const lines = stuck.map((entry) => `- ${entry.path}: ${entry.reason}`);
  return [STUCK_HEADING, '', unread === undefined ? STUCK_NOTE : unreadNote(unread), '', ...(lines.length === 0 ? [] : [...lines, ''])];
};

// Rewritten whole on every run rather than appended to, so it is always the current view. The history
// of any one source is in that source's own `_sync-report.md`, which is still appended to.
export const renderGlobalReport = (run: GlobalRun): string => {
  const opening = run.stopped === undefined ? [] : [stoppedLine(run.stopped), ''];
  return [GLOBAL_REPORT_HEADING, '', `Written ${run.at}.`, '', ...opening, ...run.ran.flatMap(section), ...stuckSection(run.stuck ?? [], run.stuckUnread), ...staleTail(run.stale)]
    .join('\n')
    .trimEnd()
    .concat('\n');
};

// The time is the one line that changes on every run, so it is the one line two reports are compared
// without: one that differs only there says nothing new.
const WRITTEN = /^Written .*\.$/m;

export const sameReport = (held: string, next: string): boolean => held.replace(WRITTEN, '') === next.replace(WRITTEN, '');
