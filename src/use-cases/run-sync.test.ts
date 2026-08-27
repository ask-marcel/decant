import { describe, expect, it } from 'bun:test';
import { ok } from '../domain/result.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import type { DriveReaderSeed } from '../test-helpers/drive-reader-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createPromptFake } from '../test-helpers/prompt-fake.ts';
import type { PromptFake } from '../test-helpers/prompt-fake.ts';
import type { SyncedSource } from '../domain/sync-state.ts';
import type { SiteCache } from '../domain/site-cache.ts';
import { createRunSync } from './run-sync.ts';
import type { RunSyncInput } from './run-sync.ts';
import type { RunSummary, SyncSiteInput } from './sync-site.ts';
import type { SyncMailboxInput } from './sync-mailbox.ts';

const sites = [
  { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/contoso' },
  { id: 'contoso,3,4', name: 'Direction', webUrl: 'https://tenant.sharepoint.com/sites/dir' },
];
const drives = [
  { id: 'b!one', name: 'Documents' },
  { id: 'b!two', name: 'Site Assets' },
];
const EMPTY_SUMMARY = { converted: 2, moved: 0, archived: 0, skipped: 0, failed: 0, queued: 0 };

const run = async (
  answers: ReadonlyArray<string>,
  over: Partial<RunSyncInput> = {},
  seeds: {
    reader?: DriveReaderSeed;
    synced?: ReadonlyArray<SyncedSource>;
    savedDrives?: ReadonlyArray<{ id: string; name: string }>;
    cached?: SiteCache;
  } = {}
): Promise<{
  calls: SyncSiteInput[];
  mailboxRuns: SyncMailboxInput[];
  prompt: PromptFake;
  logger: LoggerFake;
  ok: boolean;
  error?: string;
  step?: string;
  cause?: string;
  summaries?: ReadonlyArray<RunSummary>;
  remembered: Array<ReadonlyArray<{ id: string; name: string; webUrl: string }>>;
  reader: ReturnType<typeof createDriveReaderFake>;
}> => {
  const calls: SyncSiteInput[] = [];
  const remembered: Array<ReadonlyArray<{ id: string; name: string; webUrl: string }>> = [];
  const mailboxRuns: SyncMailboxInput[] = [];
  const prompt = createPromptFake(answers);
  const logger = createLoggerFake();
  const reader = createDriveReaderFake({ sites, drives, ...seeds.reader });
  const runSync = createRunSync({
    reader,
    cachedSites: async () => seeds.cached,
    rememberSites: async (listed) => {
      remembered.push(listed);
    },
    prompt,
    logger,
    syncSite: async (input) => {
      calls.push(input);
      return ok(EMPTY_SUMMARY);
    },
    listSyncedSources: async () => ok(seeds.synced ?? []),
    savedDrives: async () => seeds.savedDrives ?? [{ id: 'b!one', name: 'Documents' }],
    syncMailbox: async (input) => {
      mailboxRuns.push(input);
      return ok(EMPTY_SUMMARY);
    },
  });
  const result = await runSync({ command: 'sync', driveIds: [], maxBytes: 1000, ocrLabel: 'paddleocr (en)', concurrency: 4, dryRun: false, ...over });
  return {
    calls,
    mailboxRuns,
    prompt,
    logger,
    ok: result.ok,
    error: result.ok ? undefined : result.error.message,
    step: result.ok ? undefined : result.error.step,
    cause: result.ok ? undefined : result.error.cause,
    summaries: result.ok ? result.value : undefined,
    remembered,
    reader,
  };
};

describe('remembering the sites so the next run does not wait for them', () => {
  const CACHED: SiteCache = {
    listedAt: '2026-08-27T20:14:00Z',
    sites: [{ id: 'contoso,9,9', name: 'Site From Last Time', webUrl: 'https://tenant.sharepoint.com/sites/Last' }],
  };

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

  it('a first run with nothing stored lists for real and keeps what it found', async () => {
    const { prompt, remembered } = await run(['q']);

    expect(prompt.shown.join('\n')).toContain('Espace Contoso');
    expect(remembered[0]?.map((site) => site.name)).toEqual(['Espace Contoso', 'Direction']);
  });
});

describe('choosing what to sync', () => {
  it('picking a site then a library syncs exactly that pair', async () => {
    const { calls } = await run(['1', '1']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.site.name).toBe('Espace Contoso');
    expect(calls[0]?.drives).toEqual([{ id: 'b!one', name: 'Documents' }]);
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

  it('every site is reported as it finishes, not only once the whole run is over', async () => {
    const { prompt } = await run(['all']);

    expect(prompt.shown.filter((text) => text.includes('converted'))).toHaveLength(2);
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

  it('naming a site and its library outright skips both questions', async () => {
    const { calls, prompt } = await run([], { siteId: 'contoso,1,2', driveIds: ['b!two'] });

    expect(prompt.asked).toEqual([]);
    expect(calls[0]?.drives).toEqual([{ id: 'b!two', name: 'Site Assets' }]);
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
    const { mailboxRuns, calls, prompt } = await run(['m']);

    expect(mailboxRuns).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(prompt.shown.at(-1)).toContain('Mailbox:');
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
      reader: createDriveReaderFake({ sites, drives }),
      prompt,
      logger: createLoggerFake(),
      syncSite: async (input) => {
        calls.push(input);
        return ok(EMPTY_SUMMARY);
      },
      listSyncedSources: async () => ({ ok: false, error: { step: 'listSyncedSources', cause: 'read-failed', message: 'kb unreadable' } }),
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      syncMailbox: async () => ok(EMPTY_SUMMARY),
    });

    await runSync({ command: 'sync', driveIds: [], maxBytes: 1000, ocrLabel: 'off', concurrency: 1, dryRun: false });

    expect(prompt.shown[0]).toContain('Espace Contoso  (new)');
    expect(calls).toHaveLength(1);
  });

  it('a refresh over an unreadable knowledge base stops rather than syncing nothing quietly', async () => {
    const runSync = createRunSync({
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async () => ok(EMPTY_SUMMARY),
      listSyncedSources: async () => ({ ok: false, error: { step: 'listSyncedSources', cause: 'read-failed', message: 'kb unreadable' } }),
      savedDrives: async () => [],
      syncMailbox: async () => ok(EMPTY_SUMMARY),
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
    });

    expect((await runSync({ command: 'update', driveIds: [], maxBytes: 1000, ocrLabel: 'off', concurrency: 1, dryRun: false })).ok).toBe(false);
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
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async (input) => {
        calls.push(input);
        return { ok: false, error: { step: 'enumerate', cause: 'auth', message: 'token expired' } };
      },
      listSyncedSources: async () => ok(synced),
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      syncMailbox: async () => ok(EMPTY_SUMMARY),
    });

    const result = await runSync({ command: 'update', driveIds: [], maxBytes: 1000, ocrLabel: 'off', concurrency: 1, dryRun: false });

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
    expect(error).toBe('choose at least one site');
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
    expect(summaries?.[0]).toEqual(EMPTY_SUMMARY);
  });

  it('syncing the mailbox returns that run summary', async () => {
    const { summaries } = await run([], { mailbox: true });

    expect(summaries).toHaveLength(1);
    expect(summaries?.[0]).toEqual(EMPTY_SUMMARY);
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
      reader: createDriveReaderFake({ sites, drives }),
      prompt,
      logger: createLoggerFake(),
      syncSite: async () => ok(EMPTY_SUMMARY),
      listSyncedSources: async () => ok([]),
      savedDrives: async () => [],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      syncMailbox: async () => ({ ok: false, error: { step: 'mailbox', cause: 'auth', message: 'token expired' } }),
    });

    const result = await runSync({ command: 'sync', mailbox: true, driveIds: [], maxBytes: 1000, ocrLabel: 'off', concurrency: 1, dryRun: false });

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
      reader: createDriveReaderFake({ sites, drives }),
      prompt: createPromptFake(),
      logger: createLoggerFake(),
      syncSite: async (input) => {
        calls.push(input);
        return ok(EMPTY_SUMMARY);
      },
      listSyncedSources: async () => ok(synced),
      savedDrives: async () => [{ id: 'b!one', name: 'Documents' }],
      cachedSites: async () => undefined,
      rememberSites: async () => undefined,
      syncMailbox: async () => ({ ok: false, error: { step: 'mailbox', cause: 'auth', message: 'token expired' } }),
    });

    const result = await runSync({ command: 'update', driveIds: [], maxBytes: 1000, ocrLabel: 'off', concurrency: 1, dryRun: false });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
