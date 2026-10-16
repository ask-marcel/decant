import type { ConversionRoute } from '../domain/conversion-plan.ts';
import { embedsImages, planFile } from '../domain/conversion-plan.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import { renderCalendar } from '../domain/icalendar.ts';
import { shortcutLink } from '../domain/internet-shortcut.ts';
import type { MimePart } from '../domain/mime.ts';
import { readMime } from '../domain/mime.ts';
import { byteString } from '../domain/mime-text.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { NO_SLIDES_NOTE, NO_TEXT_NOTE, SCANNED_PDF_NOTE, VECTOR_NOTE, kbDocument } from '../domain/kb-document.ts';
import { fitSegment, safeRelPath, safeSegment } from '../domain/kb-path.ts';
import type { SkipReason } from '../domain/report.ts';
import { cutArchiveReason } from '../domain/report.ts';
import { linkMembers, placeMembers } from '../domain/archive-members.ts';
import { unwrapSafelinks } from '../domain/safelink.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { Clock } from './ports/clock.ts';
import type { ArchiveEntries, DriveReader, DriveReaderError, ItemRef } from './ports/drive-reader.ts';
import type { Files, FilesError } from './ports/files.ts';
import { placeImages } from './place-images.ts';
import type { Logger } from './ports/logger.ts';
import type { Progress } from './ports/progress.ts';
import type { Ocr } from './ports/ocr.ts';

export type ConvertFileDeps = {
  readonly reader: DriveReader;
  readonly files: Files;
  readonly ocr: Ocr;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Progress;
  // How long a path may be as decant writes it. Absent, names are not cut for length.
  readonly pathBudget?: number;
};

// Where the file goes, one way or the other. A sweep files a library under the day each document
// last changed and the folders it had at the source, which is what `libraryRoot` is the root of. A
// thread pulling one document names the folder outright: it sits beside the card standing for it,
// and a library tree rebuilt inside a thread folder would bury it four levels down. Written as a
// choice rather than an override so neither caller has to pass a root the other one ignores.
type Placement =
  | { readonly libraryRoot: string; readonly into?: undefined; readonly asName?: undefined }
  // `asName` is given when two documents one thread linked share a name, so both are kept.
  | { readonly libraryRoot?: undefined; readonly into: string; readonly asName?: string };

export type ConvertFileInput = {
  readonly item: DriveItem;
  readonly driveId: string;
  readonly site: string;
  readonly library: string;
  readonly maxBytes: number;
} & Placement;

// `lost` names what a conversion had to go without, a part of the document that would not read: the
// document landed without it. A library sync tries such a document again for the rest; a mail thread
// keeps what landed.
export type ConvertOutcome =
  // `lost` names a part the conversion went without, to try again for; `leftOut` what it left in an
  // archive the library read in part, which no run reads more of.
  | { readonly kind: 'converted'; readonly outputs: ReadonlyArray<string>; readonly lost?: string; readonly leftOut?: string }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'failed'; readonly reason: string };

type Context = {
  readonly deps: ConvertFileDeps;
  readonly input: ConvertFileInput;
  readonly dir: string;
  readonly name: string;
  readonly stamp: DocumentStamp;
  // Each part the conversion had to go without, said once in the outcome.
  readonly lost: string[];
};

// Reported under the item's path, which is the label the counter names it by: a step drawn against
// any other name would be worse than none, so the bar decides whether this one is the row's.
const saying = (context: Context, what: string): void => {
  context.deps.progress.detail(context.input.item.path, what);
};

// A file that needs a password is not a failed read to try again: the bytes arrived and cannot be
// turned into text by anyone without it, so it is left out the way an unsupported type is.
const failure = (error: DriveReaderError | FilesError): ConvertOutcome =>
  error.kind === 'protected' ? { kind: 'skipped', reason: 'protected' } : { kind: 'failed', reason: `${error.kind}: ${error.message}` };

// The folders the document has in SharePoint, under the library. No day folder: a path that changed
// with every edit broke every link into the knowledge base and every copy of it, and the day a
// document last changed is in its front matter.
const targetDir = (input: ConvertFileInput): string => {
  if (input.libraryRoot === undefined) return input.into;
  const relative = safeRelPath(input.item.path.split('/').slice(0, -1));
  return relative.length === 0 ? input.libraryRoot : `${input.libraryRoot}/${relative}`;
};

