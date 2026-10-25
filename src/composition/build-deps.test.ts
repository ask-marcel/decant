import { describe, expect, it } from 'bun:test';
import type { DriveDeltaPage } from '../domain/drive-item.ts';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import { createGroupReaderFake } from '../test-helpers/group-reader-fake.ts';
import { createTodoReaderFake } from '../test-helpers/todo-reader-fake.ts';
import { createTeamReaderFake } from '../test-helpers/team-reader-fake.ts';
import { createPeopleReaderFake } from '../test-helpers/people-reader-fake.ts';
import { createCalendarReaderFake } from '../test-helpers/calendar-reader-fake.ts';
import { createNotebookReaderFake } from '../test-helpers/notebook-reader-fake.ts';
import { createListReaderFake } from '../test-helpers/list-reader-fake.ts';
import { createPlanReaderFake } from '../test-helpers/plan-reader-fake.ts';
import { createMailReaderFake } from '../test-helpers/mail-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createPromptFake } from '../test-helpers/prompt-fake.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { disambiguateSegment, idHash } from '../domain/kb-path.ts';
import { emptyNotebookState, notebookRootName, serializeNotebookState } from '../domain/notebook-state.ts';
import { emptyPlanState, serializePlanState } from '../domain/plan-state.ts';
import { emptyMailboxState, serializeMailboxState, withConversation, withThread } from '../domain/mail-state.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { buildDeps } from './build-deps.ts';
import { readConfig } from './config.ts';

// Never interactive: a wired run that reached Microsoft through a reader left real would open a
// browser to sign in, once per test that got there, and under mutation once per mutant.
const configFor = (env: Readonly<Record<string, string | undefined>>): ReturnType<typeof readConfig> =>
  readConfig({ env, ocrLang: 'en', interactive: false, timezone: '', machineTimezone: 'UTC' });

describe('reading the run configuration', () => {
  it('an empty environment writes to the default knowledge base folder and stays quiet', () => {
    expect(configFor({})).toEqual({ logLevel: 'error', kbRoot: 'kb', ocrLang: 'en', ocr: true, interactive: false, timezone: 'UTC' });
  });

  it('reading images can be turned off in the configuration', () => {
    expect(readConfig({ env: {}, ocrLang: 'en', interactive: true, ocr: false, timezone: '', machineTimezone: 'UTC' })).toMatchObject({ ocr: false });
  });

  it('the environment can move the knowledge base and raise the log level', () => {
    expect(configFor({ KB_LOG_LEVEL: 'debug', KB_ROOT: 'other-kb' })).toMatchObject({ logLevel: 'debug', kbRoot: 'other-kb' });
  });

  // `--out` is asked for on this run, so it wins over a folder the environment keeps for every run.
  it('a folder named for the run is where the knowledge base goes, over the environment', () => {
    expect(readConfig({ env: { KB_ROOT: 'other-kb' }, out: 'export', ocrLang: 'en', interactive: true, timezone: '', machineTimezone: 'UTC' })).toMatchObject({ kbRoot: 'export' });
    expect(readConfig({ env: {}, out: 'export', ocrLang: 'en', interactive: true, timezone: '', machineTimezone: 'UTC' })).toMatchObject({ kbRoot: 'export' });
  });

  // Every path under the knowledge base is joined with `/`, so a Windows folder named with `\` would
  // leave one path holding both. Elsewhere a backslash is an ordinary character and is kept.
  it('on Windows, a folder named with backslashes is written with forward slashes, from the command line or the environment', () => {
    const on = (platform: string, out: string | undefined, env: Readonly<Record<string, string>>): ReturnType<typeof readConfig> =>
      readConfig({ env, out, platform, ocrLang: 'en', interactive: true, timezone: '', machineTimezone: 'UTC' });

    expect(on('win32', 'C:\\Users\\me\\KB\\raw', {})).toMatchObject({ kbRoot: 'C:/Users/me/KB/raw' });
    expect(on('win32', undefined, { KB_ROOT: 'D:\\kb' })).toMatchObject({ kbRoot: 'D:/kb' });
    expect(on('linux', 'odd\\name', {})).toMatchObject({ kbRoot: 'odd\\name' });
  });

  // Windows counts a path from the drive letter, so what stands in front of the knowledge base comes
  // off the 259 characters before any name inside it is planned.
  it('the path budget is what Windows accepts less the folders in front of the knowledge base, and none without a way to resolve the folder', () => {
    const resolvePath = (path: string): string => `C:/Users/contoso-employee/Documents/KB/raw/${path}`;

    expect(readConfig({ env: {}, out: 'office365', resolvePath, ocrLang: 'en', interactive: true, timezone: '', machineTimezone: 'UTC' })).toMatchObject({ pathBudget: 216 });
    expect(readConfig({ env: {}, out: 'office365', ocrLang: 'en', interactive: true, timezone: '', machineTimezone: 'UTC' }).pathBudget).toBeUndefined();
  });

  // The zone a run was told to count in wins; with none given, the machine's own is what it gets.
  it('a zone named for the run is what its days are counted in', () => {
    expect(readConfig({ env: {}, ocrLang: 'en', interactive: true, timezone: 'Asia/Shanghai', machineTimezone: 'Europe/Paris' })).toMatchObject({ timezone: 'Asia/Shanghai' });
  });

  it('a run told no zone counts its days where the machine does', () => {
    expect(readConfig({ env: {}, ocrLang: 'en', interactive: true, timezone: '', machineTimezone: 'Europe/Paris' })).toMatchObject({ timezone: 'Europe/Paris' });
  });

  // One knowledge base counts its days in one zone: the zone it keeps wins over the machine's, and a
  // zone named for the run wins over both, since naming one is how a person moves it.
  it('a zone the knowledge base keeps is what its days are counted in, unless the run names another', () => {
    const kept = { env: {}, ocrLang: 'en', interactive: true, storedTimezone: 'Asia/Shanghai', machineTimezone: 'Europe/Berlin' };

    expect(readConfig({ ...kept, timezone: '' })).toMatchObject({ timezone: 'Asia/Shanghai' });
    expect(readConfig({ ...kept, timezone: 'Europe/Paris' })).toMatchObject({ timezone: 'Europe/Paris' });
  });

  it('the language chosen for the run reaches the configuration', () => {
    expect(readConfig({ env: {}, ocrLang: 'fr', interactive: false, timezone: '', machineTimezone: 'UTC' })).toMatchObject({ ocrLang: 'fr', interactive: false });
  });
});

