import { describe, expect, it } from 'bun:test';
import { createClockFake } from '../test-helpers/clock-fake.ts';
import { createFilesFake } from '../test-helpers/files-fake.ts';
import type { FilesFake, FilesFakeSeed } from '../test-helpers/files-fake.ts';
import { createLoggerFake } from '../test-helpers/logger-fake.ts';
import type { LoggerFake } from '../test-helpers/logger-fake.ts';
import { digestOf } from '../domain/aside-ledger.ts';
import { err } from '../domain/result.ts';
import { createAsideLedger } from './aside-ledger.ts';
import type { AsideLedgerRun } from './aside-ledger.ts';

const LEDGER = 'kb/.sync-aside.json';
const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const ASIDE = 'kb/_archive/2026-10-15/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const TASK = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';
const LOCKED = { kind: 'write-failed' as const, path: NOTE, message: 'EBUSY: resource busy or locked' };

const ledgerOf = (text: string | undefined): Record<string, { cause: string; since: string; digest?: string }> => JSON.parse(text ?? '{}');

const setUp = (seed: FilesFakeSeed = {}, timezone = 'UTC'): { files: FilesFake; logger: LoggerFake; ledger: AsideLedgerRun } => {
  const files = createFilesFake(seed);
  const logger = createLoggerFake();
  return { files, logger, ledger: createAsideLedger(files, { clock: createClockFake('2026-10-15T09:00:00Z'), kbRoot: 'kb', logger, timezone }) };
};

