import { describe, expect, it } from 'bun:test';
import { createDriveReaderFake } from '../test-helpers/drive-reader-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createOcrFake } from '../test-helpers/ocr-fake.ts';
import { createPromptFake } from '../test-helpers/prompt-fake.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { buildDeps } from './build-deps.ts';
import { readConfig } from './config.ts';

const configFor = (env: Readonly<Record<string, string | undefined>>): ReturnType<typeof readConfig> => readConfig({ env, ocrLang: 'en', interactive: true });

describe('reading the run configuration', () => {
  it('an empty environment writes to the default knowledge base folder and stays quiet', () => {
    expect(configFor({})).toEqual({ logLevel: 'error', kbRoot: 'kb', ocrLang: 'en', ocr: true, interactive: true });
  });

  it('reading images can be turned off in the configuration', () => {
    expect(readConfig({ env: {}, ocrLang: 'en', interactive: true, ocr: false })).toMatchObject({ ocr: false });
  });

  it('the environment can move the knowledge base and raise the log level', () => {
    expect(configFor({ KB_LOG_LEVEL: 'debug', KB_ROOT: 'other-kb' })).toMatchObject({ logLevel: 'debug', kbRoot: 'other-kb' });
  });

  it('the language chosen for the run reaches the configuration', () => {
    expect(readConfig({ env: {}, ocrLang: 'fr', interactive: false })).toMatchObject({ ocrLang: 'fr', interactive: false });
  });
});

describe('wiring the command together', () => {
  it('the wired run reads the knowledge base folder named in the configuration', async () => {
    const files = createFilesFake({ directories: { 'other-kb': [] } });
    const deps = buildDeps(configFor({ KB_ROOT: 'other-kb' }), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake(),
      ocr: createOcrFake(),
      prompt: createPromptFake(['q']),
      clock: createClockFake(),
    });

    const summaries = await deps.runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(summaries).toEqual({ ok: true, value: [] });
  });

  it('a refresh repeats the libraries the earlier run recorded for that site', async () => {
    const statePath = 'kb/Espace Contoso/.sync-state.json';
    const state = JSON.stringify({
      version: 1,
      source: { kind: 'site', id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://x' },
      lastRun: '2026-07-22T09:00:00Z',
      drives: { 'b!two': { name: 'Site Assets', pending: [], items: {} } },
    });
    const files = createFilesFake({ directories: { kb: ['Espace Contoso'] }, texts: { [statePath]: state } });
    const deps = buildDeps(configFor({}), {
      files,
      logger: createLoggerFake(),
      reader: createDriveReaderFake({ pages: [{ items: [], skipped: 0, deltaLink: 'cursor-1' }] }),
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    const summaries = await deps.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(summaries.ok && summaries.value).toHaveLength(1);
    expect(JSON.parse(files.written.get(statePath) ?? '{}').drives['b!two'].deltaLink).toBe('cursor-1');
  });

  it('two sites sharing a name each refresh their own libraries, not the first one to be filed', async () => {
    // The second site's folder carries the suffix `disambiguateSegment` gives it: sha256 of its id, first 8.
    const first = 'kb/Team Site/.sync-state.json';
    const second = 'kb/Team Site-7b75821a/.sync-state.json';
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
    const deps = buildDeps(configFor({}), { files, logger: createLoggerFake(), reader, ocr: createOcrFake(), prompt, clock: createClockFake() });

    await deps.runSync({ command: 'sync', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false });

    expect(prompt.shown.join('\n')).toContain('Site From Last Time');
    expect(reader.calls).not.toContain('listSites');
  });

  it('the real wiring builds without reaching Microsoft, so a run only signs in when it needs to', () => {
    const deps = buildDeps(configFor({}), { files: createFilesFake(), logger: createLoggerFake(), prompt: createPromptFake(), clock: createClockFake(), ocr: createOcrFake() });

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
      ocr: createOcrFake(),
      prompt: createPromptFake(),
      clock: createClockFake(),
    });

    expect(await deps.runSync({ command: 'update', driveIds: [], maxBytes: 1000, concurrency: 1, dryRun: false })).toEqual({ ok: true, value: [] });
  });
});