const stampFor = (input: ConvertFileInput, clock: Clock): DocumentStamp => ({
  source: input.item.webUrl,
  site: input.site,
  library: input.library,
  path: input.item.path,
  lastModified: input.item.lastModified,
  modifiedBy: input.item.modifiedBy,
  syncedAt: clock.nowIso(),
});

// Every kind that produces markdown comes through here, so this is where a document's pictures are
// taken as well. A picture read that fails costs the pictures and not the text: the document is the
// point, and the placeholders left in its body already say something stood there.
const withImages = async (context: Context, body: string): Promise<Result<{ readonly body: string; readonly paths: ReadonlyArray<string> }, FilesError>> => {
  if (!embedsImages(context.name)) return ok({ body, paths: [] });
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  saying(context, 'taking out the pictures');
  const found = await context.deps.reader.images(ref);
  if (!found.ok) {
    context.deps.logger.warn('images.failed', { itemId: context.input.item.id, path: context.input.item.path, cause: found.error.kind });
    context.lost.push(`the pictures could not be read: ${found.error.kind}: ${found.error.message}`);
    return ok({ body, paths: [] });
  }
  if (found.value.length === 0) return ok({ body, paths: [] });
  const placed = await placeImages(context.deps, context.dir, context.name, found.value, (what) => saying(context, what));
  return placed.ok ? ok({ body: `${body}${placed.value.section}`, paths: placed.value.paths }) : placed;
};

const writeMarkdown = async (context: Context, fileName: string, stamp: DocumentStamp, body: string): Promise<Result<ReadonlyArray<string>, FilesError>> => {
  const path = `${context.dir}/${fileName}`;
  const withPictures = await withImages(context, body);
  if (!withPictures.ok) return withPictures;
  const written = await context.deps.files.writeText(path, kbDocument(stamp, withPictures.value.body));
  return written.ok ? ok([path, ...withPictures.value.paths]) : written;
};

const convertDocument = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  saying(context, 'reading the text');
  const converted = await context.deps.reader.markdown(ref);
  if (!converted.ok) return failure(converted.error);
  const body = converted.value.trim().length === 0 ? NO_TEXT_NOTE : converted.value;
  const written = await writeMarkdown(context, `${context.name}.md`, context.stamp, body);
  return written.ok ? { kind: 'converted', outputs: written.value } : failure(written.error);
};

// A deck the source will not render is not a deck we cannot read: the text comes from elsewhere and
// arrives intact, so it is written on its own rather than the whole document being given up on. Only
// the old formats truly need the render, since their text is read back out of it.
// The same as the mail side: read for the cell text, kept for everything the reading cannot hold.
const convertSpreadsheet = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const converted = await context.deps.reader.markdown(ref);
  if (!converted.ok) return failure(converted.error);
  const raw = await context.deps.reader.bytes(ref);
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const stamp = { ...context.stamp, original: `./${context.name}` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, converted.value.trim().length === 0 ? NO_TEXT_NOTE : converted.value);
  return written.ok ? { kind: 'converted', outputs: [rawPath, ...written.value] } : failure(written.error);
};

// The same reading a mail attachment gets: the library passes an `.ics` through as text, and what a
// reader wants out of it is a handful of fields rather than the file around them.
const convertCalendar = async (context: Context): Promise<ConvertOutcome> => {
  const passed = await context.deps.reader.markdown({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!passed.ok) return failure(passed.error);
  const read = renderCalendar(passed.value);
  const written = await writeMarkdown(context, `${context.name}.md`, context.stamp, read.length === 0 ? NO_TEXT_NOTE : read);
  return written.ok ? { kind: 'converted', outputs: written.value } : failure(written.error);
};

// A shortcut holds nothing but where it goes, so that address, as a link, is the whole document.
const convertShortcut = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const body = shortcutLink(context.name, new TextDecoder().decode(raw.value)) ?? NO_TEXT_NOTE;
  const written = await writeMarkdown(context, `${context.name}.md`, context.stamp, body);
  return written.ok ? { kind: 'converted', outputs: written.value } : failure(written.error);
};

const convertSlides = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  saying(context, 'rendering the slides');
  const rendered = await context.deps.reader.pdf(ref);
  if (!rendered.ok && rendered.error.kind === 'unrenderable' && !isLegacyDeck(context)) return slideTextAlone(context, rendered.error);
  if (!rendered.ok) return failure(rendered.error);
  const pdfPath = `${context.dir}/${context.name}.pdf`;
  const wrotePdf = await context.deps.files.writeBytes(pdfPath, rendered.value);
  if (!wrotePdf.ok) return failure(wrotePdf.error);
  return withSlideText(context, pdfPath);
};

