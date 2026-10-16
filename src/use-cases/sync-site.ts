import { addressKindOf } from '../domain/address-kind.ts';
import { planFile } from '../domain/conversion-plan.ts';
import { INDEX_FILE } from '../domain/index-page.ts';
import { libraryIndexPage } from '../domain/library-index.ts';
import { sweptFolders, underMoved } from '../domain/drive-folders.ts';
import type { FolderMove } from '../domain/drive-folders.ts';
import { goneItem, sameVersion } from '../domain/drive-item.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import { categoryFolderOf } from '../domain/kb-category.ts';
import { disambiguateSegment, idHash, safeSegment, sameIgnoringCase } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import { PEOPLE_NAME, emptyPeopleState, parsePeopleState } from '../domain/people-state.ts';
import type { PeopleState } from '../domain/people-state.ts';
import { hasMembers, peopleLinksOf, renderSiteMembers } from '../domain/site-members.ts';
import type { DriveState, SiteRef, SiteState } from '../domain/site-state.ts';
import {
  LIBRARY_LAYOUT,
  belongsToAnotherSite,
  emptySiteState,
  forgetFailure,
  forgetItem,
  ownOutputs,
  parseSiteState,
  recordItem,
  refileDrive,
  rememberFailure,
  serializeSiteState,
  withDrive,
} from '../domain/site-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { forgetSwept, givenUp, nextFailure } from '../domain/retry-policy.ts';
import type { RetryEntry } from '../domain/retry-policy.ts';
import { latestById, widens } from '../domain/sync-window.ts';
import { buildWorklist, goneFromListing } from '../domain/worklist.ts';
import type { ReportEntry, ReportNotes, ReportRun } from '../domain/report.ts';
import { appendReportRun, hasSomethingToReport, skipReason } from '../domain/report.ts';
import type { ManifestEntry, WorkItem } from '../domain/worklist.ts';
import type { RunSummary } from '../domain/run-summary.ts';
import type { ConvertFile } from './convert-file.ts';
import { sweepDrive } from './enumerate-drive.ts';
import { expiredCursor, notFound } from './graph-status.ts';
import type { DriveSweep } from './enumerate-drive.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader, DriveReaderError, DriveSummary } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { StepError } from './ports/step-error.ts';
import { heldInPlace, letGo, putAside, putBack, setAside } from './put-aside.ts';
import type { SetAside, WriteDown } from './put-aside.ts';
import { refileAll } from './refile.ts';

export const STATE_FILE_NAME = '.sync-state.json';

export type SyncSiteDeps = {
  readonly reader: DriveReader;
  readonly files: Files;
  readonly convertFile: ConvertFile;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  readonly kbRoot: string;
  // The zone the knowledge base counts its days in, which the library page lists each document under.
  readonly timezone: string;
  // Where the files this sync lets go that would not move under the archive are written down, so a
  // later run moves them. Absent, such a file is only logged.
  readonly writeDown?: WriteDown;
};

export type SyncSiteInput = {
  readonly site: SiteRef;
  readonly drives: ReadonlyArray<DriveSummary>;
  readonly maxBytes: number;
  readonly dryRun: boolean;
  // How many items to convert at once. Each item's outputs are its own, so a window of them runs in
  // parallel and the manifest updates fold afterwards; a window interrupted re-runs, writing the
  // same bytes to the same paths.
  readonly concurrency: number;
  // Only files last edited on or after this day are converted; absent, every file is.
  readonly since?: string;
};

// Defined in the domain, where the presenter can read it too; exported here as well, where every
// source already takes it from.
export type { RunSummary };

// What one source's run hands back. The notes used to stop at this source's own report; the global
// report needs them a level up, where every source of a run can be written to one file.
export type SourceRun = {
  // Keyed by id, not by name: two sites can carry the same display name, and a report that mistook
  // one for the other would drop the untouched one from its tail, reading as if it were clean.
  readonly id: string;
  readonly source: string;
  readonly summary: RunSummary;
  readonly notes: RunNotes;
};

