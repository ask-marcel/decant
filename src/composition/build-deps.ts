import { buildDeps as buildMarcelDeps, commands } from 'ask-marcel-office-cli';
import type { SiteRef } from '../domain/site-state.ts';
import { createSystemClock } from '../infra/clock-system.ts';
import type { MarcelApi, MarcelCommand } from '../infra/drive-reader-marcel.ts';
import { createDriveReaderFromApi, createMarcelCall } from '../infra/drive-reader-marcel.ts';
import { MAILBOX_NAME } from '../domain/mail-state.ts';
import { createGroupReaderFromCall } from '../infra/group-reader-marcel.ts';
import type { GroupReader } from '../use-cases/ports/group-reader.ts';
import { createTodoReaderFromCall } from '../infra/todo-reader-marcel.ts';
import type { TodoReader } from '../use-cases/ports/todo-reader.ts';
import { createTeamReaderFromCall } from '../infra/team-reader-marcel.ts';
import { createPeopleReaderFromCall } from '../infra/people-reader-marcel.ts';
import type { PeopleReader } from '../use-cases/ports/people-reader.ts';
import { createSyncPeople } from '../use-cases/sync-people.ts';
import { createCalendarReaderFromCall } from '../infra/calendar-reader-marcel.ts';
import type { CalendarReader } from '../use-cases/ports/calendar-reader.ts';
import { createSyncCalendar } from '../use-cases/sync-calendar.ts';
import { createNotebookReaderFromCall } from '../infra/notebook-reader-marcel.ts';
import type { NotebookReader } from '../use-cases/ports/notebook-reader.ts';
import { createSyncNotebook } from '../use-cases/sync-notebook.ts';
import { createListReaderFromCall } from '../infra/list-reader-marcel.ts';
import type { ListReader } from '../use-cases/ports/list-reader.ts';
import { createSyncLists } from '../use-cases/sync-lists.ts';
import { createPlanReaderFromCall } from '../infra/plan-reader-marcel.ts';
import type { PlanReader } from '../use-cases/ports/plan-reader.ts';
import { createSyncPlan } from '../use-cases/sync-plan.ts';
import { parsePlanState, planRootName } from '../domain/plan-state.ts';
import type { Plan } from '../domain/planner.ts';
import { parseNotebookState, notebookRootName } from '../domain/notebook-state.ts';
import type { Notebook } from '../domain/onenote.ts';
import type { ChannelSummary, TeamReader, TeamSummary } from '../use-cases/ports/team-reader.ts';
import { createMailReaderFromCall } from '../infra/mail-reader-marcel.ts';
import { createBunFiles } from '../infra/files-bun.ts';
import { createWinstonLogger } from '../infra/logger.ts';
import { createBunShell, createFileOcrCache, createNoOcr, createRapidOcr } from '../infra/ocr-rapid.ts';
import { createStderrProgress, createStderrStatus } from '../infra/progress-bar.ts';
import { createStdinPrompt } from '../infra/prompt-stdin.ts';
import { createConvertAttachment } from '../use-cases/convert-attachment.ts';
import { createConvertFile } from '../use-cases/convert-file.ts';
import { createListSyncedSources } from '../use-cases/list-synced-sources.ts';
import type { Clock } from '../use-cases/ports/clock.ts';
import type { DriveReader, DriveSummary, SiteSummary } from '../use-cases/ports/drive-reader.ts';
import type { MailReader } from '../use-cases/ports/mail-reader.ts';
import type { Files } from '../use-cases/ports/files.ts';
import type { Logger } from '../use-cases/ports/logger.ts';
import type { Ocr } from '../use-cases/ports/ocr.ts';
import type { Progress } from '../use-cases/ports/progress.ts';
import type { Prompt } from '../use-cases/ports/prompt.ts';
import { createRunSync } from '../use-cases/run-sync.ts';
import type { RunSync } from '../use-cases/run-sync.ts';
import { createRenderThread } from '../use-cases/render-thread.ts';
import { createSyncGroup } from '../use-cases/sync-group.ts';
import { createSyncTodo } from '../use-cases/sync-todo.ts';
import { createSyncTeam, teamRoot } from '../use-cases/sync-team.ts';
import { parseTeamState } from '../domain/team-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import { createSyncMailbox } from '../use-cases/sync-mailbox.ts';
import { createWriteGlobalReport } from '../use-cases/write-global-report.ts';
import { createSyncSite, resolveSite } from '../use-cases/sync-site.ts';
import type { SiteCache } from '../domain/site-cache.ts';
import { parseSiteCache, serializeSiteCache } from '../domain/site-cache.ts';
import { SINCE_SHAPE, parseSettings, serializeSettings } from '../domain/sync-window.ts';
import { err, ok } from '../domain/result.ts';
import type { RunSyncDeps } from '../use-cases/run-sync.ts';
import type { Config } from './config.ts';
import { pickerView } from './picker-view.ts';

