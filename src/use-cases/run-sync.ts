import type { PickerRow, Selection, SyncedMark } from '../domain/picker.ts';
import { annotate, parseSelection } from '../domain/picker.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { SiteRef } from '../domain/site-state.ts';
import { MAILBOX_ID, MAILBOX_NAME } from '../domain/mail-state.ts';
import { renderLibraryPicker, renderReportPointer, renderSitePicker, renderSummary } from '../presenter/render-picker.ts';
import type { ListSyncedSources } from './list-synced-sources.ts';
import type { DriveReader, DriveSummary, SiteSummary } from './ports/drive-reader.ts';
import type { Logger } from './ports/logger.ts';
import type { Prompt } from './ports/prompt.ts';
import type { StepError } from './ports/step-error.ts';
import type { SourceRun, SyncSite } from './sync-site.ts';
import type { SiteCache } from '../domain/site-cache.ts';
import type { SyncMailbox } from './sync-mailbox.ts';
import type { WriteGlobalReport } from './write-global-report.ts';

export type RunSyncDeps = {
  readonly reader: DriveReader;
  readonly prompt: Prompt;
  readonly logger: Logger;
  readonly syncSite: SyncSite;
  readonly listSyncedSources: ListSyncedSources;
  // The libraries a previous run chose for this site, so `update` repeats them without asking.
  readonly savedDrives: (site: SiteRef) => Promise<ReadonlyArray<DriveSummary>>;
  // What the last run listed, so this one draws its picker at once instead of waiting on Graph.
  readonly cachedSites: () => Promise<SiteCache | undefined>;
  readonly rememberSites: (sites: ReadonlyArray<SiteSummary>) => Promise<void>;
  readonly syncMailbox: SyncMailbox;
  // One file naming what the whole run left behind, written once every source is done.
  readonly writeGlobalReport: WriteGlobalReport;
};

export type RunSyncInput = {
  readonly command: 'sync' | 'update';
  readonly siteId?: string;
  readonly siteUrl?: string;
  readonly driveIds: ReadonlyArray<string>;
  readonly maxBytes: number;
  readonly concurrency: number;
  readonly dryRun: boolean;
  readonly mailbox?: boolean;
  readonly since?: string;
  // Ignore what was stored and list for real, for when a site is known to be new.
  readonly refresh?: boolean;
};

// A run that stops carries out the sources that did finish. They wrote their documents and their own
// reports, so a global report that omitted them would claim less happened than did; `ran` is what the
// run got through before the step named by the error. Absent on errors raised before any source ran.
export type RunFailure = StepError & { readonly ran?: ReadonlyArray<SourceRun> };

export type RunSync = (input: RunSyncInput) => Promise<Result<ReadonlyArray<SourceRun>, RunFailure>>;

const stoppedAfter = (ran: ReadonlyArray<SourceRun>, error: StepError): Result<never, RunFailure> => err({ ...error, ran });

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

// `ask` is false once more than one site was chosen: putting the library question to the operator
// once per site is exactly what choosing them together was meant to avoid, so every library is taken.
const librariesFor = async (deps: RunSyncDeps, site: SiteRef, wanted: ReadonlyArray<string>, ask: boolean): Promise<Result<ReadonlyArray<DriveSummary>, StepError>> => {
  const drives = await deps.reader.listDrives(site.id);
  if (!drives.ok) return failed('listDrives', drives.error.kind, drives.error.message);
  if (wanted.length > 0) return ok(drives.value.filter((drive) => wanted.includes(drive.id)));
  return ask ? chooseLibraries(deps, drives.value) : ok(drives.value);
};

const syncOne = async (deps: RunSyncDeps, input: RunSyncInput, site: SiteRef, drives: ReadonlyArray<DriveSummary>): Promise<Result<SourceRun, StepError>> => {
  if (drives.length === 0) return failed('sync', 'no-library', `no library chosen for ${site.name}`);
  deps.logger.info('sync.started', { siteId: site.id, libraries: drives.length });
  const summary = await deps.syncSite({ site, drives, maxBytes: input.maxBytes, concurrency: input.concurrency, dryRun: input.dryRun });
  if (summary.ok) deps.prompt.show(renderSummary(site.name, summary.value.summary, input.dryRun));
  return summary;
};