export type SyncSite = (input: SyncSiteInput) => Promise<Result<SourceRun, StepError>>;

const EMPTY: RunSummary = { converted: 0, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const add = (left: RunSummary, right: Partial<RunSummary>): RunSummary => ({
  converted: left.converted + (right.converted ?? 0),
  moved: left.moved + (right.moved ?? 0),
  archived: left.archived + (right.archived ?? 0),
  skipped: left.skipped + (right.skipped ?? 0),
  failed: left.failed + (right.failed ?? 0),
  queued: left.queued + (right.queued ?? 0),
});

const siteRoot = (kbRoot: string, segment: string): string => `${kbRoot}/${segment}`;

const libraryRootOf = (kbRoot: string, segment: string, drive: DriveSummary): string => `${siteRoot(kbRoot, segment)}/${safeSegment(drive.name)}`;

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

// Two sites can share a display name, so the default path can hold someone else's file: that
// folder's own state names its real owner (`SiteState.source.id`), checked once here before
// anything is read or written under it. A collision moves this site into a disambiguated folder
// instead, the other site's file untouched; the common, uncollided case costs the one read below.
export type ResolvedSite = { readonly segment: string; readonly state: SiteState };

// Narrower than `SyncSiteDeps` on purpose: anything that needs to find a site's folder can ask,
// without owning a converter or a progress bar. `SyncSiteDeps` satisfies it as it stands.
export type ResolveSiteDeps = { readonly files: Files; readonly logger: Logger; readonly kbRoot: string };

export const resolveSite = async (deps: ResolveSiteDeps, site: SiteRef): Promise<ResolvedSite> => {
  const category = categoryFolderOf(site.webUrl);
  const defaultSegment = `${category}/${safeSegment(site.name)}`;
  const defaultState = await loadState(deps.files, `${siteRoot(deps.kbRoot, defaultSegment)}/${STATE_FILE_NAME}`, site, deps.logger);
  if (!belongsToAnotherSite(defaultState, site)) return { segment: defaultSegment, state: defaultState };
  deps.logger.warn('sync.site-name-collision', { siteId: site.id, name: site.name });
  const segment = `${category}/${disambiguateSegment(site.name, idHash(site.id))}`;
  return { segment, state: await loadState(deps.files, `${siteRoot(deps.kbRoot, segment)}/${STATE_FILE_NAME}`, site, deps.logger) };
};

export type ResolvedInput = SyncSiteInput & { readonly segment: string };

// The work a stopped run queued holds the paths of the earlier layout, so it is worked through first,
// and the run after it moves the library.
const hasQueue = (state: SiteState): boolean => Object.values(state.drives).some((drive) => drive.pending.length > 0);

// Each file a move left behind, recorded where it still is.
const stayedAt = (drive: DriveState, stuck: ReadonlyMap<string, string>): DriveState => ({
  ...drive,
  items: Object.fromEntries(Object.entries(drive.items).map(([id, entry]) => [id, { ...entry, outputs: entry.outputs.map((output) => stuck.get(output) ?? output) }] as const)),
});

// The first run of this layout moves every document out of the day folder the first layout filed it
// under, once. The moves are not put aside: nothing is superseded, only filed again. A file that will
// not move keeps the library in the earlier layout, so the next run moves what is left.
const refile = async (deps: SyncSiteDeps, input: ResolvedInput, state: SiteState): Promise<SiteState> => {
  const drives: Record<string, DriveState> = {};
  let settled = true;
  for (const [id, drive] of Object.entries(state.drives)) {
    const refiled = refileDrive(libraryRootOf(deps.kbRoot, input.segment, { id, name: drive.name }), drive);
    const stuck = await refileAll(deps, refiled.moves);
    settled &&= stuck.size === 0;
    drives[id] = stayedAt(refiled.drive, stuck);
  }
  return { ...state, drives, layout: settled ? LIBRARY_LAYOUT : state.layout };
};

// The library as a reader scans it, made from the state. A page that will not write is logged and
// leaves the run standing: the documents themselves already landed.
const writeLibraryIndex = async (deps: SyncSiteDeps, input: ResolvedInput, drive: DriveSummary, state: SiteState): Promise<void> => {
  if (input.dryRun) return;
  const root = libraryRootOf(deps.kbRoot, input.segment, drive);
  const path = `${root}/${INDEX_FILE}`;
  const written = await deps.files.writeText(path, libraryIndexPage(drive.name, root, state.drives[drive.id], deps.timezone));
  if (!written.ok) deps.logger.warn('index.failed', { path, cause: written.error.kind });
};

export const createSyncSite =
  (deps: SyncSiteDeps): SyncSite =>
  async (rawInput) => {
    const resolved = await resolveSite(deps, rawInput.site);
    const input: ResolvedInput = { ...rawInput, segment: resolved.segment };
    const statePath = `${siteRoot(deps.kbRoot, resolved.segment)}/${STATE_FILE_NAME}`;
    let state = input.dryRun || resolved.state.layout === LIBRARY_LAYOUT || hasQueue(resolved.state) ? resolved.state : await refile(deps, input, resolved.state);
    let summary = EMPTY;
    let notes = NO_NOTES;
    for (const drive of input.drives) {
      const outcome = await syncDrive(deps, input, drive, state, statePath);
      if (!outcome.ok) return outcome;
      state = outcome.value.state;
      summary = add(summary, outcome.value.summary);
      notes = mergeNotes(notes, outcome.value.notes);
      await writeLibraryIndex(deps, input, drive, state);
    }
    const finished = { ...state, lastRun: deps.clock.nowIso() };
    const saved = await save(deps.files, statePath, finished, input.dryRun);
    if (!saved.ok) return saved;
    await writeReport(deps, input, siteRoot(deps.kbRoot, resolved.segment), input.site.name, summary, notes);
    await writeMembers(deps, input);
    return ok({ id: input.site.id, source: input.site.name, summary, notes });
  };

export const REPORT_FILE_NAME = '_sync-report.md';

export const countsLine = (summary: RunSummary): string =>
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
  // A log of runs: an item out of tries is named in the run that gave up on it, and not by every run
  // after. The report of the whole run is the one that lists every item still given up.
  const run: ReportRun = { source, at: deps.clock.nowIso(), counts: countsLine(summary), ...notes, givenUp: notes.gaveUp ?? [] };
  if (input.dryRun || !hasSomethingToReport(run)) return;
  const path = `${root}/${REPORT_FILE_NAME}`;
  const existing = await deps.files.readText(path);
  const written = await deps.files.writeText(path, appendReportRun(existing.ok ? existing.value : undefined, run));
  if (!written.ok) deps.logger.warn('report.failed', { cause: written.error.kind });
};

