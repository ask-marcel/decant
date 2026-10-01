import { siteIdHash } from './site-state.ts';

// The filesystem sink checkpoint: SharePoint and Outlook name their items freely, so every name
// crosses this module before it reaches a path. Sanitizing always succeeds, which is why the
// factories are total: a name we cannot keep becomes one we can, never an error mid-sync.
export type SafeSegment = string & { readonly __brand: 'SafeSegment' };
export type SafeRelPath = string & { readonly __brand: 'SafeRelPath' };

const MAX_SEGMENT_LENGTH = 180;
const SUFFIX_LENGTH = 8;
const FIRST_PRINTABLE = 0x20;
// Reserved by Windows/SharePoint or by the path grammar itself; the C0 control range goes too.
const FORBIDDEN = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);
// A name ending in a dot or a space is stored under a different name by some filesystems.
const TRAILING = new Set(['.', ' ']);

const isForbidden = (char: string): boolean => FORBIDDEN.has(char) || (char.codePointAt(0) ?? FIRST_PRINTABLE) < FIRST_PRINTABLE;

const replaceForbidden = (raw: string): string => [...raw].map((char) => (isForbidden(char) ? '_' : char)).join('');

const stripTrailing = (value: string): string => {
  let end = value.length;
  while (end > 0 && TRAILING.has(value[end - 1] ?? '')) end -= 1;
  return value.slice(0, end);
};

export const safeSegment = (raw: string): SafeSegment => {
  const replaced = replaceForbidden(raw.normalize('NFC'));
  const trimmed = stripTrailing(replaced).slice(0, MAX_SEGMENT_LENGTH);
  return (trimmed.length === 0 ? '_' : trimmed) as SafeSegment;
};

export const safeRelPath = (segments: ReadonlyArray<string>): SafeRelPath =>
  segments
    .filter((segment) => segment.length > 0)
    .map(safeSegment)
    .join('/') as SafeRelPath;

// A leading dot names a hidden file, it does not open an extension, so `.sync-state.json`
// splits at the second dot and keeps `.json`.
const extensionStart = (segment: string): number => {
  const lastDot = segment.lastIndexOf('.');
  return lastDot <= 0 ? segment.length : lastDot;
};

// The suffix is what tells two documents of the same name apart, so the length limit is spent on
// the name and never on the suffix or the extension: trimming the tail of a long name would drop
// both and land two different files on one path, silently overwriting one with the other.
export const disambiguateSegment = (segment: string, itemId: string): SafeSegment => {
  const cut = extensionStart(segment);
  const suffix = `-${itemId.slice(0, SUFFIX_LENGTH)}`;
  const extension = segment.slice(cut);
  const room = Math.max(0, MAX_SEGMENT_LENGTH - suffix.length - extension.length);
  return safeSegment(`${segment.slice(0, Math.min(cut, room))}${suffix}${extension}`);
};

// A namesake's suffix is cut from a hash of its id, never from the id itself: ids often open alike
// (every item in one mailbox shares a long run, and a Teams post id is the millisecond it was sent),
// so a slice of the id can hand every namesake the same suffix. A suffixed name something else holds
// too moves on to the hash of the hash. Cut from the item's own id, the suffix stays put when a
// namesake comes or goes.
const freeSuffixed = (segment: string, hash: string, isTaken: (candidate: string) => boolean): string => {
  const candidate = disambiguateSegment(segment, hash);
  return isTaken(candidate) ? freeSuffixed(segment, siteIdHash(hash), isTaken) : candidate;
};

// The name an item takes among others: its own while nothing else holds it, a suffixed one when
// something does.
export const freeSegment = (segment: string, itemId: string, isTaken: (candidate: string) => boolean): string =>
  isTaken(segment) ? freeSuffixed(segment, siteIdHash(itemId), isTaken) : segment;

// The same for a file in a folder, where what is taken is held as whole paths. The item's own file,
// when it already has one, never stands in its way.
export const freePath = (folder: string, segment: string, itemId: string, taken: ReadonlySet<string>, own?: string): string => {
  const within = (name: string): string => `${folder}/${name}`;
  const held = (path: string): boolean => path !== own && taken.has(path);
  return within(freeSegment(segment, itemId, (candidate) => held(within(candidate))));
};
