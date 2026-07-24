import { planFile } from '../domain/conversion-plan.ts';
import type { ConversionRoute } from '../domain/conversion-plan.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { NO_TEXT_NOTE, SCANNED_PDF_NOTE, VECTOR_NOTE, kbDocument } from '../domain/kb-document.ts';
import { safeSegment } from '../domain/kb-path.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { MailAttachment, MailReader, MailReaderError } from './ports/mail-reader.ts';
import type { Ocr } from './ports/ocr.ts';

export type ConvertAttachmentDeps = {
  readonly reader: MailReader;
  readonly files: Files;
  readonly ocr: Ocr;
};

export type ConvertAttachmentInput = {
  readonly messageId: string;
  readonly attachment: MailAttachment;
  readonly folder: string;
  readonly stamp: DocumentStamp;
  readonly maxBytes: number;
  readonly ocrLabel: string;
};

export type AttachmentOutcome =
  | { readonly kind: 'converted'; readonly outputs: ReadonlyArray<string> }
  | { readonly kind: 'skipped'; readonly reason: 'unsupported-type' | 'too-large' }
  | { readonly kind: 'failed'; readonly reason: string };

type Context = {
  readonly deps: ConvertAttachmentDeps;
  readonly input: ConvertAttachmentInput;
  readonly name: string;
};

const failure = (error: MailReaderError | FilesError): AttachmentOutcome => ({ kind: 'failed', reason: `${error.kind}: ${error.message}` });

const writeMarkdown = async (context: Context, stamp: DocumentStamp, body: string): Promise<Result<string, FilesError>> => {
  const path = `${context.input.folder}/${context.name}.md`;
  const written = await context.deps.files.writeText(path, kbDocument(stamp, body));
  return written.ok ? ok(path) : written;
};

const asMarkdown = async (context: Context): Promise<AttachmentOutcome> => {
  const converted = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
  if (!converted.ok) return failure(converted.error);
  const written = await writeMarkdown(context, context.input.stamp, converted.value.trim().length === 0 ? NO_TEXT_NOTE : converted.value);
  return written.ok ? { kind: 'converted', outputs: [written.value] } : failure(written.error);
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
  return written.ok ? { kind: 'converted', outputs: [pdfPath, written.value] } : failure(written.error);
};

const rawAndMarkdown = async (context: Context, body: (rawPath: string) => Promise<{ readonly text: string; readonly stamp: DocumentStamp }>): Promise<AttachmentOutcome> => {
  const raw = await context.deps.reader.attachmentBytes(context.input.messageId, context.input.attachment.id);
  if (!raw.ok) return failure(raw.error);
  const rawPath = `${context.input.folder}/${context.name}`;
  const wroteRaw = await context.deps.files.writeBytes(rawPath, raw.value);
  if (!wroteRaw.ok) return failure(wroteRaw.error);
  const rendered = await body(rawPath);
  const written = await writeMarkdown(context, rendered.stamp, rendered.text);
  return written.ok ? { kind: 'converted', outputs: [rawPath, written.value] } : failure(written.error);
};

const asPdf = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async () => {
    const text = await context.deps.reader.attachmentMarkdown(context.input.messageId, context.input.attachment.id);
    const body = text.ok && text.value.trim().length > 0 ? text.value : SCANNED_PDF_NOTE;
    return { text: body, stamp: { ...context.input.stamp, pdf: `./${context.name}` } };
  });

const asImage = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async (rawPath) => {
    const read = await context.deps.ocr.read(rawPath);
    const body = read.ok && read.value.trim().length > 0 ? read.value : NO_TEXT_NOTE;
    return { text: body, stamp: { ...context.input.stamp, image: `./${context.name}`, ocr: read.ok ? context.input.ocrLabel : undefined } };
  });

const asVector = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async () => ({ text: VECTOR_NOTE, stamp: { ...context.input.stamp, image: `./${context.name}` } }));

// An archive attached to a mail is kept as it came: unpacking needs a Graph round trip the mail
// side does not have, and the bytes beside the thread are still readable by hand.
const asArchive = async (context: Context): Promise<AttachmentOutcome> =>
  rawAndMarkdown(context, async () => ({ text: `_This archive was kept as it came. Open \`./${context.name}\` to read what is inside._`, stamp: context.input.stamp }));

const CONVERTERS: Readonly<Record<ConversionRoute, (context: Context) => Promise<AttachmentOutcome>>> = {
  document: asMarkdown,
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
    const decision = planFile({ name: input.attachment.name, size: input.attachment.size }, input.maxBytes);
    if (decision.kind === 'skip') return { kind: 'skipped', reason: decision.reason };
    return CONVERTERS[decision.route]({ deps, input, name: safeSegment(input.attachment.name) });
  };