const slideTextAlone = async (context: Context, refused: DriveReaderError): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  context.deps.logger.warn('render.refused', { itemId: context.input.item.id, path: context.input.item.path });
  context.lost.push(`the slides could not be rendered: ${refused.kind}: ${refused.message}`);
  const text = await context.deps.reader.markdown(ref);
  if (!text.ok) return failure(text.error);
  const written = await writeMarkdown(context, `${context.name}.md`, context.stamp, `${NO_SLIDES_NOTE}\n\n${text.value}`.trim());
  return written.ok ? { kind: 'converted', outputs: [...written.value] } : failure(written.error);
};

// A `.ppt` or an `.rtf` has no reader of its own here: its text is read back out of the PDF that was
// rendered from it, which is why a refused render costs those two the text as well.
const isLegacyDeck = (context: Context): boolean => /\.(ppt|rtf)$/i.test(context.input.item.name);

const withSlideText = async (context: Context, pdfPath: string): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const text = isLegacyDeck(context) ? await context.deps.reader.localMarkdown(pdfPath) : await context.deps.reader.markdown(ref);
  if (!text.ok) return failure(text.error);
  const stamp = { ...context.stamp, pdf: `./${context.name}.pdf` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, text.value.trim().length === 0 ? NO_TEXT_NOTE : text.value);
  return written.ok ? { kind: 'converted', outputs: [pdfPath, ...written.value] } : failure(written.error);
};

// A PDF with a text layer yields it straight. One without (a scan) is read by OCR from the copy on
// disk, and only when OCR finds nothing does the note stand in for the text.
// A scanned PDF holds pictures of its pages and no text at all, and OCR reads pictures rather than
// PDFs: handing it the file itself only ever produced the note. So the pages are asked for and read
// one by one, the same call and the same folder a document's diagrams already go through. The note
// stays above them either way, because a reading of a scan is a reading and the file is the original.
const pdfText = async (context: Context, ref: ItemRef, extracted: string): Promise<Result<{ readonly body: string; readonly paths: ReadonlyArray<string> }, FilesError>> => {
  if (extracted.trim().length > 0) return ok({ body: extracted, paths: [] });
  saying(context, 'reading the pages');
  const pages = await context.deps.reader.images(ref);
  if (!pages.ok) context.lost.push(`the pages could not be read: ${pages.error.kind}: ${pages.error.message}`);
  if (!pages.ok || pages.value.length === 0) return ok({ body: SCANNED_PDF_NOTE, paths: [] });
  const placed = await placeImages(context.deps, context.dir, context.name, pages.value, (what) => saying(context, what));
  return placed.ok ? ok({ body: `${SCANNED_PDF_NOTE}${placed.value.section}`, paths: placed.value.paths }) : placed;
};

const convertPdf = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const raw = await context.deps.reader.bytes(ref);
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  // A scanned PDF is refused rather than answered with an empty body, and that refusal names the one
  // case OCR is here for. The file is already on disk, so read its pages instead of giving up on it.
  const text = await context.deps.reader.markdown(ref);
  if (!text.ok && text.error.kind !== 'unrenderable') return failure(text.error);
  const read = await pdfText(context, ref, text.ok ? text.value : '');
  if (!read.ok) return failure(read.error);
  const stamp = { ...context.stamp, pdf: `./${context.name}` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, read.value.body);
  return written.ok ? { kind: 'converted', outputs: [rawPath, ...read.value.paths, ...written.value] } : failure(written.error);
};

const convertImage = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const read = await context.deps.ocr.read(rawPath);
  const body = read.ok && read.value.text.trim().length > 0 ? read.value.text : NO_TEXT_NOTE;
  const stamp = { ...context.stamp, image: `./${context.name}`, ocr: read.ok ? read.value.label : undefined };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, body);
  return written.ok ? { kind: 'converted', outputs: [rawPath, ...written.value] } : failure(written.error);
};

const convertVector = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const stamp = { ...context.stamp, image: `./${context.name}` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, VECTOR_NOTE);
  return written.ok ? { kind: 'converted', outputs: [rawPath, ...written.value] } : failure(written.error);
};

