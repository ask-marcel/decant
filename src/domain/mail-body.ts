import { inlineImageLabels, linkInlineImages, pairInlineImages, showPicture, withoutPlaceholders } from './inline-image.ts';
import { linkDestination } from './markdown-link.ts';
import type { InlineImage } from './inline-image.ts';

// What a message body says about the files it carried. The library renders that body for a caller
// holding its CLI, so it closes with a list naming each file, its raw Graph attachment id, and the
// command to fetch it. By the time a thread is written those files are converted and on disk, so
// the instruction is stale and the ids are noise: the list is cut and rewritten to link what landed.
const LIST_MARKER = '**Attachments:**';

// The library joins headers, body and list in that order, so the list is always the tail. Matching
// a whole line rather than the text anywhere keeps a message that merely mentions the words intact.
export const withoutAttachmentList = (body: string): string => {
  const lines = body.split('\n');
  const marker = lines.lastIndexOf(LIST_MARKER);
  return marker === -1 ? body : lines.slice(0, marker).join('\n').trimEnd();
};

// One file a message carried: where it landed if it was converted, or why it was left alone.
export type AttachmentLink = {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly path?: string;
  readonly note?: string;
};

const KILO = 1024;

const formatBytes = (size: number): string => {
  if (size < KILO) return `${size} B`;
  const kilobytes = size / KILO;
  return kilobytes < KILO ? `${kilobytes.toFixed(1)} KB` : `${(kilobytes / KILO).toFixed(1)} MB`;
};

// Graph reports no content type for an item attachment, and an empty one beside a size reads as a
// mistake rather than as an absence.
const detail = (entry: AttachmentLink): string => [formatBytes(entry.size), entry.contentType].filter((part) => part.length > 0).join(', ');

const line = (entry: AttachmentLink): string => {
  const named = entry.path === undefined ? entry.name : `[${entry.name}](${linkDestination(entry.path)})`;
  const note = entry.note === undefined ? '' : `, ${entry.note}`;
  return `- ${named} (${detail(entry)})${note}`;
};

export const renderAttachmentList = (entries: ReadonlyArray<AttachmentLink>): string => (entries.length === 0 ? '' : [LIST_MARKER, ...entries.map(line)].join('\n'));

// One file a message carried, as the thread knows it once the conversion has run: where its
// markdown landed, the picture itself when the file is one worth showing, or why nothing was
// written. Paths are already relative to the folder the thread sits in.
export type CarriedFile = {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly contentId: string;
  readonly isInline: boolean;
  readonly path?: string;
  readonly picture?: string;
  // What was read out of the picture, for a file shown in the body rather than linked from it. It
  // travels with the picture because nothing else in the thread would name it.
  readonly text?: string;
  readonly note?: string;
};

// Only a picture the body could show is a candidate for a placeholder: it has to be one, and it has
// to be on disk. Keyed by the object handed to the pairing, so the file comes back from the pair.
const picturesOf = (files: ReadonlyArray<CarriedFile>): Map<InlineImage, CarriedFile> =>
  new Map(files.filter((file) => file.isInline && file.picture !== undefined).map((file) => [{ name: file.name, contentId: file.contentId }, file]));

type ShownPicture = { readonly label: string; readonly path: string; readonly text?: string; readonly file: CarriedFile };

const shownPictures = (text: string, files: ReadonlyArray<CarriedFile>): ReadonlyArray<ShownPicture> => {
  const candidates = picturesOf(files);
  return pairInlineImages(inlineImageLabels(text), [...candidates.keys()]).flatMap((pair) => {
    const file = candidates.get(pair.image);
    return file?.picture === undefined ? [] : [{ label: pair.label, path: file.picture, text: file.text, file }];
  });
};

const asLink = (file: CarriedFile): AttachmentLink => ({ name: file.name, size: file.size, contentType: file.contentType, path: file.path, note: file.note });

export type RewrittenBody = { readonly body: string; readonly pictures: ReadonlyArray<string> };

// A picture put back where the message showed it is not named again below: the reader is looking at
// it. Everything else is, including a picture no placeholder answered, so nothing carried goes
// unmentioned however the pairing turned out.
// An inline picture no placeholder in the text claimed. It is still part of the message rather than
// a file the message sent: a signature logo, or a screenshot whose placeholder the conversion lost
// along with half the body. Listing it under **Attachments:** tells a reader to go and open a logo;
// showing it after the text puts it where it very likely stood.
type Unplaced = { readonly file: CarriedFile; readonly picture: string };

const unplacedPictures = (files: ReadonlyArray<CarriedFile>): ReadonlyArray<Unplaced> =>
  files.flatMap((file) => (file.isInline && file.picture !== undefined ? [{ file, picture: file.picture }] : []));

export const rewriteMessageBody = (body: string, files: ReadonlyArray<CarriedFile>): RewrittenBody => {
  const text = withoutAttachmentList(body);
  const shown = shownPictures(text, files);
  const rest = files.filter((file) => !shown.some((picture) => picture.file === file));
  const unplaced = unplacedPictures(rest);
  const listed = rest.filter((file) => !unplaced.some((pair) => pair.file === file));
  const parts = [
    withoutPlaceholders(linkInlineImages(text, shown)),
    ...unplaced.map((pair) => showPicture(pair.file.name, pair.picture, pair.file.text)),
    renderAttachmentList(listed.map(asLink)),
  ];
  return {
    body: parts.filter((part) => part.length > 0).join('\n\n'),
    pictures: [...shown.map((picture) => picture.path), ...unplaced.map((pair) => pair.picture)],
  };
};
