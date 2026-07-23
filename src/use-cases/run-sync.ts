import type { PickerRow, Selection, SyncedMark } from '../domain/picker.ts';
import { annotate, parseSelection } from '../domain/picker.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { SiteRef } from '../domain/site-state.ts';
import { renderLibraryPicker, renderSitePicker, renderSummary } from '../presenter/render-picker.ts';
import type { ListSyncedSources } from './list-synced-sources.ts';
import type { DriveReader, DriveSummary } from './ports/drive-reader.ts';
import type { Logger } from './ports/logger.ts';
import type { Prompt } from './ports/prompt.ts';
import type { StepError } from './ports/step-error.ts';
import type { RunSummary, SyncSite } from './sync-site.ts';

export type RunSyncDeps = {
  readonly reader: DriveReader;
  readonly prompt: Prompt;
  readonly logger: Logger;
  readonly syncSite: SyncSite;
  readonly listSyncedSources: ListSyncedSources;
  // The libraries a previous run chose for this site, so `update` repeats them without asking.
  readonly savedDrives: (site: SiteRef) => Promise<ReadonlyArray<DriveSummary>>;
};

export type RunSyncInput = {
  readonly command: 'sync' | 'update';
  readonly siteId?: string;
  readonly siteUrl?: string;
  readonly driveIds: ReadonlyArray<string>;
  readonly maxBytes: number;
  readonly ocrLabel: string;
  readonly dryRun: boolean;
};

export type RunSync = (input: RunSyncInput) => Promise<Result<ReadonlyArray<RunSummary>, StepError>>;

const failed = (step: string, cause: string, message: string): Result<never, StepError> => err({ step, cause, message });

const syncedMarks = async (deps: RunSyncDeps): Promise<Readonly<Record<string, SyncedMark>>> => {
  const known = await deps.listSyncedSources();
  if (!known.ok) return {};
  return Object.fromEntries(known.value.map((source) => [source.id, { lastRun: source.lastRun, fileCount: source.fileCount }]));
};

const chooseLibraries = async (deps: RunSyncDeps, drives: ReadonlyArray<DriveSummary>): Promise<Result<ReadonlyArray<DriveSummary>, StepError>> => {
  const rows: ReadonlyArray<PickerRow> = drives.map((drive) => ({ id: drive.id, name: drive.name, webUrl: '' }));
  deps.prompt.show(renderLibraryPicker(rows));
  const chosen = parseSelection(await deps.prompt.ask('Libraries:'), drives.length);
  if (!chosen.ok) return failed('pickLibraries', chosen.error.kind, chosen.error.message);
  if (chosen.value.kind !== 'rows') return failed('pickLibraries', 'bad-choice', 'choose libraries by number, or all');
  return ok(chosen.value.indices.flatMap((index) => (drives[index] === undefined ? [] : [drives[index]])));
};

const librariesFor = async (deps: RunSyncDeps, site: SiteRef, wanted: ReadonlyArray<string>): Promise<Result<ReadonlyArray<DriveSummary>, StepError>> => {
  const drives = await deps.reader.listDrives(site.id);
  if (!drives.ok) return failed('listDrives', drives.error.kind, drives.error.message);
  if (wanted.length > 0) return ok(drives.value.filter((drive) => wanted.includes(drive.id)));
  return chooseLibraries(deps, drives.value);
};

const syncOne = async (deps: RunSyncDeps, input: RunSyncInput, site: SiteRef, drives: ReadonlyArray<DriveSummary>): Promise<Result<RunSummary, StepError>> => {
  if (drives.length === 0) return failed('sync', 'no-library', `no library chosen for ${site.name}`);
  deps.logger.info('sync.started', { siteId: site.id, libraries: drives.length });
  const summary = await deps.syncSite({ site, drives, maxBytes: input.maxBytes, ocrLabel: input.ocrLabel, dryRun: input.dryRun });
  if (summary.ok) deps.prompt.show(renderSummary(site.name, summary.value, input.dryRun));
  return summary;
};

const updateEverything = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<ReadonlyArray<RunSummary>, StepError>> => {
  const known = await deps.listSyncedSources();
  if (!known.ok) return known;
  const summaries: RunSummary[] = [];
  for (const source of known.value.filter((candidate) => candidate.kind === 'site')) {
    const site = { id: source.id, name: source.name, webUrl: '' };
    const summary = await syncOne(deps, input, site, await deps.savedDrives(site));
    if (!summary.ok) return summary;
    summaries.push(summary.value);
  }
  return ok(summaries);
};

const siteFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SiteRef, StepError> | undefined> => {
  if (input.siteUrl !== undefined) return siteAt(deps, input.siteUrl);
  if (input.siteId === undefined) return undefined;
  const found = await deps.reader.siteById(input.siteId);
  return found.ok ? ok(found.value) : failed('siteById', found.error.kind, found.error.message);
};

const siteAt = async (deps: RunSyncDeps, url: string): Promise<Result<SiteRef, StepError>> => {
  const found = await deps.reader.siteByUrl(url);
  return found.ok ? ok(found.value) : failed('siteByUrl', found.error.kind, found.error.message);
};

type Chosen = SiteRef | 'update-all' | 'quit';

const resolve = async (deps: RunSyncDeps, choice: Selection, sites: ReadonlyArray<SiteRef>): Promise<Result<Chosen, StepError>> => {
  if (choice.kind === 'quit') return ok('quit');
  if (choice.kind === 'update-all') return ok('update-all');
  if (choice.kind === 'address') return siteAt(deps, choice.url);
  const site = sites[choice.indices[0] ?? -1];
  return site === undefined ? failed('pickSite', 'bad-choice', 'choose one site') : ok(site);
};

const chooseSite = async (deps: RunSyncDeps): Promise<Result<Chosen, StepError>> => {
  const sites = await deps.reader.listSites();
  if (!sites.ok) return failed('listSites', sites.error.kind, sites.error.message);
  deps.prompt.show(renderSitePicker(annotate(sites.value, await syncedMarks(deps))));
  const chosen = parseSelection(await deps.prompt.ask('Source:'), sites.value.length);
  return chosen.ok ? resolve(deps, chosen.value, sites.value) : failed('pickSite', chosen.error.kind, chosen.error.message);
};

const runOne = async (deps: RunSyncDeps, input: RunSyncInput, site: SiteRef): Promise<Result<ReadonlyArray<RunSummary>, StepError>> => {
  const drives = await librariesFor(deps, site, input.driveIds);
  if (!drives.ok) return drives;
  const summary = await syncOne(deps, input, site, drives.value);
  return summary.ok ? ok([summary.value]) : summary;
};

export const createRunSync =
  (deps: RunSyncDeps): RunSync =>
  async (input) => {
    if (input.command === 'update') return updateEverything(deps, input);
    const named = await siteFromOptions(deps, input);
    if (named !== undefined) return named.ok ? runOne(deps, input, named.value) : named;
    const chosen = await chooseSite(deps);
    if (!chosen.ok) return chosen;
    if (chosen.value === 'quit') return ok([]);
    if (chosen.value === 'update-all') return updateEverything(deps, input);
    return runOne(deps, input, chosen.value);
  };
