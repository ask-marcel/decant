import type { PickerRow, Selection, SyncedMark } from '../domain/picker.ts';
import { annotate, parseSelection } from '../domain/picker.ts';
import { kindOf, orderByKind } from '../domain/address-kind.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { SiteRef } from '../domain/site-state.ts';
import { MAILBOX_ID, MAILBOX_NAME } from '../domain/mail-state.ts';
import { PEOPLE_ID, PEOPLE_NAME } from '../domain/people-state.ts';
import { CALENDAR_ID, CALENDAR_NAME } from '../domain/calendar-state.ts';
import { sourceKey } from '../domain/sync-state.ts';
import type { SourceKind, SyncedSource } from '../domain/sync-state.ts';
import { SINCE_SHAPE, dayOf, parseSince } from '../domain/sync-window.ts';
import type { ListSyncedSources } from './list-synced-sources.ts';
import type { DriveReader, DriveSummary, SiteSummary } from './ports/drive-reader.ts';
import type { Logger } from './ports/logger.ts';
import type { Prompt } from './ports/prompt.ts';
import type { PickerView } from './ports/picker-view.ts';
import type { StepError } from './ports/step-error.ts';
import type { GroupReader, GroupSummary } from './ports/group-reader.ts';
import type { TodoList, TodoReader } from './ports/todo-reader.ts';
import type { ChannelSummary, TeamReader, TeamSummary } from './ports/team-reader.ts';
import type { SyncGroup } from './sync-group.ts';
import type { SyncPeople } from './sync-people.ts';
import type { SyncCalendar } from './sync-calendar.ts';
import type { SyncNotebook } from './sync-notebook.ts';
import type { SyncLists } from './sync-lists.ts';
import type { SyncPlan } from './sync-plan.ts';
import type { PlanReader } from './ports/plan-reader.ts';
import type { Plan } from '../domain/planner.ts';
import type { NotebookReader } from './ports/notebook-reader.ts';
import type { Notebook } from '../domain/onenote.ts';
import type { SyncTeam } from './sync-team.ts';
import type { SyncTodo } from './sync-todo.ts';
import type { SourceRun, SyncSite } from './sync-site.ts';
import type { SiteCache } from '../domain/site-cache.ts';
import type { SyncMailbox } from './sync-mailbox.ts';
import type { WriteGlobalReport } from './write-global-report.ts';

export type RunSyncDeps = {
  readonly reader: DriveReader;
  readonly prompt: Prompt;
  // The words the run shows, from the presenter: the run decides what to say and when, not how.
  readonly view: PickerView;
  readonly logger: Logger;
  readonly syncSite: SyncSite;
  readonly listSyncedSources: ListSyncedSources;
  // The libraries a previous run chose for this site, so `update` repeats them without asking.
  readonly savedDrives: (site: SiteRef) => Promise<ReadonlyArray<DriveSummary>>;
  // What the last run listed, so this one draws its picker at once instead of waiting on Graph.
  readonly cachedSites: () => Promise<SiteCache | undefined>;
  readonly rememberSites: (sites: ReadonlyArray<SiteSummary>) => Promise<void>;
  // How far back the runs reach, as an earlier run kept it: undefined when none ever was, refused
  // when the file keeping it says something that is not a reach.
  readonly storedSince: () => Promise<Result<string | undefined, StepError>>;
  // Kept for every run after this one. One that cannot be kept is asked for again on the next run.
  readonly rememberSince: (since: string) => Promise<void>;
  readonly syncMailbox: SyncMailbox;
  readonly syncGroup: SyncGroup;
  readonly syncTodo: SyncTodo;
  readonly syncTeam: SyncTeam;
  readonly syncPeople: SyncPeople;
  readonly syncCalendar: SyncCalendar;
  readonly syncNotebook: SyncNotebook;
  readonly syncLists: SyncLists;
  readonly syncPlan: SyncPlan;
  // Only the listing half of the group reader: choosing a source needs to know which groups can be
  // read, and reading one is the use-case's business, not the picker's.
  readonly groups: Pick<GroupReader, 'listGroups'>;
  // The listing half of the To Do reader, for the same reason: which lists exist is the picker's
  // business, and reading one is the use-case's.
  readonly todo: Pick<TodoReader, 'taskLists'>;
  // A team is chosen the way a site is, then asked which of its channels to take the way a site is
  // asked about its libraries, so the picker needs both listings and none of the reading.
  readonly teams: Pick<TeamReader, 'listTeams' | 'listChannels'>;
  // The channels a previous run chose for this team, so `update` repeats them without asking.
  readonly savedChannels: (team: TeamSummary) => Promise<ReadonlyArray<ChannelSummary>>;
  // The listing half of the notebook reader. A notebook is found through the sites the picker
  // already knows, so the listing takes those and asks each in turn.
  readonly notebooks: Pick<NotebookReader, 'listNotebooks'>;
  // The notebook as an earlier run recorded it, site and all, so `update` can reach it without
  // listing every site again.
  readonly savedNotebook: (source: { readonly id: string; readonly name: string }) => Promise<Notebook | undefined>;
  // The plans are found through the groups the picker already lists, and one named by id is
  // fetched outright, which is what a plan no listing answers for needs.
  readonly plans: Pick<PlanReader, 'listPlans' | 'plan'>;
  // The plan as an earlier run recorded it, so `update` can reach it without listing again.
  readonly savedPlan: (source: { readonly id: string; readonly name: string }) => Promise<Plan | undefined>;
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
  readonly people?: boolean;
  readonly calendar?: boolean;
  readonly groupId?: string;
  readonly todoListId?: string;
  readonly teamId?: string;
  readonly notebookId?: string;
  // The site whose lists to sync, by name, id or address.
  readonly listsSite?: string;
  // The plan to sync, by its title among the plans listed or by its id.
  readonly planId?: string;
  // How far back to reach, a day or all, as `--since` named it. Kept for every run after this one,
  // in place of whatever an earlier run kept.
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
  return Object.fromEntries(known.value.map((source) => [sourceKey(source), { lastRun: source.lastRun, fileCount: source.fileCount }]));
};

