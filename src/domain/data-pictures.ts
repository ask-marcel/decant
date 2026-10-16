import { linkDestination } from './markdown-link.ts';

// A picture cut out of the text: the name of the file it goes to, and its bytes.
export type CutPicture = { readonly name: string; readonly bytes: Uint8Array };

// The text with a link to a file in place of each picture, and the pictures in the order the text
// first shows them.
export type CutPictures = { readonly text: string; readonly pictures: ReadonlyArray<CutPicture> };

// A picture held in the text as base64: its alt text, its type and its data. `[^[\]]` rather than an
// open class, so a run of brackets with no close fails at each one instead of rescanning.
const DATA_PICTURE = /!\[([^[\]]*)\]\(data:([^;,()\s]*);base64,([A-Za-z0-9+/=]+)\)/g;

// The subtype of a picture type, less the `x-` of a type no standard names: `image/x-emf` is `emf`,
// and `image/svg+xml` is `svg`.
const SUBTYPE = /^image\/(?:x-)?([a-z0-9]+)/i;

const MIN_DIGITS = 2;

const extensionOf = (type: string): string => {
  const subtype = SUBTYPE.exec(type)?.[1];
  return subtype === undefined ? '' : `.${subtype.toLowerCase()}`;
};

// `fromBase64` throws on data that ends out of step. A pure-domain fallback (rule 17): such a picture
// gives no file, and the text says that a picture stood there.
const decoded = (data: string): Uint8Array | undefined => {
  try {
    return Uint8Array.fromBase64(data);
  } catch {
    return undefined;
  }
};

// What the library writes in place of a picture it does not give.
const placeholder = (alt: string): string => (alt.length > 0 ? `[image: ${alt}]` : '[image]');

const pictureName = (at: number, width: number, type: string): string => `image-${String(at + 1).padStart(width, '0')}${extensionOf(type)}`;

const linkTo = (alt: string, name: string, folder: string): string => {
  const target = linkDestination(`${folder}/${name}`);
  return `![${alt.length > 0 ? alt : name}](${target})`;
};

// Each picture of a Word document, which the library gives in its place in the text as base64, goes
// to a file of its own in `folder`, numbered in the order the text first shows it, and the text links
// to that file where the picture stood. A picture the text shows twice is one file. A picture with no
// alt text takes the name of its file, so the text says which file stood there.
export const cutDataPictures = (markdown: string, folder: string): CutPictures => {
  const found = new Map<string, { readonly type: string; readonly bytes: Uint8Array }>();
  for (const [, , type = '', data = ''] of markdown.matchAll(DATA_PICTURE)) {
    const bytes = found.has(data) ? undefined : decoded(data);
    if (bytes !== undefined) found.set(data, { type, bytes });
  }
  const width = Math.max(MIN_DIGITS, String(found.size).length);
  const named = new Map([...found].map(([data, picture], at) => [data, { name: pictureName(at, width, picture.type), bytes: picture.bytes }]));
  const text = markdown.replace(DATA_PICTURE, (_whole, alt: string, _type: string, data: string) => {
    const picture = named.get(data);
    return picture === undefined ? placeholder(alt) : linkTo(alt, picture.name, folder);
  });
  return { text, pictures: [...named.values()] };
};
