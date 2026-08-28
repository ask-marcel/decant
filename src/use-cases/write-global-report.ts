import type { SourceSection, StaleSource } from '../domain/global-report.ts';
import { renderGlobalReport } from '../domain/global-report.ts';
import type { ListSyncedSources } from './list-synced-sources.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { SourceRun } from './sync-site.ts';
import { countsLine } from './sync-site.ts';

export type WriteGlobalReportDeps = {
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  // What is already in `kb/`, so a source this run did not touch is named rather than left out.
  readonly listSyncedSources: ListSyncedSources;
  readonly kbRoot: string;
};

// One file for the whole run, against one `_sync-report.md` per source. Same basename, one level up:
// a reader who knows the per-source file knows this one.
export const GLOBAL_REPORT_PATH = (kbRoot: string): string => `${kbRoot}/_sync-report.md`;

// Answers with the path it wrote, or nothing when it wrote nothing, so the caller can point a reader
// at the file without having to know where the knowledge base lives.
export type WriteGlobalReport = (ran: ReadonlyArray<SourceRun>, dryRun: boolean) => Promise<string | undefined>;

const section = (run: SourceRun): SourceSection => ({ source: run.source, counts: countsLine(run.summary), ...run.notes });

// A listing that cannot be read costs the tail, not the report: what this run did is already in hand,
// and losing it over a directory read would throw away the part that was actually measured.
const staleSources = async (deps: WriteGlobalReportDeps, ran: ReadonlyArray<SourceRun>): Promise<ReadonlyArray<StaleSource>> => {
  const known = await deps.listSyncedSources();
  if (!known.ok) return [];
  const touched = new Set(ran.map((run) => run.id));
  return known.value.filter((source) => !touched.has(source.id)).map((source) => ({ name: source.name, lastRun: source.lastRun }));
};

// Rewritten whole each run, so it is always the current view rather than a log that grows. A run that
// synced nothing writes nothing: quitting the picker should leave the last real report standing, and
// a dry run reports work that did not happen.
export const createWriteGlobalReport =
  (deps: WriteGlobalReportDeps): WriteGlobalReport =>
  async (ran, dryRun) => {
    if (dryRun || ran.length === 0) return undefined;
    const path = GLOBAL_REPORT_PATH(deps.kbRoot);
    const report = renderGlobalReport(deps.clock.nowIso(), ran.map(section), await staleSources(deps, ran));
    const written = await deps.files.writeText(path, report);
    if (written.ok) return path;
    deps.logger.warn('global-report.failed', { cause: written.error.kind });
    return undefined;
  };
