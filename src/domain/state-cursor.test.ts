import { describe, expect, it } from 'bun:test';
import { cursorFor, mergeCursor, serializeCursor, splitCursor } from './state-cursor.ts';

const SITE = {
  version: 1,
  source: { kind: 'site', id: 's1', name: 'Site' },
  lastRun: '2026-10-13T08:00:00Z',
  drives: {
    d1: { name: 'Documents', deltaLink: 'https://graph/delta?token=1', since: '2026-01-01', pending: [{ id: 'i1', deltaLink: 'kept' }], items: {} },
    d2: { name: 'Empty', items: {} },
  },
};

describe('keeping what moves on every run apart from what a run found', () => {
  // The state says what each source holds, and changes only when the source does. The time of the
  // run and the cursors Graph hands back change on every run, so they go to a file of their own.
  it('the run time and every delta cursor leave the state, and come back into it as they were', () => {
    const split = splitCursor(SITE);

    expect(split.state).toEqual({
      version: 1,
      source: { kind: 'site', id: 's1', name: 'Site' },
      drives: { d1: { name: 'Documents', since: '2026-01-01', pending: [{ id: 'i1', deltaLink: 'kept' }], items: {} }, d2: { name: 'Empty', items: {} } },
    });
    expect(split.cursor).toEqual({ lastRun: '2026-10-13T08:00:00Z', drives: { d1: { deltaLink: 'https://graph/delta?token=1' } } });
    expect(mergeCursor(split.state, split.cursor)).toEqual(SITE);
  });

  // A cursor says what changed after it, so it is only safe beside the record it was taken with. One
  // for a library the state no longer holds would skip every file of that library on the next run.
  it('a cursor for something the state does not hold is dropped, and a state with no cursor is read as it is', () => {
    const lost = mergeCursor({ version: 1, drives: {} }, { lastRun: '2026-10-13T08:00:00Z', drives: { d1: { deltaLink: 'https://graph/delta?token=1' } } });

    expect(lost).toEqual({ version: 1, drives: {}, lastRun: '2026-10-13T08:00:00Z' });
    expect(mergeCursor(SITE, undefined)).toEqual(SITE);
    expect(mergeCursor(SITE, 'not a cursor')).toEqual(SITE);
    expect(mergeCursor('not a state', { lastRun: 'x' })).toBe('not a state');
    expect(mergeCursor({ drives: { d1: 'odd' } }, { drives: { d1: { deltaLink: 'x' } } })).toEqual({ drives: { d1: 'odd' } });
  });

  it('a state with nothing that moves splits into itself and no cursor, and so does anything that is not a record', () => {
    expect(splitCursor({ version: 1, lists: { l1: { file: 'a.md' } } })).toEqual({ state: { version: 1, lists: { l1: { file: 'a.md' } } }, cursor: {} });
    expect(splitCursor([1, 2])).toEqual({ state: [1, 2], cursor: {} });
  });

  // Bound to the state it was saved with. A state put back from a backup or from git, older than its
  // cursor, would read on from a cursor past what it holds and miss what changed in between. Such a
  // cursor is dropped, and the source is read whole once.
  it('a cursor is read back only beside the state it was saved with', () => {
    const saved = serializeCursor('{ "version": 1 }\n', { lastRun: '2026-10-13T08:00:00Z' });

    expect(cursorFor('{ "version": 1 }\n', saved)).toEqual({ lastRun: '2026-10-13T08:00:00Z' });
    expect(cursorFor('{ "version": 2 }\n', saved)).toBeUndefined();
    expect(cursorFor('{ "version": 1 }\n', 'not json')).toBeUndefined();
    expect(cursorFor('{ "version": 1 }\n', JSON.stringify({ ...JSON.parse(saved), cursor: 'odd' }))).toBeUndefined();
    expect(cursorFor('{ "version": 1 }\n', 'null')).toBeUndefined();
  });
});