describe('wiring the command together', () => {
  it('the wired run reads the knowledge base folder named in the configuration', async () => {
    const files = createFilesFake({ directories: { 'other-kb': [] } });
    const deps = buildDeps(configFor({ KB_ROOT: 'other-kb' }), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(['q']),
      clock: createClockFake(),
    });

    const summaries = await deps.runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(summaries).toEqual({ ok: true, value: [] });
  });

  it('a refresh repeats the libraries the earlier run recorded for that site', async () => {
    const statePath = 'kb/SharePoint sites/Espace Contoso/.sync-state.json';
    const state = JSON.stringify({
      version: 1,
      source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://x' },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!two': { name: 'Site Assets', pending: [], items: {} } },
    });
    const files = createFilesFake({ directories: { kb: ['SharePoint sites'], 'kb/SharePoint sites': ['Espace Contoso'] }, texts: { [statePath]: state } });
    const deps = buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake({ pages: [{ items: [], skipped: 0, deltaLink: 'cursor-1' }] }),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    const summaries = await deps.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(summaries.ok && summaries.value).toHaveLength(1);
    // The cursor is kept beside the state, in a file of its own.
    const cursor = JSON.parse(files.written.get('kb/SharePoint sites/Espace Contoso/.sync-cursor.json') ?? '{}').cursor;

    expect(cursor.drives['b!two'].deltaLink).toBe('cursor-1');
    expect(JSON.parse(files.written.get(statePath) ?? '{}').drives['b!two'].deltaLink).toBeUndefined();
  });

  it('a refresh repeats the channels the earlier run recorded for that team, and a team whose record is unreadable refuses rather than guessing', async () => {
    const statePath = 'kb/Teams/Northwind Leadership/.sync-state.json';
    const state = JSON.stringify({
      version: 1,
      source: { kind: 'team', id: 'team-1', name: 'Northwind Leadership' },
      lastRun: '2026-09-10T09:00:00Z',
      channels: { 'ch-planning': { name: 'Planning', posts: {} } },
    });
    const files = createFilesFake({ directories: { kb: ['Teams'], 'kb/Teams': ['Northwind Leadership'] }, texts: { [statePath]: state } });
    const team = createTeamReaderFake({ deltaLinks: { 'ch-planning': 'https://graph/delta?token=1' } });
    const deps = buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team,
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    const summaries = await deps.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(summaries.ok && summaries.value.map((source) => source.source)).toEqual(['Northwind Leadership']);
    expect(team.calls).toContain('postsDelta:ch-planning:fresh');
    expect(JSON.parse(files.written.get('kb/Teams/Northwind Leadership/.sync-cursor.json') ?? '{}').cursor.channels['ch-planning'].deltaLink).toBe('https://graph/delta?token=1');

    const unreadable = createFilesFake({
      directories: { kb: ['Teams'], 'kb/Teams': ['Northwind Leadership'] },
      texts: { [statePath]: '{"version":99,"source":{"kind":"team","id":"team-1","name":"Northwind Leadership"}}' },
    });
    const refused = buildDeps(configFor({}), {
      files: unreadable,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    const outcome = await refused.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(outcome.ok && outcome.value.map((source) => source.notes.failed)).toEqual([
      [{ path: 'Northwind Leadership', reason: 'failed at sync: no channel chosen for Northwind Leadership' }],
    ]);
  });

  it('two sites sharing a name each refresh their own libraries, not the first one to be filed', async () => {
    // The second site's folder carries the suffix `disambiguateSegment` gives it: sha256 of its id, first 8.
    const first = 'kb/SharePoint sites/Team Site/.sync-state.json';
    const second = 'kb/SharePoint sites/Team Site-7b75821a/.sync-state.json';
    const stateFor = (id: string, driveId: string): string =>
      JSON.stringify({
        version: 1,
        source: { kind: 'site', id, name: 'Team Site', webUrl: 'https://tenant.sharepoint.com' },
        lastRun: '2026-07-22T09:00:00Z',
        drives: { [driveId]: { name: 'Documents', pending: [], items: {} } },
      });
    const files = createFilesFake({
      directories: { kb: ['Team Site', 'Team Site-7b75821a'] },
      texts: { [first]: stateFor('contoso,aaa,1', 'b!alpha'), [second]: stateFor('contoso,bbb,2', 'b!beta') },
    });
    const deps = buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    await deps.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(Object.keys(JSON.parse(files.written.get(second) ?? '{}').drives)).toEqual(['b!beta']);
  });

  it('the sites a run listed are kept beside the knowledge base, for the next run to draw at once', async () => {
    const files = createFilesFake({ directories: { kb: [] } });
    const deps = buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake({ sites: [{ id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/X' }] }),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(['q']),
      clock: createClockFake(),
    });

    await deps.runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(JSON.parse(files.written.get('kb/.sites.json') ?? '{}')).toMatchObject({ version: 1, sites: [{ id: 'contoso,1,2', name: 'Espace Contoso' }] });
  });

  it('a second run draws its picker from that file rather than asking Microsoft again', async () => {
    const stored = JSON.stringify({
      version: 1,
      listedAt: '2026-08-27T20:14:00Z',
      sites: [{ id: 'contoso,9,9', name: 'Site From Last Time', webUrl: 'https://tenant.sharepoint.com/sites/Last' }],
    });
    const files = createFilesFake({ directories: { kb: [] }, texts: { 'kb/.sites.json': stored } });
    const reader = createDriveReaderFake({ sites: [] });
    const prompt = createPromptFake(['q']);
    const deps = buildDeps(configFor({}), {
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      files,
      logger: createLoggerFake(),
      reader,
      mail: createMailReaderFake(),
      ocr: createOcrFake(),
      prompt,
      clock: createClockFake(),
    });

    await deps.runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(prompt.shown.join('\n')).toContain('Site From Last Time');
    expect(reader.calls).not.toContain('listSites');
  });

  it('the real wiring builds without reaching Microsoft, so a run only signs in when it needs to', () => {
    const deps = buildDeps(configFor({}), {
      files: createFilesFake(),
      logger: createLoggerFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
      ocr: createOcrFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
    });

    expect(typeof deps.runSync).toBe('function');
  });

  it('every part it builds for itself is built without asking anything of the network or the disk', () => {
    // Nothing injected, so each `??` falls through to the real constructor. Building one reaches
    // nothing: the sign-in ladder runs on the first Graph call, and the readers only hold the api.
    const deps = buildDeps(configFor({}));

    expect(typeof deps.runSync).toBe('function');
    expect(typeof deps.logger.info).toBe('function');
  });

  it('the update command over an empty knowledge base finishes without syncing anything', async () => {
    const deps = buildDeps(configFor({}), {
      files: createFilesFake(),
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    expect(await deps.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false })).toEqual({ ok: true, value: [] });
  });
});

describe('keeping how far back the runs reach', () => {
  const RUN = { command: 'sync' as const, driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false };

  const wired = (files: ReturnType<typeof createFilesFake>, prompt: ReturnType<typeof createPromptFake>, logger = createLoggerFake()): ReturnType<typeof buildDeps> =>
    buildDeps(configFor({}), {
      files,
      prompt,
      logger,
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      clock: createClockFake(),
    });

  it('the answer a first run is given is kept beside the knowledge base, and the next run reads it without asking', async () => {
    const files = createFilesFake({ directories: { kb: [] } });

    await wired(files, createPromptFake(['m', '2025-01-01'])).runSync(RUN);

    expect(files.written.get('kb/.decant.json')).toBe('{\n  "since": "2025-01-01",\n  "timezone": "UTC"\n}\n');

    const next = createPromptFake(['m']);
    await wired(files, next).runSync(RUN);

    expect(next.asked).toEqual(['Source:']);
  });

  it('a kept reach that cannot be read stops the run and names the file to mend, and a file that cannot be opened says why', async () => {
    const mistyped = createFilesFake({ directories: { kb: [] }, texts: { 'kb/.decant.json': '{ "since": "2025/01/01" }' } });

    expect(await wired(mistyped, createPromptFake()).runSync({ ...RUN, command: 'update' })).toEqual({
      ok: false,
      error: { step: 'readSince', cause: 'bad-since', message: 'kb/.decant.json does not say a day like 2026-01-31, or all; run with --since to set it again' },
    });

    const locked = createFilesFake({ failReadWith: { kind: 'read-failed', path: 'kb/.decant.json', message: 'permission denied' } });

    expect(await wired(locked, createPromptFake()).runSync({ ...RUN, command: 'update' })).toMatchObject({
      ok: false,
      error: { step: 'readSince', cause: 'read-failed', message: 'permission denied' },
    });
  });

  // Made before the zone was kept, a knowledge base holds a reach and no zone. Its next run keeps the
  // zone it counts in, and from then on only a zone named for a run moves it. A dry run keeps nothing,
  // and a reach that cannot be read is left for the person to mend.
  it('a knowledge base that keeps a reach keeps the zone of its runs beside it, once', async () => {
    const files = createFilesFake({ directories: { kb: [] }, texts: { 'kb/.decant.json': '{\n  "since": "2025-01-01"\n}\n' } });

    await wired(files, createPromptFake()).runSync({ ...RUN, command: 'update', dryRun: true });

    expect(files.writeLog).not.toContain('kb/.decant.json');

    await wired(files, createPromptFake()).runSync({ ...RUN, command: 'update' });
    await wired(files, createPromptFake()).runSync({ ...RUN, command: 'update' });

    expect(files.written.get('kb/.decant.json')).toBe('{\n  "since": "2025-01-01",\n  "timezone": "UTC"\n}\n');
    expect(files.writeLog.filter((path) => path === 'kb/.decant.json')).toHaveLength(1);

    const mistyped = createFilesFake({ directories: { kb: [] }, texts: { 'kb/.decant.json': '{ "since": "2025/01/01" }' } });
    await wired(mistyped, createPromptFake()).runSync({ ...RUN, command: 'update' });

    expect(mistyped.writeLog).not.toContain('kb/.decant.json');
  });

  it('a zone that cannot be kept is logged and the run goes on in it', async () => {
    const files = createFilesFake({ directories: { kb: [] }, texts: { 'kb/.decant.json': '{ "since": "2025-01-01" }' }, failWritesMatching: '.decant.json' });
    const logger = createLoggerFake();

    const outcome = await wired(files, createPromptFake(), logger).runSync({ ...RUN, command: 'update' });

    expect(outcome.ok).toBe(true);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'zone.unkept', meta: { cause: 'write-failed' } });
  });

  it('a reach that cannot be kept is logged and the run goes on with it', async () => {
    const files = createFilesFake({ directories: { kb: [] }, failWritesMatching: '.decant.json' });
    const logger = createLoggerFake();

    const outcome = await wired(files, createPromptFake(), logger).runSync({ ...RUN, command: 'update', since: '2025-01-01' });

    expect(outcome.ok).toBe(true);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'since.unkept', meta: { cause: 'write-failed' } });
  });
});

