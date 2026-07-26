import type { DriveItem } from '../domain/drive-item.ts';
import { safeSegment } from '../domain/kb-path.ts';
import { archivePath, outputPrefix, remapOutputs } from '../domain/output-paths.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { DriveState, SiteRef, SiteState } from '../domain/site-state.ts';
import { emptySiteState, forgetItem, parseSiteState, recordItem, renameItem, serializeSiteState, withDrive } from '../domain/site-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { buildWorklist } from '../domain/worklist.ts';
import type { ReportEntry, ReportRun } from '../domain/report.ts';
import { appendReportRun, hasSomethingToReport, tooLargeReason, UNSUPPORTED_REASON } from '../domain/report.ts';
import type { WorkItem } from '../domain/worklist.ts';
import type { ConvertFile } from './convert-file.ts';
import { sweepDrive } from './enumerate-drive.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader, DriveSummary } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';

export const STATE_FILE_NAME = '.sync-state.json';

export type SyncSiteDeps = {
  readonly reader: DriveReader;
  readonly files: Files;
  readonly convertFile: ConvertFile;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
};

export type SyncSiteInput = {
  readonly site: SiteRef;
  readonly drives: ReadonlyArray<DriveSummary>;
  readonly maxBytes: number;
  readonly ocrLabel: string;
  readonly dryRun: boolean;
  // How many items to convert at once. Each item's outputs are its own, so a window of them runs in
  // parallel and the manifest updates fold afterwards; a window interrupted re-runs, writing the
  // same bytes to the same paths.
  readonly concurrency: number;
};

export type RunSummary = {
  readonly converted: number;
  readonly moved: number;
  readonly archived: number;
  readonly skipped: number;
  readonly failed: number;
  readonly queued: number;
};

export type SyncSite = (input: SyncSiteInput) => Promise<Result<RunSummary, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const add = (left: RunSummary, right: Partial<RunSummary>): RunSummary => ({
  converted: left.converted + (right.converted ?? 0),
  moved: left.moved + (right.moved ?? 0),
  archived: left.archived + (right.archived ?? 0),
  skipped: left.skipped + (right.skipped ?? 0),
  failed: left.failed + (right.failed ?? 0),
  queued: left.queued + (right.queued ?? 0),
});

const siteRoot = (kbRoot: string, site: SiteRef): string => `${kbRoot}/${safeSegment(site.name)}`;

const libraryRootOf = (kbRoot: string, site: SiteRef, drive: DriveSummary): string => `${siteRoot(kbRoot, site)}/${safeSegment(drive.name)}`;

const archiveRootOf = (kbRoot: string, site: SiteRef, drive: DriveSummary): string => `${kbRoot}/_archive/${safeSegment(site.name)}/${safeSegment(drive.name)}`;

export const loadState = async (files: Files, path: string, site: SiteRef, logger: Logger): Promise<SiteState> => {
  const text = await files.readText(path);
  if (!text.ok) return emptySiteState(site);
  const parsed = parseJson(text.value);
  if (!parsed.ok) return unusable(logger, site, parsed.error.kind);
  const state = parseSiteState(parsed.value);
  return state.ok ? state.value : unusable(logger, site, state.error.kind);
};

const unusable = (logger: Logger, site: SiteRef, cause: string): SiteState => {
  logger.warn('sync-state.unusable', { siteId: site.id, cause });
  return emptySiteState(site);
};

export const createSyncSite =
  (deps: SyncSiteDeps): SyncSite =>
  async (input) => {
    const statePath = `${siteRoot(deps.kbRoot, input.site)}/${STATE_FILE_NAME}`;
    let state = await loadState(deps.files, statePath, input.site, deps.logger);
    let summary = EMPTY;
    let notes = NO_NOTES;
    for (const drive of input.drives) {
      const outcome = await syncDrive(deps, input, drive, state, statePath);
      if (!outcome.ok) return outcome;
      state = outcome.value.state;
      summary = add(summary, outcome.value.summary);
      notes = mergeNotes(notes, outcome.value.notes);
    }
    const finished = { ...state, lastRun: deps.clock.nowIso() };
    const saved = await save(deps.files, statePath, finished, input.dryRun);
    if (!saved.ok) return saved;
    await writeReport(deps, input, siteRoot(deps.kbRoot, input.site), input.site.name, summary, notes);
    return ok(summary);
  };