// The same unpacking the mail side does for a saved email: the message read out of the raw MIME, and
// every file it carried written as a file rather than left as base64 in the middle of the text.
const writeParts = async (context: Context, folder: string, parts: ReadonlyArray<MimePart>): Promise<Result<ReadonlyArray<string>, FilesError>> => {
  const written: string[] = [];
  for (const part of parts) {
    const name = safeSegment(part.name);
    const wrote = await context.deps.files.writeBytes(`${folder}/${name}`, part.bytes);
    if (!wrote.ok) return wrote;
    written.push(`${folder}/${name}`);
    const text = await context.deps.reader.localMarkdown(`${folder}/${name}`);
    if (!text.ok) continue;
    const wroteText = await context.deps.files.writeText(`${folder}/${name}.md`, kbDocument({ ...context.stamp, original: `./${name}` }, text.value));
    if (!wroteText.ok) return wroteText;
    written.push(`${folder}/${name}.md`);
  }
  return ok(written);
};

const convertMessage = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const folder = `${context.dir}/${safeSegment(context.name.slice(0, context.name.lastIndexOf('.')))}`;
  const read = readMime(byteString(raw.value));
  const message = `${folder}/${context.name}.md`;
  // Outlook's wrapper comes off each link, as it does for the same email attached to a mail.
  const text = unwrapSafelinks(read.text);
  const wrote = await context.deps.files.writeText(message, kbDocument(context.stamp, text.trim().length === 0 ? NO_TEXT_NOTE : text));
  if (!wrote.ok) return failure(wrote.error);
  const carried = await writeParts(context, folder, read.parts);
  return carried.ok ? { kind: 'converted', outputs: [message, ...carried.value] } : failure(carried.error);
};

const convertArchive = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const folder = `${context.dir}/${safeSegment(context.name.slice(0, context.name.lastIndexOf('.')))}`;
  const archivePath = `${folder}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(archivePath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const entries = await context.deps.reader.localArchive(archivePath);
  if (!entries.ok) return failure(entries.error);
  return writeArchiveEntries(context, folder, archivePath, entries.value);
};

const leftOutOf = (entries: ArchiveEntries): { readonly leftOut?: string } =>
  entries.totalEntries === undefined ? {} : { leftOut: cutArchiveReason(entries.length, entries.totalEntries) };

const writeArchiveEntries = async (context: Context, folder: string, archivePath: string, entries: ArchiveEntries): Promise<ConvertOutcome> => {
  const outputs: string[] = [archivePath];
  const placed = placeMembers(folder, entries, context.deps.pathBudget);
  const files = new Map(placed.map((member) => [member.entry.path, member.file]));
  for (const { entry, file } of placed) {
    const stamp = { ...context.stamp, zipEntry: entry.path };
    // A page someone saved out of Outlook and zipped keeps each link Outlook wrapped, and the wrapper
    // comes off as it does in mail. A link to another member leads to the file written for it.
    const written = await context.deps.files.writeText(file, kbDocument(stamp, linkMembers(unwrapSafelinks(entry.text ?? entry.note ?? NO_TEXT_NOTE), entry.path, files)));
    if (!written.ok) return failure(written.error);
    outputs.push(file);
  }
  return { kind: 'converted', outputs, ...leftOutOf(entries) };
};

const CONVERTERS: Readonly<Record<ConversionRoute, (context: Context) => Promise<ConvertOutcome>>> = {
  document: convertDocument,
  spreadsheet: convertSpreadsheet,
  message: convertMessage,
  calendar: convertCalendar,
  shortcut: convertShortcut,
  slides: convertSlides,
  'legacy-slides': convertSlides,
  pdf: convertPdf,
  image: convertImage,
  vector: convertVector,
  archive: convertArchive,
};

export type ConvertFile = (input: ConvertFileInput) => Promise<ConvertOutcome>;

export const createConvertFile =
  (deps: ConvertFileDeps): ConvertFile =>
  async (input) => {
    const decision = planFile({ name: input.item.name, size: input.item.size }, input.maxBytes);
    if (decision.kind === 'skip') return { kind: 'skipped', reason: decision.reason };
    const dir = targetDir(input);
    const lost: string[] = [];
    const context = { deps, input, dir, name: fitSegment(dir, safeSegment(input.asName ?? input.item.name), deps.pathBudget), stamp: stampFor(input, deps.clock), lost };
    const outcome = await CONVERTERS[decision.route](context);
    return outcome.kind === 'converted' && lost.length > 0 ? { ...outcome, lost: lost.join('; ') } : outcome;
  };