const chooseLibraries = async (deps: RunSyncDeps, drives: ReadonlyArray<DriveSummary>): Promise<Result<ReadonlyArray<DriveSummary>, StepError>> => {
  const rows: ReadonlyArray<PickerRow> = drives.map((drive) => ({ id: drive.id, name: drive.name, webUrl: '' }));
  deps.prompt.show(deps.view.libraryPicker(rows));
  const chosen = parseSelection(await deps.prompt.ask('Libraries:'), drives.length);
  if (!chosen.ok) return failed('pickLibraries', chosen.error.kind, chosen.error.message);
  if (chosen.value.kind !== 'rows') return failed('pickLibraries', 'bad-choice', 'choose libraries by number, or all');
  return ok(chosen.value.indices.flatMap((index) => (drives[index] === undefined ? [] : [drives[index]])));
};

const chooseChannels = async (deps: RunSyncDeps, channels: ReadonlyArray<ChannelSummary>): Promise<Result<ReadonlyArray<ChannelSummary>, StepError>> => {
  const rows: ReadonlyArray<PickerRow> = channels.map((channel) => ({ id: channel.id, name: channel.name, webUrl: '' }));
  deps.prompt.show(deps.view.channelPicker(rows));
  const chosen = parseSelection(await deps.prompt.ask('Channels:'), channels.length);
  if (!chosen.ok) return failed('pickChannels', chosen.error.kind, chosen.error.message);
  if (chosen.value.kind !== 'rows') return failed('pickChannels', 'bad-choice', 'choose channels by number, or all');
  return ok(chosen.value.indices.flatMap((index) => (channels[index] === undefined ? [] : [channels[index]])));
};

// The same rule a site's libraries follow: asked about only when this team is the one thing chosen.
const channelsFor = async (deps: RunSyncDeps, team: TeamSummary, ask: boolean): Promise<Result<ReadonlyArray<ChannelSummary>, StepError>> => {
  const channels = await deps.teams.listChannels(team.id);
  if (!channels.ok) return failed('listChannels', channels.error.kind, channels.error.message);
  return ask ? chooseChannels(deps, channels.value) : ok(channels.value);
};

const syncOneTeam = async (deps: RunSyncDeps, input: RunSyncInput, team: TeamSummary, channels: ReadonlyArray<ChannelSummary>): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('team.started', { teamId: team.id, channels: channels.length });
  const summary = await deps.syncTeam({ team, channels, concurrency: input.concurrency, dryRun: input.dryRun, since: dayOf(input.since) });
  if (summary.ok) deps.prompt.show(deps.view.summary(team.name, summary.value.summary, input.dryRun));
  return summary;
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
  const summary = await deps.syncSite({ site, drives, maxBytes: input.maxBytes, concurrency: input.concurrency, dryRun: input.dryRun, since: dayOf(input.since) });
  if (summary.ok) deps.prompt.show(deps.view.summary(site.name, summary.value.summary, input.dryRun));
  return summary;
};

const syncTheMailbox = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('mailbox.started', {});
  const summary = await deps.syncMailbox({ maxBytes: input.maxBytes, concurrency: input.concurrency, dryRun: input.dryRun, since: dayOf(input.since) });
  if (summary.ok) deps.prompt.show(deps.view.summary(MAILBOX_NAME, summary.value.summary, input.dryRun));
  return summary;
};

const syncThePeople = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('people.started', {});
  const summary = await deps.syncPeople({ concurrency: input.concurrency, dryRun: input.dryRun });
  if (summary.ok) deps.prompt.show(deps.view.summary(PEOPLE_NAME, summary.value.summary, input.dryRun));
  return summary;
};

