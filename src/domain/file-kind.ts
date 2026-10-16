import { extensionOf } from './conversion-plan.ts';
import { isOpaqueName } from './opaque-name.ts';

// What a file is, when its name does not say it: the content type Graph sends with it, or the first
// bytes of a picture. A file is routed by the extension of its name, so a name with none was skipped
// as a kind nothing reads, and a picture named for another kind was read as that kind.

// The extension each kind a mail carries goes by, among the kinds decant reads. A map, since the sender
// writes the content type, and a plain object would answer `constructor` with a function.
const EXTENSION_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/zip', 'zip'],
  ['image/bmp', 'bmp'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/tiff', 'tif'],
  ['image/webp', 'webp'],
  ['message/rfc822', 'eml'],
  ['text/calendar', 'ics'],
  ['text/csv', 'csv'],
  ['text/html', 'html'],
  ['text/plain', 'txt'],
]);

// The kind alone, without the parameters after a semicolon, in lower case.
const typeOf = (contentType: string): string => {
  const end = contentType.indexOf(';');
  return (end === -1 ? contentType : contentType.slice(0, end)).trim().toLowerCase();
};

// A name with no extension takes the one its content type goes by. A name that is a machine id stays
// as it is: it names the decoration of a sharing notification, which is left out unread.
export const namedForType = (name: string, contentType: string): string => {
  if (extensionOf(name) !== undefined || isOpaqueName(name)) return name;
  const extension = EXTENSION_BY_TYPE.get(typeOf(contentType));
  return extension === undefined ? name : `${name}.${extension}`;
};

// The picture extensions, and the two that are another name for a kind.
const PICTURE_EXTENSIONS: ReadonlySet<string> = new Set(['bmp', 'gif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp']);
const ALIASES: Readonly<Partial<Record<string, string>>> = { jpeg: 'jpg', tiff: 'tif' };

const pictureKindOfName = (name: string): string | undefined => {
  const extension = extensionOf(name);
  if (extension === undefined || !PICTURE_EXTENSIONS.has(extension)) return undefined;
  return ALIASES[extension] ?? extension;
};

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, from = 0): boolean => signature.every((value, at) => bytes[from + at] === value);

const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

// The signatures the picture formats open with. WebP opens a RIFF container and names itself four
// bytes further on.
const SIGNATURES: ReadonlyArray<readonly [string, (bytes: Uint8Array) => boolean]> = [
  ['png', (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])],
  ['jpg', (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ['gif', (bytes) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38])],
  ['bmp', (bytes) => startsWith(bytes, [0x42, 0x4d])],
  ['tif', (bytes) => startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])],
  ['webp', (bytes) => startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)],
];

const pictureKindOf = (bytes: Uint8Array): string | undefined => SIGNATURES.find(([, opens]) => opens(bytes))?.[0];

// A picture whose first bytes say another kind than its name, a GIF sent as `.png`, takes the
// extension of what it is. Only a name that says picture is read this way: the bytes of a document
// are its converter's business.
export const namedForBytes = (name: string, bytes: Uint8Array): string => {
  const said = pictureKindOfName(name);
  const found = said === undefined ? undefined : pictureKindOf(bytes);
  if (found === undefined || found === said) return name;
  return `${name.slice(0, name.lastIndexOf('.'))}.${found}`;
};