export const MEMBERS_FILE_NAME = '_members.md';

// The People sync's own record of the pages it wrote. Without one, or with one that cannot be read,
// the members page names people without linking them.
const loadPeople = async (files: Files, kbRoot: string): Promise<PeopleState> => {
  const text = await files.readText(`${kbRoot}/${PEOPLE_NAME}/${STATE_FILE_NAME}`);
  const parsed = text.ok ? parseJson(text.value) : undefined;
  const state = parsed?.ok ? parsePeopleState(parsed.value) : undefined;
  return state?.ok ? state.value : emptyPeopleState();
};

// A site that answers with nobody no longer says who can open it, so its page goes where anything
// the source no longer has goes. A refused read says nothing either way and keeps the page.
const archiveMembers = async (deps: SyncSiteDeps, input: ResolvedInput, path: string): Promise<void> => {
  const present = await deps.files.exists(path);
  if (!present.ok || !present.value) return;
  for (const missed of await putAside(deps, [path])) deps.logger.warn('members.archive-failed', { siteId: input.site.id, cause: missed.error.kind });
};

// Who can open the site, read once a run after its libraries. Only a SharePoint site is asked: a Loop
// workspace and a OneDrive have no group of people behind them. A read or a write that fails is
// logged and costs the run nothing.
const writeMembers = async (deps: SyncSiteDeps, input: ResolvedInput): Promise<void> => {
  if (input.dryRun || addressKindOf(input.site.webUrl) !== 'site') return;
  const found = await deps.reader.members(input.site.id);
  if (!found.ok) {
    deps.logger.warn('members.unavailable', { siteId: input.site.id, cause: found.error.kind });
    return;
  }
  const path = `${siteRoot(deps.kbRoot, input.segment)}/${MEMBERS_FILE_NAME}`;
  if (!hasMembers(found.value)) {
    await archiveMembers(deps, input, path);
    return;
  }
  const links = peopleLinksOf(await loadPeople(deps.files, deps.kbRoot), deps.kbRoot, input.segment);
  const page = renderSiteMembers(input.site, found.value, links);
  const existing = await deps.files.readText(path);
  if (existing.ok && existing.value === page) return;
  const written = await deps.files.writeText(path, page);
  if (!written.ok) deps.logger.warn('members.failed', { siteId: input.site.id, cause: written.error.kind });
};