const syncTheCalendar = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('calendar.started', {});
  const summary = await deps.syncCalendar({ concurrency: input.concurrency, dryRun: input.dryRun, since: dayOf(input.since) });
  if (summary.ok) deps.prompt.show(deps.view.summary(CALENDAR_NAME, summary.value.summary, input.dryRun));
  return summary;
};

// A run's outcome: what it got through, or where it stopped along with what it got through first.
type RunOutcome = Result<ReadonlyArray<SourceRun>, RunFailure>;

type Step = () => Promise<Result<SourceRun, StepError>>;

// Each step in turn, stopping at the first that fails and carrying out what finished before it.
const runInTurn = async (steps: ReadonlyArray<Step>): Promise<RunOutcome> => {
  const summaries: SourceRun[] = [];
  for (const step of steps) {
    const summary = await step();
    if (!summary.ok) return stoppedAfter(summaries, summary.error);
    summaries.push(summary.value);
  }
  return ok(summaries);
};

const refreshSite = async (deps: RunSyncDeps, input: RunSyncInput, source: SyncedSource): Promise<Result<SourceRun, StepError>> => {
  const site = { id: source.id, name: source.name, webUrl: '' };
  return syncOne(deps, input, site, await deps.savedDrives(site));
};

const refreshTeam = async (deps: RunSyncDeps, input: RunSyncInput, source: SyncedSource): Promise<Result<SourceRun, StepError>> => {
  const team = { id: source.id, name: source.name };
  return syncOneTeam(deps, input, team, await deps.savedChannels(team));
};

const refreshNotebook = async (deps: RunSyncDeps, input: RunSyncInput, source: SyncedSource): Promise<Result<SourceRun, StepError>> => {
  const notebook = await deps.savedNotebook(source);
  return notebook === undefined ? failed('savedNotebook', 'not-found', `no record of the notebook ${source.name}`) : syncTheNotebook(deps, input, notebook);
};

const refreshPlan = async (deps: RunSyncDeps, input: RunSyncInput, source: SyncedSource): Promise<Result<SourceRun, StepError>> => {
  const plan = await deps.savedPlan(source);
  return plan === undefined ? failed('savedPlan', 'not-found', `no record of the plan ${source.name}`) : syncThePlan(deps, input, plan);
};

// The sources that stand alone, refreshed once each when the knowledge base holds them at all, in
// this order and before the rest.
const STANDING: ReadonlyArray<{ readonly kind: SourceKind; readonly refresh: (deps: RunSyncDeps, input: RunSyncInput) => Promise<Result<SourceRun, StepError>> }> = [
  { kind: 'mailbox', refresh: syncTheMailbox },
  { kind: 'calendar', refresh: syncTheCalendar },
  { kind: 'people', refresh: syncThePeople },
];

type Refresh = (deps: RunSyncDeps, input: RunSyncInput, source: SyncedSource) => Promise<Result<SourceRun, StepError>>;

// Every other source, once for each the knowledge base holds, kind by kind in this order, rebuilt
// from what its own state recorded rather than listed again.
const EACH: ReadonlyArray<{ readonly kind: SourceKind; readonly refresh: Refresh }> = [
  { kind: 'site', refresh: refreshSite },
  { kind: 'group', refresh: (deps, input, source) => syncTheGroup(deps, input, { id: source.id, name: source.name, mail: '' }) },
  { kind: 'todo', refresh: (deps, input, source) => syncTheTodoList(deps, input, { id: source.id, name: source.name }) },
  { kind: 'team', refresh: refreshTeam },
  { kind: 'notebook', refresh: refreshNotebook },
  { kind: 'lists', refresh: (deps, input, source) => syncTheLists(deps, input, { id: source.id, name: source.name, webUrl: '' }) },
  { kind: 'plan', refresh: refreshPlan },
];

const updateEverything = async (deps: RunSyncDeps, input: RunSyncInput): Promise<RunOutcome> => {
  const known = await deps.listSyncedSources();
  if (!known.ok) return known;
  const standing = STANDING.filter(({ kind }) => known.value.some((source) => source.kind === kind)).map(
    ({ refresh }) =>
      () =>
        refresh(deps, input)
  );
  const each = EACH.flatMap(({ kind, refresh }) => known.value.filter((source) => source.kind === kind).map((source) => () => refresh(deps, input, source)));
  return runInTurn([...standing, ...each]);
};

const siteFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SiteRef, StepError> | undefined> => {
  if (input.siteUrl !== undefined) return siteAt(deps, input.siteUrl);
  if (input.siteId === undefined) return undefined;
  const found = await deps.reader.siteById(input.siteId);
  return found.ok ? ok(found.value) : failed('siteById', found.error.kind, found.error.message);
};

