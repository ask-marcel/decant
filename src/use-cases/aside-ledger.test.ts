import { describe, expect, it } from 'bun:test';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import { createRetryAside, createStuckFiles, withAsideLedger } from './aside-ledger.ts';

const LEDGER = 'kb/.sync-aside.json';
const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const ASIDE = 'kb/_archive/2026-10-15/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const GONE = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';
const LOCKED = { kind: 'write-failed' as const, path: NOTE, message: 'EBUSY: resource busy or locked' };

const ledgerOf = (text: string | undefined): Record<string, { cause: string; since: string }> => JSON.parse(text ?? '{}');

const setUp = (seed: FilesFakeSeed = {}): { files: FilesFake; deps: { clock: Clock; kbRoot: string; logger: LoggerFake }; wrapped: Files } => {
  const files = createFilesFake(seed);
  const deps = { clock: createClockFake('2026-10-15T09:00:00Z'), kbRoot: 'kb', logger: createLoggerFake() };
  return { files, deps, wrapped: withAsideLedger(files, deps) };
};

describe('writing down the files that would not move under the archive', () => {
  it('a move under the archive that fails, of a file still on disk, is written down with its cause', async () => {
    const { files, wrapped } = setUp({ texts: { [NOTE]: 'the contract' }, failMoveWith: LOCKED });

    const moved = await wrapped.move(NOTE, ASIDE);

    expect(moved).toEqual({ ok: false, error: LOCKED });
    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY: resource busy or locked', since: '2026-10-15T09:00:00Z' } });
  });

  it('a ledger that will not save is logged, and the move answers with its own failure', async () => {
    const { deps, wrapped } = setUp({ texts: { [NOTE]: 'the contract' }, failMoveWith: LOCKED, failWriteWith: { kind: 'write-failed', path: LEDGER, message: 'disk full' } });

    expect(await wrapped.move(NOTE, ASIDE)).toEqual({ ok: false, error: LOCKED });
    expect(deps.logger.calls).toContainEqual({ level: 'warn', event: 'aside-ledger.unsaved', meta: { cause: 'write-failed' } });
  });

  it('a move that works, a move that fails outside the archive, and a move of a file no longer there write nothing down', async () => {
    const working = setUp({ texts: { [NOTE]: 'the contract' } });
    const elsewhere = setUp({ texts: { [NOTE]: 'the contract' }, failMoveWith: LOCKED });
    const missing = setUp({ failMoveWith: LOCKED });

    await working.wrapped.move(NOTE, ASIDE);
    await elsewhere.wrapped.move(NOTE, 'kb/SharePoint sites/Espace Contoso/Documents/Archive/Contrat.docx.md');
    await missing.wrapped.move(NOTE, ASIDE);

    expect(working.files.written.has(LEDGER)).toBe(false);
    expect(elsewhere.files.written.has(LEDGER)).toBe(false);
    expect(missing.files.written.has(LEDGER)).toBe(false);
  });

  // A window converts several items at once: two moves failing together would each read the ledger
  // before the other wrote it, and one of them would be lost.
  it('two moves that fail at the same time are both written down', async () => {
    const { files, wrapped } = setUp({ texts: { [NOTE]: 'the contract', [GONE]: 'the task' }, failMoveWith: LOCKED });

    await Promise.all([wrapped.move(NOTE, ASIDE), wrapped.move(GONE, 'kb/_archive/2026-10-15/To Do/Tasks/2026-09-01/Book the venue.md')]);

    expect(Object.keys(ledgerOf(files.written.get(LEDGER)))).toEqual([NOTE, GONE]);
  });
});

describe('moving them aside again at the start of a run', () => {
  const held = (since = '2026-10-14T09:00:00Z'): string => JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since }, [GONE]: { cause: 'write-failed: EBUSY', since } });

  it('each file still on disk goes under the archive, and the ledger keeps neither it nor a file that is gone', async () => {
    const { files, deps, wrapped } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the contract' } });

    await createRetryAside({ ...deps, files: wrapped })();

    expect(files.moves).toEqual([{ from: NOTE, to: ASIDE }]);
    expect(ledgerOf(files.written.get(LEDGER))).toEqual({});
    expect(deps.logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 1, stuck: 0 } });
  });

  it('a file that still will not move stays in the ledger, with the day it first would not and the latest cause', async () => {
    const { files, deps, wrapped } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the contract' }, failMoveWith: LOCKED });

    await createRetryAside({ ...deps, files: wrapped })();

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY: resource busy or locked', since: '2026-10-14T09:00:00Z' } });
    expect(deps.logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 0, stuck: 1 } });
  });

  it('with nothing in the ledger, the run starts without a move or a write', async () => {
    const { files, deps, wrapped } = setUp();

    await createRetryAside({ ...deps, files: wrapped })();

    expect(files.moves).toStrictEqual([]);
    expect(files.writeLog).toStrictEqual([]);
  });
});

describe('naming the files still stuck in the report of the run', () => {
  it('each file of the ledger still on disk is named with its cause, and one that is gone is not', async () => {
    const { files } = setUp({
      texts: {
        [LEDGER]: JSON.stringify({
          [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' },
          [GONE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' },
        }),
        [NOTE]: 'the contract',
      },
    });

    expect(await createStuckFiles({ files, kbRoot: 'kb' })()).toEqual([
      { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-14)' },
    ]);
  });

  it('a ledger that cannot be read names nothing', async () => {
    const { files } = setUp({ texts: { [LEDGER]: 'not json', [NOTE]: 'the contract' } });

    expect(await createStuckFiles({ files, kbRoot: 'kb' })()).toStrictEqual([]);
  });
});