export type BuiltDeps = {
  readonly runSync: RunSync;
  readonly logger: Logger;
};

export type DepOverrides = {
  readonly logger?: Logger;
  readonly files?: Files;
  readonly reader?: DriveReader;
  readonly mail?: MailReader;
  readonly group?: GroupReader;
  readonly todo?: TodoReader;
  readonly team?: TeamReader;
  readonly people?: PeopleReader;
  readonly calendar?: CalendarReader;
  readonly notebook?: NotebookReader;
  readonly list?: ListReader;
  readonly plan?: PlanReader;
  readonly ocr?: Ocr;
  readonly prompt?: Prompt;
  readonly clock?: Clock;
  readonly progress?: Progress;
};

// `interactive: false` keeps a lapsed sign-in from opening a browser mid-run: the call fails with
// an auth error the run reports, which is what a scheduled `update` needs.
const realApi = (interactive: boolean): MarcelApi => {
  const marcel = buildMarcelDeps({ interactive });
  const status = createStderrStatus();
  return { graph: marcel.graph, fs: marcel.fs, commands: commands as Readonly<Partial<Record<string, MarcelCommand>>>, notify: status };
};

// Resolved the same way the sync itself resolves it: two sites can share a display name, and the
// name alone would hand the second site the first one's libraries to refresh.
const savedDrivesFrom =
  (files: Files, logger: Logger, kbRoot: string) =>
  async (site: SiteRef): Promise<ReadonlyArray<DriveSummary>> => {
    const { state } = await resolveSite({ files, logger, kbRoot }, site);
    return Object.entries(state.drives).map(([id, drive]) => ({ id, name: drive.name }));
  };

// The channels the earlier run recorded for this team, read off its own state file, the way a
// site's libraries are. A state that cannot be read answers no channels, and `syncTeam` refuses to
// run on none, which is the honest outcome for a team whose record is gone.
const savedChannelsFrom =
  (files: Files, kbRoot: string) =>
  async (team: TeamSummary): Promise<ReadonlyArray<ChannelSummary>> => {
    const text = await files.readText(`${teamRoot(kbRoot, team.name)}/.sync-state.json`);
    if (!text.ok) return [];
    const parsed = parseJson(text.value);
    const state = parsed.ok ? parseTeamState(parsed.value) : parsed;
    return state.ok ? Object.entries(state.value.channels).map(([id, channel]) => ({ id, name: channel.name })) : [];
  };

// The plan as its own state file recorded it, found the way a notebook is.
const savedPlanFrom =
  (files: Files, kbRoot: string) =>
  async (source: { readonly id: string; readonly name: string }): Promise<Plan | undefined> => {
    const text = await files.readText(`${kbRoot}/${planRootName(source.name)}/.sync-state.json`);
    if (!text.ok) return undefined;
    const parsed = parseJson(text.value);
    const state = parsed.ok ? parsePlanState(parsed.value) : parsed;
    return state.ok && state.value.plan.id === source.id ? state.value.plan : undefined;
  };

// The notebook as its own state file recorded it, site and all. Read from the plain folder the name
// gives; a notebook that took an id-suffixed folder because another held the name is found by the
// id in the state, since two states cannot claim one folder.
const savedNotebookFrom =
  (files: Files, kbRoot: string) =>
  async (source: { readonly id: string; readonly name: string }): Promise<Notebook | undefined> => {
    const text = await files.readText(`${kbRoot}/${notebookRootName(source.name)}/.sync-state.json`);
    if (!text.ok) return undefined;
    const parsed = parseJson(text.value);
    const state = parsed.ok ? parseNotebookState(parsed.value) : parsed;
    return state.ok && state.value.notebook.id === source.id ? state.value.notebook : undefined;
  };

// Kept beside the knowledge base it describes, so clearing `kb/` clears it too: a list of sites is
// only ever a convenience, never something to carry over a deliberate reset.
const SITE_CACHE_FILE = '.sites.json';