// A group named outright is looked up in the listing rather than fetched by id: `listGroups` is one
// call and it is the same call that says whether the user belongs to it, which is what decides
// whether anything can be read at all.
const groupFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<GroupSummary, StepError> | undefined> => {
  if (input.groupId === undefined) return undefined;
  const listed = await deps.groups.listGroups();
  if (!listed.ok) return failed('listGroups', listed.error.kind, listed.error.message);
  const found = listed.value.find((group) => group.id === input.groupId || group.mail === input.groupId);
  return found === undefined ? failed('findGroup', 'bad-choice', `no group you belong to is ${input.groupId}`) : ok(found);
};

// A list named outright is looked up in the listing rather than fetched by id, the way a group is:
// one call answers both whether the list exists and what it is called, and a name is what a person
// has to hand where a Graph list id is thirty opaque characters.
const todoFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<TodoList, StepError> | undefined> => {
  if (input.todoListId === undefined) return undefined;
  const listed = await deps.todo.taskLists();
  if (!listed.ok) return failed('listTaskLists', listed.error.kind, listed.error.message);
  const found = listed.value.find((list) => list.id === input.todoListId || list.name === input.todoListId);
  return found === undefined ? failed('findTodoList', 'bad-choice', `no To Do list of yours is ${input.todoListId}`) : ok(found);
};

// A team named outright is looked up in the listing rather than fetched by id, the way a group and
// a list are: one call answers both whether the user is in it and what it is called.
const teamFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<TeamSummary, StepError> | undefined> => {
  if (input.teamId === undefined) return undefined;
  const listed = await deps.teams.listTeams();
  if (!listed.ok) return failed('listTeams', listed.error.kind, listed.error.message);
  const found = listed.value.find((team) => team.id === input.teamId || team.name === input.teamId);
  return found === undefined ? failed('findTeam', 'bad-choice', `no team you belong to is ${input.teamId}`) : ok(found);
};

// A notebook named outright is looked up among the notebooks of the sites the picker knows and
// the user's own, by name or by id.
const notebookFromOptions = async (deps: RunSyncDeps, input: RunSyncInput, sites: ReadonlyArray<SiteSummary>): Promise<Result<Notebook, StepError> | undefined> => {
  if (input.notebookId === undefined) return undefined;
  const listed = await deps.notebooks.listNotebooks(sites);
  if (!listed.ok) return failed('listNotebooks', listed.error.kind, listed.error.message);
  const found = listed.value.find((notebook) => notebook.id === input.notebookId || notebook.name === input.notebookId);
  return found === undefined ? failed('findNotebook', 'bad-choice', `no notebook you can read is ${input.notebookId}`) : ok(found);
};

const syncTheNotebook = async (deps: RunSyncDeps, input: RunSyncInput, notebook: Notebook): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('notebook.started', { notebook: notebook.id });
  const summary = await deps.syncNotebook({ notebook, concurrency: input.concurrency, dryRun: input.dryRun, since: dayOf(input.since) });
  if (summary.ok) deps.prompt.show(deps.view.summary(notebook.name, summary.value.summary, input.dryRun));
  return summary;
};

const syncTheLists = async (deps: RunSyncDeps, input: RunSyncInput, site: SiteRef): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('lists.started', { site: site.id });
  const summary = await deps.syncLists({ site, concurrency: input.concurrency, dryRun: input.dryRun });
  if (summary.ok) deps.prompt.show(deps.view.summary(summary.value.source, summary.value.summary, input.dryRun));
  return summary;
};

const syncThePlan = async (deps: RunSyncDeps, input: RunSyncInput, plan: Plan): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('plan.started', { plan: plan.id });
  const summary = await deps.syncPlan({ plan, concurrency: input.concurrency, dryRun: input.dryRun });
  if (summary.ok) deps.prompt.show(deps.view.summary(plan.title, summary.value.summary, input.dryRun));
  return summary;
};

// A plan named outright is looked up among the plans listed, by title or by id, and failing that
// fetched by id: a plan of a group whose listing the library cannot answer is still readable once
// named, and its id is what a person has, off the address bar.
const planFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<Plan, StepError> | undefined> => {
  if (input.planId === undefined) return undefined;
  const listed = await deps.plans.listPlans(await listedGroups(deps));
  if (!listed.ok) return failed('listPlans', listed.error.kind, listed.error.message);
  const found = listed.value.find((plan) => plan.id === input.planId || plan.title === input.planId);
  if (found !== undefined) return ok(found);
  const fetched = await deps.plans.plan(input.planId);
  return fetched.ok ? ok(fetched.value) : failed('findPlan', 'bad-choice', `no plan you can read is ${input.planId}`);
};

// A site named for its lists is looked up among the sites the picker knows, by name or by id, or
// reached by its address the way a pasted one is.
const listsSiteFromOptions = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<SiteRef, StepError> | undefined> => {
  if (input.listsSite === undefined) return undefined;
  if (input.listsSite.startsWith('http')) return siteAt(deps, input.listsSite);
  const listing = await listedSites(deps, input);
  if (!listing.ok) return listing;
  const found = listing.value.sites.find((site) => site.id === input.listsSite || site.name === input.listsSite);
  return found === undefined ? failed('findListsSite', 'bad-choice', `no site you can read is ${input.listsSite}`) : ok(found);
};

