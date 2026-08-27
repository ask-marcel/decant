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
