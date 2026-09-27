import { describe, expect, it } from 'bun:test';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createPromptFake } from '../test-helpers/prompt-fake.ts';
import type { PromptFake } from '../test-helpers/prompt-fake.ts';
import type { SyncedSource } from '../domain/sync-state.ts';
import type { SiteCache } from '../domain/site-cache.ts';
import { pickerView } from '../composition/picker-view.ts';
import { createRunSync } from './run-sync.ts';
import type { RunSyncInput } from './run-sync.ts';
import type { RunSummary, SourceRun, SyncSiteInput } from './sync-site.ts';
import type { SyncMailboxInput } from './sync-mailbox.ts';
import type { StepError } from './ports/step-error.ts';

const sites = [
  { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/contoso' },
  { id: 'contoso,3,4', name: 'Direction', webUrl: 'https://tenant.sharepoint.com/sites/dir' },
];
const drives = [
  { id: 'b!one', name: 'Documents' },
  { id: 'b!two', name: 'Site Assets' },
];
const EMPTY_SUMMARY = { converted: 2, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

// Every fake source hands back the same run: these tests are about which sources get synced and in
// what order, never about what any one of them left behind.
const SOURCE_RUN = { id: 'site!one', source: 'Espace Contoso', summary: EMPTY_SUMMARY, notes: { skipped: [], failed: [], givenUp: [], archived: [] } };

// The sources a test can make fail once begun. Each fails at a step named after it, so a test can
// tell which one stopped the run.
type FailingKind = 'calendar' | 'people' | 'group' | 'todo' | 'team' | 'notebook';

const busy = (kind: FailingKind): Result<never, StepError> => err({ step: kind, cause: 'transient', message: 'Graph is busy' });

const run = async (
  answers: ReadonlyArray<string>,
  over: Partial<RunSyncInput> = {},
  seeds: {
    reader?: DriveReaderSeed;
    synced?: ReadonlyArray<SyncedSource>;
    savedDrives?: ReadonlyArray<{ id: string; name: string }>;
    cached?: SiteCache;
    groups?: ReadonlyArray<{ id: string; name: string; mail: string }>;
    failGroups?: boolean;
    todoLists?: ReadonlyArray<{ id: string; name: string }>;
    failTodo?: boolean;
    teams?: ReadonlyArray<{ id: string; name: string }>;
    teamChannels?: ReadonlyArray<{ id: string; name: string }>;
    failTeams?: boolean;
    failChannels?: boolean;
    savedChannels?: ReadonlyArray<{ id: string; name: string }>;
    notebooks?: ReadonlyArray<{ id: string; name: string; webUrl: string; site: { id: string; name: string } | undefined }>;
    failNotebooks?: boolean;
    savedNotebook?: { id: string; name: string; webUrl: string; site: { id: string; name: string } | undefined };
    failLists?: boolean;
    plans?: ReadonlyArray<{ id: string; title: string; groupId: string }>;
    failPlans?: boolean;
    failPlanSync?: boolean;
    unfetchablePlans?: boolean;
    // Plans no listing answers for, readable by id all the same: a group's plans while the library lacks the group route.
    hiddenPlans?: ReadonlyArray<{ id: string; title: string; groupId: string }>;
    savedPlan?: { id: string; title: string; groupId: string };
    reportPath?: string;
    summary?: RunSummary;
    failing?: ReadonlyArray<FailingKind>;
    // A report that could not be written, so there is no file to point the operator at.
    unreported?: boolean;
    // The reach an earlier run kept, all unless a test says otherwise, so no other test is asked for one.
    stored?: string;
    // No reach was ever kept: the first run.
    firstRun?: boolean;
    // The file keeping the reach says something that is not one.
    unreadableSince?: boolean;
  } = {}
): Promise<{
  calls: SyncSiteInput[];
  groupRuns: string[];
  todoRuns: string[];
  teamRuns: Array<{ team: string; channels: string[] }>;
  peopleRuns: Array<{ concurrency: number; dryRun: boolean }>;
  calendarRuns: Array<{ since?: string }>;
  notebookRuns: string[];
  listsRuns: string[];
  planRuns: string[];
  mailboxRuns: SyncMailboxInput[];
  // The day each source that keeps a history was handed, in the order they ran.
  reached: Array<{ kind: string; since?: string }>;
  reported: Array<{ ran: ReadonlyArray<SourceRun>; dryRun: boolean; stopped?: string }>;
  prompt: PromptFake;
  logger: LoggerFake;
  ok: boolean;
  error?: string;
  step?: string;
  cause?: string;
  summaries?: ReadonlyArray<SourceRun>;
  remembered: Array<ReadonlyArray<{ id: string; name: string; webUrl: string }>>;
  rememberedSince: string[];
  reader: ReturnType<typeof createDriveReaderFake>;
}> => {
  const calls: SyncSiteInput[] = [];
  const groupRuns: string[] = [];
  const todoRuns: string[] = [];
  const teamRuns: Array<{ team: string; channels: string[] }> = [];
  const peopleRuns: Array<{ concurrency: number; dryRun: boolean }> = [];
  const calendarRuns: Array<{ since?: string }> = [];
  const notebookRuns: string[] = [];
  const listsRuns: string[] = [];
  const planRuns: string[] = [];
  const remembered: Array<ReadonlyArray<{ id: string; name: string; webUrl: string }>> = [];
  const mailboxRuns: SyncMailboxInput[] = [];
  const rememberedSince: string[] = [];
  const reached: Array<{ kind: string; since?: string }> = [];
  const reported: Array<{ ran: ReadonlyArray<SourceRun>; dryRun: boolean; stopped?: string }> = [];
  const prompt = createPromptFake(answers);
  const logger = createLoggerFake();
  const reader = createDriveReaderFake({ sites, drives, ...seeds.reader });
  const fails = (kind: FailingKind): boolean => seeds.failing?.includes(kind) === true;
  const runSync = createRunSync({
    reader,
    syncGroup: async (input) => {
      groupRuns.push(input.group.name);
      reached.push({ kind: 'group', since: input.since });
      if (fails('group')) return busy('group');
      return ok({ ...SOURCE_RUN, id: input.group.id, source: input.group.name });
    },
    groups: { listGroups: async () => (seeds.failGroups === true ? err({ kind: 'permanent' as const, message: 'ErrorAccessDenied' }) : ok(seeds.groups ?? [])) },
    syncTodo: async (input) => {
      todoRuns.push(input.list.name);
      if (fails('todo')) return busy('todo');
      return ok({ ...SOURCE_RUN, id: input.list.id, source: input.list.name });
    },
    todo: { taskLists: async () => (seeds.failTodo === true ? err({ kind: 'permanent' as const, message: 'MailboxNotEnabledForRESTAPI' }) : ok(seeds.todoLists ?? [])) },
    syncTeam: async (input) => {
      teamRuns.push({ team: input.team.name, channels: input.channels.map((channel) => channel.name) });
      reached.push({ kind: 'team', since: input.since });
      if (fails('team')) return busy('team');
      return ok({ ...SOURCE_RUN, id: input.team.id, source: input.team.name });
    },
    teams: {
      listTeams: async () => (seeds.failTeams === true ? err({ kind: 'permanent' as const, message: 'Forbidden' }) : ok(seeds.teams ?? [])),
      listChannels: async () =>
        seeds.failChannels === true
          ? err({ kind: 'permanent' as const, message: 'Forbidden' })
          : ok(
              seeds.teamChannels ?? [
                { id: 'ch-general', name: 'General' },
                { id: 'ch-planning', name: 'Planning' },
              ]
            ),
    },
    savedChannels: async () => seeds.savedChannels ?? [{ id: 'ch-general', name: 'General' }],
    syncPeople: async (input) => {
      peopleRuns.push({ concurrency: input.concurrency, dryRun: input.dryRun });
      if (fails('people')) return busy('people');
      return ok({ ...SOURCE_RUN, id: 'people', source: 'People' });
    },
    syncCalendar: async (input) => {
      calendarRuns.push({ since: input.since });
      if (fails('calendar')) return busy('calendar');
      return ok({ ...SOURCE_RUN, id: 'calendar', source: 'Calendar' });
    },
    syncNotebook: async (input) => {
      notebookRuns.push(input.notebook.name);
      reached.push({ kind: 'notebook', since: input.since });
      if (fails('notebook')) return busy('notebook');
      return ok({ ...SOURCE_RUN, id: input.notebook.id, source: input.notebook.name });
    },
    notebooks: { listNotebooks: async () => (seeds.failNotebooks === true ? err({ kind: 'permanent' as const, message: 'OneNote read blocked' }) : ok(seeds.notebooks ?? [])) },
    savedNotebook: async () => seeds.savedNotebook,
    syncLists: async (input) => {
      listsRuns.push(input.site.name);
      if (seeds.failLists === true) return err({ step: 'listLists', cause: 'permanent', message: 'Forbidden' });
      return ok({ ...SOURCE_RUN, id: `lists:${input.site.id}`, source: `${input.site.name} (lists)` });
    },
    syncPlan: async (input) => {
      planRuns.push(input.plan.title);
      if (seeds.failPlanSync === true) return err({ step: 'listTasks', cause: 'transient', message: 'Graph is busy' });
      return ok({ ...SOURCE_RUN, id: input.plan.id, source: input.plan.title });
    },
    plans: {
      listPlans: async () => (seeds.failPlans === true ? err({ kind: 'permanent' as const, message: 'Forbidden' }) : ok(seeds.plans ?? [])),
      plan: async (planId) => {
        const found = seeds.unfetchablePlans === true ? undefined : [...(seeds.plans ?? []), ...(seeds.hiddenPlans ?? [])].find((plan) => plan.id === planId);
        return found === undefined ? err({ kind: 'permanent' as const, status: 404, message: 'The requested item is not found.' }) : ok(found);
      },
    },
    savedPlan: async () => seeds.savedPlan,
    cachedSites: async () => seeds.cached,
    storedSince: async () => {
      if (seeds.unreadableSince === true) return err({ step: 'readSince', cause: 'bad-since', message: 'kb/.decant.json does not say a day like 2026-01-31, or all' });
      return ok(seeds.firstRun === true ? undefined : (seeds.stored ?? 'all'));
    },
    rememberSince: async (since) => {
      rememberedSince.push(since);
    },
    view: pickerView,
    rememberSites: async (listed) => {
      remembered.push(listed);
    },
    prompt,
    logger,
    syncSite: async (input) => {
      calls.push(input);
      return ok(seeds.summary === undefined ? SOURCE_RUN : { ...SOURCE_RUN, summary: seeds.summary });
    },
    listSyncedSources: async () => ok(seeds.synced ?? []),
    savedDrives: async () => seeds.savedDrives ?? [{ id: 'b!one', name: 'Documents' }],
    syncMailbox: async (input) => {
      mailboxRuns.push(input);
      return ok({ ...SOURCE_RUN, id: 'me', source: 'Mailbox' });
    },
    writeGlobalReport: async ({ ran, dryRun, stopped }) => {
      reported.push({ ran, dryRun, stopped });
      return seeds.unreported === true ? undefined : (seeds.reportPath ?? 'kb/_sync-report.md');
    },
  });
  const result = await runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 4, dryRun: false, ...over });
  return {
    calls,
    groupRuns,
    todoRuns,
    teamRuns,
    peopleRuns,
    calendarRuns,
    notebookRuns,
    listsRuns,
    planRuns,
    mailboxRuns,
    reached,
    reported,
    prompt,
    logger,
    ok: result.ok,
    error: result.ok ? undefined : result.error.message,
    step: result.ok ? undefined : result.error.step,
    cause: result.ok ? undefined : result.error.cause,
    summaries: result.ok ? result.value : undefined,
    remembered,
    rememberedSince,
    reader,
  };
};

