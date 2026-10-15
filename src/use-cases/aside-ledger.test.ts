import { describe, expect, it } from 'bun:test';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { createAsideLedger } from './aside-ledger.ts';
import type { AsideLedgerRun } from './aside-ledger.ts';

const LEDGER = 'kb/.sync-aside.json';
const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const ASIDE = 'kb/_archive/2026-10-15/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const TASK = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';
const LOCKED = { kind: 'write-failed' as const, path: NOTE, message: 'EBUSY: resource busy or locked' };

const ledgerOf = (text: string | undefined): Record<string, { cause: string; since: string }> => JSON.parse(text ?? '{}');

const setUp = (seed: FilesFakeSeed = {}): { files: FilesFake; logger: LoggerFake; ledger: AsideLedgerRun } => {
  const files = createFilesFake(seed);
  const logger = createLoggerFake();
  return { files, logger, ledger: createAsideLedger(files, { clock: createClockFake('2026-10-15T09:00:00Z'), kbRoot: 'kb', logger }) };
};

describe('writing down the files a source lets go that would not move under the archive', () => {
  it('a file still on disk is written down with its cause, and one that is gone already is not', async () => {
    const { files, ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.writeDown([
      { path: NOTE, error: LOCKED },
      { path: TASK, error: LOCKED },
    ]);

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY: resource busy or locked', since: '2026-10-15T09:00:00Z' } });
  });

  it('nothing still on disk writes nothing', async () => {
    const { files, ledger } = setUp();

    await ledger.writeDown([{ path: TASK, error: LOCKED }]);

    expect(files.writeLog).toStrictEqual([]);
  });

  it('what the ledger already held is kept beside what a run adds', async () => {
    const { files, ledger } = setUp({ texts: { [LEDGER]: JSON.stringify({ [TASK]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' } }), [NOTE]: 'the contract' } });

    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(Object.keys(ledgerOf(files.written.get(LEDGER)))).toEqual([NOTE, TASK]);
  });

  it('a ledger that will not save is logged', async () => {
    const { logger, ledger } = setUp({ texts: { [NOTE]: 'the contract' }, failWriteWith: { kind: 'write-failed', path: LEDGER, message: 'disk full' } });

    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(logger.calls).toContainEqual({ level: 'warn', event: 'aside-ledger.unsaved', meta: { cause: 'write-failed' } });
  });

  // A window converts several items at once, and two of them can let a file go together.
  it('two files handed on at the same time are both written down', async () => {
    const { files, ledger } = setUp({ texts: { [NOTE]: 'the contract', [TASK]: 'the task' } });

    await Promise.all([ledger.writeDown([{ path: NOTE, error: LOCKED }]), ledger.writeDown([{ path: TASK, error: LOCKED }])]);

    expect(Object.keys(ledgerOf(files.written.get(LEDGER)))).toEqual([NOTE, TASK]);
  });
});

describe('moving them aside again at the start of a run', () => {
  const held = (since = '2026-10-14T09:00:00Z'): string => JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since }, [TASK]: { cause: 'write-failed: EBUSY', since } });

  it('each file still on disk goes under the archive, and the ledger keeps neither it nor a file that is gone', async () => {
    const { files, logger, ledger } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the contract' } });

    await ledger.retry();

    expect(files.moves).toEqual([{ from: NOTE, to: ASIDE }]);
    expect(ledgerOf(files.written.get(LEDGER))).toEqual({});
    expect(logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 1, stuck: 0 } });
  });

  it('a file that still will not move stays in the ledger, with the day it first would not and the latest cause', async () => {
    const { files, logger, ledger } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the contract' }, failMoveWith: LOCKED });

    await ledger.retry();

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY: resource busy or locked', since: '2026-10-14T09:00:00Z' } });
    expect(logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 0, stuck: 1 } });
  });

  it('with nothing in the ledger, the run starts without a move or a write', async () => {
    const { files, ledger } = setUp();

    await ledger.retry();

    expect(files.moves).toStrictEqual([]);
    expect(files.writeLog).toStrictEqual([]);
  });
});

describe('naming the files still stuck in the report of the run', () => {
  it('each file of the ledger still on disk is named with its cause, and one that is gone is not', async () => {
    const { ledger } = setUp({
      texts: {
        [LEDGER]: JSON.stringify({
          [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' },
          [TASK]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' },
        }),
        [NOTE]: 'the contract',
      },
    });

    expect(await ledger.stuck()).toEqual([{ path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-14)' }]);
  });

  it('a file this run wrote down is named as well', async () => {
    const { ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(await ledger.stuck()).toEqual([
      { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY: resource busy or locked (since 2026-10-15)' },
    ]);
  });

  it('a ledger that cannot be read names nothing', async () => {
    const { ledger } = setUp({ texts: { [LEDGER]: 'not json', [NOTE]: 'the contract' } });

    expect(await ledger.stuck()).toStrictEqual([]);
  });
});
