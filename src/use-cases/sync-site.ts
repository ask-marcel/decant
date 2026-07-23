import type { DriveItem } from '../domain/drive-item.ts';
import { safeSegment } from '../domain/kb-path.ts';
import { archivePath, outputPrefix, remapOutputs } from '../domain/output-paths.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { DriveState, SiteRef, SiteState } from '../domain/site-state.ts';
import { emptySiteState, forgetItem, parseSiteState, recordItem, renameItem, serializeSiteState, withDrive } from '../domain/site-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { buildWorklist } from '../domain/worklist.ts';
import type { WorkItem } from '../domain/worklist.ts';
import type { ConvertFile } from './convert-file.ts';
import { sweepDrive } from './enumerate-drive.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader, DriveSummary } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { StepError } from './ports/step-error.ts';

export const STATE_FILE_NAME = '.sync-state.json';

export type SyncSiteDeps = {
  readonly reader: DriveReader;
  readonly files: Files;
  readonly convertFile: ConvertFile;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly kbRoot: string;
};

export type SyncSiteInput = {
  readonly site: SiteRef;
  readonly drives: ReadonlyArray<DriveSummary>;
  readonly maxBytes: number;
  readonly ocrLabel: string;
  readonly dryRun: boolean;
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
    for (const drive of input.drives) {
      const outcome = await syncDrive(deps, input, drive, state, statePath);
      if (!outcome.ok) return outcome;
      state = outcome.value.state;
      summary = add(summary, outcome.value.summary);
    }
    const finished = { ...state, lastRun: deps.clock.nowIso() };
    const saved = await save(deps.files, statePath, finished, input.dryRun);
    return saved.ok ? ok(summary) : saved;
  };

const save = async (files: Files, path: string, state: SiteState, dryRun: boolean): Promise<Result<void, StepError>> => {
  if (dryRun) return ok(undefined);
  const written = await files.writeText(path, serializeSiteState(state));
  return written.ok ? ok(undefined) : { ok: false, error: { step: 'saveState', cause: written.error.kind, message: written.error.message } };
};

type DriveOutcome = { readonly state: SiteState; readonly summary: RunSummary };

const syncDrive = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<DriveOutcome, StepError>> => {
  const queued = await queueWork(deps, input, drive, state, statePath);
  if (!queued.ok) return queued;
  if (input.dryRun) return ok({ state: queued.value.state, summary: add(EMPTY, { queued: queued.value.state.drives[drive.id]?.pending.length ?? 0 }) });
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

const processQueue = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<DriveOutcome, StepError>> => {
  let current = state;
  let summary = EMPTY;
  for (;;) {
    const driveState = current.drives[drive.id];
    const work = driveState?.pending[0];
    if (driveState === undefined || work === undefined) return ok({ state: current, summary });
    const done = await applyWork(deps, input, drive, driveState, work);
    const advanced = withDrive(current, drive.id, { ...done.drive, pending: driveState.pending.slice(1) });
    const saved = await save(deps.files, statePath, advanced, input.dryRun);
    if (!saved.ok) return saved;
    current = advanced;
    summary = add(summary, done.counted);
  }
};

type WorkOutcome = { readonly drive: DriveState; readonly counted: Partial<RunSummary> };

const applyWork = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, driveState: DriveState, work: WorkItem): Promise<WorkOutcome> => {
  if (work.kind === 'archive') return archiveOutputs(deps, input, drive, driveState, work.itemId, work.outputs);
  if (work.kind === 'move') return moveOutputs(deps, input, drive, driveState, work.item, work.from, work.outputs);
  return convertOne(deps, input, drive, driveState, work.item);
};

const convertOne = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, driveState: DriveState, item: DriveItem): Promise<WorkOutcome> => {
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
    return { drive: driveState, counted: { failed: 1 } };
  }
  const outputs = outcome.kind === 'converted' ? outcome.outputs : [];
  const recorded = recordItem(driveState, item.id, { path: item.path, cTag: item.cTag, outputs });
  return { drive: recorded, counted: outcome.kind === 'converted' ? { converted: 1 } : { skipped: 1 } };
};

const moveOutputs = async (
  deps: SyncSiteDeps,
  input: SyncSiteInput,
  drive: DriveSummary,
  driveState: DriveState,
  item: DriveItem,
  from: string,
  outputs: ReadonlyArray<string>
): Promise<WorkOutcome> => {
  const libraryRoot = libraryRootOf(deps.kbRoot, input.site, drive);
  const moved = remapOutputs(outputs, outputPrefix(libraryRoot, from), outputPrefix(libraryRoot, item.path));
  for (const [index, target] of moved.entries()) {
    const source = outputs[index];
    if (source === undefined || source === target) continue;
    const done = await deps.files.move(source, target);
    if (!done.ok) deps.logger.warn('move.failed', { itemId: item.id, cause: done.error.kind });
  }
  return { drive: renameItem(driveState, item.id, item.path, moved), counted: { moved: 1 } };
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
  return { drive: forgetItem(driveState, itemId), counted: { archived: 1 } };
};
