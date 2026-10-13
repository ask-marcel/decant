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

// An extension is kept whole when a long name is cut: a few letters or digits after the last dot. A
// title such as `deck v1.2 for Mark` has a dot that opens no extension, and is cut like any text.
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

const HIGH_SURROGATE_FIRST = 0xd8_00;
const HIGH_SURROGATE_LAST = 0xdb_ff;

// Counted in UTF-16 units, the way Windows counts a path, and never between the two halves of one
// character: half an emoji is not a character any filesystem should be asked to store.
const cutAt = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? limit - 1 : limit);
};

// Cut back to the last separator inside the limit, so a name ends on a word. A single word longer
// than the whole limit has no separator to fall back to and is cut where it must be: a path that is
// too long is worse than a word that is.
export const cutToWord = (text: string, limit: number, separator: string): string => {
  if (text.length <= limit) return text;
  const head = cutAt(text, limit);
  const lastSeparator = head.lastIndexOf(separator);
  return lastSeparator < 0 ? head : head.slice(0, lastSeparator);
};

const cutKeepingExtension = (name: string): string => {
  if (name.length <= MAX_SEGMENT_LENGTH) return name;
  const extension = EXTENSION.exec(name)?.[0] ?? '';
  return `${cutAt(name.slice(0, name.length - extension.length), MAX_SEGMENT_LENGTH - extension.length)}${extension}`;
};

// Windows keeps these names for devices, with an extension or without one, so `CON` or `nul.txt`
// cannot be written there.
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i;

// Git reads these as its own when the knowledge base is kept in git: it skips a `.git` folder and
// obeys a `.gitignore`. An attachment or a zip entry can carry one.
const GIT_OWN = /^\.git(ignore|attributes|modules)?$/i;

const unclaimed = (name: string): string => (GIT_OWN.test(name) ? `_${name}` : name.replace(DEVICE, '$1_'));

// The cut comes before the trailing dots and spaces are dropped: the other way round, a cut that
// fell just after a space kept it, and the `.md` a caller adds followed the space.
export const safeSegment = (raw: string): SafeSegment => {
  const replaced = replaceForbidden(raw.normalize('NFC'));
  const trimmed = stripTrailing(cutKeepingExtension(replaced));
  return unclaimed(trimmed.length === 0 ? '_' : trimmed) as SafeSegment;
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
export const disambiguateSegment = (segment: string, itemId: string, limit = MAX_SEGMENT_LENGTH): SafeSegment => {
  const cut = extensionStart(segment);
  const suffix = `-${itemId.slice(0, SUFFIX_LENGTH)}`;
  const extension = segment.slice(cut);
  const room = Math.max(0, limit - suffix.length - extension.length);
  return safeSegment(`${cutAt(segment.slice(0, cut), room)}${suffix}${extension}`);
};

// SHA-256 of an id, hex-encoded. Every suffix cut from an id is cut from this instead, since ids open
// alike: a namesake's (below), and the folder of a site or notebook sharing another's name.
export const idHash = (id: string): string => new Bun.CryptoHasher('sha256').update(id).digest('hex');

// Windows refuses a longer path, counted from the drive letter, unless long paths are turned on for
// the whole machine. The export the audit read lost one document to a picture path of 260.
export const WINDOWS_PATH_LIMIT = 259;

// What decant can still add below a name it plans: `.md` (3), a picture under `<name>.media/` (20),
// the `_archive/<day>/` an old copy moves under (20), a namesake's suffix (9), and 3 to spare.
const ROOM_FOR_LATER = 55;

// A name cut until its path fits, its extension kept and 8 characters of a hash of the whole name
// added, so two names cut alike stay apart. The budget counts the path as decant writes it: what
// stands in front of the knowledge base on disk is taken off it already. With no budget, nothing
// is cut, which is how a caller that was never told one keeps working as it did.
export const fitSegment = (folder: string, segment: string, budget: number | undefined): string => {
  if (budget === undefined) return segment;
  const over = folder.length + 1 + segment.length + ROOM_FOR_LATER - budget;
  return over <= 0 ? segment : disambiguateSegment(segment, idHash(segment), segment.length - over);
};

// A namesake's suffix is cut from a hash of its id, never from the id itself: ids often open alike
// (every item in one mailbox shares a long run, and a Teams post id is the millisecond it was sent),
// so a slice of the id can hand every namesake the same suffix. A suffixed name something else holds
// too moves on to the hash of the hash. Cut from the item's own id, the suffix stays put when a
// namesake comes or goes.
const freeSuffixed = (segment: string, hash: string, isTaken: (candidate: string) => boolean): string => {
  const candidate = disambiguateSegment(segment, hash);
  return isTaken(candidate) ? freeSuffixed(segment, idHash(hash), isTaken) : candidate;
};

// The name an item takes among others: its own while nothing else holds it, a suffixed one when
// something does.
export const freeSegment = (segment: string, itemId: string, isTaken: (candidate: string) => boolean): string =>
  isTaken(segment) ? freeSuffixed(segment, idHash(itemId), isTaken) : segment;

// Windows and macOS take `Report.md` and `report.md` for one file, so a name is held when a held
// name matches it in either case: the second write would otherwise replace the first without a word.
const sameIgnoringCase = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export const holdsIgnoringCase = (taken: Iterable<string>, name: string): boolean => {
  for (const held of taken) if (sameIgnoringCase(held, name)) return true;
  return false;
};

// The same for a file in a folder, where what is taken is held as whole paths. The item's own file,
// when it already has one, never stands in its way. When only the letter case of its name changed,
// the file is kept as it is: renamed, the old path would be put aside next, and on a disk that
// ignores case that path is the fresh note.
// A budget, when one is given, fits the name to it before anything else is decided.
export const freePath = (folder: string, segment: string, itemId: string, taken: ReadonlySet<string>, own?: string, budget?: number): string => {
  const within = (name: string): string => `${folder}/${name}`;
  const fitted = fitSegment(folder, segment, budget);
  if (own !== undefined && sameIgnoringCase(within(fitted), own)) return own;
  const held = (path: string): boolean => path !== own && holdsIgnoringCase(taken, path);
  return within(freeSegment(fitted, itemId, (candidate) => held(within(candidate))));
};
