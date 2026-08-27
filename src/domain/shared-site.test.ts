import { describe, expect, it } from 'bun:test';
import { siteUrlOfLibrary, unlistedSiteUrls } from './shared-site.ts';

const TEAM = 'https://tenant.sharepoint.com/sites/Team';

describe('finding a site through a library someone shared', () => {
  it('the site holding a library is named by dropping the library from its address', () => {
    expect(siteUrlOfLibrary(`${TEAM}/Shared%20Documents`)).toBe(TEAM);
  });

  it('a library whose site the index already listed adds nothing', () => {
    expect(unlistedSiteUrls([`${TEAM}/Shared%20Documents`], [TEAM])).toHaveLength(0);
  });

  it('a site already listed is recognised through an encoded, differently cased address', () => {
    expect(unlistedSiteUrls(['https://TENANT.sharepoint.com/sites/Team/Documents%20partages'], [TEAM])).toEqual([]);
  });

  it('two libraries of one site name that site once', () => {
    expect(unlistedSiteUrls([`${TEAM}/Shared%20Documents`, `${TEAM}/Site%20Assets`], [])).toEqual([TEAM]);
  });

  it('a site already listed with a trailing slash is recognised without it', () => {
    expect(unlistedSiteUrls([`${TEAM}/Shared%20Documents`], [`${TEAM}/`])).toEqual([]);
  });

  it('a library address ending in a slash still names the site above it', () => {
    expect(siteUrlOfLibrary(`${TEAM}/Shared%20Documents/`)).toBe(TEAM);
  });

  it('a site address is not mistaken for a library and trimmed down to its host', () => {
    expect(siteUrlOfLibrary('https://tenant.sharepoint.com/sites')).toBeUndefined();
  });

  it('a library nested deeper than one folder still names the site, not the folder above it', () => {
    expect(siteUrlOfLibrary('https://tenant.sharepoint.com/sites/Team/Shared%20Documents')).toBe(TEAM);
  });

  it('the address offered is the one that came in, not the folded form used to compare it', () => {
    expect(unlistedSiteUrls(['https://TENANT.sharepoint.com/sites/Equipe%20A/Documents'], [])).toEqual(['https://tenant.sharepoint.com/sites/Equipe%20A']);
  });

  it('two sites, neither of them listed, are both offered rather than folded into one', () => {
    const other = 'https://tenant.sharepoint.com/sites/Partage';
    expect(unlistedSiteUrls([`${TEAM}/Shared%20Documents`, `${other}/Shared%20Documents`], [])).toEqual([TEAM, other]);
  });

  it('a site address two segments deep is not trimmed into a path no site answers to', () => {
    expect(siteUrlOfLibrary(TEAM)).toBeUndefined();
  });

  it('an address that is not a library is left out entirely rather than offered as nothing', () => {
    // `toEqual([])` alone would pass on `[undefined]` in Bun, so the length is pinned as well.
    expect(unlistedSiteUrls(['not a url'], [])).toHaveLength(0);
  });

  it('an unreadable address among the ones already listed does not hide a real site', () => {
    expect(unlistedSiteUrls([`${TEAM}/Shared%20Documents`], ['not a url'])).toEqual([TEAM]);
  });

  it('an address that cannot be decoded is still compared, so one bad row does not end the listing', () => {
    // A lone `%` makes decodeURIComponent throw; the address is compared as it came instead.
    expect(unlistedSiteUrls(['https://tenant.sharepoint.com/sites/Team%/Documents'], [])).toEqual(['https://tenant.sharepoint.com/sites/Team%']);
  });

  it('an address with no library segment is ignored rather than guessed at', () => {
    expect(siteUrlOfLibrary('https://tenant.sharepoint.com')).toBeUndefined();
    expect(unlistedSiteUrls(['https://tenant.sharepoint.com', 'not a url'], [])).toHaveLength(0);
  });
});
