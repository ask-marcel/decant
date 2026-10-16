import { describe, expect, it } from 'bun:test';
import { causeOf, digestOf, parseAsideLedger, serializeAsideLedger, stuckAt, stuckNotes, unreadableNote, unstuck } from './aside-ledger.ts';

const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const TASK = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';

describe('keeping the files that would not move under the archive', () => {
  it('what one run writes down, the next run reads back, in the order of the paths', () => {
    const ledger = stuckAt(
      stuckAt({}, TASK, 'write-failed: EBUSY: resource busy or locked', '2026-10-15T09:00:00Z'),
      NOTE,
      'write-failed: EPERM',
      '2026-10-15T09:05:00Z',
      digestOf('the contract')
    );
    const text = serializeAsideLedger(ledger);

    expect(Object.keys(JSON.parse(text))).toEqual([NOTE, TASK]);
    expect(parseAsideLedger(JSON.parse(text))).toEqual({ ok: true, value: ledger });
    expect(parseAsideLedger(JSON.parse(serializeAsideLedger({})))).toEqual({ ok: true, value: {} });
  });

  // The rest of the message names both paths, the day of the run among them: kept whole, the cause
  // would change on each day a file stays stuck.
  it('the cause of a failed move keeps its kind and the system code, and leaves the paths out', () => {
    expect(causeOf({ kind: 'write-failed', message: "EBUSY: resource busy or locked, rename 'kb/a.md' -> 'kb/_archive/2026-10-15/a.md'" })).toBe('write-failed: EBUSY');
    expect(causeOf({ kind: 'write-failed', message: 'EPERM' })).toBe('write-failed: EPERM');
    expect(causeOf({ kind: 'write-failed', message: 'a file is already at kb/_archive/2026-10-15/a.md' })).toBe('write-failed');
    expect(causeOf({ kind: 'write-failed', message: 'EBUSYNESS is no code' })).toBe('write-failed');
  });

  // The day it first would not move says how long it has waited; the cause is the latest one.
  it('a file that would not move again keeps the day it first would not, and takes the latest cause', () => {
    const again = stuckAt(stuckAt({}, NOTE, 'write-failed: EBUSY', '2026-10-14T09:00:00Z', 'd1'), NOTE, 'write-failed: EPERM', '2026-10-15T09:00:00Z', 'd2');

    expect(again).toEqual({ [NOTE]: { path: NOTE, cause: 'write-failed: EPERM', since: '2026-10-14T09:00:00Z', digest: 'd2' } });
  });

  it('a file that moved, or that is gone, leaves the ledger, and the others stay', () => {
    const ledger = stuckAt(stuckAt({}, NOTE, 'write-failed: EBUSY', '2026-10-15T09:00:00Z'), TASK, 'write-failed: EBUSY', '2026-10-15T09:00:00Z');

    expect(Object.keys(unstuck(ledger, [NOTE]))).toEqual([TASK]);
  });

  // No source records these files any more: a ledger read in part would let the rest go for good.
  it('a ledger that is not one, or that holds an entry that is not one, does not read at all', () => {
    const valid = { cause: 'write-failed: EBUSY', since: '2026-10-15T09:00:00Z' };
    const notLedgers = ['nope', [NOTE], null, [valid]];
    const badEntries = ['stuck', null, { cause: 42, since: valid.since }, { cause: valid.cause, since: 20261015 }, { ...valid, digest: 42 }];

    expect(notLedgers.map((raw) => parseAsideLedger(raw))).toEqual(notLedgers.map(() => ({ ok: false, error: 'not a ledger' })));
    expect(badEntries.map((entry) => parseAsideLedger({ [NOTE]: valid, [TASK]: entry }))).toEqual(badEntries.map(() => ({ ok: false, error: 'an entry is not one' })));
  });

  it('a ledger that does not read is named in the report in place of its files, with why', () => {
    expect(unreadableNote('invalid-json')).toEqual({
      path: '.sync-aside.json',
      reason: 'could not be read (invalid-json): no run moves the files it lists, or adds to it, until it is repaired or deleted',
    });
  });

  it('the report names each file as the knowledge base does, with why it would not move and since when', () => {
    const ledger = stuckAt({}, NOTE, 'write-failed: EBUSY: resource busy or locked', '2026-10-14T09:00:00Z', 'd1');

    expect(stuckNotes(Object.values(ledger), 'kb', 'UTC')).toEqual([
      { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY: resource busy or locked (since 2026-10-14)' },
    ]);
  });

  // A path the ledger holds from another place on disk is named whole, never cut at the wrong length.
  // A run at 07:00 in Shanghai is still the day before in UTC.
  it('the day a file first would not move is told in the zone of the knowledge base', () => {
    const ledger = stuckAt({}, NOTE, 'write-failed: EBUSY', '2026-10-14T23:00:00Z', 'd1');

    expect(stuckNotes(Object.values(ledger), 'kb', 'Asia/Shanghai')).toEqual([
      { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-15)' },
    ]);
  });

  // Such a file cannot be told from one that took its path later, so no run moves it.
  it('a file that would not read when it stuck is named with a word that no run moves it', () => {
    const ledger = stuckAt({}, NOTE, 'write-failed: EBUSY', '2026-10-14T09:00:00Z');

    expect(stuckNotes(Object.values(ledger), 'kb', 'UTC')).toEqual([
      { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-14). It would not read when it stuck, so no run moves it' },
    ]);
  });

  it('the digest of a file tells the same text from another one', () => {
    expect(digestOf('the contract')).toBe(digestOf('the contract'));
    expect(digestOf('the contract')).not.toBe(digestOf('the new contract'));
  });

  it('a file outside the knowledge base is named by its whole path', () => {
    const ledger = stuckAt({}, 'elsewhere/Contrat.docx.md', 'write-failed: EBUSY', '2026-10-14T09:00:00Z', 'd1');

    expect(stuckNotes(Object.values(ledger), 'kb', 'UTC')).toEqual([{ path: 'elsewhere/Contrat.docx.md', reason: 'write-failed: EBUSY (since 2026-10-14)' }]);
  });
});
