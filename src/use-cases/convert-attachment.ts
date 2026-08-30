import { embedsImages, planFile } from '../domain/conversion-plan.ts';
import type { ConversionRoute } from '../domain/conversion-plan.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { renderCalendar } from '../domain/icalendar.ts';
import type { MimePart } from '../domain/mime.ts';
import { readMime } from '../domain/mime.ts';
import { NO_TEXT_NOTE, SCANNED_PDF_NOTE, VECTOR_NOTE, kbDocument } from '../domain/kb-document.ts';
import { safeRelPath, safeSegment } from '../domain/kb-path.ts';
import { renderZipManifest } from '../domain/zip-manifest.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { SkipReason } from '../domain/report.ts';
import type { ArchiveEntry } from './ports/drive-reader.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { MailAttachment, MailReader, MailReaderError } from './ports/mail-reader.ts';
import type { Logger } from './ports/logger.ts';
import type { Ocr } from './ports/ocr.ts';
import { placeImages } from './place-images.ts';

export type ConvertAttachmentDeps = {
  readonly reader: MailReader;
  readonly files: Files;
  readonly ocr: Ocr;
  readonly logger: Logger;
  // Unpacking reads a file already on disk, which is all this needs of the wider drive reader.
  readonly unpackArchive: (path: string) => Promise<Result<ReadonlyArray<ArchiveEntry>, { readonly kind: string; readonly message: string }>>;
  // Reads a file already on disk, which is what a part taken out of a saved email is by then.
  readonly convertLocal: (path: string) => Promise<Result<string, { readonly kind: string; readonly message: string }>>;
};

export type ConvertAttachmentInput = {
  readonly messageId: string;
  readonly attachment: MailAttachment;
  readonly folder: string;
  readonly stamp: DocumentStamp;
  readonly maxBytes: number;
  // What to call the file on disk. Given when two different attachments of one conversation share
  // a name, so both are kept rather than one overwriting the other.
  readonly asName?: string;
  // Hand the reading back rather than writing a document to hold it. A picture shown inside a thread
  // carries its own words in the thread, so a second file repeating them is one file too many, and
  // there is no delete to take it away again afterwards.
  readonly textOnly?: boolean;
  // What an embedded email already rendered to. It arrives ready because the caller had to render it
  // to know its content address, an item attachment having no bytes of its own to take one from.
  readonly rendered?: string;
};

export type AttachmentOutcome =
  // `primary` is the one file to link a reader to, out of everything the conversion wrote: always
  // the markdown, since that is what carries the text and stamps where its siblings sit, except for
  // an archive, whose entries are many and whose own file is the thing that was sent.
  // `media` names the pictures taken out of a document, which are outputs like any other but are not
  // files the message carried: the document's own markdown links them, so a thread naming them again
  // would put twelve lines in its head for one Word file.
  | { readonly kind: 'converted'; readonly outputs: ReadonlyArray<string>; readonly primary: string; readonly media: ReadonlyArray<string>; readonly text?: string }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'failed'; readonly reason: string };

type Context = {
  readonly deps: ConvertAttachmentDeps;
  readonly input: ConvertAttachmentInput;
  readonly name: string;
};

// Same rule as a SharePoint file: a password nobody here has is not a reason to ask again.
const failure = (error: MailReaderError | FilesError): AttachmentOutcome =>
  error.kind === 'protected' ? { kind: 'skipped', reason: 'protected' } : { kind: 'failed', reason: `${error.kind}: ${error.message}` };

// A Word or Excel file keeps no copy you can look at, so a diagram inside one survives nowhere but
// the extraction. A picture read that fails costs the pictures and not the text: the document is the
// point, and the `[image]` placeholders left in its body already say something stood there.
const withImages = async (context: Context, body: string): Promise<Result<{ readonly body: string; readonly paths: ReadonlyArray<string> }, FilesError>> => {
  if (!embedsImages(context.name)) return ok({ body, paths: [] });
  const found = await context.deps.reader.attachmentImages(context.input.messageId, context.input.attachment.id);
  if (!found.ok) {
    context.deps.logger.warn('images.failed', { attachmentId: context.input.attachment.id, name: context.input.attachment.name, cause: found.error.kind });
    return ok({ body, paths: [] });
  }
  if (found.value.length === 0) return ok({ body, paths: [] });
  const placed = await placeImages(context.deps, context.input.folder, context.name, found.value);
  return placed.ok ? ok({ body: `${body}${placed.value.section}`, paths: placed.value.paths }) : placed;
};