describe('remembering the sites so the next run does not wait for them', () => {
  const CACHED: SiteCache = { listedAt: '2026-08-27T20:14:00Z', sites: [{ id: 'contoso,9,9', name: 'Site From Last Time', webUrl: 'https://tenant.sharepoint.com/sites/Last' }] };

  it('a second run draws the picker from what it stored, without asking Graph first', async () => {
    const { prompt, reader } = await run(['q'], {}, { cached: CACHED });

    expect(prompt.shown.join('\n')).toContain('Site From Last Time');
    expect(reader.calls).not.toContain('listSites');
  });

  it('what the refresh finds replaces the cache, so the next run sees the new site', async () => {
    const { remembered } = await run(['1', '1'], {}, { cached: CACHED });

    expect(remembered).toHaveLength(1);
    expect(remembered[0]?.map((site) => site.name)).toEqual(['Espace Contoso', 'Direction']);
  });

  it('quitting leaves the stored list alone rather than paying for a refresh nobody asked for', async () => {
    const { remembered } = await run(['q'], {}, { cached: CACHED });

    expect(remembered).toHaveLength(0);
  });

  it('a refresh asked for outright ignores the stored list and lists before drawing', async () => {
    const { prompt, remembered } = await run(['q'], { refresh: true }, { cached: CACHED });

    expect(prompt.shown.join('\n')).toContain('Espace Contoso');
    expect(prompt.shown.join('\n')).not.toContain('Site From Last Time');
    expect(remembered).toHaveLength(1);
  });

  it('a first run with nothing stored lists for real, once, and keeps what it found', async () => {
    const { prompt, remembered } = await run(['1', '1']);

    expect(prompt.shown.join('\n')).toContain('Espace Contoso');
    expect(remembered).toHaveLength(1);
    expect(remembered[0]?.map((site) => site.name)).toEqual(['Espace Contoso', 'Direction']);
  });

  it('a refresh that fails leaves the stored list as it was, and the run it rode alongside still finishes', async () => {
    const { ok: succeeded, mailboxRuns, remembered } = await run(['m'], {}, { cached: CACHED, reader: { failWith: { kind: 'transient', message: 'Graph is busy' } } });

    expect(succeeded).toBe(true);
    expect(mailboxRuns).toHaveLength(1);
    expect(remembered).toHaveLength(0);
  });
});

