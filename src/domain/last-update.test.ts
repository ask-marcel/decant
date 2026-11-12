import { describe, expect, it } from 'bun:test';
import { parseLastUpdate, serializeLastUpdate } from './last-update.ts';

describe('keeping the time of the last update', () => {
  it('the record keeps the time it was given', () => {
    expect(parseLastUpdate(serializeLastUpdate('2026-11-12T06:45:00.000Z'))).toBe('2026-11-12T06:45:00.000Z');
  });

  it('text that is not a record reads as no record, so the next update runs', () => {
    for (const text of ['', 'not json', '{}', '{"at":42}', '{"at":"yesterday"}']) expect(parseLastUpdate(text)).toBeUndefined();
  });
});