export const REPORT_FILE_NAME = '_sync-report.md';

const countsLine = (summary: RunSummary): string =>
  `${summary.converted} converted, ${summary.moved} moved, ${summary.archived} archived, ${summary.skipped} skipped, ${summary.failed} failed.`;

// The report answers "what is not in here, and why", so a run that converted everything writes
// nothing: the state file already records that it ran. A report that cannot be written is logged
// rather than failing the run, since the documents themselves already landed.
export const writeReport = async (
  deps: { readonly files: Files; readonly clock: Clock; readonly logger: Logger },
  input: { readonly dryRun: boolean },
  root: string,
  source: string,
  summary: RunSummary,
  notes: RunNotes
): Promise<void> => {
  const run: ReportRun = { source, at: deps.clock.nowIso(), counts: countsLine(summary), ...notes };
  if (input.dryRun || !hasSomethingToReport(run)) return;
  const path = `${root}/${REPORT_FILE_NAME}`;
  const existing = await deps.files.readText(path);
  const written = await deps.files.writeText(path, appendReportRun(existing.ok ? existing.value : undefined, run));
  if (!written.ok) deps.logger.warn('report.failed', { cause: written.error.kind });
};

const save = async (files: Files, path: string, state: SiteState, dryRun: boolean): Promise<Result<void, StepError>> => {
  if (dryRun) return ok(undefined);
  const written = await files.writeText(path, serializeSiteState(state));
  return written.ok ? ok(undefined) : { ok: false, error: { step: 'saveState', cause: written.error.kind, message: written.error.message } };
};

type DriveOutcome = { readonly state: SiteState; readonly summary: RunSummary; readonly notes: RunNotes };

const syncDrive = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<DriveOutcome, StepError>> => {
  const queued = await queueWork(deps, input, drive, state, statePath);
  if (!queued.ok) return queued;
  if (input.dryRun) return ok({ state: queued.value.state, summary: add(EMPTY, { queued: queued.value.state.drives[drive.id]?.pending.length ?? 0 }), notes: NO_NOTES });
  return processQueue(deps, input, drive, queued.value.state, statePath);
};

const queueWork = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<{ state: SiteState }, StepError>> => {
  const known: DriveState = state.drives[drive.id] ?? { name: drive.name, pending: [], items: {} };
  if (known.pending.length > 0) {
    deps.logger.info('sync.resuming', { driveId: drive.id, pending: known.pending.length });
    return ok({ state });
  }
  const swept = await sweepDrive(deps.reader, drive.id, known.deltaLink);
  if (!swept.ok) return { ok: false, error: { step: 'enumerate', cause: swept.error.kind, message: swept.error.message } };
  deps.logger.info('sync.enumerated', { driveId: drive.id, items: swept.value.items.length, skipped: swept.value.skipped });
  const queued = { ...known, name: drive.name, deltaLink: swept.value.deltaLink, pending: buildWorklist(swept.value.items, known.items) };
  const next = withDrive(state, drive.id, queued);
  const saved = await save(deps.files, statePath, next, input.dryRun);
  return saved.ok ? ok({ state: next }) : saved;
};

// What the moving counter names for each item: the path it sits at, or the id of one being archived.
const labelOf = (work: WorkItem): string => (work.kind === 'archive' ? work.itemId : work.item.path);

const processQueue = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<DriveOutcome, StepError>> => {
  let current = state;
  let summary = EMPTY;
  let notes = NO_NOTES;
  deps.progress.start(current.drives[drive.id]?.pending.length ?? 0, 'Converting');
  for (;;) {
    const driveState = current.drives[drive.id];
    if (driveState === undefined || driveState.pending.length === 0) {
      deps.progress.done();
      return ok({ state: current, summary, notes });
    }
    const window = driveState.pending.slice(0, input.concurrency);
    const results = await Promise.all(
      window.map((work) => {
        deps.progress.begin(labelOf(work));
        return applyWork(deps, input, drive, driveState, work).then((outcome) => {
          deps.progress.step(labelOf(work));
          return outcome;
        });
      })
    );
    const folded = results.reduce((manifest, done) => done.update(manifest), driveState);
    const advanced = withDrive(current, drive.id, { ...folded, pending: driveState.pending.slice(window.length) });
    const saved = await save(deps.files, statePath, advanced, input.dryRun);
    if (!saved.ok) {
      deps.progress.done();
      return saved;
    }
    current = advanced;
    for (const done of results) {
      summary = add(summary, done.counted);
      notes = mergeNotes(notes, done.notes ?? {});
    }
  }
};