// What a copy of the knowledge base sees: a backup, git or OneDrive takes every changed file as news.
describe('a run that finds nothing new', () => {
  const STATE = 'kb/SharePoint sites/Espace Contoso/.sync-state.json';
  const seeded = JSON.stringify({
    version: 1,
    source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://x' },
    lastRun: '',
    drives: { 'b!one': { name: 'Documents', pending: [], items: {} } },
  });
  const contract = {
    id: '01ABC',
    name: 'Contrat.docx',
    kind: 'file' as const,
    size: 4096,
    path: 'Contrat.docx',
    lastModified: '2026-05-12T09:31:00Z',
    cTag: 'c1',
    webUrl: 'https://x/Contrat.docx',
  };

  const updateAt = async (files: ReturnType<typeof createFilesFake>, pages: ReadonlyArray<DriveDeltaPage>, at: string): Promise<void> => {
    await buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake({ pages }),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(at),
    }).runSync({ command: 'update', driveIds: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });
  };

  // The first run with nothing new still says so: the report names what the last run did, and the
  // run before it converted a file. From the second on, the cursor alone moves.
  it('a second update in a row with nothing new at the source changes no file but the cursor beside the state', async () => {
    const files = createFilesFake({ directories: { kb: ['SharePoint sites'], 'kb/SharePoint sites': ['Espace Contoso'] }, texts: { [STATE]: seeded } });
    await updateAt(files, [{ items: [contract], skipped: 0, deltaLink: 'cursor-1' }], '2026-10-12T08:00:00Z');
    const converted = new Map(files.written);
    await updateAt(files, [{ items: [], skipped: 0, deltaLink: 'cursor-2' }], '2026-10-13T08:00:00Z');
    const changedBy = (before: ReadonlyMap<string, string>): ReadonlyArray<string> => [...files.written].filter(([path, text]) => before.get(path) !== text).map(([path]) => path);

    expect(changedBy(converted)).toEqual(['kb/SharePoint sites/Espace Contoso/.sync-cursor.json', 'kb/_sync-report.md']);

    const quiet = new Map(files.written);
    await updateAt(files, [{ items: [], skipped: 0, deltaLink: 'cursor-3' }], '2026-10-14T08:00:00Z');

    expect(changedBy(quiet)).toEqual(['kb/SharePoint sites/Espace Contoso/.sync-cursor.json']);
  });
});

