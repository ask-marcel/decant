// What a source actually is, which its display name does not say: a Loop workspace and a team site
// are both SharePoint underneath, and a personal site is named after its owner's mail address, so a
// flat listing shows twenty-one rows of three different things. The address tells them apart.
// `group` is the one a caller declares rather than the address answering for it: a group inbox is
// reached through Graph's group id and has no address of its own in the listing.
export type AddressKind = 'site' | 'group' | 'loop' | 'onedrive';

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

export const addressKindOf = (webUrl: string): AddressKind => {
  const address = addressOf(webUrl);
  if (address === undefined) return 'site';
  if (address.hostname.endsWith(PERSONAL_HOST)) return 'onedrive';
  const [first] = address.pathname.split('/').filter((segment) => segment.length > 0);
  return first === LOOP_SEGMENT ? 'loop' : 'site';
};

// Sites first because they are what a run is nearly always after, then Loop, then the one OneDrive.
const RANK: Readonly<Record<AddressKind, number>> = { site: 0, group: 1, loop: 2, onedrive: 3 };

// Sorting is stable in JavaScript, so the order the source listed its rows in survives inside each
// group: a listing that put the sites you touched most recently first still does.
// A source states its kind when its address cannot answer for it, which is what a group inbox does.
export const kindOf = (source: { readonly webUrl: string; readonly kind?: AddressKind }): AddressKind => source.kind ?? addressKindOf(source.webUrl);

export const orderByKind = <T extends { readonly webUrl: string; readonly kind?: AddressKind }>(sources: ReadonlyArray<T>): ReadonlyArray<T> =>
  [...sources].sort((left, right) => RANK[kindOf(left)] - RANK[kindOf(right)]);
