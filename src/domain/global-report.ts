import type { ReportNotes } from './report.ts';
import { renderNoteLists } from './report.ts';

// One source as this run left it. The timestamp is not here but at the top of the file: every section
// belongs to the same run, and repeating the time under each heading would say nothing new.
export type SourceSection = ReportNotes & { readonly source: string; readonly counts: string };

// A source already in `kb/` that this run did not touch. It carries a date and nothing else: what it
// left behind last time is in its own `_sync-report.md`, and repeating an unrechecked answer here
// would read as current.
export type StaleSource = { readonly name: string; readonly lastRun: string };

export const GLOBAL_REPORT_HEADING = '# What did not reach the knowledge base';

const STALE_HEADING = '## Not rechecked by this run';

const NOTHING_LEFT = 'Nothing was left behind.';

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

// Rewritten whole on every run rather than appended to, so it is always the current view. The history
// of any one source is in that source's own `_sync-report.md`, which is still appended to.
export const renderGlobalReport = (at: string, ran: ReadonlyArray<SourceSection>, stale: ReadonlyArray<StaleSource>): string =>
  [GLOBAL_REPORT_HEADING, '', `Written ${at}.`, '', ...ran.flatMap(section), ...staleTail(stale)].join('\n').trimEnd().concat('\n');
