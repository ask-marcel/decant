import { extensionOf, planFile } from '../domain/conversion-plan.ts';
import { cutDataPictures } from '../domain/data-pictures.ts';
import { safeSegment } from '../domain/kb-path.ts';
import { linkDestination } from '../domain/markdown-link.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { EmbeddedImage } from './ports/drive-reader.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { Ocr } from './ports/ocr.ts';

// The folder a document's own pictures sit in, named after the document so the two stay together
// and sort side by side.
const MEDIA_SUFFIX = '.media';

const MIN_DIGITS = 2;

// Each picture is numbered in the order the source gave it, wide enough to sort as a number, with the
// extension its part had. The part's own name says no more than the number does, and it can be a
// 40-character hash: copied into the name, one made a path longer than Windows accepts.
const mediaNames = (images: ReadonlyArray<EmbeddedImage>): ReadonlyArray<string> => {
  const width = Math.max(MIN_DIGITS, String(images.length).length);
  return images.map((image, at) => {
    const extension = extensionOf(image.path.split('/').at(-1) ?? '');
    const suffix = extension === undefined ? '' : `.${extension}`;
    return safeSegment(`image-${String(at + 1).padStart(width, '0')}${suffix}`);
  });
};

export type PlaceImagesDeps = { readonly files: Files; readonly ocr: Ocr };

export type PlacedImages = { readonly paths: ReadonlyArray<string>; readonly section: string };

// A picture is written first and read second, because the reader works on a file already on disk.
// Text that comes back empty (or OCR being off entirely) leaves the entry as a bare link: the
// picture is still there to open, and the markdown does not pretend to know what it shows.
// Shared by a workbook in a library, a document attached to a mail and the pages of a scanned PDF, which
// all get the pictures apart from the text: the same folder, the same names, the same section. A Word
// document in a library gets them in its text instead, and `placeDataPictures` below puts them in the
// same folder.
// Reading a picture is slow enough to look like a stall, so the caller is told which one is being
// read. A caller with nowhere to say it passes nothing.
export type SayWhat = (what: string) => void;

export const placeImages = async (
  deps: PlaceImagesDeps,
  directory: string,
  name: string,
  images: ReadonlyArray<EmbeddedImage>,
  saying: SayWhat = () => undefined
): Promise<Result<PlacedImages, FilesError>> => {
  const folder = `${directory}/${name}${MEDIA_SUFFIX}`;
  const names = mediaNames(images);
  const paths: string[] = [];
  const entries: string[] = [];
  for (const [at, image] of images.entries()) {
    saying(`reading picture ${at + 1}/${images.length}`);
    const pictureName = names[at] ?? '';
    const written = await deps.files.writeBytes(`${folder}/${pictureName}`, image.bytes);
    if (!written.ok) return written;
    paths.push(`${folder}/${pictureName}`);
    entries.push(await entryFor(deps, folder, name, pictureName));
  }
  return ok({ paths, section: `\n\n## Images\n\n${entries.join('\n\n')}\n` });
};

// The words OCR reads in a picture on disk, or nothing when it reads none or cannot read it.
const textOf = async (deps: PlaceImagesDeps, path: string): Promise<string> => {
  const read = await deps.ocr.read(path);
  return read.ok ? read.value.text.trim() : '';
};

const entryFor = async (deps: PlaceImagesDeps, folder: string, name: string, pictureName: string): Promise<string> => {
  const text = await textOf(deps, `${folder}/${pictureName}`);
  const caption = text.length === 0 ? '' : `\n\n${text}`;
  const target = linkDestination(`./${name}${MEDIA_SUFFIX}/${pictureName}`);
  return `![${pictureName}](${target})${caption}`;
};

export type PlacedPictures = { readonly body: string; readonly paths: ReadonlyArray<string> };

// OCR reads a photo, as it reads one in a library, and not a drawing: Word keeps a pasted drawing as EMF
// or WMF, which OCR cannot load off Windows, and each try starts the reader again.
const readable = (name: string): boolean => {
  const decision = planFile({ name, size: 0 }, Number.POSITIVE_INFINITY);
  return decision.kind === 'process' && decision.route === 'image';
};

// One entry of the end section: a link to the picture, then the words OCR read in it.
const textEntry = (name: string, pictureName: string, text: string): string => {
  const target = linkDestination(`./${name}${MEDIA_SUFFIX}/${pictureName}`);
  return `[${pictureName}](${target})\n\n${text}`;
};

// A Word document's pictures, which the library gives in their place in its text, go to the same
// folder as the pictures taken out apart, and the text links to each one where it stood. What OCR
// reads in them goes under one heading at the end, because a caption in the text breaks a table or a
// list. A picture OCR reads nothing in has no entry there: the text already links it.
export const placeDataPictures = async (deps: PlaceImagesDeps, directory: string, name: string, markdown: string, saying: SayWhat): Promise<Result<PlacedPictures, FilesError>> => {
  const cut = cutDataPictures(markdown, `./${name}${MEDIA_SUFFIX}`);
  const folder = `${directory}/${name}${MEDIA_SUFFIX}`;
  const paths: string[] = [];
  const entries: string[] = [];
  for (const [at, picture] of cut.pictures.entries()) {
    saying(`reading picture ${at + 1}/${cut.pictures.length}`);
    const path = `${folder}/${picture.name}`;
    const written = await deps.files.writeBytes(path, picture.bytes);
    if (!written.ok) return written;
    paths.push(path);
    const text = readable(picture.name) ? await textOf(deps, path) : '';
    if (text.length > 0) entries.push(textEntry(name, picture.name, text));
  }
  const section = entries.length === 0 ? '' : `\n\n## Text in the pictures\n\n${entries.join('\n\n')}\n`;
  return ok({ body: `${cut.text}${section}`, paths });
};