// A file held open on Windows will not move under the archive. The source lets it go all the same,
// so the ledger beside the knowledge base is what keeps it: named in the report of the run, and moved
// by the first run that finds it free.
describe('a file that would not move under the archive', () => {
  const STATE = 'kb/SharePoint sites/Espace Contoso/.sync-state.json';
  const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
  const LEDGER = 'kb/.sync-aside.json';
  const directories = { kb: ['SharePoint sites'], 'kb/SharePoint sites': ['Espace Contoso'] };
  const held = JSON.stringify({
    version: 1,
    source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://x' },
    lastRun: '',
    layout: 2,
    drives: {
      'b!one': { name: 'Documents', deltaLink: 'cursor-1', pending: [], items: { '01ABC': { path: 'Contrat.docx', cTag: 'c1', outputs: [NOTE] } }, retry: {}, folders: {} },
    },
  });
  const deleted = { id: '01ABC', name: '', kind: 'deleted' as const, size: 0, path: '', lastModified: '', cTag: '', webUrl: '' };
  const edited = { ...deleted, name: 'Contrat.docx', kind: 'file' as const, size: 4096, path: 'Contrat.docx', lastModified: '2026-10-15T08:00:00Z', cTag: 'c2' };

  const updateWith = async (files: ReturnType<typeof createFilesFake>, pages: ReadonlyArray<DriveDeltaPage>): Promise<void> => {
    await buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake({ pages }),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake('2026-10-15T09:00:00Z'),
    }).runSync({ command: 'update', driveIds: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });
  };

  it('is written down, named in the report of the run, and moved under the archive by the next run', async () => {
    const locked = createFilesFake({ directories, texts: { [STATE]: held, [NOTE]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'EBUSY' } });
    await updateWith(locked, [{ items: [deleted], skipped: 0, deltaLink: 'cursor-2' }]);

    expect(JSON.parse(locked.written.get(LEDGER) ?? '{}')).toEqual({
      [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-15T09:00:00Z', digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(locked.written.get('kb/_sync-report.md')).toContain('- SharePoint sites/Espace Contoso/Documents/Contrat.docx.md: write-failed: EBUSY (since 2026-10-15)');

    const free = createFilesFake({ directories, texts: Object.fromEntries(locked.written) });
    await updateWith(free, [{ items: [], skipped: 0, deltaLink: 'cursor-3' }]);

    expect(free.moves).toContainEqual({ from: NOTE, to: 'kb/_archive/2026-10-15/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md' });
    expect(JSON.parse(free.written.get(LEDGER) ?? '{}')).toEqual({});
  });

  // The document still records its note and tries the edit again itself, three runs in all: moved by
  // the ledger before that, the note would leave the document with no current copy.
  it('a held note that its document still records is not written down', async () => {
    const locked = createFilesFake({ directories, texts: { [STATE]: held, [NOTE]: 'the contract' }, failMoveWith: { kind: 'write-failed', path: NOTE, message: 'EBUSY' } });
    await updateWith(locked, [{ items: [edited], skipped: 0, deltaLink: 'cursor-2' }]);

    expect(locked.written.has(LEDGER)).toBe(false);
    expect(locked.written.get(NOTE)).toBe('the contract');
  });

  // Another document that lands at the path holds it now: moved by the next run, its note would leave
  // that document with no current copy.
  it('a file written down and then written over by another document leaves the ledger, and the next run leaves the new note', async () => {
    const busy = { kind: 'write-failed' as const, path: NOTE, message: 'EBUSY' };
    const locked = createFilesFake({ directories, texts: { [STATE]: held, [NOTE]: 'the contract' }, failMoveWith: busy });
    await updateWith(locked, [{ items: [deleted], skipped: 0, deltaLink: 'cursor-2' }]);
    const reused = createFilesFake({ directories, texts: Object.fromEntries(locked.written), failMoveWith: busy });
    await updateWith(reused, [{ items: [{ ...edited, id: '01XYZ' }], skipped: 0, deltaLink: 'cursor-3' }]);
    const free = createFilesFake({ directories, texts: Object.fromEntries(reused.written) });
    await updateWith(free, [{ items: [], skipped: 0, deltaLink: 'cursor-4' }]);

    expect(JSON.parse(reused.written.get(LEDGER) ?? '{}')).toEqual({});
    expect(free.moves).toStrictEqual([]);
    expect(free.written.get(NOTE)).toContain('converted 01XYZ');
  });
});

// Two notebooks can carry one name: the second takes a folder suffixed with its id, and an update must
// find its state there, not stop at the folder the first one holds.
describe('a notebook in a folder suffixed with its id', () => {
  it('is refreshed by an update, beside the notebook that holds the plain folder', async () => {
    const first = { id: 'nb-1', name: 'Northwind Notebook', webUrl: 'https://x/1', site: { id: 'site-1', name: 'Northwind' } };
    const second = { ...first, id: 'nb-2', webUrl: 'https://x/2' };
    const plain = notebookRootName(first.name);
    const suffixed = notebookRootName(disambiguateSegment(second.name, idHash(second.id)));
    const files = createFilesFake({
      directories: { kb: ['OneNote'], 'kb/OneNote': [plain.slice('OneNote/'.length), suffixed.slice('OneNote/'.length)] },
      texts: {
        [`kb/${plain}/.sync-state.json`]: serializeNotebookState(emptyNotebookState(first)),
        [`kb/${suffixed}/.sync-state.json`]: serializeNotebookState(emptyNotebookState(second)),
      },
    });

    await buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake({ sections: { 'nb-1': [], 'nb-2': [] } }),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake('2026-10-16T09:00:00Z'),
    }).runSync({ command: 'update', driveIds: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });

    expect(files.written.get('kb/_sync-report.md')).not.toContain('no record of the notebook');
    expect(files.written.has(`kb/${suffixed}/.sync-cursor.json`)).toBe(true);
  });
});

