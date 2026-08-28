import { describe, expect, it } from 'bun:test';
import { parseSiteCache, serializeSiteCache } from './site-cache.ts';

const SITES = [
  { id: 'contoso,1,2', name: 'Espace Contoso', webUrl: 'https://tenant.sharepoint.com/sites/Espace' },
  { id: 'contoso,3,4', name: 'Partage', webUrl: 'https://tenant.sharepoint.com/sites/Partage' },
];

describe('remembering the sites a run listed', () => {
  it('the sites one run listed are read back unchanged by the next', () => {
    expect(parseSiteCache(serializeSiteCache(SITES, '2026-08-27T20:14:00Z'))).toEqual({ listedAt: '2026-08-27T20:14:00Z', sites: SITES });
  });

  it('a cache written by an older version is ignored rather than half-understood', () => {
    expect(parseSiteCache(JSON.stringify({ version: 0, listedAt: '2026-08-27T20:14:00Z', sites: SITES }))).toBeUndefined();
  });

  it('a cache that is not JSON at all is ignored rather than crashing the picker', () => {
    expect(parseSiteCache('not json {')).toBeUndefined();
  });

  it('a stored entry missing its id or its name is left out rather than filed under nothing', () => {
    const text = JSON.stringify({
      version: 1,
      listedAt: '2026-08-27T20:14:00Z',
      sites: [
        { id: 'contoso,1,2', name: 'Kept', webUrl: 'https://tenant.sharepoint.com/sites/Kept' },
        { id: 'contoso,3,4' },
        { name: 'No id at all' },
        'not an object',
        { id: 5, name: 'Id that is not text' },
        { id: 'contoso,7,8', name: 'No address' },
      ],
    });

    expect(parseSiteCache(text)?.sites).toEqual([
      { id: 'contoso,1,2', name: 'Kept', webUrl: 'https://tenant.sharepoint.com/sites/Kept' },
      { id: 'contoso,7,8', name: 'No address', webUrl: '' },
    ]);
  });

  it('a cache whose sites are not a list at all is ignored rather than read as one', () => {
    expect(parseSiteCache(JSON.stringify({ version: 1, listedAt: '2026-08-27T20:14:00Z', sites: 'not a list' }))).toBeUndefined();
  });

  it('a cache with sites but no time on it is ignored, since the picker says when it was listed', () => {
    expect(parseSiteCache(JSON.stringify({ version: 1, sites: SITES }))).toBeUndefined();
  });

  it('a cache naming no sites is ignored, so an empty list never stands in for a real one', () => {
    expect(parseSiteCache(serializeSiteCache([], '2026-08-27T20:14:00Z'))).toBeUndefined();
  });
});