type WrittenMarkdown = { readonly path: string; readonly media: ReadonlyArray<string> };

// What a conversion that ended in one markdown file came to: the file, whatever was written before
// it, and the pictures taken out of the document on the way.
const converted_ = (written: WrittenMarkdown, before: ReadonlyArray<string> = []): AttachmentOutcome => ({
  kind: 'converted',
  outputs: [...before, written.path, ...written.media],
  primary: written.path,
  media: written.media,
});

const writeMarkdown = async (context: Context, stamp: DocumentStamp, body: string): Promise<Result<WrittenMarkdown, FilesError>> => {
  const pictures = await withImages(context, body);
  if (!pictures.ok) return pictures;
  const path = `${context.input.folder}/${context.name}.md`;
  const written = await context.deps.files.writeText(path, kbDocument(stamp, pictures.value.body));
  return written.ok ? ok({ path, media: pictures.value.paths }) : written;
};

const asMarkdown = async (context: Context): Promise<AttachmentOutcome> => {
  const converted = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
  if (!converted.ok) return failure(converted.error);
  const written = await writeMarkdown(context, context.input.stamp, converted.value.trim().length === 0 ? NO_TEXT_NOTE : converted.value);
  return written.ok ? converted_(written.value) : failure(written.error);
};

const asSlides = async (context: Context): Promise<AttachmentOutcome> => {
  const rendered = await context.deps.reader.attachmentPdf(context.input.messageId, context.input.attachment.id);
  if (!rendered.ok) return failure(rendered.error);
  const pdfPath = `${context.input.folder}/${context.name}.pdf`;
  const wrotePdf = await context.deps.files.writeBytes(pdfPath, rendered.value);
  if (!wrotePdf.ok) return failure(wrotePdf.error);
  const text = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
  if (!text.ok) return failure(text.error);
  const stamp = { ...context.input.stamp, pdf: `./${context.name}.pdf` };
  const written = await writeMarkdown(context, stamp, text.value.trim().length === 0 ? NO_TEXT_NOTE : text.value);
  return written.ok ? converted_(written.value, [pdfPath]) : failure(written.error);
};

const rawAndMarkdown = async (context: Context, body: (rawPath: string) => Promise<{ readonly text: string; readonly stamp: DocumentStamp }>): Promise<AttachmentOutcome> => {
  const raw = await context.deps.reader.attachmentBytes(context.input.messageId, context.input.attachment.id);
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.input.folder}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const rendered = await body(rawPath);
  // The file itself is the only output, and it is its own primary: there is no document for a
  // caller to be pointed at, only the picture and the text handed back with it.
  // The note stands in for text in a document, where a file holding nothing needs to say so. Under
  // a picture in a thread it is worse than silence: it tells a reader to open a file beside a note
  // that no longer exists, once per picture, down a thread of signatures nobody could read.
  if (context.input.textOnly === true) {
    const read = rendered.text === NO_TEXT_NOTE ? undefined : rendered.text;
    return { kind: 'converted', outputs: [rawPath], primary: rawPath, media: [], text: read };
  }
  const written = await writeMarkdown(context, rendered.stamp, rendered.text);
  return written.ok ? converted_(written.value, [rawPath]) : failure(written.error);
};

