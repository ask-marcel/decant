import { safeSegment } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { EmbeddedImage } from './ports/drive-reader.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { Ocr } from './ports/ocr.ts';

// The folder a document's own pictures sit in, named after the document so the two stay together
// and sort side by side. Part paths are flattened rather than mirrored: `word/media/image1.png`
// would otherwise rebuild the OOXML tree under every document for no reader's benefit.
const MEDIA_SUFFIX = '.media';

const mediaName = (image: EmbeddedImage): string => safeSegment(image.path.split('/').join('_'));

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
  const paths: string[] = [];
  const entries: string[] = [];
  for (const [at, image] of images.entries()) {
    saying(`reading picture ${at + 1}/${images.length}`);
    const written = await deps.files.writeBytes(`${folder}/${mediaName(image)}`, image.bytes);
    if (!written.ok) return written;
    paths.push(`${folder}/${mediaName(image)}`);
    entries.push(await entryFor(deps, folder, name, image));
  }
  return ok({ paths, section: `\n\n## Images\n\n${entries.join('\n\n')}\n` });
};

const entryFor = async (deps: PlaceImagesDeps, folder: string, name: string, image: EmbeddedImage): Promise<string> => {
  const read = await deps.ocr.read(`${folder}/${mediaName(image)}`);
  const text = read.ok ? read.value.text.trim() : '';
  const caption = text.length === 0 ? '' : `\n\n${text}`;
  return `![${mediaName(image)}](./${name}${MEDIA_SUFFIX}/${mediaName(image)})${caption}`;
};