// A plan renamed in Planner since the last run: update reads it by id, and its files go to the folder
// of the new title.
describe('a plan renamed in Planner', () => {
  it('is synced by an update into the folder of its new title, and the old folder is put aside', async () => {
    const saved = { id: 'plan-1', title: 'Offsite 2026', groupId: 'g-1' };
    const files = createFilesFake({
      directories: { kb: ['Planner'], 'kb/Planner': ['Offsite 2026'] },
      texts: { 'kb/Planner/Offsite 2026/.sync-state.json': serializePlanState(emptyPlanState(saved)) },
    });

    await buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake({ plans: [{ ...saved, title: 'Offsite 2027' }], buckets: { 'plan-1': [] }, tasks: { 'plan-1': [] } }),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake('2026-10-16T09:00:00Z'),
    }).runSync({ command: 'update', driveIds: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });

    expect(files.written.has('kb/Planner/Offsite 2027/.sync-state.json')).toBe(true);
    expect(files.written.has('kb/Planner/Offsite 2026/.sync-state.json')).toBe(false);
    expect(files.written.has('kb/_archive/2026-10-16/Planner/Offsite 2026/.sync-state.json')).toBe(true);
  });
});

// A knowledge base copied to another folder keeps the paths its states recorded, and each one names the
// folder it was copied from. A run on the copy then moved the files of the original, and found nothing
// of its own to move. The copy follows its own paths, and nothing outside it is touched.
describe('a knowledge base copied to another folder', () => {
  const COPY = '/copy/kb';
  const updateIn = async (files: ReturnType<typeof createFilesFake>, readers: Partial<Pick<NonNullable<Parameters<typeof buildDeps>[1]>, 'reader' | 'mail'>>): Promise<void> => {
    await buildDeps(configFor({ KB_ROOT: COPY }), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      mail: createMailReaderFake(),
      group: createGroupReaderFake(),
      todo: createTodoReaderFake(),
      team: createTeamReaderFake(),
      people: createPeopleReaderFake(),
      calendar: createCalendarReaderFake(),
      notebook: createNotebookReaderFake(),
      list: createListReaderFake(),
      plan: createPlanReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake('2026-10-24T09:00:00Z'),
      ...readers,
    }).runSync({ command: 'update', driveIds: [], maxBytes: 50 * 1024 * 1024, concurrency: 1, dryRun: false });
  };
  const touchedOutside = (files: ReturnType<typeof createFilesFake>): ReadonlyArray<string> =>
    [...files.writeLog, ...files.moves.flatMap((move) => [move.from, move.to])].filter((path) => !path.startsWith(`${COPY}/`));

  it('a library in the day folders of the first layout moves out of them in the copy, and the original stays as it was', async () => {
    const dated = (root: string): string => `${root}/SharePoint sites/Espace Contoso/Documents/2026-05-12/Contrat.docx.md`;
    const state = JSON.stringify({
      version: 1,
      source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://x' },
      lastRun: '',
      drives: { 'b!one': { name: 'Documents', deltaLink: 'cursor-1', pending: [], items: { '01ABC': { path: 'Contrat.docx', cTag: 'c1', outputs: [dated('kb')] } }, retry: {} } },
    });
    const contract = {
      id: '01ABC',
      name: 'Contrat.docx',
      kind: 'file' as const,
      size: 4096,
      path: 'Contrat.docx',
      lastModified: '2026-05-12T09:31:00Z',
      cTag: 'c1',
      webUrl: 'https://x/Contrat.docx',
    };
    const files = createFilesFake({
      directories: { [COPY]: ['SharePoint sites'], [`${COPY}/SharePoint sites`]: ['Espace Contoso'] },
      texts: { [`${COPY}/SharePoint sites/Espace Contoso/.sync-state.json`]: state, [dated(COPY)]: 'the copy', [dated('kb')]: 'the original' },
    });

    await updateIn(files, { reader: createDriveReaderFake({ pages: [{ items: [contract], skipped: 0, deltaLink: 'cursor-2' }] }) });

    expect(files.moves).toContainEqual({ from: dated(COPY), to: `${COPY}/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md` });
    expect(files.written.get(dated('kb'))).toBe('the original');
    expect(touchedOutside(files)).toStrictEqual([]);
  });

  it('a mail thread with no message left goes under the archive of the copy, and the original stays as it was', async () => {
    const FOLDER = '2026-05-12-thread-1-contrat';
    const card = (root: string): string => `${root}/Mailbox/threads/${FOLDER}/_attachments/a.pdf.md`;
    const note = (root: string): string => `${root}/Mailbox/threads/${FOLDER}/contrat.md`;
    const fed = withConversation(emptyMailboxState(), 'conv-1', { threadId: 'thread-1', root: '<r@example.com>' });
    const state = withThread(fed, 'thread-1', {
      folder: FOLDER,
      conversationIds: ['conv-1'],
      file: `threads/${FOLDER}/contrat.md`,
      messageIds: ['m0'],
      lastMessage: '2026-05-12T09:31:00Z',
      attachments: [],
      inlineImages: [],
      files: [card('kb')],
    });
    const removed: MailMessage = { id: 'm0', conversationId: '', subject: '', received: '', hasAttachments: false, from: { name: '', address: '' }, to: [], isDeleted: true };
    const files = createFilesFake({
      directories: { [COPY]: ['Mailbox'] },
      texts: { [`${COPY}/Mailbox/.sync-state.json`]: serializeMailboxState(state), [note(COPY)]: 'note', [card(COPY)]: 'card', [note('kb')]: 'note', [card('kb')]: 'card' },
    });

    await updateIn(files, {
      mail: createMailReaderFake({ folders: [{ id: 'AAMk-inbox', name: 'Inbox', childCount: 0, itemCount: 1 }], pages: [{ messages: [removed], skipped: 0, deltaLink: 'c1' }] }),
    });

    expect(files.moves).toContainEqual({ from: card(COPY), to: `${COPY}/_archive/2026-10-24/Mailbox/threads/${FOLDER}/_attachments/a.pdf.md` });
    expect(files.moves).toContainEqual({ from: note(COPY), to: `${COPY}/_archive/2026-10-24/Mailbox/threads/${FOLDER}/contrat.md` });
    expect(files.written.get(card('kb'))).toBe('card');
    expect(touchedOutside(files)).toStrictEqual([]);
  });

  // The ledger keeps the paths it was given, and names no folder: an entry from the original is never
  // moved from the copy, and the report of the run names it with why.
  it('an entry the ledger holds from the original is not moved, and the report names it', async () => {
    const held = 'kb/People/Jane Doe.md';
    const files = createFilesFake({
      directories: { [COPY]: ['Mailbox'] },
      texts: {
        [`${COPY}/Mailbox/.sync-state.json`]: serializeMailboxState(emptyMailboxState()),
        [`${COPY}/.sync-aside.json`]: JSON.stringify({ [held]: { cause: 'write-failed: EBUSY', since: '2026-10-20T09:00:00Z' } }),
        [held]: 'Jane',
      },
    });

    await updateIn(files, {});

    expect(files.written.get(held)).toBe('Jane');
    expect(touchedOutside(files)).toStrictEqual([]);
    expect(Object.keys(JSON.parse(files.written.get(`${COPY}/.sync-aside.json`) ?? '{}'))).toEqual([held]);
    expect(files.written.get(`${COPY}/_sync-report.md`)).toContain(`- ${held}: write-failed: EBUSY (since 2026-10-20)`);
  });
});
