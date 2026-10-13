import { describe, expect, it } from 'bun:test';
import { clearAttempt, gaveUpNotes, givenUpNotes, isGivenUp, nextAttempt, parseAttempts, recordAttempt } from './retry-ledger.ts';

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
});
