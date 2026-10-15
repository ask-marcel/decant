import { describe, expect, it } from 'bun:test';
import { parseAsideLedger, serializeAsideLedger, stuckAt, stuckNotes, unstuck } from './aside-ledger.ts';

const NOTE = 'kb/SharePoint sites/Espace Contoso/Documents/Contrat.docx.md';
const TASK = 'kb/To Do/Tasks/2026-09-01/Book the venue.md';

describe('keeping the files that would not move under the archive', () => {
  it('what one run writes down, the next run reads back, in the order of the paths', () => {
    const ledger = stuckAt(stuckAt({}, TASK, 'write-failed: EBUSY: resource busy or locked', '2026-10-15T09:00:00Z'), NOTE, 'write-failed: EPERM', '2026-10-15T09:05:00Z');
    const text = serializeAsideLedger(ledger);

    expect(Object.keys(JSON.parse(text))).toEqual([NOTE, TASK]);
    expect(parseAsideLedger(JSON.parse(text))).toEqual(ledger);
  });

  // The day it first would not move says how long it has waited; the cause is the latest one.
  it('a file that would not move again keeps the day it first would not, and takes the latest cause', () => {
    const again = stuckAt(stuckAt({}, NOTE, 'write-failed: EBUSY', '2026-10-14T09:00:00Z'), NOTE, 'write-failed: EPERM', '2026-10-15T09:00:00Z');

    expect(again).toEqual({ [NOTE]: { path: NOTE, cause: 'write-failed: EPERM', since: '2026-10-14T09:00:00Z' } });
  });

  it('a file that moved, or that is gone, leaves the ledger, and the others stay', () => {
    const ledger = stuckAt(stuckAt({}, NOTE, 'write-failed: EBUSY', '2026-10-15T09:00:00Z'), TASK, 'write-failed: EBUSY', '2026-10-15T09:00:00Z');

    expect(Object.keys(unstuck(ledger, [NOTE]))).toEqual([TASK]);
  });

  // The ledger lists moves a run still owes, and the next move that fails writes its file down again.
  it('a ledger that is not one, or an entry that is not one, reads as nothing', () => {
    expect(parseAsideLedger('nope')).toEqual({});
    expect(parseAsideLedger([NOTE])).toEqual({});
    expect(parseAsideLedger({ [NOTE]: 'stuck', [TASK]: { cause: 42, since: '2026-10-15T09:00:00Z' } })).toEqual({});
  });

  it('the report names each file as the knowledge base does, with why it would not move and since when', () => {
    const ledger = stuckAt({}, NOTE, 'write-failed: EBUSY: resource busy or locked', '2026-10-14T09:00:00Z');

    expect(stuckNotes(Object.values(ledger), 'kb')).toEqual([
      { path: 'SharePoint sites/Espace Contoso/Documents/Contrat.docx.md', reason: 'write-failed: EBUSY: resource busy or locked (since 2026-10-14)' },
    ]);
  });
});
