import { describe, expect, it } from 'bun:test';
import { addressKindOf, kindOf, orderByKind } from './address-kind.ts';

describe('telling one kind of source from another by its address', () => {
  it('a Loop workspace is told from a team site by the path it is stored under', () => {
    expect(addressKindOf('https://tenant.sharepoint.com/contentstorage/CSP_58a5d752')).toBe('loop');
    expect(addressKindOf('https://tenant.sharepoint.com/sites/Direction')).toBe('site');
  });

  it('a personal site is OneDrive, whatever its owner is called', () => {
    expect(addressKindOf('https://tenant-my.sharepoint.com/personal/jane_doe_example_com')).toBe('onedrive');
  });

  it('the tenant root and an older managed path are sites like any other', () => {
    expect(addressKindOf('https://tenant.sharepoint.com')).toBe('site');
    expect(addressKindOf('https://tenant.sharepoint.com/teamsite01')).toBe('site');
  });

  it('an address that will not parse is still offered, as a site', () => {
    expect(addressKindOf('not an address')).toBe('site');
  });

  it('a source that states its kind is taken at its word, since a group inbox has no address to read', () => {
    expect(kindOf({ webUrl: '', kind: 'group' })).toBe('group');
    expect(kindOf({ webUrl: 'https://tenant.sharepoint.com/sites/Direction' })).toBe('site');
  });

  it('sites come first, then Loop, then OneDrive, then the group inboxes, and the order inside each is left alone', () => {
    const listed = [
      { webUrl: '', kind: 'group' as const },
      { webUrl: 'https://tenant-my.sharepoint.com/personal/jane' },
      { webUrl: 'https://tenant.sharepoint.com/sites/Direction' },
      { webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_one' },
      { webUrl: 'https://tenant.sharepoint.com/sites/Ventes' },
      { webUrl: 'https://tenant.sharepoint.com/contentstorage/CSP_two' },
    ];

    expect(orderByKind(listed).map((source) => source.webUrl)).toEqual([
      'https://tenant.sharepoint.com/sites/Direction',
      'https://tenant.sharepoint.com/sites/Ventes',
      'https://tenant.sharepoint.com/contentstorage/CSP_one',
      'https://tenant.sharepoint.com/contentstorage/CSP_two',
      'https://tenant-my.sharepoint.com/personal/jane',
      '',
    ]);
  });
});