describe('writing down the files a source lets go that would not move under the archive', () => {
  it('a file still on disk is written down with its cause, and one that is gone already is not', async () => {
    const { files, ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.writeDown([
      { path: NOTE, error: LOCKED },
      { path: TASK, error: LOCKED },
    ]);

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-15T09:00:00Z', digest: digestOf('the contract') } });
  });

  it('a file that will not read is written down with no digest', async () => {
    const { files, ledger } = setUp();
    await files.writeBytes(NOTE, new Uint8Array([1, 2, 3]));

    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-15T09:00:00Z' } });
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
  const held = (since = '2026-10-14T09:00:00Z'): string =>
    JSON.stringify({
      [NOTE]: { cause: 'write-failed: EBUSY', since, digest: digestOf('the contract') },
      [TASK]: { cause: 'write-failed: EBUSY', since, digest: digestOf('the task') },
    });

  it('each file still on disk goes under the archive, and the ledger keeps neither it nor a file that is gone', async () => {
    const { files, logger, ledger } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the contract' } });

    await ledger.retry();

    expect(files.moves).toEqual([{ from: NOTE, to: ASIDE }]);
    expect(ledgerOf(files.written.get(LEDGER))).toEqual({});
    expect(logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 1, stuck: 0, replaced: 0 } });
  });

  it('a file that still will not move stays in the ledger, with the day it first would not and the latest cause', async () => {
    const { files, logger, ledger } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the contract' }, failMoveWith: LOCKED });

    await ledger.retry();

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z', digest: digestOf('the contract') } });
    expect(logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 0, stuck: 1, replaced: 0 } });
  });

  // A removal a run could not save, or a path that differs only in letter case, must never send a live
  // file away: the file at a listed path is moved only while it holds what was written down.
  it('a listed path that holds another file now is left as it is, and leaves the ledger', async () => {
    const { files, logger, ledger } = setUp({ texts: { [LEDGER]: held(), [NOTE]: 'the new contract' } });

    await ledger.retry();

    expect(files.moves).toStrictEqual([]);
    expect(ledgerOf(files.written.get(LEDGER))).toEqual({});
    expect(logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 0, stuck: 0, replaced: 1 } });
    expect(await ledger.stuck()).toEqual({
      files: [
        {
          path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md',
          reason: 'write-failed: EBUSY (since 2026-10-14). Another file is at this path now, so it left the list',
        },
      ],
    });
  });

  // Read as text, a file the fake holds as bytes will not read, as a file another program locks may not.
  it('a file that would not read when it stuck, or that will not read now, stays listed and does not move', async () => {
    const unread = setUp({ texts: { [LEDGER]: JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' } }), [NOTE]: 'the contract' } });
    const unreadNow = setUp({ texts: { [LEDGER]: JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z', digest: digestOf('the contract') } }) } });
    await unreadNow.files.writeBytes(NOTE, new Uint8Array([1, 2, 3]));

    await unread.ledger.retry();
    await unreadNow.ledger.retry();

    expect(unread.files.moves).toStrictEqual([]);
    expect(unreadNow.files.moves).toStrictEqual([]);
    expect(Object.keys(ledgerOf(unread.files.written.get(LEDGER)))).toEqual([NOTE]);
    expect(Object.keys(ledgerOf(unreadNow.files.written.get(LEDGER)))).toEqual([NOTE]);
    expect(unread.logger.calls).toContainEqual({ level: 'info', event: 'aside.retried', meta: { moved: 0, stuck: 1, replaced: 0 } });
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
          [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z', digest: 'd1' },
          [TASK]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z', digest: 'd2' },
        }),
        [NOTE]: 'the contract',
      },
    });

    expect(await ledger.stuck()).toEqual({ files: [{ path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-14)' }] });
  });

  it('the day a file first would not move is told in the zone of the knowledge base', async () => {
    const { ledger } = setUp(
      { texts: { [LEDGER]: JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T23:00:00Z', digest: 'd1' } }), [NOTE]: 'the contract' } },
      'Asia/Shanghai'
    );

    expect(await ledger.stuck()).toEqual({ files: [{ path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-15)' }] });
  });

  // The ledger keeps such a file, so the report names it: the move is still owed, and nothing else
  // says so. A ledger copied with the knowledge base holds paths outside the copy, which read so.
  it('a file of the ledger that cannot be checked is named as well, and the file stays where it is', async () => {
    const disk = createFilesFake({ texts: { [LEDGER]: JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z', digest: 'd1' } }) } });
    const unchecked = { ...disk, exists: async (path: string) => err({ kind: 'read-failed' as const, path, message: 'EACCES' }) };
    const ledger = createAsideLedger(unchecked, { clock: createClockFake('2026-10-15T09:00:00Z'), kbRoot: 'kb', logger: createLoggerFake(), timezone: 'UTC' });

    await ledger.retry();

    expect(await ledger.stuck()).toEqual({ files: [{ path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-14)' }] });
    expect(disk.moves).toStrictEqual([]);
  });

  it('a file this run wrote down is named as well', async () => {
    const { ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(await ledger.stuck()).toEqual({ files: [{ path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-15)' }] });
  });
});

// What it lists is named nowhere else, so a ledger that does not read stays as it is until someone
// repairs or deletes it. The report of the run says why, and names the files this run let go.
describe('a ledger that does not read', () => {
  const NAMED = { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-15)' };

  it('is logged and never written over: the retry, a file let go and a file landing leave it as it is', async () => {
    const { files, logger, ledger } = setUp({ texts: { [LEDGER]: 'not json', [NOTE]: 'the contract' } });

    await ledger.retry();
    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);
    await ledger.files.writeText(TASK, 'the task');

    expect(files.written.get(LEDGER)).toBe('not json');
    expect(files.moves).toStrictEqual([]);
    expect(logger.calls).toContainEqual({ level: 'warn', event: 'aside-ledger.unreadable', meta: { cause: 'invalid-json' } });
    expect(await ledger.stuck()).toEqual({ files: [NAMED], unreadable: 'invalid-json' });
  });

  it('one the disk will not read, or one that holds an entry that is not one, is kept the same way', async () => {
    const refused = setUp({ texts: { [NOTE]: 'the contract' }, failReadWith: { kind: 'read-failed', path: LEDGER, message: 'EIO' } });
    const odd = setUp({ texts: { [LEDGER]: JSON.stringify({ [NOTE]: 'stuck' }), [NOTE]: 'the contract' } });

    await refused.ledger.writeDown([{ path: NOTE, error: LOCKED }]);
    await odd.ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(refused.files.writeLog).toStrictEqual([]);
    expect(odd.files.written.get(LEDGER)).toBe(JSON.stringify({ [NOTE]: 'stuck' }));
    expect(await refused.ledger.stuck()).toEqual({
      files: [{ ...NAMED, reason: `${NAMED.reason}. It would not read when it stuck, so no run moves it` }],
      unreadable: 'read-failed',
    });
    expect(await odd.ledger.stuck()).toEqual({ files: [NAMED], unreadable: 'malformed' });
  });
});

describe('keeping the ledger in step with what lands on disk', () => {
  const listed = JSON.stringify({ [NOTE]: { cause: 'write-failed: EBUSY', since: '2026-10-14T09:00:00Z' } });

  // The file the ledger meant is gone, written over: moved by the next run, the new file would leave
  // its own source with no current copy.
  it('a file written at a path the ledger holds takes it out, and the next run leaves the new file in place', async () => {
    const { files, ledger } = setUp({ texts: { [LEDGER]: listed, [NOTE]: 'the contract' } });

    await ledger.files.writeText(NOTE, 'the new contract');
    await ledger.retry();

    expect(ledgerOf(files.written.get(LEDGER))).toEqual({});
    expect(files.moves).toStrictEqual([]);
    expect(files.written.get(NOTE)).toBe('the new contract');
  });

  it('bytes written, or a file moved, to a path the ledger holds take it out as well', async () => {
    const bytes = setUp({ texts: { [LEDGER]: listed, [NOTE]: 'the contract' } });
    const moved = setUp({ texts: { [LEDGER]: listed, [TASK]: 'the task' } });

    await bytes.ledger.files.writeBytes(NOTE, new Uint8Array([1]));
    await moved.ledger.files.move(TASK, NOTE);

    expect(ledgerOf(bytes.files.written.get(LEDGER))).toEqual({});
    expect(ledgerOf(moved.files.written.get(LEDGER))).toEqual({});
  });

  it('a write elsewhere, or one that fails, leaves the ledger as it is', async () => {
    const elsewhere = setUp({ texts: { [LEDGER]: listed, [NOTE]: 'the contract' } });
    const refused = setUp({ texts: { [LEDGER]: listed, [NOTE]: 'the contract' }, failWritesMatching: 'Contrat.docx.md' });

    await elsewhere.ledger.files.writeText(TASK, 'the task');
    await refused.ledger.files.writeText(NOTE, 'the new contract');

    expect(elsewhere.files.written.get(LEDGER)).toBe(listed);
    expect(refused.files.written.get(LEDGER)).toBe(listed);
  });

  // A file moved by its own source, a layout change of Teams for one, is still that source's file, and
  // the source can let it go later in the same run.
  it('a file moved to a path in this run is still written down when its source lets it go', async () => {
    const MOVED = 'kb/SharePoint sites/Espace Contoso/Documents/Projets/Contrat.docx.md';
    const { files, ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.files.move(NOTE, MOVED);
    await ledger.writeDown([{ path: MOVED, error: LOCKED }]);

    expect(Object.keys(ledgerOf(files.written.get(LEDGER)))).toEqual([MOVED]);
  });

  // On Windows and macOS, a path that differs only in letter case is the same file: written down, it
  // would take the digest of the new file, and a later run would move that live file away.
  it('a file let go at a path written in this run in another letter case is not written down', async () => {
    const { files, ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.files.writeText(NOTE.toLowerCase(), 'the new contract');
    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(files.written.has(LEDGER)).toBe(false);
  });

  // In one window, a file can land at a path before another item lets go of its own file there.
  it('a file let go at a path another file landed at in this run is not written down', async () => {
    const { files, ledger } = setUp({ texts: { [NOTE]: 'the contract' } });

    await ledger.files.writeText(NOTE, 'the new contract');
    await ledger.writeDown([{ path: NOTE, error: LOCKED }]);

    expect(files.written.has(LEDGER)).toBe(false);
  });
});
