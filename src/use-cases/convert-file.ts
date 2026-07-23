import type { ConversionRoute } from '../domain/conversion-plan.ts';
import { planFile } from '../domain/conversion-plan.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { NO_TEXT_NOTE, SCANNED_PDF_NOTE, VECTOR_NOTE, kbDocument } from '../domain/kb-document.ts';
import { safeRelPath, safeSegment } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader, DriveReaderError } from './ports/drive-reader.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { Ocr } from './ports/ocr.ts';

export type ConvertFileDeps = {
  readonly reader: DriveReader;
  readonly files: Files;
  readonly ocr: Ocr;
  readonly clock: Clock;
};

export type ConvertFileInput = {
  readonly item: DriveItem;
  readonly driveId: string;
  readonly libraryRoot: string;
  readonly site: string;
  readonly library: string;
  readonly maxBytes: number;
  readonly ocrLabel: string;
};

export type ConvertOutcome =
  | { readonly kind: 'converted'; readonly outputs: ReadonlyArray<string> }
  | { readonly kind: 'skipped'; readonly reason: 'unsupported-type' | 'too-large' }
  | { readonly kind: 'failed'; readonly reason: string };

type Context = {
  readonly deps: ConvertFileDeps;
  readonly input: ConvertFileInput;
  readonly dir: string;
  readonly name: string;
  readonly stamp: DocumentStamp;
};

const failure = (error: DriveReaderError | FilesError): ConvertOutcome => ({ kind: 'failed', reason: `${error.kind}: ${error.message}` });

const targetDir = (input: ConvertFileInput): string => {
  const folders = input.item.path.split('/').slice(0, -1);
  const relative = safeRelPath(folders);
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

const writeMarkdown = async (context: Context, fileName: string, stamp: DocumentStamp, body: string): Promise<Result<string, FilesError>> => {
  const path = `${context.dir}/${fileName}`;
  const written = await context.deps.files.writeText(path, kbDocument(stamp, body));
  return written.ok ? ok(path) : written;
};

const convertDocument = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const converted = await context.deps.reader.markdown(ref);
  if (!converted.ok) return failure(converted.error);
  const body = converted.value.trim().length === 0 ? NO_TEXT_NOTE : converted.value;
  const written = await writeMarkdown(context, `${context.name}.md`, context.stamp, body);
  return written.ok ? { kind: 'converted', outputs: [written.value] } : failure(written.error);
};

const convertSlides = async (context: Context): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const rendered = await context.deps.reader.pdf(ref);
  if (!rendered.ok) return failure(rendered.error);
  const pdfPath = `${context.dir}/${context.name}.pdf`;
  const wrotePdf = await context.deps.files.writeBytes(pdfPath, rendered.value);
  if (!wrotePdf.ok) return failure(wrotePdf.error);
  return withSlideText(context, pdfPath);
};

const withSlideText = async (context: Context, pdfPath: string): Promise<ConvertOutcome> => {
  const ref = { driveId: context.input.driveId, itemId: context.input.item.id };
  const isLegacy = context.input.item.name.toLowerCase().endsWith('.ppt') || context.input.item.name.toLowerCase().endsWith('.rtf');
  const text = isLegacy ? await context.deps.reader.localMarkdown(pdfPath) : await context.deps.reader.markdown(ref);
  if (!text.ok) return failure(text.error);
  const stamp = { ...context.stamp, pdf: `./${context.name}.pdf` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, text.value.trim().length === 0 ? NO_TEXT_NOTE : text.value);
  return written.ok ? { kind: 'converted', outputs: [pdfPath, written.value] } : failure(written.error);
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
  const stamp = { ...context.stamp, pdf: `./${context.name}` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, text.value.trim().length === 0 ? SCANNED_PDF_NOTE : text.value);
  return written.ok ? { kind: 'converted', outputs: [rawPath, written.value] } : failure(written.error);
};

const convertImage = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const read = await context.deps.ocr.read(rawPath);
  const body = read.ok && read.value.trim().length > 0 ? read.value : NO_TEXT_NOTE;
  const stamp = { ...context.stamp, image: `./${context.name}`, ocr: read.ok ? context.input.ocrLabel : undefined };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, body);
  return written.ok ? { kind: 'converted', outputs: [rawPath, written.value] } : failure(written.error);
};

const convertVector = async (context: Context): Promise<ConvertOutcome> => {
  const raw = await context.deps.reader.bytes({ driveId: context.input.driveId, itemId: context.input.item.id });
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.dir}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const stamp = { ...context.stamp, image: `./${context.name}` };
  const written = await writeMarkdown(context, `${context.name}.md`, stamp, VECTOR_NOTE);
  return written.ok ? { kind: 'converted', outputs: [rawPath, written.value] } : failure(written.error);
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
