import { describe, expect, it } from 'bun:test';
import { dayOf, isBefore, latestById, parseKeptZone, parseSettings, parseSince, serializeSettings, widens } from './sync-window.ts';

describe('how far back a run reaches', () => {
  it('a day, or the word all, is a reach; anything else is refused', () => {
    expect(parseSince('2025-01-31')).toEqual({ ok: true, value: '2025-01-31' });
    expect(parseSince('all')).toEqual({ ok: true, value: 'all' });
    expect(parseSince('All')).toEqual({ ok: true, value: 'all' });
    expect(parseSince('2025-02-30')).toEqual({ ok: false, error: { kind: 'bad-since' } });
    expect(parseSince('2025-13-01').ok).toBe(false);
    expect(parseSince('last week').ok).toBe(false);
    expect(parseSince('2025-01-31T00:00:00Z').ok).toBe(false);
    expect(parseSince('').ok).toBe(false);
  });

  it('all reaches everything, and a day reaches from its own start, counted in UTC', () => {
    expect(dayOf('all')).toBeUndefined();
    expect(dayOf('2025-01-01')).toBe('2025-01-01');
    expect(isBefore('2024-12-31T23:59:59Z', '2025-01-01')).toBe(true);
    expect(isBefore('2025-01-01T00:00:00Z', '2025-01-01')).toBe(false);
    expect(isBefore('2025-01-01', '2025-01-01')).toBe(false);
    expect(isBefore('2024-12-31T23:59:59Z', undefined)).toBe(false);
  });

  it('something with no time at all is never before the day, since nothing says it is old', () => {
    expect(isBefore('', '2025-01-01')).toBe(false);
  });

  it('a day earlier than the one a cursor was taken under widens it, and so does all; the same day or a later one does not', () => {
    expect(widens('2025-01-01', '2024-06-01')).toBe(true);
    expect(widens('2025-01-01', undefined)).toBe(true);
    expect(widens('2025-01-01', '2025-01-01')).toBe(false);
    expect(widens('2025-01-01', '2025-06-01')).toBe(false);
  });

  it('a cursor read out and a whole read make one entry per id, the whole read winning, and what only the cursor saw kept', () => {
    const drained = [
      { id: 'gone', state: 'deleted' },
      { id: 'edited', state: 'as the cursor saw it' },
    ];
    const whole = [
      { id: 'edited', state: 'as it is now' },
      { id: 'older', state: 'never filed' },
    ];

    expect(latestById([...drained, ...whole])).toEqual([
      { id: 'gone', state: 'deleted' },
      { id: 'edited', state: 'as it is now' },
      { id: 'older', state: 'never filed' },
    ]);
  });

  it('a cursor taken before any day was recorded reached everything, which nothing widens', () => {
    expect(widens(undefined, '2024-06-01')).toBe(false);
    expect(widens(undefined, undefined)).toBe(false);
  });
});

describe('keeping the reach for the runs after', () => {
  it('the stored reach reads back as it was written', () => {
    expect(serializeSettings('2025-01-01')).toBe('{\n  "since": "2025-01-01"\n}\n');
    expect(parseSettings(serializeSettings('2025-01-01'))).toEqual({ ok: true, value: '2025-01-01' });
    expect(parseSettings(serializeSettings('all'))).toEqual({ ok: true, value: 'all' });
  });

  // A run in Germany counted its days in Berlin time and a run in Shanghai would count them there, so
  // one knowledge base held days counted two ways. The zone is kept beside the reach instead.
  it('the zone a run counts its days in is kept beside the reach, and read back when it is a zone the machine knows', () => {
    const kept = serializeSettings('2025-01-01', 'Asia/Shanghai');

    expect(kept).toBe('{\n  "since": "2025-01-01",\n  "timezone": "Asia/Shanghai"\n}\n');
    expect(parseSettings(kept)).toEqual({ ok: true, value: '2025-01-01' });
    expect(parseKeptZone(kept)).toBe('Asia/Shanghai');
    expect(parseKeptZone(serializeSettings('2025-01-01'))).toBeUndefined();
    expect(parseKeptZone('{ "since": "all", "timezone": "China Standard Time" }')).toBeUndefined();
    expect(parseKeptZone('{ "since": "all", "timezone": 8 }')).toBeUndefined();
    expect(parseKeptZone('null')).toBeUndefined();
    expect(parseKeptZone('8')).toBeUndefined();
    expect(parseKeptZone('not json')).toBeUndefined();
  });

  it('a file saying anything else is refused rather than read as everything', () => {
    expect(parseSettings('{ "since": "2025/01/01" }')).toEqual({ ok: false, error: { kind: 'bad-since' } });
    expect(parseSettings('{ "since": 20250101 }')).toEqual({ ok: false, error: { kind: 'bad-since' } });
    expect(parseSettings('{}').ok).toBe(false);
    expect(parseSettings('20250101').ok).toBe(false);
    expect(parseSettings('null').ok).toBe(false);
    expect(parseSettings('not json').ok).toBe(false);
  });
});