type SiteCacheStore = {
  readonly cached: () => Promise<SiteCache | undefined>;
  readonly remember: (sites: ReadonlyArray<SiteSummary>) => Promise<void>;
};

const siteCacheAt = (files: Files, kbRoot: string, clock: Clock): SiteCacheStore => ({
  cached: async (): Promise<SiteCache | undefined> => {
    const text = await files.readText(`${kbRoot}/${SITE_CACHE_FILE}`);
    return text.ok ? parseSiteCache(text.value) : undefined;
  },
  remember: async (sites: ReadonlyArray<SiteSummary>): Promise<void> => {
    await files.writeText(`${kbRoot}/${SITE_CACHE_FILE}`, serializeSiteCache(sites, clock.nowIso()));
  },
});

// Kept beside the knowledge base, like the list of sites: clearing `kb/` starts over, and the next run
// asks again how far back to reach. Unlike that list it is read strictly, since a day mistyped by
// hand must stop a run rather than let it sync everything.
const SINCE_FILE = '.decant.json';

const sinceAt = (files: Files, logger: Logger, kbRoot: string): Pick<RunSyncDeps, 'storedSince' | 'rememberSince'> => {
  const path = `${kbRoot}/${SINCE_FILE}`;
  return {
    storedSince: async () => {
      const text = await files.readText(path);
      if (!text.ok) return text.error.kind === 'not-found' ? ok(undefined) : err({ step: 'readSince', cause: text.error.kind, message: text.error.message });
      const since = parseSettings(text.value);
      return since.ok ? since : err({ step: 'readSince', cause: since.error.kind, message: `${path} does not say ${SINCE_SHAPE}; run with --since to set it again` });
    },
    // A reach that cannot be kept is asked for again next run, so the run itself goes on.
    rememberSince: async (since) => {
      const written = await files.writeText(path, serializeSettings(since));
      if (!written.ok) logger.warn('since.unkept', { cause: written.error.kind });
    },
  };
};

// The part a test handed in, or the real one, built only when none was: every part of the run
// takes the same choice, so it is made in one place rather than once a part.
const given = <T>(override: T | undefined, build: () => T): T => override ?? build();

