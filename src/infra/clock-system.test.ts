import { describe, expect, it } from 'bun:test';
import { createSystemClock } from './clock-system.ts';

describe('stamping when a document was synced', () => {
  it('the moment is recorded in UTC, the way every other stamp in the knowledge base is', () => {
    expect(createSystemClock().nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