const save = async (files: Files, path: string, state: SiteState, dryRun: boolean): Promise<Result<void, StepError>> => {
  if (dryRun) return ok(undefined);
  const written = await files.writeText(path, serializeSiteState(state));
  return written.ok ? ok(undefined) : { ok: false, error: { step: 'saveState', cause: written.error.kind, message: written.error.message } };
};

type DriveOutcome = { readonly state: SiteState; readonly summary: RunSummary; readonly notes: RunNotes };

const syncDrive = async (deps: SyncSiteDeps, input: ResolvedInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<DriveOutcome, StepError>> => {
  const queued = await queueWork(deps, input, drive, state, statePath);
  if (!queued.ok) return queued;
  if (input.dryRun) return ok({ state: queued.value.state, summary: add(EMPTY, { queued: queued.value.state.drives[drive.id]?.pending.length ?? 0 }), notes: NO_NOTES });
  const done = await processQueue(deps, input, drive, queued.value.state, statePath);
  if (!done.ok) return done;
  const after = done.value.state.drives[drive.id];
  return ok({ ...done.value, notes: mergeNotes(done.value.notes, { givenUp: givenUpNotes(after), gaveUp: gaveUpNotes(state.drives[drive.id], after) }) });
};

const givenUpEntries = (drive: DriveState | undefined): ReadonlyArray<readonly [string, RetryEntry]> => Object.entries(drive?.retry ?? {}).filter(([, entry]) => givenUp(entry));

const noteOf = ([, entry]: readonly [string, RetryEntry]): ReportEntry => ({ path: entry.item.path, reason: entry.reason });

// Read off the ledger rather than off this run's work, because a document out of tries is precisely
// one this run did nothing about. Naming it every run is the point: it is the only thing standing
// between a file nobody can convert and a file nobody knows about. The report of the whole run
// names these; the library's own report names only the ones this run gave up on.
const givenUpNotes = (drive: DriveState | undefined): ReadonlyArray<ReportEntry> => givenUpEntries(drive).map(noteOf);

const gaveUpNotes = (before: DriveState | undefined, after: DriveState | undefined): ReadonlyArray<ReportEntry> => {
  const already = new Set(givenUpEntries(before).map(([id]) => id));
  return givenUpEntries(after)
    .filter(([id]) => !already.has(id))
    .map(noteOf);
};

const queueWork = async (deps: SyncSiteDeps, input: SyncSiteInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<{ state: SiteState }, StepError>> => {
  const known: DriveState = state.drives[drive.id] ?? { name: drive.name, pending: [], items: {}, retry: {} };
  if (known.pending.length > 0) {
    deps.logger.info('sync.resuming', { driveId: drive.id, pending: known.pending.length });
    return ok({ state });
  }
  const swept = await sweepFor(deps, drive.id, known, input.since);
  if (!swept.ok) return { ok: false, error: { step: 'enumerate', cause: swept.error.kind, message: swept.error.message } };
  deps.logger.info('sync.enumerated', { driveId: drive.id, items: swept.value.items.length, skipped: swept.value.skipped });
  const folders = sweptFolders(known.folders ?? {}, swept.value.items);
  const followed = await followMoves(deps, { driveId: drive.id, concurrency: input.concurrency }, known, swept.value.items, folders.moves);
  if (!followed.ok) return { ok: false, error: { step: 'enumerate', cause: followed.error.kind, message: followed.error.message } };
  if (folders.moves.length > 0) deps.logger.info('sync.folders-moved', { driveId: drive.id, folders: folders.moves.length, documents: followed.value.length });
  const items = listedItems(known, swept.value, followed.value);
  const queued = {
    ...known,
    name: drive.name,
    deltaLink: swept.value.deltaLink,
    since: input.since,
    pending: buildWorklist(items, known.items, known.retry, input.since),
    retry: forgetSwept(known.retry, items),
    folders: swept.value.complete || known.folders !== undefined ? folders.folders : undefined,
  };
  const next = withDrive(state, drive.id, queued);
  const saved = await save(deps.files, statePath, next, input.dryRun);
  return saved.ok ? ok({ state: next }) : saved;
};

// A day earlier than the one the cursor was taken under: what the cursor passed over never comes back
// through it. A library filed before its folders were kept: the folders of the documents it holds were
// never reported, and only a whole read reports them. Either way the cursor is read out first all the
// same, so what was deleted or moved since the last run is still seen, then the library is read whole;
// a document already filed at the same version is left as it is.
const readsWhole = (known: DriveState, since: string | undefined): boolean =>
  known.deltaLink !== undefined && (widens(known.since, since) || (known.folders === undefined && Object.keys(known.items).length > 0));

// What a sweep found, and whether it listed the library whole: a read from the root that reached the
// cursor closing it. Such a read lists every document the library holds, so one recorded that it does
// not list was deleted at a time no delta told of. A read that stopped short, on a page Graph handed
// back twice, lists part of it, and what it did not reach is not gone for that.
type Listing = DriveSweep & { readonly complete: boolean };

const listing = (sweep: DriveSweep, fromRoot: boolean): Listing => ({ ...sweep, complete: fromRoot && sweep.deltaLink !== undefined });

// Graph answers 410 to a cursor whose sync state it no longer keeps, and asks for a read from the start,
// compared with what is held: the library is read whole, and what it does not list is gone.
const readAgain = async (deps: SyncSiteDeps, driveId: string): Promise<Result<Listing, DriveReaderError>> => {
  deps.logger.warn('sync.cursor-expired', { driveId });
  const whole = await sweepDrive(deps.reader, driveId, undefined);
  return whole.ok ? ok(listing(whole.value, true)) : whole;
};

// A whole read that stopped short hands back no cursor, and none is kept: the next run reads the
// library from the root again, which a cursor kept from the drain would hide for a wider day.
const sweepFor = async (deps: SyncSiteDeps, driveId: string, known: DriveState, since: string | undefined): Promise<Result<Listing, DriveReaderError>> => {
  const drained = await sweepDrive(deps.reader, driveId, known.deltaLink);
  if (!drained.ok) return expiredCursor(drained.error) ? readAgain(deps, driveId) : drained;
  if (!readsWhole(known, since)) return ok(listing(drained.value, known.deltaLink === undefined));
  const whole = await sweepDrive(deps.reader, driveId, undefined);
  if (!whole.ok) return whole;
  return ok({
    items: latestById([...drained.value.items, ...whole.value.items]),
    skipped: drained.value.skipped + whole.value.skipped,
    deltaLink: whole.value.deltaLink,
    complete: whole.value.deltaLink !== undefined,
  });
};

// What the run decides on: the sweep, the documents a moved folder took with it, and, after a read
// that listed the library whole, each recorded document it did not list, as one deleted. Graph can
// name one item twice in a delta, and says to use the last one: one decision for each document.
const listedItems = (known: DriveState, swept: Listing, followed: ReadonlyArray<DriveItem>): ReadonlyArray<DriveItem> => {
  const listed = latestById([...swept.items, ...followed]);
  return swept.complete ? [...listed, ...goneFromListing(listed, known.items, known.retry)] : listed;
};

// Where each document recorded, or waiting on a retry, was last known to be.
const recordedPaths = (known: DriveState): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(Object.entries(known.retry).map(([id, entry]) => [id, entry.item.path])),
  ...Object.fromEntries(Object.entries(known.items).map(([id, entry]) => [id, entry.path])),
});

