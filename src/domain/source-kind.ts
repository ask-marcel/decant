// What a source actually is, which its display name does not say: a Loop workspace and a team site
// are both SharePoint underneath, and a personal site is named after its owner's mail address, so a
// flat listing shows twenty-one rows of three different things. The address tells them apart.
export type SourceKind = 'site' | 'loop' | 'onedrive';

// A Loop workspace is stored in SharePoint under `/contentstorage/`, and a personal site lives on
// the tenant's `-my` host. Everything else is a site, including the tenant root (no path at all) and
// the older managed paths (`/jacktest01`), which are ordinary sites wearing an unusual address.
const LOOP_SEGMENT = 'contentstorage';
const PERSONAL_HOST = '-my.sharepoint.com';

// `new URL` throws on anything that is not an address, which is the pure-domain fallback rule 17
// allows. A row whose address will not parse is still a row worth offering, so it is called a site
// rather than dropped from the listing.
const addressOf = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

export const sourceKindOf = (webUrl: string): SourceKind => {
  const address = addressOf(webUrl);
  if (address === undefined) return 'site';
  if (address.hostname.endsWith(PERSONAL_HOST)) return 'onedrive';
  const [first] = address.pathname.split('/').filter((segment) => segment.length > 0);
  return first === LOOP_SEGMENT ? 'loop' : 'site';
};

// Sites first because they are what a run is nearly always after, then Loop, then the one OneDrive.
const RANK: Readonly<Record<SourceKind, number>> = { site: 0, loop: 1, onedrive: 2 };

// Sorting is stable in JavaScript, so the order the source listed its rows in survives inside each
// group: a listing that put the sites you touched most recently first still does.
export const orderByKind = <T extends { readonly webUrl: string }>(sources: ReadonlyArray<T>): ReadonlyArray<T> =>
  [...sources].sort((left, right) => RANK[sourceKindOf(left.webUrl)] - RANK[sourceKindOf(right.webUrl)]);
