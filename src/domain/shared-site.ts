// A site can be reachable without being listed. The tenant's site index answers with the sites you
// belong to; a library shared with you by link grants access to its contents without making you a
// member, so its site never enters that index and never reaches the picker. What does show it is
// the drive sweep, which reports the library itself. This turns those libraries back into the sites
// that hold them, so the picker can offer what you can actually read.

// `new URL` throws on anything that is not an address, which is a pure-domain fallback (rule 17):
// a row we cannot parse is left out rather than ending the listing. Empty segments are dropped, so
// a trailing slash stops mattering here rather than needing trimming later.
const addressOf = (url: string): { readonly origin: string; readonly segments: ReadonlyArray<string> } | undefined => {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, segments: parsed.pathname.split('/').filter((segment) => segment.length > 0) };
  } catch {
    return undefined;
  }
};

// decodeURIComponent throws on a lone `%` or a bad escape; such an address is folded as it came.
const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// A library lives directly under its site, and a site is itself at least two segments deep
// (`/sites/Team`), so a library address has at least three and the site is that address without
// the last segment. Anything shorter is a host or a site, never a library: trimming a segment off
// `/sites/Team` would answer `/sites`, which no site ever answers to.
const SITE_SEGMENTS = 2;

export const siteUrlOfLibrary = (libraryUrl: string): string | undefined => {
  const address = addressOf(libraryUrl);
  if (address === undefined || address.segments.length <= SITE_SEGMENTS) return undefined;
  return `${address.origin}/${address.segments.slice(0, -1).join('/')}`;
};

// Two spellings of one address must not become two rows: Graph percent-encodes its paths, case
// varies by source, and a trailing slash is optional. Comparison folds all three away. What is
// handed back is the address as it was given, since that is the form that gets resolved.
const comparable = (url: string): string => {
  const address = addressOf(url);
  const rebuilt = address === undefined ? url : `${address.origin}/${address.segments.join('/')}`;
  return decoded(rebuilt).toLowerCase();
};

export const unlistedSiteUrls = (libraryUrls: ReadonlyArray<string>, known: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set(known.map(comparable));
  const found: string[] = [];
  for (const libraryUrl of libraryUrls) {
    const site = siteUrlOfLibrary(libraryUrl);
    if (site === undefined) continue;
    const key = comparable(site);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(site);
  }
  return found;
};
