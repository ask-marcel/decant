import type { SiteSummary } from '../use-cases/ports/drive-reader.ts';

// The sites a run listed, kept so the next run can draw its picker at once. Finding them takes three
// listings and a lookup per site the index does not name, tens of seconds, and the answer barely
// changes between runs: showing what was there last time and refreshing behind it trades a site that
// appeared since (it arrives one run late, and `--refresh` fetches it now) for never waiting again.
export type SiteCache = { readonly listedAt: string; readonly sites: ReadonlyArray<SiteSummary> };

// Bumped whenever the shape below changes, so a cache an older version wrote is passed over rather
// than half-understood. The cost of being wrong here is a picker built from nonsense.
const CACHE_VERSION = 1;

export const serializeSiteCache = (sites: ReadonlyArray<SiteSummary>, listedAt: string): string => `${JSON.stringify({ version: CACHE_VERSION, listedAt, sites }, undefined, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const siteOf = (raw: unknown): ReadonlyArray<SiteSummary> => {
  if (!isRecord(raw)) return [];
  const id = readString(raw, 'id');
  const name = readString(raw, 'name');
  return id === undefined || name === undefined ? [] : [{ id, name, webUrl: readString(raw, 'webUrl') ?? '' }];
};

// `undefined` means "no usable cache", which the caller answers by listing for real. Every reason to
// refuse lands here: unreadable text, a version we do not know, and a list naming nothing, since an
// empty list is indistinguishable from a tenant you can read nothing in and would hide the real one.
export const parseSiteCache = (text: string): SiteCache | undefined => {
  const raw = parsed(text);
  if (!isRecord(raw) || raw['version'] !== CACHE_VERSION) return undefined;
  const listedAt = readString(raw, 'listedAt');
  const sites = Array.isArray(raw['sites']) ? raw['sites'].flatMap(siteOf) : [];
  return listedAt === undefined || sites.length === 0 ? undefined : { listedAt, sites };
};

// JSON.parse throws on malformed text; a pure-domain fallback (rule 17) turns that into "no cache".
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
