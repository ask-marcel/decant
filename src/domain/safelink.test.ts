import { describe, expect, it } from 'bun:test';
import { unwrapSafelinks } from './safelink.ts';

const WRAPPED =
  'https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup&data=05%7C02%7Cvincent.delacourt%40moovlogistics.com&sdata=P6xTt8ch%3D&reserved=0';

describe('reading where a link really goes', () => {
  it('a wrapped link becomes the address it was wrapped around', () => {
    expect(unwrapSafelinks(WRAPPED)).toBe('https://teams.microsoft.com/l/meetup');
  });

  it('a wrapped link inside a markdown destination is unwrapped where it stands', () => {
    expect(unwrapSafelinks(`See [the meeting](${WRAPPED}) for details.`)).toBe('See [the meeting](https://teams.microsoft.com/l/meetup) for details.');
  });

  it('every link in a message is unwrapped, not merely the first', () => {
    expect(unwrapSafelinks(`${WRAPPED} and ${WRAPPED}`)).toBe('https://teams.microsoft.com/l/meetup and https://teams.microsoft.com/l/meetup');
  });

  it('a link nobody wrapped is left exactly as it stands', () => {
    expect(unwrapSafelinks('https://teams.microsoft.com/l/meetup')).toBe('https://teams.microsoft.com/l/meetup');
  });

  // The wrapper is the only record of the link when its `url` cannot be read, so it stays. Losing
  // an unreadable address is worse than keeping an ugly one.
  it('a wrapper carrying no destination is kept, being the only record of the link', () => {
    const empty = 'https://apc01.safelinks.protection.outlook.com/?data=05%7C02&reserved=0';

    expect(unwrapSafelinks(empty)).toBe(empty);
  });

  it('a destination that is not decodable is kept, since decoding it would throw', () => {
    const broken = 'https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fa%zz&reserved=0';

    expect(unwrapSafelinks(broken)).toBe(broken);
  });

  it('a destination present but empty is kept, an empty link being no link at all', () => {
    const blank = 'https://apc01.safelinks.protection.outlook.com/?url=&reserved=0';

    expect(unwrapSafelinks(blank)).toBe(blank);
  });
});
