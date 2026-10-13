import { describe, expect, it } from 'bun:test';
import { UNREAD, clearAttempt, forgetAttempts, gaveUpNotes, givenUpNotes, heldAttempts, isGivenUp, nextAttempt, parseAttempts, recordAttempt, triedReads } from './retry-ledger.ts';

describe('counting the runs that tried an item and failed', () => {
  it('each run that fails on the same version adds a try, and a new version of the item starts the count over', () => {
    const first = nextAttempt(undefined, 'v1', 'Book the venue', 'write-failed: locked');
    const second = nextAttempt(first, 'v1', 'Book the venue', 'write-failed: still locked');
    const edited = nextAttempt(second, 'v2', 'Book the venue', 'write-failed: locked');

    expect(first).toEqual({ attempts: 1, version: 'v1', name: 'Book the venue', reason: 'write-failed: locked' });
    expect(second).toEqual({ attempts: 2, version: 'v1', name: 'Book the venue', reason: 'write-failed: still locked' });
    expect(edited.attempts).toBe(1);
  });

  it('an item is given up on after three runs on the same version, and tried again once the source changes it', () => {
    const third = nextAttempt(nextAttempt(nextAttempt(undefined, 'v1', 'A', 'r'), 'v1', 'A', 'r'), 'v1', 'A', 'r');

    expect(isGivenUp(nextAttempt(nextAttempt(undefined, 'v1', 'A', 'r'), 'v1', 'A', 'r'), 'v1')).toBe(false);
    expect(isGivenUp(third, 'v1')).toBe(true);
    expect(isGivenUp(third, 'v2')).toBe(false);
    expect(isGivenUp(undefined, 'v1')).toBe(false);
  });

  // No ledger at all is what a state with no failure holds, so a source that never failed keeps the
  // state it had before the ledger existed.
  it('a ledger holds what failed, and an item that worked leaves it, the ledger going when it is empty', () => {
    const ledger = recordAttempt(undefined, 't1', nextAttempt(undefined, 'v1', 'A', 'r'));
    const two = recordAttempt(ledger, 't2', nextAttempt(undefined, 'v1', 'B', 'r'));

    expect(Object.keys(two)).toEqual(['t1', 't2']);
    expect(clearAttempt(two, 't1')).toEqual({ t2: { attempts: 1, version: 'v1', name: 'B', reason: 'r' } });
    expect(clearAttempt(ledger, 't1')).toBeUndefined();
    expect(clearAttempt(undefined, 't1')).toBeUndefined();
  });

  // Every item still out of tries goes to the report of the whole run, on every run. A source's own
  // report is a log of runs and names an item once, in the run that gave up on it.
  it('the items given up on are named by what the report calls them, and the ones this run gave up on are told apart', () => {
    const out = (version: string): ReturnType<typeof nextAttempt> => ({ attempts: 3, version, name: 'Book the venue', reason: 'write-failed: locked' });
    const before = { t1: out('v1'), t2: { ...out('v1'), attempts: 2, name: 'Call the caterer' } };
    const after = { ...before, t2: { ...out('v1'), name: 'Call the caterer' }, t3: { ...out('v1'), attempts: 1, name: 'Print the badges' } };

    expect(givenUpNotes(after)).toEqual([
      { path: 'Book the venue', reason: 'write-failed: locked' },
      { path: 'Call the caterer', reason: 'write-failed: locked' },
    ]);
    expect(gaveUpNotes(before, after)).toEqual([{ path: 'Call the caterer', reason: 'write-failed: locked' }]);
    expect(gaveUpNotes(undefined, { t1: out('v2') })).toEqual([{ path: 'Book the venue', reason: 'write-failed: locked' }]);
    expect(gaveUpNotes({ t1: out('v1') }, { t1: out('v2') })).toEqual([{ path: 'Book the venue', reason: 'write-failed: locked' }]);
    expect(givenUpNotes(undefined)).toHaveLength(0);
  });

  it('a ledger read back keeps every entry it can trust and drops the rest, and none at all is no ledger', () => {
    const raw = { t1: { attempts: 2, version: 'v1', name: 'A', reason: 'r' }, t2: { attempts: '2' }, t3: 'odd', t4: { attempts: 1, version: 'v1', name: 'B' } };

    expect(parseAttempts(raw)).toEqual({ t1: { attempts: 2, version: 'v1', name: 'A', reason: 'r' } });
    expect(parseAttempts({})).toBeUndefined();
    expect(parseAttempts(undefined)).toBeUndefined();
    expect(parseAttempts([1])).toBeUndefined();
  });

  // A profile or a section listing is read on every run, so it cannot be left alone like a document:
  // after three runs it is still read, but no longer named as a failure, and its count stays put.
  it('a thing read on every run is counted while it fails, given up after three runs without moving again, and cleared once read', () => {
    const jane = { id: 'jane', name: 'Jane Doe', reason: 'no such user' };
    const first = triedReads(undefined, [], [jane]);
    const third = triedReads(triedReads(first.retry, [], [jane]).retry, [], [jane]);
    const fourth = triedReads(third.retry, ['dana'], [jane]);

    expect(first).toEqual({
      retry: { jane: { attempts: 1, version: UNREAD, name: 'Jane Doe', reason: 'no such user' } },
      tried: 1,
      failed: [{ path: 'Jane Doe', reason: 'no such user' }],
    });
    expect(third.tried).toBe(1);
    expect(third.failed).toHaveLength(0);
    expect(fourth).toEqual({ retry: third.retry, tried: 0, failed: [] });
    expect(triedReads(third.retry, ['jane'], []).retry).toBeUndefined();
  });

  it('a thing read again is cleared only when it was counted as unread, not when it failed in another way', () => {
    const written = recordAttempt(undefined, 'jane', nextAttempt(undefined, 'fingerprint-1', 'Jane Doe', 'write-failed'));

    expect(triedReads(written, ['jane'], []).retry).toEqual(written);
  });
});

describe('forgetting the tries of an item the source no longer holds', () => {
  const tries = { attempts: 3, version: 'v1', name: 'Budget', reason: 'locked' };
  const ledger = { kept: tries, gone: { ...tries, name: 'Old budget' } };

  it('a source read whole keeps the tries of what it still holds and forgets the rest', () => {
    expect(heldAttempts(ledger, new Set(['kept']))).toEqual({ kept: tries });
    expect(heldAttempts(ledger, new Set())).toBeUndefined();
  });

  it('a source read as changes forgets what the changes say is gone', () => {
    expect(forgetAttempts(ledger, ['gone'])).toEqual({ kept: tries });
    expect(forgetAttempts(ledger, ['gone', 'kept'])).toBeUndefined();
  });

  // The same ledger, not an equal copy: a run that forgot nothing has nothing to save.
  it('a ledger that loses nothing is handed back as it was', () => {
    expect(heldAttempts(ledger, new Set(['kept', 'gone']))).toBe(ledger);
    expect(forgetAttempts(ledger, ['elsewhere'])).toBe(ledger);
    expect(heldAttempts(undefined, new Set(['kept']))).toBeUndefined();
  });
});