// The documents a moved folder took with it: Graph reports the folder alone, so each document recorded
// under the path it left is read again by id, a few at a time. One Graph answers 404 for is gone.
// Another refusal that will not pass, or an answer that cannot be read, says nothing of where the
// document is: it stays where it is recorded, named in the log. Any other failure stops the library
// before its cursor moves, so the next run reads the same changes, the moved folder with them, and
// looks again.
const followMoves = async (
  deps: SyncSiteDeps,
  where: { readonly driveId: string; readonly concurrency: number },
  known: DriveState,
  swept: ReadonlyArray<DriveItem>,
  moves: ReadonlyArray<FolderMove>
): Promise<Result<ReadonlyArray<DriveItem>, DriveReaderError>> => {
  const ids = underMoved(recordedPaths(known), swept, moves);
  const found: DriveItem[] = [];
  for (let at = 0; at < ids.length; at += where.concurrency) {
    const read = await Promise.all(ids.slice(at, at + where.concurrency).map(async (itemId) => ({ itemId, outcome: await deps.reader.item({ driveId: where.driveId, itemId }) })));
    for (const { itemId, outcome } of read) {
      if (outcome.ok) found.push(outcome.value);
      else if (notFound(outcome.error)) found.push(goneItem(itemId));
      else if (outcome.error.kind !== 'permanent') return outcome;
      else deps.logger.warn('sync.reread-failed', { driveId: where.driveId, itemId, cause: outcome.error.kind });
    }
  }
  return ok(found);
};

