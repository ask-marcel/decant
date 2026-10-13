import { describe, expect, it } from 'bun:test';
import { compareText } from './compare-text.ts';

describe('putting text in order', () => {
  // `localeCompare` with no locale sorts by the language of the machine, so one list came out in two
  // orders from two laptops, and every file holding it changed between them.
  it('text is put in the same order on every machine, letters before their accented and capital forms', () => {
    expect(['zoe', 'Émile', 'b', 'A', 'a', 'é', 'e'].toSorted(compareText)).toEqual(['a', 'A', 'b', 'e', 'é', 'Émile', 'zoe']);
    expect(compareText('2026-10-12T08:00:00Z', '2026-10-13T08:00:00Z')).toBeLessThan(0);
    expect(compareText('same', 'same')).toBe(0);
  });
});