export type RunNotes = { readonly skipped: ReadonlyArray<ReportEntry>; readonly failed: ReadonlyArray<ReportEntry>; readonly archived: ReadonlyArray<ReportEntry> };

const NO_NOTES: RunNotes = { skipped: [], failed: [], archived: [] };

const mergeNotes = (left: RunNotes, right: Partial<RunNotes>): RunNotes => ({
  skipped: [...left.skipped, ...(right.skipped ?? [])],
  failed: [...left.failed, ...(right.failed ?? [])],
  archived: [...left.archived, ...(right.archived ?? [])],
});

// The IO (converting, moving, archiving) happens now; the manifest change it implies comes back as a
// function so a whole window's updates fold onto the manifest in order, after the parallel IO.
type WorkOutcome = { readonly update: (drive: DriveState) => DriveState; readonly counted: Partial<RunSummary>; readonly notes?: Partial<RunNotes> };

const applyWork = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, driveState: DriveState, work: WorkItem): Promise<WorkOutcome> => {
  if (work.kind === 'archive') return archiveOutputs(deps, input, drive, driveState, work.itemId, work.outputs);
  if (work.kind === 'move') return moveOutputs(deps, input, drive, work.item, work.from, work.outputs);
  return convertOne(deps, input, drive, work.item);
};

const convertOne = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, item: DriveItem): Promise<WorkOutcome> => {
  const outcome = await deps.convertFile({
    item,
    driveId: drive.id,
    libraryRoot: libraryRootOf(deps.kbRoot, input.site, drive),
    site: input.site.name,
    library: drive.name,
    maxBytes: input.maxBytes,
    ocrLabel: input.ocrLabel,
  });
  if (outcome.kind === 'failed') {
    deps.logger.warn('convert.failed', { itemId: item.id, reason: outcome.reason });
    return { update: (manifest) => manifest, counted: { failed: 1 }, notes: { failed: [{ path: item.path, reason: outcome.reason }] } };
  }
  const outputs = outcome.kind === 'converted' ? outcome.outputs : [];
  const update = (manifest: DriveState): DriveState => recordItem(manifest, item.id, { path: item.path, cTag: item.cTag, outputs });
  if (outcome.kind === 'converted') return { update, counted: { converted: 1 } };
  const reason = outcome.reason === 'too-large' ? tooLargeReason(input.maxBytes) : UNSUPPORTED_REASON;
  return { update, counted: { skipped: 1 }, notes: { skipped: [{ path: item.path, reason }] } };
};

const moveOutputs = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, item: DriveItem, from: string, outputs: ReadonlyArray<string>): Promise<WorkOutcome> => {
  const libraryRoot = libraryRootOf(deps.kbRoot, input.site, drive);
  const moved = remapOutputs(outputs, outputPrefix(libraryRoot, from), outputPrefix(libraryRoot, item.path));
  for (const [index, target] of moved.entries()) {
    const source = outputs[index];
    if (source === undefined || source === target) continue;
    const done = await deps.files.move(source, target);
    if (!done.ok) deps.logger.warn('move.failed', { itemId: item.id, cause: done.error.kind });
  }
  return { update: (manifest) => renameItem(manifest, item.id, item.path, moved), counted: { moved: 1 } };
};

const archiveOutputs = async (
  deps: SyncSiteDeps,
  input: SyncSiteInput,
  drive: DriveSummary,
  driveState: DriveState,
  itemId: string,
  outputs: ReadonlyArray<string>
): Promise<WorkOutcome> => {
  const libraryRoot = libraryRootOf(deps.kbRoot, input.site, drive);
  const archiveRoot = archiveRootOf(deps.kbRoot, input.site, drive);
  for (const output of outputs) {
    const done = await deps.files.move(output, archivePath(archiveRoot, libraryRoot, output));
    if (!done.ok) deps.logger.warn('archive.failed', { itemId, cause: done.error.kind });
  }
  const known = driveState.items[itemId];
  return {
    update: (manifest) => forgetItem(manifest, itemId),
    counted: { archived: 1 },
    notes: { archived: [{ path: known?.path ?? itemId, reason: 'no longer at the source' }] },
  };
};