const syncTheMailbox = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('mailbox.started', {});
  const summary = await deps.syncMailbox({ maxBytes: input.maxBytes, concurrency: input.concurrency, dryRun: input.dryRun, since: input.since });
  if (summary.ok) deps.prompt.show(renderSummary(MAILBOX_NAME, summary.value.summary, input.dryRun));
  return summary;
};

const updateEverything = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<ReadonlyArray<SourceRun>, RunFailure>> => {
  const known = await deps.listSyncedSources();
  if (!known.ok) return known;
  const summaries: SourceRun[] = [];
  if (known.value.some((candidate) => candidate.kind === 'mailbox')) {
    const mailbox = await syncTheMailbox(deps, input);
    if (!mailbox.ok) return stoppedAfter(summaries, mailbox.error);
    summaries.push(mailbox.value);
  }
  for (const source of known.value.filter((candidate) => candidate.kind === 'site')) {
    const site = { id: source.id, name: source.name, webUrl: '' };
    const summary = await syncOne(deps, input, site, await deps.savedDrives(site));
    if (!summary.ok) return stoppedAfter(summaries, summary.error);
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

type Chosen = ReadonlyArray<SiteRef> | 'update-all' | 'quit' | 'mailbox';

const oneSite = (found: Result<SiteRef, StepError>): Result<Chosen, StepError> => (found.ok ? ok([found.value]) : found);

const resolve = async (deps: RunSyncDeps, choice: Selection, sites: ReadonlyArray<SiteRef>): Promise<Result<Chosen, StepError>> => {
  if (choice.kind === 'quit') return ok('quit');
  if (choice.kind === 'mailbox') return ok('mailbox');
  if (choice.kind === 'update-all') return ok('update-all');
  if (choice.kind === 'address') return oneSite(await siteAt(deps, choice.url));
  // Selecting by position rather than by index lookup: `parseSelection` has already refused any
  // number outside the list, so there is no missing-site case left to guard against here.
  const chosen = sites.filter((_site, index) => choice.indices.includes(index));
  return chosen.length === 0 ? failed('pickSite', 'bad-choice', 'choose at least one site') : ok(chosen);
};

// What the picker is drawn from, and what to do about it afterwards. A stored list is shown at once
// and refreshed only once the run is committed to work, where thirty seconds alongside a sync that
// takes minutes costs nothing; quitting leaves the stored list as it was rather than paying for a
// refresh nobody asked for. Nothing stored, or `--refresh`, means listing for real before drawing.
type Listing = { readonly sites: ReadonlyArray<SiteSummary>; readonly fromCache: boolean };

const listedSites = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<Listing, StepError>> => {
  const cached = input.refresh === true ? undefined : await deps.cachedSites();
  if (cached !== undefined) return ok({ sites: cached.sites, fromCache: true });
  const fresh = await deps.reader.listSites();
  if (!fresh.ok) return failed('listSites', fresh.error.kind, fresh.error.message);
  await deps.rememberSites(fresh.value);
  return ok({ sites: fresh.value, fromCache: false });
};

// Listed again for next time, alongside the work rather than in front of it. A listing that fails
// leaves the stored one alone: it is still the best answer available, and the run has already got
// what it came for.
const refreshInBackground = async (deps: RunSyncDeps): Promise<void> => {
  const fresh = await deps.reader.listSites();
  if (fresh.ok) await deps.rememberSites(fresh.value);
};

type Picked = { readonly chosen: Chosen; readonly fromCache: boolean };

const chooseSite = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<Picked, StepError>> => {
  const listing = await listedSites(deps, input);
  if (!listing.ok) return listing;
  const { sites, fromCache } = listing.value;
  const marks = await syncedMarks(deps);
  deps.prompt.show(renderSitePicker(annotate(sites, marks), annotate([{ id: MAILBOX_ID, name: MAILBOX_NAME }], marks)[0] ?? { id: MAILBOX_ID, name: MAILBOX_NAME, webUrl: '' }));
  const chosen = parseSelection(await deps.prompt.ask('Source:'), sites.length);
  if (!chosen.ok) return failed('pickSite', chosen.error.kind, chosen.error.message);
  const resolved = await resolve(deps, chosen.value, sites);
  return resolved.ok ? ok({ chosen: resolved.value, fromCache }) : resolved;
};

const oneSummary = (summary: Result<SourceRun, StepError>): Result<ReadonlyArray<SourceRun>, StepError> => (summary.ok ? ok([summary.value]) : summary);

// Each site is summarised as it lands, so a run over many of them reports along the way. A site that
// fails stops the run there rather than burying the reason under the ones after it; every site
// finished before it keeps what it wrote, and a re-run resumes from its own checkpoint.
const runMany = async (deps: RunSyncDeps, input: RunSyncInput, chosen: ReadonlyArray<SiteRef>): Promise<Result<ReadonlyArray<SourceRun>, RunFailure>> => {
  const summaries: SourceRun[] = [];
  for (const site of chosen) {
    const drives = await librariesFor(deps, site, input.driveIds, chosen.length === 1);
    if (!drives.ok) return stoppedAfter(summaries, drives.error);
    const summary = await syncOne(deps, input, site, drives.value);
    if (!summary.ok) return stoppedAfter(summaries, summary.error);
    summaries.push(summary.value);
  }
  return ok(summaries);
};

const syncChosen = async (deps: RunSyncDeps, input: RunSyncInput, chosen: Exclude<Chosen, 'quit'>): Promise<Result<ReadonlyArray<SourceRun>, RunFailure>> => {
  if (chosen === 'update-all') return updateEverything(deps, input);
  if (chosen === 'mailbox') return oneSummary(await syncTheMailbox(deps, input));
  return runMany(deps, input, chosen);
};

// What a run left behind, across every source it touched: the two numbers a reader wants before
// deciding whether to open the report at all.
const leftBehind = (ran: ReadonlyArray<SourceRun>): { readonly skipped: number; readonly failed: number } =>
  ran.reduce((carried, run) => ({ skipped: carried.skipped + run.summary.skipped, failed: carried.failed + run.summary.failed }), { skipped: 0, failed: 0 });

const chooseAndSync = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<ReadonlyArray<SourceRun>, RunFailure>> => {
  if (input.command === 'update') return updateEverything(deps, input);
  if (input.mailbox === true) return oneSummary(await syncTheMailbox(deps, input));
  const named = await siteFromOptions(deps, input);
  if (named !== undefined) return named.ok ? runMany(deps, input, [named.value]) : named;
  const picked = await chooseSite(deps, input);
  if (!picked.ok) return picked;
  const { chosen, fromCache } = picked.value;
  // Quitting asks for nothing, so it pays for nothing: the stored list stands until a run that
  // actually works, where the listing rides alongside a sync that takes far longer than it does.
  if (chosen === 'quit') return ok([]);
  const refreshing = fromCache ? refreshInBackground(deps) : Promise.resolve();
  const chosenSummaries = await syncChosen(deps, input, chosen);
  await refreshing;
  return chosenSummaries;
};

// Every way of choosing sources funnels through here, so the report is written once at the end of a
// run however the run was asked for, rather than once per branch.
export const createRunSync =
  (deps: RunSyncDeps): RunSync =>
  async (input) => {
    const summaries = await chooseAndSync(deps, input);
    // A stopped run still reports: the sources it got through wrote their documents, and the file
    // says where it stopped so a short report is not read as a complete one.
    const ran = summaries.ok ? summaries.value : (summaries.error.ran ?? []);
    const stopped = summaries.ok ? undefined : `${summaries.error.step}: ${summaries.error.message}`;
    const path = await deps.writeGlobalReport({ ran, dryRun: input.dryRun, stopped });
    const left = leftBehind(ran);
    if (path !== undefined && left.skipped + left.failed > 0) deps.prompt.show(renderReportPointer(left, path));
    return summaries;
  };