// A PDF with a text layer yields it straight. One without (a scan) is read by OCR from the copy on
// disk, and only when OCR finds nothing does the note stand in for the text.
const pdfText = async (context: Context, rawPath: string, extracted: string): Promise<{ readonly body: string; readonly ocr?: string }> => {
  if (extracted.trim().length > 0) return { body: extracted };
  const read = await context.deps.ocr.read(rawPath);
  return read.ok && read.value.text.trim().length > 0 ? { body: read.value.text, ocr: read.value.label } : { body: SCANNED_PDF_NOTE };
};

const asPdf = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async (rawPath) => {
    const text = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
    const read = await pdfText(context, rawPath, text.ok ? text.value : '');
    return { text: read.body, stamp: { ...context.input.stamp, pdf: `./${context.name}`, ocr: read.ocr } };
  });

const asImage = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async (rawPath) => {
    const read = await context.deps.ocr.read(rawPath);
    const body = read.ok && read.value.text.trim().length > 0 ? read.value.text : NO_TEXT_NOTE;
    return { text: body, stamp: { ...context.input.stamp, image: `./${context.name}`, ocr: read.ok ? read.value.label : undefined } };
  });

// A workbook is read for its cell text and kept as it came, because the reading is all the markdown
// can hold: a formula, a second sheet and a chart are in the file and nowhere else. The text is
// asked for first, so a refused conversion is reported rather than written down as an empty note.
const asSpreadsheet = async (context: Context): Promise<AttachmentOutcome> => {
  const text = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
  if (!text.ok) return failure(text.error);
  return rawAndMarkdown(context, async () => ({
    text: text.value.trim().length === 0 ? NO_TEXT_NOTE : text.value,
    stamp: { ...context.input.stamp, original: `./${context.name}` },
  }));
};

const asVector = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async () => ({ text: VECTOR_NOTE, stamp: { ...context.input.stamp, image: `./${context.name}` } }));

// Each file a saved email carried, written as it was and read where the library can read it. A kind
// it refuses keeps the file and loses only the text, the same bargain a picture in a document gets.
const writeParts = async (context: Context, folder: string, parts: ReadonlyArray<MimePart>): Promise<Result<ReadonlyArray<string>, FilesError>> => {
  const written: string[] = [];
  for (const part of parts) {
    const name = safeSegment(part.name);
    const wrote = await context.deps.files.writeBytes(`${folder}/${name}`, part.bytes);
    if (!wrote.ok) return wrote;
    written.push(`${folder}/${name}`);
    const text = await context.deps.convertLocal(`${folder}/${name}`);
    if (!text.ok) continue;
    const wroteText = await context.deps.files.writeText(`${folder}/${name}.md`, kbDocument({ ...context.input.stamp, original: `./${name}` }, text.value));
    if (!wroteText.ok) return wroteText;
    written.push(`${folder}/${name}.md`);
  }
  return ok(written);
};

// A saved email is a folder like an archive is. The library has no parser for one, so the message is
// read here and every file it carried is taken out of the base64 it travelled in, rather than left
// sitting in the middle of the text where nothing can read it and everything has to scroll past it.
const asMessage = async (context: Context): Promise<AttachmentOutcome> => {
  const raw = await context.deps.reader.attachmentBytes(context.input.messageId, context.input.attachment.id);
  if (!raw.ok) return failure(raw.error);
  const folder = `${context.input.folder}/${safeSegment(context.name.slice(0, context.name.lastIndexOf('.')))}`;
  const read = readMime(new TextDecoder().decode(raw.value));
  const message = `${folder}/${context.name}.md`;
  const wrote = await context.deps.files.writeText(message, kbDocument(context.input.stamp, read.text.trim().length === 0 ? NO_TEXT_NOTE : read.text));
  if (!wrote.ok) return failure(wrote.error);
  const carried = await writeParts(context, folder, read.parts);
  return carried.ok ? { kind: 'converted', outputs: [message, ...carried.value], primary: message, media: [] } : failure(carried.error);
};