// What the moving counter names for each item: the path it sits at, or the id of one being archived.
const labelOf = (work: WorkItem): string => (work.kind === 'archive' ? work.itemId : work.item.path);

const processQueue = async (deps: SyncSiteDeps, input: ResolvedInput, drive: DriveSummary, state: SiteState, statePath: string): Promise<Result<DriveOutcome, StepError>> => {
  let current = state;
  let summary = EMPTY;
  let notes = NO_NOTES;
  // Named for the source rather than the verb: `all` works through twenty-odd sites in one run, and
  // a path alone never says which of them a file came from.
  deps.progress.start(current.drives[drive.id]?.pending.length ?? 0, `${input.site.name} / ${drive.name}`);
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

// The same three lists the reports draw, named in the domain so both reports share the shape.
export type RunNotes = ReportNotes;

const NO_NOTES: RunNotes = { skipped: [], failed: [], givenUp: [], archived: [] };

const mergeNotes = (left: RunNotes, right: Partial<RunNotes>): RunNotes => {
  const gaveUp = [...(left.gaveUp ?? []), ...(right.gaveUp ?? [])];
  return {
    skipped: [...left.skipped, ...(right.skipped ?? [])],
    failed: [...left.failed, ...(right.failed ?? [])],
    givenUp: [...left.givenUp, ...(right.givenUp ?? [])],
    ...(gaveUp.length === 0 ? {} : { gaveUp }),
    archived: [...left.archived, ...(right.archived ?? [])],
  };
};

// The IO (converting, moving, archiving) happens now; the manifest change it implies comes back as a
// function so a whole window's updates fold onto the manifest in order, after the parallel IO.
type WorkOutcome = { readonly update: (drive: DriveState) => DriveState; readonly counted: Partial<RunSummary>; readonly notes?: Partial<RunNotes> };

// A move a run of an earlier version queued carries its item, so it is converted at its new place
// like any other renamed document.
const applyWork = async (deps: SyncSiteDeps, input: ResolvedInput, drive: DriveSummary, driveState: DriveState, work: WorkItem): Promise<WorkOutcome> => {
  if (work.kind === 'archive') return archiveOutputs(deps, input, drive, driveState, work.itemId, work.outputs);
  return convertOne(deps, input, drive, driveState, work.item);
};

// A document converted again, after an edit or a move, has the version before it set aside first,
// under the day of the run: the knowledge base keeps its old versions without any help from git, and
// a move leaves nothing at the place the document left. A conversion that fails puts that version
// back, and it stays the current one.
const setAsideBefore = async (deps: SyncSiteDeps, held: ReadonlyArray<string>): Promise<SetAside> => {
  const aside = await setAside(deps, held);
  for (const missed of aside.failed) deps.logger.warn('supersede.failed', { path: missed.path, cause: missed.error.kind });
  return aside;
};

const NOTHING_ASIDE: SetAside = { moved: [], failed: [] };

// A document left out now had its earlier files set aside first. The report says where they went,
// the folder of the run under the archive, since the document is no longer where it was.
const leftOutReason = (kbRoot: string, reason: string, aside: SetAside): string => {
  const to = aside.moved[0]?.to;
  return to === undefined
    ? reason
    : `${reason}. Its earlier version is in ${to
        .slice(kbRoot.length + 1)
        .split('/')
        .slice(0, 2)
        .join('/')}/.`;
};

// A document converted again at the version already recorded, to bring back a part that would not
// read, writes over its own files: a copy of the same version under the archive for each try would
// keep nothing worth keeping. What such a conversion no longer writes goes aside after it, so no file
// stays behind without a record.
const atRecordedVersion = (driveState: DriveState, item: DriveItem): boolean => {
  const held = driveState.items[item.id];
  return held !== undefined && sameVersion(item, { cTag: held.cTag, lastModified: held.modified }) && held.path === item.path;
};

const leftBehind = (driveState: DriveState, itemId: string, outputs: ReadonlyArray<string>): ReadonlyArray<string> =>
  ownOutputs(driveState, itemId).filter((output) => !outputs.includes(output));

// An edit whose version before would not move aside, a file held open most often, would write over
// it, and the version would be lost. The conversion waits for a run that can move it, three runs in
// all, and the files on disk stay the current ones.
const waiting = async (deps: SyncSiteDeps, driveState: DriveState, item: DriveItem, aside: SetAside, reason: string): Promise<WorkOutcome> => {
  for (const missed of await putBack(deps, aside)) deps.logger.warn('restore.failed', { path: missed.path, cause: missed.error.kind });
  const entry = nextFailure(driveState.retry[item.id], item, reason);
  return { update: (manifest) => rememberFailure(manifest, entry), counted: { failed: 1 }, notes: givenUp(entry) ? {} : { failed: [{ path: item.path, reason }] } };
};

// What a conversion needs before it starts: the version before set aside, unless the same version is
// written again, and the reason to wait when a file of it would not move and the conversion would
// write over it. A document left out for its kind or its size writes nothing, so nothing stops it.
type Ready = { readonly again: boolean; readonly aside: SetAside; readonly held?: string };

const ready = async (deps: SyncSiteDeps, input: ResolvedInput, driveState: DriveState, item: DriveItem): Promise<Ready> => {
  const again = atRecordedVersion(driveState, item);
  const aside = again ? NOTHING_ASIDE : await setAsideBefore(deps, ownOutputs(driveState, item.id));
  // Letter case aside, as Windows and macOS read a path: a rename in case alone writes over the same file.
  const inPlace = sameIgnoringCase(driveState.items[item.id]?.path ?? '', item.path) && planFile({ name: item.name, size: item.size }, input.maxBytes).kind !== 'skip';
  return { again, aside, held: inPlace ? await heldInPlace(deps, aside) : undefined };
};

const convertOne = async (deps: SyncSiteDeps, input: ResolvedInput, drive: DriveSummary, driveState: DriveState, item: DriveItem): Promise<WorkOutcome> => {
  const { again, aside, held } = await ready(deps, input, driveState, item);
  if (held !== undefined) return waiting(deps, driveState, item, aside, held);
  const outcome = await deps.convertFile({
    item,
    driveId: drive.id,
    libraryRoot: libraryRootOf(deps.kbRoot, input.segment, drive),
    site: input.site.name,
    library: drive.name,
    maxBytes: input.maxBytes,
  });
  if (outcome.kind === 'failed') {
    deps.logger.warn('convert.failed', { itemId: item.id, reason: outcome.reason });
    for (const missed of await putBack(deps, aside)) deps.logger.warn('restore.failed', { path: missed.path, cause: missed.error.kind });
    const entry = nextFailure(driveState.retry[item.id], item, outcome.reason);
    // The ledger's own list names an item that has run out of tries, so reporting it here as well
    // would print it twice under headings promising opposite things.
    const notes = givenUp(entry) ? {} : { failed: [{ path: item.path, reason: outcome.reason }] };
    return { update: (manifest) => rememberFailure(manifest, entry), counted: { failed: 1 }, notes };
  }
  const outputs = outcome.kind === 'converted' ? outcome.outputs : [];
  const moved = again ? await setAsideBefore(deps, leftBehind(driveState, item.id, outputs)) : aside;
  // Settled: a file of the version before that would not move is no longer the document's.
  await letGo(deps, moved);
  // A conversion, and a decision to leave the file alone, both settle what an earlier failure was
  // waiting on: the ledger entry goes with them.
  const recorded = { path: item.path, cTag: item.cTag, outputs, modified: item.lastModified, modifiedBy: item.modifiedBy };
  const update = (manifest: DriveState): DriveState => forgetFailure(recordItem(manifest, item.id, recorded), item.id);
  if (outcome.kind === 'converted') return outcome.lost === undefined ? { update, counted: { converted: 1 } } : partly(driveState, item, recorded, outcome.lost);
  return {
    update,
    counted: { skipped: 1 },
    notes: { skipped: [{ path: item.path, reason: leftOutReason(deps.kbRoot, skipReason(outcome.reason, input.maxBytes, item.name), moved) }] },
  };
};

// A document that landed without a part of it, its pictures or its slides: recorded at what it wrote,
// counted as failed as well, and tried again on the next run for the rest, three times in all, as one
// that failed is.
const partly = (driveState: DriveState, item: DriveItem, recorded: ManifestEntry, lost: string): WorkOutcome => {
  const entry = nextFailure(driveState.retry[item.id], item, lost);
  return {
    update: (manifest) => rememberFailure(recordItem(manifest, item.id, recorded), entry),
    counted: { converted: 1, failed: 1 },
    notes: givenUp(entry) ? {} : { failed: [{ path: item.path, reason: lost }] },
  };
};

const archiveOutputs = async (
  deps: SyncSiteDeps,
  input: ResolvedInput,
  drive: DriveSummary,
  driveState: DriveState,
  itemId: string,
  outputs: ReadonlyArray<string>
): Promise<WorkOutcome> => {
  for (const missed of await putAside(deps, outputs)) deps.logger.warn('archive.failed', { itemId, cause: missed.error.kind });
  const known = driveState.items[itemId];
  return {
    update: (manifest) => forgetItem(manifest, itemId),
    counted: { archived: 1 },
    notes: { archived: [{ path: known?.path ?? itemId, reason: 'no longer at the source' }] },
  };
};