const siteAt = async (deps: RunSyncDeps, url: string): Promise<Result<SiteRef, StepError>> => {
  const found = await deps.reader.siteByUrl(url);
  return found.ok ? ok(found.value) : failed('siteByUrl', found.error.kind, found.error.message);
};

// What a choice came to. Sites and groups travel together because one picker offers both and one
// run can take either, and they are kept apart because syncing them is not the same call.
type Sources = {
  readonly sites: ReadonlyArray<SiteRef>;
  readonly groups: ReadonlyArray<GroupSummary>;
  readonly todoLists: ReadonlyArray<TodoList>;
  readonly teams: ReadonlyArray<TeamSummary>;
  readonly notebooks: ReadonlyArray<Notebook>;
  // The sites whose lists were chosen, apart from the sites whose libraries were.
  readonly lists: ReadonlyArray<SiteRef>;
  readonly plans: ReadonlyArray<Plan>;
};

type Chosen = Sources | 'update-all' | 'quit' | 'mailbox' | 'people' | 'calendar';

const NOTHING: Sources = { sites: [], groups: [], todoLists: [], teams: [], notebooks: [], lists: [], plans: [] };

const oneSite = (found: Result<SiteRef, StepError>): Result<Chosen, StepError> => (found.ok ? ok({ ...NOTHING, sites: [found.value] }) : found);

// How many sources a choice came to, which is what decides whether a site is asked about its
// libraries and a team about its channels: one source is asked, more than one is taken whole.
const countOf = (sources: Sources): number =>
  sources.sites.length + sources.groups.length + sources.todoLists.length + sources.teams.length + sources.notebooks.length + sources.lists.length + sources.plans.length;

const resolve = async (deps: RunSyncDeps, choice: Selection, offered: Sources): Promise<Result<Chosen, StepError>> => {
  if (choice.kind === 'quit') return ok('quit');
  if (choice.kind === 'mailbox') return ok('mailbox');
  if (choice.kind === 'people') return ok('people');
  if (choice.kind === 'calendar') return ok('calendar');
  if (choice.kind === 'update-all') return ok('update-all');
  if (choice.kind === 'address') return oneSite(await siteAt(deps, choice.url));
  // Selecting by position rather than by index lookup: `parseSelection` has already refused any
  // number outside the list, so there is no missing-source case left to guard against here. The
  // groups are numbered after the sites, in the order the picker drew them.
  const sites = offered.sites.filter((_site, index) => choice.indices.includes(index));
  const groups = offered.groups.filter((_group, index) => choice.indices.includes(offered.sites.length + index));
  const todoLists = offered.todoLists.filter((_list, index) => choice.indices.includes(offered.sites.length + offered.groups.length + index));
  const teams = offered.teams.filter((_team, index) => choice.indices.includes(offered.sites.length + offered.groups.length + offered.todoLists.length + index));
  const before = offered.sites.length + offered.groups.length + offered.todoLists.length + offered.teams.length;
  const notebooks = offered.notebooks.filter((_notebook, index) => choice.indices.includes(before + index));
  const lists = offered.lists.filter((_site, index) => choice.indices.includes(before + offered.notebooks.length + index));
  const plans = offered.plans.filter((_plan, index) => choice.indices.includes(before + offered.notebooks.length + offered.lists.length + index));
  const chosen = { sites, groups, todoLists, teams, notebooks, lists, plans };
  return countOf(chosen) === 0 ? failed('pickSite', 'bad-choice', 'choose at least one source') : ok(chosen);
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
  const { fromCache } = listing.value;
  // Ordered once, here, because this same array is both what the picker draws and what a chosen
  // number indexes into. Sorting it anywhere else would let the two disagree, and a listing that
  // shows one source against a number while picking another is worse than an unsorted one.
  const sites = orderByKind(listing.value.sites);
  // A group that cannot be listed costs the group inboxes and not the run: the sites are still
  // there to choose from, and a picker that refused to draw because one listing failed would be
  // worse than one drawn short.
  const groups = await listedGroups(deps);
  const todoLists = await listedTodoLists(deps);
  const teams = await listedTeams(deps);
  const notebooks = await listedNotebooks(deps, listing.value.sites);
  const lists = sitesWithLists(sites);
  const plans = await listedPlans(deps, groups);
  const marks = await syncedMarks(deps);
  const rows = [
    ...annotate(sites, marks),
    ...annotate(groups.map(asChoosable), marks),
    ...annotate(todoLists.map(asChoosableList), marks),
    ...annotate(teams.map(asChoosableTeam), marks),
    ...annotate(notebooks.map(asChoosableNotebook), marks),
    ...annotate(lists.map(asChoosableLists), marks),
    ...annotate(plans.map(asChoosablePlan), marks),
  ];
  deps.prompt.show(
    deps.view.sitePicker(rows, {
      mailbox: standingRow(MAILBOX_ID, MAILBOX_NAME, marks),
      people: standingRow(PEOPLE_ID, PEOPLE_NAME, marks),
      calendar: standingRow(CALENDAR_ID, CALENDAR_NAME, marks),
    })
  );
  const chosen = parseSelection(await deps.prompt.ask('Source:'), rows.length);
  if (!chosen.ok) return failed('pickSite', chosen.error.kind, chosen.error.message);
  const resolved = await resolve(deps, chosen.value, { sites, groups, todoLists, teams, notebooks, lists, plans });
  return resolved.ok ? ok({ chosen: resolved.value, fromCache }) : resolved;
};