// An archive is kept as it came and also unpacked, one markdown file per document inside, so a
// contract sent as a zip is as readable as one sent on its own.
const asArchive = async (context: Context): Promise<AttachmentOutcome> => {
  const raw = await context.deps.reader.attachmentBytes(context.input.messageId, context.input.attachment.id);
  if (!raw.ok) return failure(raw.error);
  const folder = `${context.input.folder}/${safeSegment(context.name.slice(0, context.name.lastIndexOf('.')))}`;
  const archivePath = `${folder}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(archivePath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const entries = await context.deps.unpackArchive(archivePath);
  if (!entries.ok) return { kind: 'failed', reason: `${entries.error.kind}: ${entries.error.message}` };
  return writeArchiveEntries(context, folder, archivePath, entries.value);
};

const writeArchiveEntries = async (context: Context, folder: string, archivePath: string, entries: ReadonlyArray<ArchiveEntry>): Promise<AttachmentOutcome> => {
  const outputs: string[] = [archivePath];
  for (const entry of entries) {
    const path = `${folder}/${safeRelPath(entry.path.split('/'))}.md`;
    const stamp = { ...context.input.stamp, zipEntry: entry.path };
    const written = await context.deps.files.writeText(path, kbDocument(stamp, entry.text ?? entry.note ?? NO_TEXT_NOTE));
    if (!written.ok) return failure(written.error);
    outputs.push(path);
  }
  // The manifest, and what a reader is sent to. An archive's `primary` used to be the archive
  // itself, so a thread linked its reader at a binary; this is the document that says what is
  // inside without unzipping, and for a folder of photographs it is the contact sheet: every
  // member on one line with the text read out of it, rather than the same text scattered across
  // forty files that have to be opened one at a time.
  const manifestPath = `${context.input.folder}/${context.name}.md`;
  const manifest = await context.deps.files.writeText(manifestPath, renderZipManifest(context.name, entries));
  if (!manifest.ok) return failure(manifest.error);
  return { kind: 'converted', outputs: [...outputs, manifestPath], primary: manifestPath, media: [] };
};

// An invitation is read rather than kept. The library has no iCalendar parser and passes the file
// through as text, which is where the reading starts: a handful of fields out of a file that is
// otherwise daylight-saving rules, vendor properties, and a description repeating the mail itself.
const asCalendar = async (context: Context): Promise<AttachmentOutcome> => {
  const passed = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
  if (!passed.ok) return failure(passed.error);
  const read = renderCalendar(passed.value);
  const written = await writeMarkdown(context, context.input.stamp, read.length === 0 ? NO_TEXT_NOTE : read);
  return written.ok ? converted_(written.value) : failure(written.error);
};

// An email attached to an email is not a file to convert: Graph answers a request for its bytes
// with the item itself, and the library renders it from the message instead. Its name carries no
// extension either, so the routing that reads one has nothing to go on and is not consulted.
const asEmbeddedMail = async (context: Context): Promise<AttachmentOutcome> => {
  const rendered = context.input.rendered ?? '';
  const written = await writeMarkdown(context, context.input.stamp, rendered.trim().length === 0 ? NO_TEXT_NOTE : rendered);
  return written.ok ? converted_(written.value) : failure(written.error);
};

const CONVERTERS: Readonly<Record<ConversionRoute, (context: Context) => Promise<AttachmentOutcome>>> = {
  document: asMarkdown,
  spreadsheet: asSpreadsheet,
  message: asMessage,
  calendar: asCalendar,
  slides: asSlides,
  'legacy-slides': asSlides,
  pdf: asPdf,
  image: asImage,
  vector: asVector,
  archive: asArchive,
};

export type ConvertAttachment = (input: ConvertAttachmentInput) => Promise<AttachmentOutcome>;

export const createConvertAttachment =
  (deps: ConvertAttachmentDeps): ConvertAttachment =>
  async (input) => {
    const context = { deps, input, name: safeSegment(input.asName ?? input.attachment.name) };
    if (input.attachment.kind === 'item') return asEmbeddedMail(context);
    const decision = planFile({ name: input.attachment.name, size: input.attachment.size }, input.maxBytes);
    if (decision.kind === 'skip') return { kind: 'skipped', reason: decision.reason };
    return CONVERTERS[decision.route](context);
  };