export const buildDeps = (config: Config, overrides: DepOverrides = {}): BuiltDeps => {
  const logger = given(overrides.logger, () => createWinstonLogger(config.logLevel));
  const files = given(overrides.files, () => createBunFiles());
  const clock = given(overrides.clock, () => createSystemClock());
  // Constructing the API reaches nothing: the sign-in ladder only runs on the first Graph call.
  const api = realApi(config.interactive);
  const reader = given(overrides.reader, () => createDriveReaderFromApi(api));
  const mail = given(overrides.mail, () => createMailReaderFromCall(createMarcelCall(api)));
  // Shared across every source, not filed under the mailbox: the same picture reaches the knowledge
  // base as a mail attachment and as a file in a library, and reading it twice is the thing this
  // exists to stop.
  const ocrCache = createFileOcrCache(`${config.kbRoot}/_meta/ocr`);
  const ocr = given(overrides.ocr, () => (config.ocr ? createRapidOcr({ shell: createBunShell(), lang: config.ocrLang, cache: ocrCache }) : createNoOcr()));
  const prompt = given(overrides.prompt, () => createStdinPrompt(() => console));
  const progress = given(overrides.progress, () => createStderrProgress());
  const convertFile = createConvertFile({ reader, files, ocr, clock, logger, progress });
  const syncSite = createSyncSite({ reader, files, convertFile, clock, logger, progress, kbRoot: config.kbRoot });
  const listSyncedSources = createListSyncedSources({ files, logger, kbRoot: config.kbRoot });
  const convertAttachment = createConvertAttachment({ reader: mail, files, ocr, logger, unpackArchive: reader.localArchive, convertLocal: reader.localMarkdown });
  // Hoisted only to keep the call below on one line: Bun reports the inner lines of a multi-line
  // expression as never executed, so splitting it reads as coverage lost. See the comment further
  // down and the journal entry for the same trap in `progress-bar.ts`.
  const mailboxRoot = `${config.kbRoot}/Mailbox`;
  const renderThread = createRenderThread({
    reader: mail,
    drive: reader,
    files,
    convertAttachment,
    convertFile,
    clock,
    logger,
    mailboxRoot,
    sourceName: MAILBOX_NAME,
    timezone: config.timezone,
  });
  const syncMailbox = createSyncMailbox({ reader: mail, files, renderThread, clock, logger, progress, kbRoot: config.kbRoot });
  // A group inbox reads through its own commands but renders through the same path, so it gets the
  // same converters with the group reader underneath them, and a renderer per group because each
  // one writes into its own folder.
  const group = given(overrides.group, () => createGroupReaderFromCall(createMarcelCall(api)));
  const convertGroupAttachment = createConvertAttachment({ reader: group, files, ocr, logger, unpackArchive: reader.localArchive, convertLocal: reader.localMarkdown });
  const renderGroupThreadFor = (root: string, name: string): ReturnType<typeof createRenderThread> =>
    createRenderThread({
      reader: group,
      drive: reader,
      files,
      convertAttachment: convertGroupAttachment,
      convertFile,
      clock,
      logger,
      mailboxRoot: root,
      sourceName: name,
      timezone: config.timezone,
    });
  const syncGroup = createSyncGroup({ reader: group, files, renderThreadFor: renderGroupThreadFor, clock, logger, progress, kbRoot: config.kbRoot });
  // A task is text with nothing hanging off it, so it needs none of the conversion machinery the
  // other sources are built out of: the reader, somewhere to write, and a clock to stamp it.
  const todo = given(overrides.todo, () => createTodoReaderFromCall(createMarcelCall(api)));
  const syncTodo = createSyncTodo({ reader: todo, files, clock, logger, progress, kbRoot: config.kbRoot });
  // A channel post renders through the library, the way a mail message does, so a team needs the
  // reader, somewhere to write, and a clock, and none of the conversion machinery.
  const team = given(overrides.team, () => createTeamReaderFromCall(createMarcelCall(api)));
  const syncTeam = createSyncTeam({ reader: team, files, clock, logger, progress, kbRoot: config.kbRoot });
  // The directory is enumerated through the Teams, so it borrows the team reader's listing.
  const people = given(overrides.people, () => createPeopleReaderFromCall(createMarcelCall(api)));
  const syncPeople = createSyncPeople({ reader: people, teams: team, files, clock, logger, progress, kbRoot: config.kbRoot });
  // The calendar counts its days where the mailbox counts them.
  const calendar = given(overrides.calendar, () => createCalendarReaderFromCall(createMarcelCall(api)));
  const syncCalendar = createSyncCalendar({ reader: calendar, files, clock, logger, progress, kbRoot: config.kbRoot, timezone: config.timezone });
  const notebook = given(overrides.notebook, () => createNotebookReaderFromCall(createMarcelCall(api)));
  const syncNotebook = createSyncNotebook({ reader: notebook, files, clock, logger, progress, kbRoot: config.kbRoot });
  const list = given(overrides.list, () => createListReaderFromCall(createMarcelCall(api)));
  const syncLists = createSyncLists({ reader: list, files, clock, logger, progress, kbRoot: config.kbRoot });
  const plan = given(overrides.plan, () => createPlanReaderFromCall(createMarcelCall(api)));
  const syncPlan = createSyncPlan({ reader: plan, files, clock, logger, progress, kbRoot: config.kbRoot });
  const savedDrives = savedDrivesFrom(files, logger, config.kbRoot);
  const { cached: cachedSites, remember: rememberSites } = siteCacheAt(files, config.kbRoot, clock);
  // Kept to few lines on purpose: Bun's line coverage reports the inner lines of a multi-line
  // expression as never executed, so spreading this call out reads as a third of the file going
  // uncovered. See the journal entry for the same trap in `progress-bar.ts`.
  const writeGlobalReport = createWriteGlobalReport({ files, clock, logger, listSyncedSources, kbRoot: config.kbRoot });
  const runSync = createRunSync({
    reader,
    prompt,
    view: pickerView,
    logger,
    syncSite,
    listSyncedSources,
    savedDrives,
    syncMailbox,
    syncGroup,
    syncTodo,
    syncTeam,
    syncPeople,
    syncCalendar,
    syncNotebook,
    syncLists,
    syncPlan,
    plans: plan,
    savedPlan: savedPlanFrom(files, config.kbRoot),
    notebooks: notebook,
    savedNotebook: savedNotebookFrom(files, config.kbRoot),
    groups: group,
    todo,
    teams: team,
    savedChannels: savedChannelsFrom(files, config.kbRoot),
    cachedSites,
    rememberSites,
    ...sinceAt(files, logger, config.kbRoot),
    writeGlobalReport,
  });
  return { logger, runSync };
};