describe('choosing what to sync', () => {
  it('picking a site then a library syncs exactly that pair', async () => {
    const { calls, prompt } = await run(['1', '1']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.site.name).toBe('Espace Contoso');
    expect(calls[0]?.drives).toEqual([{ id: 'b!one', name: 'Documents' }]);
    expect(prompt.shown).toContain('Libraries in this site:\n\n  1) Documents  (new)\n  2) Site Assets  (new)\n\nChoose one or more numbers (1,3), or all.');
    expect(prompt.asked).toEqual(['Source:', 'Libraries:']);
  });

  it('the site list marks what is already synced, so the operator sees what is new', async () => {
    const synced = [{ kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 143 }];
    const { prompt } = await run(['1', '1'], {}, { synced });

    expect(prompt.shown[0]).toContain('Espace Contoso  (synced 2026-07-22, 143 files)');
    expect(prompt.shown[0]).toContain('Direction  (new)');
  });

  it('several libraries can be chosen at once', async () => {
    const { calls } = await run(['1', '1,2']);

    expect(calls[0]?.drives).toEqual(drives);
  });

  it('the group inboxes are offered under the sites, and a number below them picks one', async () => {
    const { groupRuns, prompt, logger } = await run(['3'], {}, { groups: [{ id: '0d3b-group', name: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com' }] });

    expect(prompt.shown.join('\n')).toContain('Group inboxes:\n  3) Northwind Leadership Team  (new)');
    expect(groupRuns).toEqual(['Northwind Leadership Team']);
    expect(prompt.shown.join('\n')).toContain('Northwind Leadership Team (group inbox): 2 converted');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'group.started', meta: { group: '0d3b-group' } });
  });

  it('a site and a group taken together are both synced, and the site is not asked about its libraries', async () => {
    const { calls, groupRuns, prompt } = await run(['1,3'], {}, { groups: [{ id: '0d3b-group', name: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com' }] });

    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(groupRuns).toEqual(['Northwind Leadership Team']);
    expect(prompt.asked).toEqual(['Source:']);
  });

  it('a group named outright is synced without drawing the picker, by its id or its address', async () => {
    const groups = [
      { id: '7a1c-group', name: 'Finance Team', mail: 'FinanceTeam@example.com' },
      { id: '0d3b-group', name: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com' },
    ];
    const byId = await run([], { groupId: '0d3b-group' }, { groups });
    const byMail = await run([], { groupId: 'NorthwindLeadershipTeam@example.com' }, { groups });

    expect(byId.groupRuns).toEqual(['Northwind Leadership Team']);
    expect(byMail.groupRuns).toEqual(['Northwind Leadership Team']);
    expect(byId.prompt.asked).toEqual([]);
    expect(byId.calls).toEqual([]);
  });

  it('a group you do not belong to is refused by name rather than syncing something else', async () => {
    const { ok: succeeded, step, cause, error } = await run([], { groupId: 'support@example.com' }, { groups: [] });

    expect(succeeded).toBe(false);
    expect(step).toBe('findGroup');
    expect(cause).toBe('bad-choice');
    expect(error).toBe('no group you belong to is support@example.com');
  });

  it('a named group whose listing is refused stops the run and names the step, rather than syncing nothing', async () => {
    const { ok: succeeded, step, error } = await run([], { groupId: '0d3b-group' }, { failGroups: true });

    expect(succeeded).toBe(false);
    expect(step).toBe('listGroups');
    expect(error).toBe('ErrorAccessDenied');
  });

  it('a picker drawn while the group listing is refused still offers the sites, and says why it is short', async () => {
    const { calls, prompt, logger } = await run(['1', 'all'], {}, { failGroups: true });

    expect(prompt.shown.join('\n')).not.toContain('Group inboxes:');
    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'groups.unlisted', meta: { cause: 'permanent' } });
  });

  it('an update refreshes the group inboxes already in the knowledge base, alongside the sites', async () => {
    const { groupRuns } = await run(
      [],
      { command: 'update' },
      { synced: [{ kind: 'group', id: '0d3b-group', name: 'Northwind Leadership Team', lastRun: '2026-09-06T09:00:00Z', fileCount: 13 }] }
    );

    expect(groupRuns).toEqual(['Northwind Leadership Team']);
  });

  it('the To Do lists are offered under the group inboxes, and a number below them picks one', async () => {
    const { todoRuns, prompt, logger } = await run(['3'], {}, { todoLists: [{ id: 'list-1', name: 'Tasks' }] });

    expect(prompt.shown.join('\n')).toContain('To Do:\n  3) Tasks  (new)');
    expect(todoRuns).toEqual(['Tasks']);
    expect(prompt.shown.join('\n')).toContain('Tasks: 2 converted');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'todo.started', meta: { list: 'list-1' } });
  });

  it('a site, a group and a To Do list taken together are each synced, in the order the picker drew them', async () => {
    const { calls, groupRuns, todoRuns } = await run(
      ['1,3,4'],
      {},
      { groups: [{ id: '0d3b-group', name: 'Northwind Leadership Team', mail: 'NorthwindLeadershipTeam@example.com' }], todoLists: [{ id: 'list-1', name: 'Tasks' }] }
    );

    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(groupRuns).toEqual(['Northwind Leadership Team']);
    expect(todoRuns).toEqual(['Tasks']);
  });

  it('a To Do list named outright is synced without drawing the picker, by its id or its name', async () => {
    const todoLists = [
      { id: 'list-0', name: 'Errands' },
      { id: 'list-1', name: 'Tasks' },
    ];
    const byId = await run([], { todoListId: 'list-1' }, { todoLists });
    const byName = await run([], { todoListId: 'Tasks' }, { todoLists });

    expect(byId.todoRuns).toEqual(['Tasks']);
    expect(byName.todoRuns).toEqual(['Tasks']);
    expect(byId.prompt.asked).toEqual([]);
  });

  it('a To Do list this account does not have is refused by name rather than syncing something else', async () => {
    const { ok: succeeded, step, cause, error } = await run([], { todoListId: 'Groceries' }, { todoLists: [] });

    expect(succeeded).toBe(false);
    expect(step).toBe('findTodoList');
    expect(cause).toBe('bad-choice');
    expect(error).toBe('no To Do list of yours is Groceries');
  });

  it('a named To Do list whose listing is refused stops the run and names the step', async () => {
    const { ok: succeeded, step, error } = await run([], { todoListId: 'list-1' }, { failTodo: true });

    expect(succeeded).toBe(false);
    expect(step).toBe('listTaskLists');
    expect(error).toBe('MailboxNotEnabledForRESTAPI');
  });

  it('an update refreshes the To Do lists already in the knowledge base, alongside the rest', async () => {
    const { todoRuns } = await run([], { command: 'update' }, { synced: [{ kind: 'todo', id: 'list-1', name: 'Tasks', lastRun: '2026-09-08T09:00:00Z', fileCount: 21 }] });

    expect(todoRuns).toEqual(['Tasks']);
  });

  it('a To Do listing that fails costs the lists and not the picker', async () => {
    const { calls, prompt, logger } = await run(['1', 'all'], {}, { failTodo: true });

    expect(prompt.shown.join('\n')).not.toContain('To Do:');
    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'todo.unlisted', meta: { cause: 'permanent' } });
  });

  it('the teams are offered under the To Do lists, and picking one asks which of its channels to take', async () => {
    const { teamRuns, prompt, logger } = await run(['3', '2'], {}, { teams: [{ id: 'team-1', name: 'Northwind Leadership' }] });

    expect(prompt.shown.join('\n')).toContain('Teams:\n  3) Northwind Leadership  (new)');
    expect(prompt.shown.join('\n')).toContain('Channels in this team:\n\n  1) General  (new)\n  2) Planning  (new)');
    expect(prompt.asked).toEqual(['Source:', 'Channels:']);
    expect(teamRuns).toEqual([{ team: 'Northwind Leadership', channels: ['Planning'] }]);
    expect(prompt.shown).toContain('Northwind Leadership: 2 converted, 0 moved, 0 archived, 0 skipped, 0 failed.');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'team.started', meta: { teamId: 'team-1', channels: 1 } });
  });

  it('a team taken together with another source takes every channel without asking, since choosing them together was the point', async () => {
    const { calls, teamRuns, prompt } = await run(['1,3'], {}, { teams: [{ id: 'team-1', name: 'Northwind Leadership' }] });

    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(teamRuns).toEqual([{ team: 'Northwind Leadership', channels: ['General', 'Planning'] }]);
    expect(prompt.asked).toEqual(['Source:']);
  });

  it('a team named outright is synced with every channel and no picker, by its name or its id', async () => {
    const teams = [
      { id: 'team-0', name: 'Finance' },
      { id: 'team-1', name: 'Northwind Leadership' },
    ];
    const byId = await run([], { teamId: 'team-1' }, { teams });
    const byName = await run([], { teamId: 'Northwind Leadership' }, { teams });

    expect(byId.teamRuns).toEqual([{ team: 'Northwind Leadership', channels: ['General', 'Planning'] }]);
    expect(byName.teamRuns).toEqual([{ team: 'Northwind Leadership', channels: ['General', 'Planning'] }]);
    expect(byId.prompt.asked).toEqual([]);
  });

  it('a team you are not in is refused by name rather than syncing something else', async () => {
    const { ok: succeeded, step, cause, error } = await run([], { teamId: 'Ghost Team' }, { teams: [] });

    expect(succeeded).toBe(false);
    expect(step).toBe('findTeam');
    expect(cause).toBe('bad-choice');
    expect(error).toBe('no team you belong to is Ghost Team');
  });

  it('a named team whose listing, or whose channel listing, is refused stops the run and names the step', async () => {
    const unlisted = await run([], { teamId: 'team-1' }, { failTeams: true });
    const noChannels = await run([], { teamId: 'team-1' }, { teams: [{ id: 'team-1', name: 'Leadership' }], failChannels: true });

    expect({ ok: unlisted.ok, step: unlisted.step }).toEqual({ ok: false, step: 'listTeams' });
    expect({ ok: noChannels.ok, step: noChannels.step, teamRuns: noChannels.teamRuns }).toEqual({ ok: false, step: 'listChannels', teamRuns: [] });
  });

  it('an update refreshes the teams already in the knowledge base, with the channels the earlier run recorded', async () => {
    const { teamRuns } = await run(
      [],
      { command: 'update' },
      {
        synced: [{ kind: 'team', id: 'team-1', name: 'Northwind Leadership', lastRun: '2026-09-10T09:00:00Z', fileCount: 40 }],
        savedChannels: [{ id: 'ch-planning', name: 'Planning' }],
      }
    );

    expect(teamRuns).toEqual([{ team: 'Northwind Leadership', channels: ['Planning'] }]);
  });

  it('a team listing that fails costs the teams and not the picker', async () => {
    const { calls, prompt, logger } = await run(['1', 'all'], {}, { failTeams: true });

    expect(prompt.shown.join('\n')).not.toContain('Teams:');
    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'teams.unlisted', meta: { cause: 'permanent' } });
  });

  it('a team whose channels cannot be listed stops the run naming the step, rather than syncing nothing and calling it done', async () => {
    const { ok: succeeded, step } = await run(['3'], {}, { teams: [{ id: 'team-1', name: 'Northwind Leadership' }], failChannels: true });

    expect(succeeded).toBe(false);
    expect(step).toBe('listChannels');
  });

  it('a channel answer nobody offered, or one that is not a number, stops the run at the pickChannels step with the reason', async () => {
    const teams = [{ id: 'team-1', name: 'Leadership' }];
    const unoffered = await run(['3', '9'], {}, { teams });
    const letter = await run(['3', 'q'], {}, { teams });

    expect({ step: unoffered.step, cause: unoffered.cause, error: unoffered.error }).toEqual({ step: 'pickChannels', cause: 'bad-choice', error: 'no such choice: 9' });
    expect({ step: letter.step, cause: letter.cause, error: letter.error }).toEqual({ step: 'pickChannels', cause: 'bad-choice', error: 'choose channels by number, or all' });
    expect([...unoffered.teamRuns, ...letter.teamRuns]).toEqual([]);
  });

  it('p syncs the people directory, offered beside the mailbox and marked when it has been synced', async () => {
    const { peopleRuns, prompt, logger } = await run(['p'], {}, { synced: [{ kind: 'people', id: 'people', name: 'People', lastRun: '2026-09-11T09:00:00Z', fileCount: 97 }] });

    expect(prompt.shown.join('\n')).toContain('  p) People, everyone in your Teams  (synced 2026-09-11, 97 files)');
    expect(peopleRuns).toHaveLength(1);
    expect(prompt.shown.join('\n')).toContain('People: 2 converted');
    expect(logger.calls.some((entry) => entry.event === 'people.started')).toBe(true);
  });

  it('--people syncs the directory without drawing the picker, passing the dry run and the concurrency through', async () => {
    const { peopleRuns, prompt } = await run([], { people: true, dryRun: true });

    expect(peopleRuns).toEqual([{ concurrency: 4, dryRun: true }]);
    expect(prompt.asked).toEqual([]);
  });

  it('an update refreshes the people directory when it is already in the knowledge base, and leaves it alone when it is not', async () => {
    const refreshed = await run([], { command: 'update' }, { synced: [{ kind: 'people', id: 'people', name: 'People', lastRun: '2026-09-11T09:00:00Z', fileCount: 97 }] });
    const untouched = await run([], { command: 'update' }, { synced: [] });

    expect(refreshed.peopleRuns).toHaveLength(1);
    expect(untouched.peopleRuns).toHaveLength(0);
  });

  it('c syncs the calendar, offered beside the mailbox and marked when it has been synced, and --since reaches it', async () => {
    const { calendarRuns, prompt, logger } = await run(
      ['c'],
      { since: '2026-09-01' },
      { synced: [{ kind: 'calendar', id: 'calendar', name: 'Calendar', lastRun: '2026-09-12T09:00:00Z', fileCount: 300 }] }
    );

    expect(prompt.shown.join('\n')).toContain('  c) My calendar  (synced 2026-09-12, 300 files)');
    expect(calendarRuns).toEqual([{ since: '2026-09-01' }]);
    expect(prompt.shown.join('\n')).toContain('Calendar: 2 converted');
    expect(logger.calls.some((entry) => entry.event === 'calendar.started')).toBe(true);
  });

  it('--calendar syncs the calendar without drawing the picker, and an update refreshes it only when it is already in the knowledge base', async () => {
    const flagged = await run([], { calendar: true });
    const refreshed = await run([], { command: 'update' }, { synced: [{ kind: 'calendar', id: 'calendar', name: 'Calendar', lastRun: '2026-09-12T09:00:00Z', fileCount: 300 }] });
    const untouched = await run([], { command: 'update' }, { synced: [] });

    expect(flagged.calendarRuns).toHaveLength(1);
    expect(flagged.prompt.asked).toEqual([]);
    expect(refreshed.calendarRuns).toHaveLength(1);
    expect(untouched.calendarRuns).toHaveLength(0);
  });

  it('the notebooks are offered under the teams, found through the sites the picker knows, and a number below them syncs one', async () => {
    const notebook = { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: '', site: { id: 'contoso,1,2', name: 'Espace Contoso' } };
    const { notebookRuns, prompt, logger } = await run(['3'], {}, { notebooks: [notebook] });

    expect(prompt.shown.join('\n')).toContain('OneNote:\n  3) Northwind Leadership Notebook  (new)');
    expect(notebookRuns).toEqual(['Northwind Leadership Notebook']);
    expect(prompt.shown).toContain('Northwind Leadership Notebook: 2 converted, 0 moved, 0 archived, 0 skipped, 0 failed.');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'notebook.started', meta: { notebook: '1-nb' } });
  });

  it('a notebook named outright is synced without the picker, by its name or its id, and one nobody can read is refused by name', async () => {
    const notebooks = [
      { id: '0-nb', name: 'Finance Notebook', webUrl: '', site: undefined },
      { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: '', site: undefined },
    ];
    const byName = await run([], { notebookId: 'Northwind Leadership Notebook' }, { notebooks });
    const byId = await run([], { notebookId: '1-nb' }, { notebooks });
    const missing = await run([], { notebookId: 'Ghost' }, { notebooks: [] });

    expect(byName.notebookRuns).toEqual(['Northwind Leadership Notebook']);
    expect(byName.prompt.asked).toEqual([]);
    expect(byId.notebookRuns).toEqual(['Northwind Leadership Notebook']);
    expect(missing.ok).toBe(false);
    expect({ step: missing.step, cause: missing.cause, error: missing.error }).toEqual({ step: 'findNotebook', cause: 'bad-choice', error: 'no notebook you can read is Ghost' });
  });

  it('a named notebook stops the run naming the step when the notebooks, or the sites they are found through, cannot be listed', async () => {
    const unlisted = await run([], { notebookId: '1-nb' }, { failNotebooks: true });
    const noSites = await run([], { notebookId: '1-nb' }, { reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect({ ok: unlisted.ok, step: unlisted.step }).toEqual({ ok: false, step: 'listNotebooks' });
    expect({ ok: noSites.ok, step: noSites.step }).toEqual({ ok: false, step: 'listSites' });
  });

  it('an update refreshes a notebook from the record its earlier run left, and stops naming the step when the record is gone', async () => {
    const synced = [{ kind: 'notebook' as const, id: '1-nb', name: 'Northwind Leadership Notebook', lastRun: '2026-09-12T09:00:00Z', fileCount: 12 }];
    const found = await run([], { command: 'update' }, { synced, savedNotebook: { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: '', site: { id: 's', name: 'S' } } });
    const lost = await run([], { command: 'update' }, { synced, savedNotebook: undefined });

    expect(found.notebookRuns).toEqual(['Northwind Leadership Notebook']);
    expect(lost.ok).toBe(false);
    expect({ step: lost.step, cause: lost.cause, error: lost.error }).toEqual({
      step: 'savedNotebook',
      cause: 'not-found',
      error: 'no record of the notebook Northwind Leadership Notebook',
    });
  });

  it('the lists of every site are offered last, off the same listing as the libraries, and a number there syncs a site`s lists and not its libraries', async () => {
    const { calls, listsRuns, prompt, logger } = await run(['4']);

    expect(prompt.shown.join('\n')).toContain('SharePoint lists:\n  3) Espace Contoso  (new)\n  4) Direction  (new)');
    expect(listsRuns).toEqual(['Direction']);
    expect(calls).toEqual([]);
    expect(prompt.shown.join('\n')).toContain('Direction (lists)');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'lists.started', meta: { site: 'contoso,3,4' } });
  });

  it('a site synced for its libraries is not marked as synced for its lists, nor the other way round', async () => {
    const synced = [
      { kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-09-10T09:00:00Z', fileCount: 40 },
      { kind: 'lists' as const, id: 'contoso,3,4', name: 'Direction', lastRun: '2026-09-11T09:00:00Z', fileCount: 3 },
    ];
    const { prompt } = await run(['q'], {}, { synced });

    const shown = prompt.shown.join('\n');
    expect(shown).toContain('  1) Espace Contoso  (synced 2026-09-10, 40 files)');
    expect(shown).toContain('  2) Direction  (new)');
    expect(shown).toContain('  3) Espace Contoso  (new)');
    expect(shown).toContain('  4) Direction  (synced 2026-09-11, 3 files)');
  });

  it('a Loop workspace and a OneDrive are not offered for their lists', async () => {
    const mixed = [
      { id: 'loop,1,1', name: 'Planning', webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_1' },
      { id: 'drive,1,1', name: 'My files', webUrl: 'https://tenant-my.sharepoint.com/personal/jane' },
      { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/contoso' },
    ];
    const { prompt } = await run(['q'], {}, { reader: { sites: mixed } });

    expect(prompt.shown.join('\n')).toContain('SharePoint lists:\n  4) Espace Contoso  (new)');
    expect(prompt.shown.join('\n')).not.toContain('5)');
  });

  it('a site named for its lists is synced without the picker, by name, by id or by address, and one unknown is refused by name', async () => {
    const byName = await run([], { listsSite: 'Direction' });
    const byId = await run([], { listsSite: 'contoso,1,2' });
    const byAddress = await run([], { listsSite: 'https://tenant.sharepoint.com/sites/dir' });
    const missing = await run([], { listsSite: 'Ghost' });
    const unlisted = await run([], { listsSite: 'Ghost' }, { reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect(byName.listsRuns).toEqual(['Direction']);
    expect(byName.prompt.asked).toEqual([]);
    expect(byName.calls).toEqual([]);
    expect(byId.listsRuns).toEqual(['Espace Contoso']);
    expect(byAddress.listsRuns).toEqual(['Direction']);
    expect(missing.ok).toBe(false);
    expect({ step: missing.step, cause: missing.cause, error: missing.error }).toEqual({ step: 'findListsSite', cause: 'bad-choice', error: 'no site you can read is Ghost' });
    expect(unlisted.step).toBe('listSites');
  });

  it('a site`s lists chosen beside its libraries and a notebook are each synced once, the lists last, and the run stops where the lists fail', async () => {
    const notebook = { id: '1-nb', name: 'Northwind Leadership Notebook', webUrl: '', site: undefined };
    const together = await run(['1,3,5'], {}, { notebooks: [notebook] });
    const stopped = await run(['3,4'], {}, { failLists: true });

    expect(together.calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(together.notebookRuns).toEqual(['Northwind Leadership Notebook']);
    expect(together.listsRuns).toEqual(['Direction']);
    expect(together.prompt.asked).toEqual(['Source:']);
    expect(stopped.ok).toBe(false);
    expect(stopped.step).toBe('listLists');
    expect(stopped.listsRuns).toEqual(['Espace Contoso']);
  });

  it('an update refreshes every site`s lists already synced, after the notebooks, and stops where one fails', async () => {
    const synced = [
      { kind: 'lists' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-09-11T09:00:00Z', fileCount: 3 },
      { kind: 'lists' as const, id: 'contoso,3,4', name: 'Direction', lastRun: '2026-09-11T09:00:00Z', fileCount: 1 },
    ];
    const both = await run([], { command: 'update' }, { synced });
    const stopped = await run([], { command: 'update' }, { synced, failLists: true });

    expect(both.listsRuns).toEqual(['Espace Contoso', 'Direction']);
    expect(both.summaries?.map((summary) => summary.id)).toEqual(['lists:contoso,1,2', 'lists:contoso,3,4']);
    expect(stopped.ok).toBe(false);
    expect(stopped.step).toBe('listLists');
    expect(stopped.listsRuns).toEqual(['Espace Contoso']);
  });

  it('the plans are offered last, found through the groups the picker lists, and a number there syncs one', async () => {
    const plan = { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' };
    const { planRuns, prompt, logger } = await run(['5'], {}, { plans: [plan] });
    const stopped = await run(['5,3'], {}, { plans: [plan], failPlanSync: true });

    expect(prompt.shown.join('\n')).toContain('Planner:\n  5) Offsite 2026  (new)');
    expect(planRuns).toEqual(['Offsite 2026']);
    expect(prompt.shown.some((text) => text.startsWith('Offsite 2026:'))).toBe(true);
    expect(logger.calls).toContainEqual({ level: 'info', event: 'plan.started', meta: { plan: 'plan-1' } });
    expect(stopped.ok).toBe(false);
    expect(stopped.step).toBe('listTasks');
    expect(stopped.listsRuns).toEqual(['Espace Contoso']);
    expect(stopped.prompt.shown.some((text) => text.startsWith('Offsite 2026:'))).toBe(false);
  });

  it('a plan named outright is synced without the picker, by title or by id among the plans listed, or by id fetched outright; one nobody can read is refused', async () => {
    const plan = { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' };
    const byTitle = await run([], { planId: 'Offsite 2026' }, { plans: [plan] });
    const byId = await run([], { planId: 'plan-1' }, { plans: [plan], unfetchablePlans: true });
    const fetched = await run([], { planId: 'plan-1' }, { hiddenPlans: [plan] });
    const missing = await run([], { planId: 'Ghost' }, { plans: [plan] });
    const unlisted = await run([], { planId: 'plan-1' }, { plans: [plan], failPlans: true });

    expect(byTitle.planRuns).toEqual(['Offsite 2026']);
    expect(byTitle.prompt.asked).toEqual([]);
    expect(byId.planRuns).toEqual(['Offsite 2026']);
    expect(fetched.planRuns).toEqual(['Offsite 2026']);
    expect(missing.ok).toBe(false);
    expect({ step: missing.step, cause: missing.cause, error: missing.error }).toEqual({ step: 'findPlan', cause: 'bad-choice', error: 'no plan you can read is Ghost' });
    expect(unlisted.step).toBe('listPlans');
  });

  it('an update refreshes a plan from the record its earlier run left, after the lists, and stops naming the step when the record is gone or the plan fails', async () => {
    const synced = [
      { kind: 'lists' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-09-11T09:00:00Z', fileCount: 3 },
      { kind: 'plan' as const, id: 'plan-1', name: 'Offsite 2026', lastRun: '2026-09-11T09:00:00Z', fileCount: 4 },
    ];
    const found = await run([], { command: 'update' }, { synced, savedPlan: { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' } });
    const lost = await run([], { command: 'update' }, { synced, savedPlan: undefined });
    const broken = await run([], { command: 'update' }, { synced, savedPlan: { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' }, failPlanSync: true });

    expect(found.planRuns).toEqual(['Offsite 2026']);
    expect({ ok: broken.ok, step: broken.step }).toEqual({ ok: false, step: 'listTasks' });
    expect(found.summaries?.map((summary) => summary.id)).toEqual(['lists:contoso,1,2', 'plan-1']);
    expect(lost.ok).toBe(false);
    expect({ step: lost.step, cause: lost.cause, error: lost.error }).toEqual({ step: 'savedPlan', cause: 'not-found', error: 'no record of the plan Offsite 2026' });
  });

  it('a plan listing that fails costs the plans and not the picker', async () => {
    const { calls, prompt, logger } = await run(['1', 'all'], {}, { failPlans: true });

    expect(prompt.shown.join('\n')).not.toContain('Planner:');
    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'plans.unlisted', meta: { cause: 'permanent' } });
  });

  it('a notebook listing that fails costs the notebooks and not the picker', async () => {
    const { calls, prompt, logger } = await run(['1', 'all'], {}, { failNotebooks: true });

    expect(prompt.shown.join('\n')).not.toContain('OneNote:');
    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'notebooks.unlisted', meta: { cause: 'permanent' } });
  });

  it('a group listing that fails costs the group inboxes and not the picker', async () => {
    const { calls, prompt, logger } = await run(['1', 'all'], {}, { groups: undefined });

    expect(prompt.shown.join('\n')).not.toContain('Group inboxes:');
    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso']);
    expect(logger.calls.every((entry) => entry.event !== 'groups.unlisted')).toBe(true);
  });

  it('choosing every site syncs each one, taking every library in each', async () => {
    const { calls } = await run(['all']);

    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso', 'Direction']);
    expect(calls.every((call) => call.drives.length === 2)).toBe(true);
  });

  it('choosing a few sites by number syncs exactly those, and asks nothing more', async () => {
    const three = [...sites, { id: 'contoso,5,6', name: 'Ventes', webUrl: 'https://tenant.sharepoint.com/sites/ventes' }];
    const { calls, prompt } = await run(['1,3'], {}, { reader: { sites: three } });

    expect(calls.map((call) => call.site.name)).toEqual(['Espace Contoso', 'Ventes']);
    expect(prompt.asked).toEqual(['Source:']);
  });

  it('the number shown against a source is the one that picks it, once the listing is grouped', async () => {
    const mixed = [
      { id: 'drive,1,1', name: 'My files', webUrl: 'https://tenant-my.sharepoint.com/personal/jane' },
      { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/contoso' },
    ];
    const { calls, prompt } = await run(['2', 'all'], {}, { reader: { sites: mixed } });

    expect(prompt.shown.join('\n')).toContain('  2) My files');
    expect(calls.map((call) => call.site.name)).toEqual(['My files']);
  });

  it('the number shown against a source picks exactly that one, however many of every kind the picker lists', async () => {
    const groups = [
      { id: 'g-1', name: 'Board', mail: 'board@example.com' },
      { id: 'g-2', name: 'Crew', mail: 'crew@example.com' },
    ];
    const todoLists = [
      { id: 'list-1', name: 'Tasks' },
      { id: 'list-2', name: 'Errands' },
    ];
    const teams = [
      { id: 'team-1', name: 'Alpha' },
      { id: 'team-2', name: 'Bravo' },
      { id: 'team-3', name: 'Charlie' },
    ];
    const notebooks = [
      { id: 'nb-1', name: 'Minutes', webUrl: '', site: undefined },
      { id: 'nb-2', name: 'Journal', webUrl: '', site: undefined },
    ];
    const plans = [
      { id: 'plan-1', title: 'Offsite', groupId: 'g-1' },
      { id: 'plan-2', title: 'Launch', groupId: 'g-2' },
    ];
    // Drawn as sites 1-2, groups 3-4, To Do lists 5-6, teams 7-9, notebooks 10-11, the sites' lists 12-13, plans 14-15.
    const { prompt, calls, groupRuns, todoRuns, teamRuns, notebookRuns, listsRuns, planRuns } = await run(['4,9,15'], {}, { groups, todoLists, teams, notebooks, plans });

    const shown = prompt.shown.join('\n');
    expect([shown.includes('  4) Crew'), shown.includes('  9) Charlie'), shown.includes(' 15) Launch')]).toEqual([true, true, true]);
    expect(groupRuns).toEqual(['Crew']);
    expect(teamRuns).toEqual([{ team: 'Charlie', channels: ['General', 'Planning'] }]);
    expect(planRuns).toEqual(['Launch']);
    expect([calls, todoRuns, notebookRuns, listsRuns]).toStrictEqual([[], [], [], []]);
  });

  it('every site is reported as it finishes, not only once the whole run is over', async () => {
    const { prompt } = await run(['all']);

    // Two sites, each reported once for its libraries and once for its lists: `all` takes every row.
    expect(prompt.shown.filter((text) => text.includes('converted'))).toHaveLength(4);
  });

  it('pasting a site address reaches a site the list does not show', async () => {
    const { calls } = await run(['https://tenant.sharepoint.com/sites/dir', '1']);

    expect(calls[0]?.site.name).toBe('Direction');
  });

  it('quitting at the picker syncs nothing', async () => {
    const { calls, ok: succeeded } = await run(['q']);

    expect(succeeded).toBe(true);
    expect(calls).toEqual([]);
  });

  it('naming a site and its library outright skips both questions, and syncs nothing else', async () => {
    const { calls, prompt, groupRuns, todoRuns, teamRuns, notebookRuns, listsRuns, planRuns } = await run([], { siteId: 'contoso,1,2', driveIds: ['b!two'] });

    expect(prompt.asked).toEqual([]);
    expect(calls[0]?.drives).toEqual([{ id: 'b!two', name: 'Site Assets' }]);
    // Strictly: `toEqual` would take a run recorded as `undefined` for no run at all.
    expect([groupRuns, todoRuns, teamRuns, notebookRuns, listsRuns, planRuns]).toStrictEqual([[], [], [], [], [], []]);
  });

  it('a site named by id is filed under its real name, not under the id', async () => {
    const { calls } = await run([], { siteId: 'contoso,1,2', driveIds: ['b!one'] });

    expect(calls[0]?.site).toEqual({ id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/contoso' });
  });

  it('an id no site answers to stops the run rather than making a folder named after it', async () => {
    const { ok: succeeded, calls } = await run([], { siteId: 'contoso,9,9', driveIds: ['b!one'] });

    expect(succeeded).toBe(false);
    expect(calls).toEqual([]);
  });

  it('naming a site by address skips the picker too', async () => {
    const { calls } = await run(['1'], { siteUrl: 'https://tenant.sharepoint.com/sites/contoso' });

    expect(calls[0]?.site.name).toBe('Espace Contoso');
  });

  it('an answer nobody offered stops the run with the reason', async () => {
    const { ok: succeeded, error } = await run(['9']);

    expect(succeeded).toBe(false);
    expect(error).toBe('no such choice: 9');
  });

  it('choosing a library that does not exist stops the run rather than syncing nothing', async () => {
    const { ok: succeeded, error } = await run([], { siteId: 'contoso,1,2', driveIds: ['b!absent'] });

    expect(succeeded).toBe(false);
    expect(error).toContain('no library chosen');
  });

  it('a site whose address cannot be resolved stops the run with the reason', async () => {
    const { ok: succeeded } = await run([], { siteUrl: 'https://tenant.sharepoint.com/sites/absent' });

    expect(succeeded).toBe(false);
  });
});

describe('refreshing everything already synced', () => {
  const synced = [
    { kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 143 },
    { kind: 'mailbox' as const, id: 'me', name: 'Mailbox', lastRun: '2026-07-22T09:00:00Z', fileCount: 12 },
  ];

  it('the update command asks nothing and syncs every site already in the knowledge base', async () => {
    const { calls, prompt } = await run([], { command: 'update' }, { synced });

    expect(prompt.asked).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.site.name).toBe('Espace Contoso');
  });

  it('the update command repeats the libraries the earlier run chose', async () => {
    const { calls } = await run([], { command: 'update' }, { synced, savedDrives: [{ id: 'b!two', name: 'Site Assets' }] });

    expect(calls[0]?.drives).toEqual([{ id: 'b!two', name: 'Site Assets' }]);
  });

  it('choosing u at the picker refreshes everything the same way', async () => {
    const { calls, prompt } = await run(['u'], {}, { synced });

    expect(calls).toHaveLength(1);
    expect(prompt.asked).toEqual(['Source:']);
  });

  it('a knowledge base holding nothing yet finishes without syncing anything', async () => {
    const { calls, ok: succeeded } = await run([], { command: 'update' });

    expect(succeeded).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('syncing the mailbox', () => {
  it('choosing m at the picker syncs the mailbox and no site', async () => {
    const { mailboxRuns, calls, prompt, logger } = await run(['m']);

    expect(mailboxRuns).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(prompt.shown.at(-1)).toContain('Mailbox:');
    expect(logger.calls).toContainEqual({ level: 'info', event: 'mailbox.started', meta: {} });
  });

  it('the mailbox is offered in the picker beside the sites', async () => {
    const { prompt } = await run(['m']);

    expect(prompt.shown[0]).toContain('m) My mailbox  (new)');
  });

  it('a mailbox already synced is marked with when it ran and how many conversations it holds', async () => {
    const synced = [{ kind: 'mailbox' as const, id: 'me', name: 'Mailbox', lastRun: '2026-07-22T09:00:00Z', fileCount: 42 }];
    const { prompt } = await run(['m'], {}, { synced });

    expect(prompt.shown[0]).toContain('m) My mailbox  (synced 2026-07-22, 42 files)');
  });

  it('naming the mailbox outright skips the picker', async () => {
    const { mailboxRuns, prompt } = await run([], { mailbox: true });

    expect(mailboxRuns).toHaveLength(1);
    expect(prompt.asked).toEqual([]);
  });

  it('a day to sync from is passed through to the mailbox run', async () => {
    const { mailboxRuns } = await run([], { mailbox: true, since: '2026-01-31' });

    expect(mailboxRuns[0]).toMatchObject({ since: '2026-01-31', dryRun: false });
  });

  it('a refresh includes the mailbox when it is already in the knowledge base', async () => {
    const synced = [
      { kind: 'mailbox' as const, id: 'me', name: 'Mailbox', lastRun: '2026-07-22T09:00:00Z', fileCount: 42 },
      { kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 143 },
    ];
    const { mailboxRuns, calls } = await run([], { command: 'update' }, { synced });

    expect(mailboxRuns).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('a refresh leaves the mailbox alone when it was never synced', async () => {
    const synced = [{ kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 143 }];
    const { mailboxRuns } = await run([], { command: 'update' }, { synced });

    expect(mailboxRuns).toEqual([]);
  });
});

describe('when the knowledge base itself cannot be read', () => {
  it('the picker still opens, simply marking nothing as synced', async () => {
    const calls: SyncSiteInput[] = [];
    const prompt = createPromptFake(['1', '1']);
    const runSync = createRunSync({
      writeGlobalReport: async () => undefined,
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt,
      logger: createLoggerFake(),
      syncSite: async (input) => {
        calls.push(input);
        return ok(SOURCE_RUN);
      },
      listSyncedSources: async () => ({ ok: false, error: { step: 'listSyncedSources', cause: 'read-failed', message: 'kb unreadable' } }),
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
      syncMailbox: async () => ok(SOURCE_RUN),
    });

    await runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(prompt.shown[0]).toContain('Espace Contoso  (new)');
    expect(calls).toHaveLength(1);
  });

  it('a refresh over an unreadable knowledge base stops rather than syncing nothing quietly', async () => {
    const runSync = createRunSync({
      writeGlobalReport: async () => undefined,
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async () => ok(SOURCE_RUN),
      listSyncedSources: async () => ({ ok: false, error: { step: 'listSyncedSources', cause: 'read-failed', message: 'kb unreadable' } }),
      savedDrives: async () => [],
      syncMailbox: async () => ok(SOURCE_RUN),
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
    });

    expect((await runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false })).ok).toBe(false);
  });
});

describe('when a library cannot be listed', () => {
  it('the run stops with the reason instead of asking which library to pick', async () => {
    const { ok: succeeded, error } = await run(['1'], { siteId: 'contoso,1,2' }, { reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect(succeeded).toBe(false);
    expect(error).toBe('not authenticated');
  });

  it('answering the library question with something that is not a number stops the run', async () => {
    const { ok: succeeded, error } = await run(['1', 'u']);

    expect(succeeded).toBe(false);
    expect(error).toBe('choose libraries by number, or all');
  });

  it('a site holding no libraries at all stops the run rather than reporting success', async () => {
    const { ok: succeeded } = await run(['1', 'all'], {}, { reader: { drives: [] } });

    expect(succeeded).toBe(false);
  });
});

describe('when one site in a refresh fails', () => {
  it('the run stops there, so the failure is not buried under later sites', async () => {
    const synced = [
      { kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 1 },
      { kind: 'site' as const, id: 'contoso,3,4', name: 'Direction', lastRun: '2026-07-22T09:00:00Z', fileCount: 1 },
    ];
    const calls: SyncSiteInput[] = [];
    const runSync = createRunSync({
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async (input) => {
        calls.push(input);
        return { ok: false, error: { step: 'enumerate', cause: 'auth', message: 'token expired' } };
      },
      listSyncedSources: async () => ok(synced),
      writeGlobalReport: async () => undefined,
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
      syncMailbox: async () => ok(SOURCE_RUN),
    });

    const result = await runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('telling the operator what happened', () => {
  it('the run reports what it did once it is finished', async () => {
    const { prompt } = await run(['1', '1']);

    expect(prompt.shown.at(-1)).toBe('Espace Contoso: 2 converted, 0 moved, 0 archived, 0 skipped, 0 failed.');
  });

  it('a dry run passes the intent through, so nothing is written', async () => {
    const { calls } = await run(['1', '1'], { dryRun: true });

    expect(calls[0]?.dryRun).toBe(true);
  });
});

describe('stopping with the step and reason named', () => {
  it('picking the second source in the list syncs that site', async () => {
    const { calls } = await run(['2', '1']);

    expect(calls[0]?.site.name).toBe('Direction');
  });

  it('an answer with no number in it stops the run, naming the pickSite step and reason', async () => {
    const { ok: succeeded, error, step, cause } = await run([',']);

    expect(succeeded).toBe(false);
    expect(step).toBe('pickSite');
    expect(cause).toBe('bad-choice');
    expect(error).toBe('choose at least one source');
  });

  it('a source answer nobody offered names the pickSite step', async () => {
    const { ok: succeeded, error, step } = await run(['9']);

    expect(succeeded).toBe(false);
    expect(step).toBe('pickSite');
    expect(error).toBe('no such choice: 9');
  });

  it('a library number the site does not offer stops the run at the pickLibraries step', async () => {
    const { ok: succeeded, error, step } = await run(['1', '9']);

    expect(succeeded).toBe(false);
    expect(step).toBe('pickLibraries');
    expect(error).toBe('no such choice: 9');
  });

  it('answering the library question with a letter names the pickLibraries step and reason', async () => {
    const { ok: succeeded, error, step, cause } = await run(['1', 'u']);

    expect(succeeded).toBe(false);
    expect(step).toBe('pickLibraries');
    expect(cause).toBe('bad-choice');
    expect(error).toBe('choose libraries by number, or all');
  });

  it('a library list Graph refuses names the listDrives step', async () => {
    const { ok: succeeded, step } = await run([], { siteId: 'contoso,1,2' }, { reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect(succeeded).toBe(false);
    expect(step).toBe('listDrives');
  });

  it('a named library the site does not have stops at the sync step with no-library', async () => {
    const { ok: succeeded, error, step, cause } = await run([], { siteId: 'contoso,1,2', driveIds: ['b!absent'] });

    expect(succeeded).toBe(false);
    expect(step).toBe('sync');
    expect(cause).toBe('no-library');
    expect(error).toContain('no library chosen');
  });

  it('an id no site answers to names the siteById step', async () => {
    const { ok: succeeded, step } = await run([], { siteId: 'contoso,9,9', driveIds: ['b!one'] });

    expect(succeeded).toBe(false);
    expect(step).toBe('siteById');
  });

  it('an address no site answers to names the siteByUrl step', async () => {
    const { ok: succeeded, step } = await run([], { siteUrl: 'https://tenant.sharepoint.com/sites/absent' });

    expect(succeeded).toBe(false);
    expect(step).toBe('siteByUrl');
  });

  it('a site list Graph refuses ends the run at the listSites step', async () => {
    const { ok: succeeded, step } = await run([], {}, { reader: { failWith: { kind: 'auth', message: 'not authenticated' } } });

    expect(succeeded).toBe(false);
    expect(step).toBe('listSites');
  });
});

describe('what a finished run carries back', () => {
  it('syncing one site returns that run summary', async () => {
    const { summaries } = await run(['1', '1']);

    expect(summaries).toHaveLength(1);
    expect(summaries?.[0]?.summary).toEqual(EMPTY_SUMMARY);
  });

  it('syncing the mailbox returns that run summary', async () => {
    const { summaries } = await run([], { mailbox: true });

    expect(summaries).toHaveLength(1);
    expect(summaries?.[0]?.summary).toEqual(EMPTY_SUMMARY);
  });

  it('a site sync logs that it started with the site id and library count', async () => {
    const { logger } = await run(['1', '1']);
    const started = logger.calls.find((call) => call.event === 'sync.started');

    expect(started?.meta).toEqual({ siteId: 'contoso,1,2', libraries: 1 });
  });
});

describe('when a source run fails after it began', () => {
  it('a mailbox run that fails is not reported as a summary', async () => {
    const prompt = createPromptFake();
    const runSync = createRunSync({
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt,
      logger: createLoggerFake(),
      syncSite: async () => ok(SOURCE_RUN),
      listSyncedSources: async () => ok([]),
      writeGlobalReport: async () => undefined,
      savedDrives: async () => [],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
      syncMailbox: async () => ({ ok: false, error: { step: 'mailbox', cause: 'auth', message: 'token expired' } }),
    });

    const result = await runSync({ command: 'sync', mailbox: true, driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(result.ok).toBe(false);
    expect(prompt.shown.some((text) => text.startsWith('Mailbox:'))).toBe(false);
  });

  it('a refresh stops when the mailbox run fails, without moving on to the sites', async () => {
    const calls: SyncSiteInput[] = [];
    const synced = [
      { kind: 'mailbox' as const, id: 'me', name: 'Mailbox', lastRun: '2026-07-22T09:00:00Z', fileCount: 12 },
      { kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 143 },
    ];
    const runSync = createRunSync({
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async (input) => {
        calls.push(input);
        return ok(SOURCE_RUN);
      },
      listSyncedSources: async () => ok(synced),
      writeGlobalReport: async () => undefined,
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
      syncMailbox: async () => ({ ok: false, error: { step: 'mailbox', cause: 'auth', message: 'token expired' } }),
    });

    const result = await runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('pointing a reader at the report a run leaves behind', () => {
  const TWO_SITES = [
    { kind: 'site' as const, id: 'contoso,1,2', name: 'Espace Contoso', lastRun: '2026-07-22T09:00:00Z', fileCount: 1 },
    { kind: 'site' as const, id: 'contoso,3,4', name: 'Direction', lastRun: '2026-07-22T09:00:00Z', fileCount: 1 },
  ];

  it('a run that left something behind ends with one line naming the report and what is in it', async () => {
    const { prompt } = await run(['1', '1'], {}, { summary: { ...EMPTY_SUMMARY, skipped: 7, failed: 2 } });
    const failedOnly = await run(['1', '1'], {}, { summary: { ...EMPTY_SUMMARY, failed: 3 } });

    expect(prompt.shown.at(-1)).toBe('2 could not be read, 7 left out. See kb/_sync-report.md');
    expect(failedOnly.prompt.shown.at(-1)).toBe('3 could not be read, 0 left out. See kb/_sync-report.md');
  });

  it('a report that could not be written is not pointed at, even when the run left something behind', async () => {
    const { prompt } = await run(['1', '1'], {}, { summary: { ...EMPTY_SUMMARY, skipped: 7, failed: 2 }, unreported: true });

    expect(prompt.shown.at(-1)).toBe('Espace Contoso: 2 converted, 0 moved, 0 archived, 7 skipped, 2 failed.');
  });

  it('a run that left nothing behind says nothing about a report, since there would be nothing to read', async () => {
    const { prompt } = await run(['1', '1']);

    expect(prompt.shown.some((shown) => shown.includes('_sync-report.md'))).toBe(false);
  });

  it('the report is written once for the whole run, however many sources the run covered', async () => {
    const { reported } = await run([], { command: 'update' }, { synced: TWO_SITES });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.ran).toHaveLength(2);
  });

  it('a dry run reaches the report knowing it was one, so nothing it describes is written down', async () => {
    const { reported } = await run(['1', '1'], { dryRun: true });

    expect(reported[0]?.dryRun).toBe(true);
  });

  it('a run that fails partway still reports the sources that finished before it', async () => {
    const reported: Array<{ ran: ReadonlyArray<SourceRun>; stopped?: string }> = [];
    let started = 0;
    const runSync = createRunSync({
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async () => {
        started += 1;
        return started === 1 ? ok(SOURCE_RUN) : { ok: false, error: { step: 'enumerate', cause: 'auth', message: 'token expired' } };
      },
      listSyncedSources: async () => ok(TWO_SITES),
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
      syncMailbox: async () => ok(SOURCE_RUN),
      writeGlobalReport: async ({ ran, stopped }) => {
        reported.push({ ran, stopped });
        return 'kb/_sync-report.md';
      },
    });

    const result = await runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 4, dryRun: false });

    expect(result.ok).toBe(false);
    // The first site finished and wrote its documents; the report must not pretend it did not.
    expect(reported[0]?.ran).toHaveLength(1);
    expect(reported[0]?.stopped).toBe('enumerate: token expired');
  });

  it('a run that fails on its very first source reports nothing, since nothing finished', async () => {
    const reported: Array<{ ran: ReadonlyArray<SourceRun> }> = [];
    const runSync = createRunSync({
      syncGroup: async () => ok(SOURCE_RUN),
      groups: { listGroups: async () => ok([]) },
      syncTodo: async () => ok(SOURCE_RUN),
      todo: { taskLists: async () => ok([]) },
      syncTeam: async () => ok(SOURCE_RUN),
      teams: { listTeams: async () => ok([]), listChannels: async () => ok([]) },
      savedChannels: async () => [],
      syncPeople: async () => ok(SOURCE_RUN),
      syncCalendar: async () => ok(SOURCE_RUN),
      syncNotebook: async () => ok(SOURCE_RUN),
      notebooks: { listNotebooks: async () => ok([]) },
      savedNotebook: async () => undefined,
      syncLists: async () => ok(SOURCE_RUN),
      syncPlan: async () => ok(SOURCE_RUN),
      plans: { listPlans: async () => ok([]), plan: async () => err({ kind: 'permanent' as const, message: 'not found' }) },
      savedPlan: async () => undefined,
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async () => ({ ok: false, error: { step: 'enumerate', cause: 'auth', message: 'token expired' } }),
      listSyncedSources: async () => ok(TWO_SITES),
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      storedSince: async () => ok('all'),
      rememberSince: async () => undefined,
      view: pickerView,
      syncMailbox: async () => ok(SOURCE_RUN),
      writeGlobalReport: async ({ ran }) => {
        reported.push({ ran });
        return undefined;
      },
    });

    await runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 4, dryRun: false });

    expect(reported[0]?.ran).toEqual([]);
  });
});

describe('stopping where a source fails, and nowhere else', () => {
  const GROUP = { id: '0d3b-group', name: 'Leadership Team', mail: 'LeadershipTeam@example.com' };
  const TODO = { id: 'list-1', name: 'Tasks' };
  const TEAM = { id: 'team-1', name: 'Leadership' };
  const NOTEBOOK = { id: '1-nb', name: 'Leadership Notebook', webUrl: '', site: undefined };
  const PLAN = { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' };
  const ALL_OFFERED = { groups: [GROUP], todoLists: [TODO], teams: [TEAM], notebooks: [NOTEBOOK], plans: [PLAN] };
  const syncedAs = (kind: SyncedSource['kind'], id: string, name: string): SyncedSource => ({ kind, id, name, lastRun: '2026-09-20T09:00:00Z', fileCount: 1 });
  const EVERY_KIND = [
    syncedAs('mailbox', 'me', 'Mailbox'),
    syncedAs('calendar', 'calendar', 'Calendar'),
    syncedAs('people', 'people', 'People'),
    syncedAs('site', 'contoso,1,2', 'Espace Contoso'),
    syncedAs('group', GROUP.id, GROUP.name),
    syncedAs('todo', TODO.id, TODO.name),
    syncedAs('team', TEAM.id, TEAM.name),
    syncedAs('notebook', NOTEBOOK.id, NOTEBOOK.name),
    syncedAs('lists', 'contoso,3,4', 'Direction'),
    syncedAs('plan', PLAN.id, PLAN.title),
  ];
  // The runs carried back, in the order an update takes the kinds.
  const UPDATED = ['me', 'calendar', 'people', 'site!one', GROUP.id, TODO.id, TEAM.id, NOTEBOOK.id, 'lists:contoso,3,4', PLAN.id];
  // The runs `all` at the picker carries back: both sites for their libraries, one of every other kind, both sites for their lists.
  const PICKED = ['site!one', 'site!one', GROUP.id, TODO.id, TEAM.id, NOTEBOOK.id, 'lists:contoso,1,2', 'lists:contoso,3,4', PLAN.id];
  const RUN_OF: Readonly<Record<FailingKind, string>> = { calendar: 'calendar', people: 'people', group: GROUP.id, todo: TODO.id, team: TEAM.id, notebook: NOTEBOOK.id };
  const finishedBefore = (order: ReadonlyArray<string>, kind: FailingKind): string[] => order.slice(0, order.indexOf(RUN_OF[kind]));

  it('an update over one source of every kind syncs each once, in a fixed order, and carries every run back', async () => {
    const { ok: succeeded, summaries } = await run([], { command: 'update' }, { synced: EVERY_KIND, savedNotebook: NOTEBOOK, savedPlan: PLAN });

    expect(succeeded).toBe(true);
    expect(summaries?.map((summary) => summary.id)).toEqual(UPDATED);
  });

  for (const kind of ['calendar', 'people', 'group', 'todo', 'team', 'notebook'] as const) {
    it(`an update stops at a ${kind} that fails, naming it, keeping what finished before it and syncing nothing after`, async () => {
      const { ok: succeeded, step, reported, planRuns } = await run([], { command: 'update' }, { synced: EVERY_KIND, savedNotebook: NOTEBOOK, savedPlan: PLAN, failing: [kind] });

      expect(succeeded).toBe(false);
      expect(step).toBe(kind);
      expect(reported[0]?.ran.map((ran) => ran.id)).toEqual(finishedBefore(UPDATED, kind));
      expect(planRuns).toEqual([]);
    });
  }

  it('every source taken with all at the picker is synced once, in the order the picker drew them, and every run is carried back', async () => {
    const { ok: succeeded, summaries, prompt } = await run(['all'], {}, ALL_OFFERED);

    expect(succeeded).toBe(true);
    expect(summaries?.map((summary) => summary.id)).toEqual(PICKED);
    expect(prompt.asked).toEqual(['Source:']);
  });

  for (const kind of ['group', 'todo', 'team', 'notebook'] as const) {
    it(`sources taken at the picker stop at a ${kind} that fails, naming it, keeping what finished before it and syncing nothing after`, async () => {
      const { ok: succeeded, step, reported, planRuns } = await run(['all'], {}, { ...ALL_OFFERED, failing: [kind] });

      expect(succeeded).toBe(false);
      expect(step).toBe(kind);
      expect(reported[0]?.ran.map((ran) => ran.id)).toEqual(finishedBefore(PICKED, kind));
      expect(planRuns).toEqual([]);
    });
  }
});

describe('reaching back as far as the first run was told to', () => {
  const ASKED = 'Since (a day like 2026-01-31, or all):';
  const CALENDAR_SYNCED = { kind: 'calendar' as const, id: 'calendar', name: 'Calendar', lastRun: '2026-09-12T09:00:00Z', fileCount: 300 };

  it('a first run asks how far back to reach once a source is chosen, keeps the answer, and hands it to the source', async () => {
    const { prompt, mailboxRuns, rememberedSince } = await run(['m', '2025-01-01'], {}, { firstRun: true });

    expect(prompt.asked).toEqual(['Source:', ASKED]);
    expect(prompt.shown).toContain(
      [
        '',
        'How far back should decant reach? From this day on it syncs mail, group inboxes, Teams posts,',
        'the calendar, library files and OneNote pages; To Do, Planner, lists and people always come whole.',
        'The answer is kept for every later run; run with --since <day|all> to change it.',
      ].join('\n')
    );
    expect(mailboxRuns).toHaveLength(1);
    expect(mailboxRuns[0]?.since).toBe('2025-01-01');
    expect(rememberedSince).toEqual(['2025-01-01']);
  });

  it('answering all keeps all, and the source is handed no day', async () => {
    const { mailboxRuns, rememberedSince } = await run(['m', 'all'], {}, { firstRun: true });

    expect(mailboxRuns).toHaveLength(1);
    expect(mailboxRuns[0]?.since).toBeUndefined();
    expect(rememberedSince).toEqual(['all']);
  });

  it('an answer that is not a day is asked again, and an answer of nothing stops the run and keeps nothing', async () => {
    const again = await run(['m', 'last week', '2025-01-01'], {}, { firstRun: true });

    expect(again.prompt.asked).toEqual(['Source:', ASKED, ASKED]);
    expect(again.prompt.shown).toContain('Not a day: last week. Answer with a day like 2026-01-31, or all.');
    expect(again.mailboxRuns[0]?.since).toBe('2025-01-01');

    const stopped = await run(['m', ''], {}, { firstRun: true });

    expect(stopped).toMatchObject({ ok: false, step: 'pickSince', cause: 'bad-choice', error: 'answer with a day like 2026-01-31, or all' });
    expect(stopped.mailboxRuns).toHaveLength(0);
    expect(stopped.rememberedSince).toEqual([]);
  });

  it('quitting the picker asks nothing more and keeps nothing', async () => {
    const { prompt, rememberedSince } = await run(['q'], {}, { firstRun: true });

    expect(prompt.asked).toEqual(['Source:']);
    expect(rememberedSince).toEqual([]);
  });

  it('a kept reach is used without asking', async () => {
    const { prompt, calendarRuns, rememberedSince } = await run(['c'], {}, { stored: '2024-06-01' });

    expect(prompt.asked).toEqual(['Source:']);
    expect(calendarRuns).toEqual([{ since: '2024-06-01' }]);
    expect(rememberedSince).toEqual([]);
  });

  it('--since replaces the kept reach and is kept for the runs after; a dry run uses a reach, named or answered, and keeps nothing', async () => {
    const moved = await run([], { mailbox: true, since: '2023-01-01' }, { stored: '2024-06-01' });

    expect(moved.mailboxRuns[0]?.since).toBe('2023-01-01');
    expect(moved.rememberedSince).toEqual(['2023-01-01']);

    const dry = await run([], { mailbox: true, since: 'all', dryRun: true }, { stored: '2024-06-01' });

    expect(dry.mailboxRuns).toHaveLength(1);
    expect(dry.mailboxRuns[0]?.since).toBeUndefined();
    expect(dry.rememberedSince).toEqual([]);

    const asked = await run(['m', '2025-01-01'], { dryRun: true }, { firstRun: true });

    expect(asked.mailboxRuns[0]?.since).toBe('2025-01-01');
    expect(asked.rememberedSince).toEqual([]);
  });

  it('a first run that uses --since in the picker is not asked again', async () => {
    const { prompt, calendarRuns } = await run(['c'], { since: '2025-03-01' }, { firstRun: true });

    expect(prompt.asked).toEqual(['Source:']);
    expect(calendarRuns).toEqual([{ since: '2025-03-01' }]);
  });

  it('update, and a source named on the command line, never ask: they take the kept reach, or everything when none was kept', async () => {
    const updated = await run([], { command: 'update' }, { firstRun: true, synced: [CALENDAR_SYNCED] });

    expect(updated.prompt.asked).toEqual([]);
    expect(updated.calendarRuns).toHaveLength(1);
    expect(updated.calendarRuns[0]?.since).toBeUndefined();

    const named = await run([], { calendar: true }, { stored: '2024-06-01' });

    expect(named.prompt.asked).toEqual([]);
    expect(named.calendarRuns).toEqual([{ since: '2024-06-01' }]);
  });

  it('a kept reach that cannot be read stops the run before anything is synced, rather than syncing everything', async () => {
    const stopped = await run([], { command: 'update' }, { unreadableSince: true, synced: [CALENDAR_SYNCED] });

    expect(stopped).toMatchObject({ ok: false, step: 'readSince', cause: 'bad-since' });
    expect(stopped.calendarRuns).toHaveLength(0);
  });

  it('--since mends a kept reach that cannot be read, without reading it', async () => {
    const mended = await run([], { calendar: true, since: '2025-01-01' }, { unreadableSince: true });

    expect(mended.ok).toBe(true);
    expect(mended.calendarRuns).toEqual([{ since: '2025-01-01' }]);
    expect(mended.rememberedSince).toEqual(['2025-01-01']);
  });
});

describe('handing the reach to every source that keeps a history', () => {
  it('a group inbox is handed the kept day', async () => {
    const { reached } = await run([], { groupId: 'g1' }, { stored: '2025-01-01', groups: [{ id: 'g1', name: 'Leadership', mail: 'lead@example.com' }] });

    expect(reached).toEqual([{ kind: 'group', since: '2025-01-01' }]);
  });

  it('a team is handed the kept day', async () => {
    const { reached } = await run([], { teamId: 't1' }, { stored: '2025-01-01', teams: [{ id: 't1', name: 'Leadership' }] });

    expect(reached).toEqual([{ kind: 'team', since: '2025-01-01' }]);
  });

  it('a site is handed the kept day', async () => {
    const { calls } = await run([], { siteId: 'contoso,1,2', driveIds: ['b!one'] }, { stored: '2025-01-01' });

    expect(calls.map((call) => call.since)).toEqual(['2025-01-01']);
  });

  it('a notebook is handed the kept day', async () => {
    const notebook = { id: 'nb1', name: 'Leadership Notebook', webUrl: 'https://tenant.sharepoint.com/nb', site: undefined };

    const { reached } = await run([], { notebookId: 'nb1' }, { stored: '2025-01-01', notebooks: [notebook] });

    expect(reached).toEqual([{ kind: 'notebook', since: '2025-01-01' }]);
  });
});
