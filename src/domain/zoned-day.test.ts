import { describe, expect, it } from 'bun:test';
import { UNDATED_DAY, dayIn, isKnownZone } from './zoned-day.ts';

describe('counting the day a message arrived on', () => {
  it('a message that arrived late in Shanghai is filed under the day it was there, not the day it was in UTC', () => {
    expect(dayIn('2026-06-10T16:40:00Z', 'Asia/Shanghai')).toBe('2026-06-11');
    expect(dayIn('2026-06-10T16:40:00Z', 'UTC')).toBe('2026-06-10');
  });

  it('a message that arrived after midnight in Paris is filed under the day it was there', () => {
    expect(dayIn('2026-06-10T23:40:00Z', 'Europe/Paris')).toBe('2026-06-11');
  });

  it('a timestamp that is not a time at all still yields a day rather than stopping the run', () => {
    expect(dayIn('', 'Asia/Shanghai')).toBe('0000-00-00');
    expect(dayIn('the fourteenth', 'Asia/Shanghai')).toBe(UNDATED_DAY);
  });

  it('a zone that slipped past the check is counted in UTC rather than stopping the run', () => {
    expect(dayIn('2026-06-10T16:40:00Z', 'Nowhere/Land')).toBe('2026-06-10');
  });
});

describe('accepting the zone a mailbox counts its days in', () => {
  it('a zone the machine knows is accepted', () => {
    expect(isKnownZone('Asia/Shanghai')).toBe(true);
    expect(isKnownZone('UTC')).toBe(true);
  });

  // What `my-quick-context` returns unless the tenant is set to IANA. Naming it here so the failure
  // reads as "that is the Windows spelling" rather than as a typo in a config file.
  it('the Windows spelling a tenant reports is not a zone this can count in', () => {
    expect(isKnownZone('China Standard Time')).toBe(false);
    expect(isKnownZone('')).toBe(false);
  });
});
