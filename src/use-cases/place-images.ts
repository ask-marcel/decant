import { extensionOf } from '../domain/conversion-plan.ts';
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
// Shared by both sides of the sync: a Word file attached to a mail loses its diagrams exactly the
// way one sitting in a library does, so it is the same folder, the same names, the same section.
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

const entryFor = async (deps: PlaceImagesDeps, folder: string, name: string, pictureName: string): Promise<string> => {
  const read = await deps.ocr.read(`${folder}/${pictureName}`);
  const text = read.ok ? read.value.text.trim() : '';
  const caption = text.length === 0 ? '' : `\n\n${text}`;
  const target = linkDestination(`./${name}${MEDIA_SUFFIX}/${pictureName}`);
  return `![${pictureName}](${target})${caption}`;
};
