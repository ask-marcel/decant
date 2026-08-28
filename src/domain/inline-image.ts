// A picture pasted into a mail travels as an attachment the body points at by a `cid:`, and the
// library renders that pointer as `[inline image: <label>]` rather than as bytes, so the body stays
// the size of its text. The label is the attachment's name when the library had a list to read it
// from, and otherwise the `alt` text or the content id cut at its `@`: three shapes, one picture.

// Turndown escapes the brackets on its way out of HTML, so both forms are matched. A label holds
// neither a bracket nor a backslash, which is what ends it.
const PLACEHOLDER = /\\?\[inline image: ([^\\\]]+)\\?\]/g;

// Enough of the marker to survive either escaping, so a message with no picture costs no listing.
const MARKER = '[inline image: ';

export const carriesInlineImage = (body: string): boolean => body.includes(MARKER);

// The pattern cannot match without its label, so the slice is that label and nothing else.
export const inlineImageLabels = (body: string): ReadonlyArray<string> => [...body.matchAll(PLACEHOLDER)].flatMap((found) => found.slice(1, 2));

export type InlineImage = { readonly name: string; readonly contentId: string };

export type InlineImagePair = { readonly label: string; readonly image: InlineImage };

// The three shapes the label can take, tried in the order the library falls back through them.
const answersTo = (image: InlineImage, label: string): boolean => label === image.name || label === image.contentId || label === image.contentId.split('@')[0];

const byIdentity = (labels: ReadonlyArray<string>, images: ReadonlyArray<InlineImage>): ReadonlyArray<InlineImagePair> =>
  labels.flatMap((label) => {
    const image = images.find((candidate) => answersTo(candidate, label));
    return image === undefined ? [] : [{ label, image }];
  });

// When one placeholder and one picture are left over, they are each other: nothing else is in the
// message for either to be. Two of either way and the guess stops, because a wrong pairing shows a
// reader the wrong picture, where an unmatched placeholder only leaves the text as it already was.
export const pairInlineImages = (labels: ReadonlyArray<string>, images: ReadonlyArray<InlineImage>): ReadonlyArray<InlineImagePair> => {
  const paired = byIdentity(labels, images);
  const [label, ...restLabels] = labels.filter((candidate) => !paired.some((pair) => pair.label === candidate));
  const [image, ...restImages] = images.filter((candidate) => !paired.some((pair) => pair.image === candidate));
  const alone = label !== undefined && image !== undefined && restLabels.length === 0 && restImages.length === 0;
  return alone ? [...paired, { label, image }] : paired;
};

export type InlineImageLink = { readonly label: string; readonly path: string };

export const linkInlineImages = (body: string, links: ReadonlyArray<InlineImageLink>): string =>
  body.replace(PLACEHOLDER, (placeholder, label: string) => {
    const link = links.find((candidate) => candidate.label === label);
    return link === undefined ? placeholder : `![${label}](${link.path})`;
  });