// The one row a source that is the only one of its kind gets: marked if it has been synced, and
// there either way.
const standingRow = (id: string, name: string, marks: Readonly<Record<string, SyncedMark>>): PickerRow => annotate([{ id, name }], marks)[0] ?? { id, name, webUrl: '' };

// A group inbox has no address of its own, so it says what it is instead of being read off one.
const asChoosable = (group: GroupSummary): { id: string; name: string; kind: 'group' } => ({ id: group.id, name: group.name, kind: 'group' });

const listedGroups = async (deps: RunSyncDeps): Promise<ReadonlyArray<GroupSummary>> => {
  const listed = await deps.groups.listGroups();
  if (listed.ok) return listed.value;
  deps.logger.warn('groups.unlisted', { cause: listed.error.kind });
  return [];
};

// A To Do list has no address either, and it says so the same way a group inbox does.
const asChoosableList = (list: TodoList): { id: string; name: string; kind: 'todo' } => ({ id: list.id, name: list.name, kind: 'todo' });

// An account with To Do switched off costs the lists and not the run, exactly as a refused group
// listing does: the sites are still there to choose from.
const listedTodoLists = async (deps: RunSyncDeps): Promise<ReadonlyArray<TodoList>> => {
  const listed = await deps.todo.taskLists();
  if (listed.ok) return listed.value;
  deps.logger.warn('todo.unlisted', { cause: listed.error.kind });
  return [];
};

const asChoosableTeam = (team: TeamSummary): { id: string; name: string; kind: 'team' } => ({ id: team.id, name: team.name, kind: 'team' });

const listedTeams = async (deps: RunSyncDeps): Promise<ReadonlyArray<TeamSummary>> => {
  const listed = await deps.teams.listTeams();
  if (listed.ok) return listed.value;
  deps.logger.warn('teams.unlisted', { cause: listed.error.kind });
  return [];
};

const asChoosableNotebook = (notebook: Notebook): { id: string; name: string; kind: 'notebook' } => ({ id: notebook.id, name: notebook.name, kind: 'notebook' });

const listedNotebooks = async (deps: RunSyncDeps, sites: ReadonlyArray<SiteSummary>): Promise<ReadonlyArray<Notebook>> => {
  const listed = await deps.notebooks.listNotebooks(sites);
  if (listed.ok) return listed.value;
  deps.logger.warn('notebooks.unlisted', { cause: listed.error.kind });
  return [];
};

// A site's lists are offered off the same listing as its libraries, without asking Graph which
// sites hold any: a site is a site. A Loop workspace and a OneDrive are SharePoint underneath too,
// but nobody keeps a tracker in either, so they are not offered twice.
const sitesWithLists = (sites: ReadonlyArray<SiteSummary>): ReadonlyArray<SiteSummary> => sites.filter((site) => kindOf(site) === 'site');

// Marked under the lists' own key, so a site synced for its libraries is not shown as synced for
// its lists too.
const asChoosableLists = (site: SiteSummary): { id: string; name: string; webUrl: string; kind: 'lists' } => ({
  id: sourceKey({ kind: 'lists', id: site.id }),
  name: site.name,
  webUrl: site.webUrl,
  kind: 'lists',
});

const asChoosablePlan = (plan: Plan): { id: string; name: string; kind: 'plan' } => ({ id: plan.id, name: plan.title, kind: 'plan' });

// The plans are found through the groups, so a group listing that failed already cost them; a
// plan listing that fails costs the plans and not the picker.
const listedPlans = async (deps: RunSyncDeps, groups: ReadonlyArray<GroupSummary>): Promise<ReadonlyArray<Plan>> => {
  const listed = await deps.plans.listPlans(groups);
  if (listed.ok) return listed.value;
  deps.logger.warn('plans.unlisted', { cause: listed.error.kind });
  return [];
};

const oneSummary = (summary: Result<SourceRun, StepError>): Result<ReadonlyArray<SourceRun>, StepError> => (summary.ok ? ok([summary.value]) : summary);

