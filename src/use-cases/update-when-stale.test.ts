import { describe, expect, it } from 'bun:test';
import { pickerView } from '../composition/picker-view.ts';
import { err, ok } from '../domain/result.ts';
import type { Result } from '../domain/result.ts';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import { createPromptFake } from '../test-helpers/prompt-fake.ts';
import type { RunFailure, RunSyncInput } from './run-sync.ts';
import type { SourceRun } from './sync-site.ts';
import { createUpdateWhenStale } from './update-when-stale.ts';
import type { UpdateInput } from './update-when-stale.ts';

const RECORD = 'kb/.last-update.json';
const NOW = '2026-11-12T07:00:00.000Z';
const UPDATE: UpdateInput = { command: 'update', driveIds: [], maxBytes: 1, concurrency: 4, dryRun: false };
const run = (failed: number): SourceRun => ({
  id: 'mailbox',
  source: 'Mailbox',
  summary: { converted: 1, moved: 0, archived: 0, skipped: 0, failed, queued: 0 },
  notes: { skipped: [], failed: [], givenUp: [], archived: [] },
});
const CLEAN: Result<ReadonlyArray<SourceRun>, RunFailure> = ok([run(0)]);

type Updated = {
  readonly outcome: Result<ReadonlyArray<SourceRun>, RunFailure>;
  readonly ran: ReadonlyArray<RunSyncInput>;
  readonly kept: string | undefined;
  readonly shown: ReadonlyArray<string>;
};

const update = async (input: UpdateInput, seed: { lastAt?: string; outcome?: Result<ReadonlyArray<SourceRun>, RunFailure> } = {}): Promise<Updated> => {
  const files = createFilesFake({ texts: seed.lastAt === undefined ? {} : { [RECORD]: `{"at":"${seed.lastAt}"}` } });
  const prompt = createPromptFake();
  const ran: RunSyncInput[] = [];
  const updateWhenStale = createUpdateWhenStale({
    runSync: async (given) => {
      ran.push(given);
      return seed.outcome ?? CLEAN;
    },
    files,
    clock: createClockFake(NOW),
    logger: createLoggerFake(),
    prompt,
    view: pickerView,
    kbRoot: 'kb',
  });
  const outcome = await updateWhenStale(input);
  return { outcome, ran, kept: files.written.get(RECORD), shown: prompt.shown };
};

describe('skipping an update that ran a short time ago', () => {
  it('an update asked with a max age of 60 minutes, 12 minutes after the last one, syncs nothing and says when the last one ran', async () => {
    const { outcome, ran, kept, shown } = await update({ ...UPDATE, maxAgeMinutes: 60 }, { lastAt: '2026-11-12T06:48:00.000Z' });
    expect(outcome).toEqual(ok([]));
    expect(ran).toHaveLength(0);
    expect(kept).toBe('{"at":"2026-11-12T06:48:00.000Z"}');
    expect(shown).toEqual(['The last update started 12 min ago, within --max-age 60: nothing to do.']);
  });

  it('an update asked with a max age of 60 minutes, 61 minutes after the last one, syncs everything and keeps the time it started', async () => {
    const { outcome, ran, kept } = await update({ ...UPDATE, maxAgeMinutes: 60 }, { lastAt: '2026-11-12T05:59:00.000Z' });
    expect(outcome).toEqual(CLEAN);
    expect(ran).toHaveLength(1);
    expect(kept).toContain(`"at": "${NOW}"`);
  });

  it('an update with a max age and no record of an earlier update syncs everything', async () => {
    const { ran, kept } = await update({ ...UPDATE, maxAgeMinutes: 60 });
    expect(ran).toHaveLength(1);
    expect(kept).toContain(`"at": "${NOW}"`);
  });

  // A clock set back, or a record edited by hand, must not turn every update after it off.
  it('a record whose time is in the future does not count as fresh, and the update runs', async () => {
    const { ran } = await update({ ...UPDATE, maxAgeMinutes: 60 }, { lastAt: '2026-11-12T08:00:00.000Z' });
    expect(ran).toHaveLength(1);
  });

  it('an update with no max age always runs and keeps the time it started, so a scheduled run feeds a later check', async () => {
    const { ran, kept } = await update(UPDATE, { lastAt: '2026-11-12T06:59:00.000Z' });
    expect(ran).toHaveLength(1);
    expect(kept).toContain(`"at": "${NOW}"`);
  });

  // A source that fails on every run would otherwise turn the skip off for good.
  it('an update that ends with failed items still keeps its time', async () => {
    const { kept } = await update(UPDATE, { outcome: ok([run(1)]) });
    expect(kept).toContain(`"at": "${NOW}"`);
  });

  it('an update that stops, as when the sign-in lapsed, keeps nothing', async () => {
    const { kept } = await update(UPDATE, { outcome: err({ step: 'listFolders', cause: 'auth', message: 'sign in again' }) });
    expect(kept).toBeUndefined();
  });

  it('a dry run keeps nothing, and a sync from the picker keeps nothing', async () => {
    expect((await update({ ...UPDATE, dryRun: true })).kept).toBeUndefined();
    expect((await update({ ...UPDATE, command: 'sync' })).kept).toBeUndefined();
  });
});
