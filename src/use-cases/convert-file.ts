import type { ConversionRoute } from '../domain/conversion-plan.ts';
import { embedsImages, planFile } from '../domain/conversion-plan.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import { renderCalendar } from '../domain/icalendar.ts';
import type { MimePart } from '../domain/mime.ts';
import { readMime } from '../domain/mime.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { NO_SLIDES_NOTE, NO_TEXT_NOTE, SCANNED_PDF_NOTE, VECTOR_NOTE, kbDocument } from '../domain/kb-document.ts';
import { safeRelPath, safeSegment } from '../domain/kb-path.ts';
import { datedRoot } from '../domain/output-paths.ts';
import type { SkipReason } from '../domain/report.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader, DriveReaderError } from './ports/drive-reader.ts';
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
};

export type ConvertFileInput = {
  readonly item: DriveItem;
  readonly driveId: string;
  readonly libraryRoot: string;
  readonly site: string;
  readonly library: string;
  readonly maxBytes: number;
};

export type ConvertOutcome =
  | { readonly kind: 'converted'; readonly outputs: ReadonlyArray<string> }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'failed'; readonly reason: string };

type Context = {
  readonly deps: ConvertFileDeps;
  readonly input: ConvertFileInput;
  readonly dir: string;
  readonly name: string;
  readonly stamp: DocumentStamp;
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

// The day the document last changed, then the folders it had in SharePoint underneath it.
const targetDir = (input: ConvertFileInput): string => {
  const day = datedRoot(input.libraryRoot, input.item.lastModified);
  const relative = safeRelPath(input.item.path.split('/').slice(0, -1));
  return relative.length === 0 ? day : `${day}/${relative}`;
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

const convertSlides = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  saying(context, 'rendering the slides');
  const rendered = await context.deps.reader.pdf(ref);
  if (!rendered.ok && rendered.error.kind === 'unrenderable' && !isLegacyDeck(context)) return slideTextAlone(context);
  if (!rendered.ok) return failure(rendered.error);
  const pdfPath = `${context.dir}/${context.name}.pdf`;
  const wrotePdf = await context.deps.files.writeBytes(pdfPath, rendered.value);
  if (!wrotePdf.ok) return failure(wrotePdf.error);
  return withSlideText(context, pdfPath);
};

const slideTextAlone = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  context.deps.logger.warn('render.refused', { itemId: context.input.item.id, path: context.input.item.path });
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
const pdfText = async (context: Context, rawPath: string, extracted: string): Promise<{ readonly body: string; readonly ocr?: string }> => {
  if (extracted.trim().length > 0) return { body: extracted };
  saying(context, 'reading the pages');
  const read = await context.deps.ocr.read(rawPath);
  return read.ok && read.value.text.trim().length > 0 ? { body: read.value.text, ocr: read.value.label } : { body: SCANNED_PDF_NOTE };
};

const convertPdf = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const raw = await context.deps.reader.bytes(ref);
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const text = await context.deps.reader.markdown(ref);
  if (!text.ok) return failure(text.error);
  const read = await pdfText(context, rawPath, text.value);
  const stamp = { ...context.stamp, pdf: `./${context.name}`, ocr: read.ocr };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, read.body);
  return written.ok ? { kind: 'converted', outputs: [rawPath, ...written.value] } : failure(written.error);
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
  const read = readMime(new TextDecoder().decode(raw.value));
  const message = `${folder}/${context.name}.md`;
  const wrote = await context.deps.files.writeText(message, kbDocument(context.stamp, read.text.trim().length === 0 ? NO_TEXT_NOTE : read.text));
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

const writeArchiveEntries = async (
  context: Context,
  folder: string,
  archivePath: string,
  entries: ReadonlyArray<{ readonly path: string; readonly text?: string; readonly note?: string }>
): Promise<ConvertOutcome> => {
  const outputs: string[] = [archivePath];
  for (const entry of entries) {
    const relative = safeRelPath(entry.path.split('/'));
    const stamp = { ...context.stamp, zipEntry: entry.path };
    const written = await context.deps.files.writeText(`${folder}/${relative}.md`, kbDocument(stamp, entry.text ?? entry.note ?? NO_TEXT_NOTE));
    if (!written.ok) return failure(written.error);
    outputs.push(`${folder}/${relative}.md`);
  }
  return { kind: 'converted', outputs };
};

const CONVERTERS: Readonly<Record<ConversionRoute, (context: Context) => Promise<ConvertOutcome>>> = {
  document: convertDocument,
  spreadsheet: convertSpreadsheet,
  message: convertMessage,
  calendar: convertCalendar,
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
    const context = { deps, input, dir: targetDir(input), name: safeSegment(input.item.name), stamp: stampFor(input, deps.clock) };
    return CONVERTERS[decision.route](context);
  };