// Each site is summarised as it lands, so a run over many of them reports along the way. A site that
// fails stops the run there rather than burying the reason under the ones after it; every site
// finished before it keeps what it wrote, and a re-run resumes from its own checkpoint.
const runMany = async (deps: RunSyncDeps, input: RunSyncInput, chosen: Sources): Promise<RunOutcome> => {
  const alone = countOf(chosen) === 1;
  return runInTurn([
    ...chosen.sites.map((site) => () => siteWithLibraries(deps, input, site, alone)),
    ...chosen.groups.map((group) => () => syncTheGroup(deps, input, group)),
    ...chosen.todoLists.map((list) => () => syncTheTodoList(deps, input, list)),
    ...chosen.teams.map((team) => () => teamWithChannels(deps, input, team, alone)),
    ...chosen.notebooks.map((notebook) => () => syncTheNotebook(deps, input, notebook)),
    ...chosen.lists.map((site) => () => syncTheLists(deps, input, site)),
    ...chosen.plans.map((plan) => () => syncThePlan(deps, input, plan)),
  ]);
};

const siteWithLibraries = async (deps: RunSyncDeps, input: RunSyncInput, site: SiteRef, alone: boolean): Promise<Result<SourceRun, StepError>> => {
  const drives = await librariesFor(deps, site, input.driveIds, alone);
  return drives.ok ? syncOne(deps, input, site, drives.value) : drives;
};

const teamWithChannels = async (deps: RunSyncDeps, input: RunSyncInput, team: TeamSummary, alone: boolean): Promise<Result<SourceRun, StepError>> => {
  const channels = await channelsFor(deps, team, alone);
  return channels.ok ? syncOneTeam(deps, input, team, channels.value) : channels;
};

const syncTheGroup = async (deps: RunSyncDeps, input: RunSyncInput, group: GroupSummary): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('group.started', { group: group.id });
  const summary = await deps.syncGroup({ group, maxBytes: input.maxBytes, dryRun: input.dryRun, concurrency: input.concurrency, since: dayOf(input.since) });
  if (summary.ok) deps.prompt.show(deps.view.summary(`${group.name} (group inbox)`, summary.value.summary, input.dryRun));
  return summary;
};

const syncTheTodoList = async (deps: RunSyncDeps, input: RunSyncInput, list: TodoList): Promise<Result<SourceRun, StepError>> => {
  deps.logger.info('todo.started', { list: list.id });
  const summary = await deps.syncTodo({ list, dryRun: input.dryRun, concurrency: input.concurrency });
  if (summary.ok) deps.prompt.show(deps.view.summary(list.name, summary.value.summary, input.dryRun));
  return summary;
};

const syncChosen = async (deps: RunSyncDeps, input: RunSyncInput, chosen: Exclude<Chosen, 'quit'>): Promise<Result<ReadonlyArray<SourceRun>, RunFailure>> => {
  if (chosen === 'update-all') return updateEverything(deps, input);
  if (chosen === 'mailbox') return oneSummary(await syncTheMailbox(deps, input));
  if (chosen === 'people') return oneSummary(await syncThePeople(deps, input));
  if (chosen === 'calendar') return oneSummary(await syncTheCalendar(deps, input));
  return runMany(deps, input, chosen);
};

// What a run left behind, across every source it touched: the two numbers a reader wants before
// deciding whether to open the report at all.
const leftBehind = (ran: ReadonlyArray<SourceRun>): { readonly skipped: number; readonly failed: number } =>
  ran.reduce((carried, run) => ({ skipped: carried.skipped + run.summary.skipped, failed: carried.failed + run.summary.failed }), { skipped: 0, failed: 0 });

// A notebook is found through the sites, so naming one costs the site listing the picker would
// have paid for anyway, drawn from the stored list where there is one.
const namedNotebook = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<Notebook, StepError> | undefined> => {
  if (input.notebookId === undefined) return undefined;
  const listing = await listedSites(deps, input);
  if (!listing.ok) return listing;
  return notebookFromOptions(deps, input, listing.value.sites);
};

const runNamedTeam = async (deps: RunSyncDeps, input: RunSyncInput, team: TeamSummary): Promise<Result<ReadonlyArray<SourceRun>, RunFailure>> => {
  const channels = await channelsFor(deps, team, false);
  if (!channels.ok) return channels;
  return oneSummary(await syncOneTeam(deps, input, team, channels.value));
};

// A run the command line settles on its own: `update`, or one of the sources that stand alone.
const standingRun = async (deps: RunSyncDeps, input: RunSyncInput): Promise<RunOutcome | undefined> => {
  if (input.command === 'update') return updateEverything(deps, input);
  if (input.mailbox === true) return oneSummary(await syncTheMailbox(deps, input));
  if (input.people === true) return oneSummary(await syncThePeople(deps, input));
  if (input.calendar === true) return oneSummary(await syncTheCalendar(deps, input));
  return undefined;
};

// What looking up a source named on the command line came to: nothing named, a refusal, or its run.
const settle = async <T>(found: Result<T, StepError> | undefined, run: (value: T) => Promise<RunOutcome>): Promise<RunOutcome | undefined> => {
  if (found === undefined) return undefined;
  return found.ok ? run(found.value) : found;
};

