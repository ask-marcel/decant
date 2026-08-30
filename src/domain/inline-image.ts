import { linkDestination } from './markdown-link.ts';
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

// `text` is what was read out of the picture, when anything was. A signature block holds the
// sender's company and phone number, and a thread that shows the picture but hides its words makes
// a reader open a second document for them.
export type InlineImageLink = { readonly label: string; readonly path: string; readonly text?: string };

// Said in words, not in punctuation. A `>` block means quoted correspondence everywhere else in a
// mail vault, which is the most available reading here and the wrong one: an LLM meeting a
// signature under an image has no reason to conclude the words were guessed at from pixels. This
// sample got `TRATEGO` out of a logo reading STRATEGO, so the warning is not theoretical, and the
// picture is right above for anyone who needs to settle it.
const READ_BY_MACHINE = '_Text below was read out of the picture by OCR, so it can be wrong. Open the image above to check._';

// Quoted, so it reads as text lifted off a picture rather than as something the sender typed. Every
// line takes the marker, blank ones included, or markdown ends the quote at the first gap and the
// rest of a two-paragraph signature falls out of it.
const quoted = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');

// A picture as the thread shows it: the image, and under it whatever was read off it. Exported
// because a picture no placeholder claimed is shown the same way, after the text rather than in it.
export const showPicture = (label: string, path: string, read?: string): string => {
  const picture = `![${label}](${linkDestination(path)})`;
  const text = read?.trim() ?? '';
  return text.length === 0 ? picture : `${picture}\n\n${READ_BY_MACHINE}\n\n${quoted(text)}`;
};

const shown = (label: string, link: InlineImageLink): string => showPicture(label, link.path, link.text);

// The converter carries the emphasis the surrounding HTML had onto the placeholder, and a signature
// block is bold, so a picture arrives as `**\[inline image: logo.png\]**`. That cost nothing while a
// picture replaced it with a single line; the replacement is three blocks now, so the opening marker
// would strand itself on the image line and the closer land after the quote.
//
// Only when the markers wrap the placeholder and NOTHING else, which is why the pattern demands the
// same marker on both sides with the placeholder alone between them: a bold sentence that happens to
// contain a picture is somebody's emphasis, and eating its markers would unbold their words.
const WRAPPED_ALONE = /(\*\*|__|\*|_)(\\?\[inline image: [^\\\]]+\\?\])\1/g;

export const linkInlineImages = (body: string, links: ReadonlyArray<InlineImageLink>): string =>
  body.replace(WRAPPED_ALONE, '$2').replace(PLACEHOLDER, (placeholder, label: string) => {
    const link = links.find((candidate) => candidate.label === label);
    return link === undefined ? placeholder : shown(label, link);
  });