// The sources the command line can name, looked up in this order: the first one named is the one
// run, and the picker is never drawn.
const NAMED: ReadonlyArray<(deps: RunSyncDeps, input: RunSyncInput) => Promise<RunOutcome | undefined>> = [
  async (deps, input) => settle(await siteFromOptions(deps, input), (site) => runMany(deps, input, { ...NOTHING, sites: [site] })),
  async (deps, input) => settle(await groupFromOptions(deps, input), (group) => runMany(deps, input, { ...NOTHING, groups: [group] })),
  async (deps, input) => settle(await todoFromOptions(deps, input), (list) => runMany(deps, input, { ...NOTHING, todoLists: [list] })),
  // Every channel, without the picker: a team named on the command line is a team meant for a script.
  async (deps, input) => settle(await teamFromOptions(deps, input), (team) => runNamedTeam(deps, input, team)),
  async (deps, input) => settle(await namedNotebook(deps, input), async (notebook) => oneSummary(await syncTheNotebook(deps, input, notebook))),
  async (deps, input) => settle(await listsSiteFromOptions(deps, input), async (site) => oneSummary(await syncTheLists(deps, input, site))),
  async (deps, input) => settle(await planFromOptions(deps, input), async (plan) => oneSummary(await syncThePlan(deps, input, plan))),
];

const namedRun = async (deps: RunSyncDeps, input: RunSyncInput): Promise<RunOutcome | undefined> => {
  for (const lookup of NAMED) {
    const ran = await lookup(deps, input);
    if (ran !== undefined) return ran;
  }
  return undefined;
};

const pickAndSync = async (deps: RunSyncDeps, input: RunSyncInput): Promise<RunOutcome> => {
  const picked = await chooseSite(deps, input);
  if (!picked.ok) return picked;
  const { chosen, fromCache } = picked.value;
  // Quitting asks for nothing, so it pays for nothing: the stored list stands until a run that
  // actually works, where the listing rides alongside a sync that takes far longer than it does.
  if (chosen === 'quit') return ok([]);
  const since = input.since === undefined ? await askSince(deps, input) : ok(input.since);
  if (!since.ok) return since;
  const refreshing = fromCache ? refreshInBackground(deps) : Promise.resolve();
  const chosenSummaries = await syncChosen(deps, { ...input, since: since.value }, chosen);
  await refreshing;
  return chosenSummaries;
};

// The command line first, then a source it names, then the picker.
const chooseAndSync = async (deps: RunSyncDeps, input: RunSyncInput): Promise<RunOutcome> =>
  (await standingRun(deps, input)) ?? (await namedRun(deps, input)) ?? pickAndSync(deps, input);

// `--since` first, kept for the runs after it unless this is a dry run, which keeps nothing; then
// whatever an earlier run kept. Neither leaves the reach undefined: the picker answers that by
// asking, and every other way of running with everything, since `update` runs unattended and a
// source named on the command line is named for a script.
const knownSince = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<string | undefined, StepError>> => {
  if (input.since === undefined) return deps.storedSince();
  if (!input.dryRun) await deps.rememberSince(input.since);
  return ok(input.since);
};

// Asked once a source is chosen, so a run that quits at the picker asks and keeps nothing. An answer
// that is not a reach is asked again; nothing at all stops the run, the way the picker refuses it.
const askSince = async (deps: RunSyncDeps, input: RunSyncInput): Promise<Result<string, StepError>> => {
  deps.prompt.show(deps.view.sinceQuestion());
  for (;;) {
    const answer = await deps.prompt.ask(`Since (${SINCE_SHAPE}):`);
    if (answer === '') return failed('pickSince', 'bad-choice', `answer with ${SINCE_SHAPE}`);
    const since = parseSince(answer);
    if (since.ok) {
      if (!input.dryRun) await deps.rememberSince(since.value);
      return since;
    }
    deps.prompt.show(deps.view.sinceRefused(answer));
  }
};

// Every way of choosing sources funnels through here, so the report is written once at the end of a
// run however the run was asked for, rather than once per branch.
export const createRunSync =
  (deps: RunSyncDeps): RunSync =>
  async (input) => {
    const known = await knownSince(deps, input);
    const summaries: Result<ReadonlyArray<SourceRun>, RunFailure> = known.ok ? await chooseAndSync(deps, { ...input, since: known.value }) : known;
    // A stopped run still reports: the sources it got through wrote their documents, and the file
    // says where it stopped so a short report is not read as a complete one.
    const ran = summaries.ok ? summaries.value : (summaries.error.ran ?? []);
    const stopped = summaries.ok ? undefined : `${summaries.error.step}: ${summaries.error.message}`;
    const path = await deps.writeGlobalReport({ ran, dryRun: input.dryRun, stopped });
    const left = leftBehind(ran);
    if (path !== undefined && left.skipped + left.failed > 0) deps.prompt.show(deps.view.reportPointer(left, path));
    return summaries;
  };
