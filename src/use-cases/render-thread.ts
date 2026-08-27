import { relative as pathBetween } from 'node:path';
import { contentHash } from '../domain/content-hash.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { inReceivedOrder } from '../domain/mail-message.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { AttachmentRecord, LinkedRecord, ThreadRecord } from '../domain/mail-state.ts';
import { renderFrontMatter } from '../domain/front-matter.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import { participantsOf, renderThread, threadDay, threadFileName, threadTitle } from '../domain/thread.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ReportEntry } from '../domain/report.ts';
import { skipReason, tooLargeReason } from '../domain/report.ts';
import type { ConvertAttachment } from './convert-attachment.ts';
import type { ConvertFile } from './convert-file.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { MailAttachment, MailReader, MailReaderError } from './ports/mail-reader.ts';

export type RenderThreadDeps = {
  readonly reader: MailReader;
  readonly drive: DriveReader;
  readonly files: Files;
  readonly convertAttachment: ConvertAttachment;
  readonly convertFile: ConvertFile;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly mailboxRoot: string;
};

export type RenderThreadInput = {
  readonly conversationId: string;
  readonly maxBytes: number;
  readonly ocrLabel: string;
  // Files already pulled from SharePoint by an earlier thread, so one link is fetched once.
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  // The shared attachment store as earlier threads left it, keyed by content address, so a file
  // sent across many threads is converted once and later threads reference what is on disk.
  readonly attachments: Readonly<Record<string, AttachmentRecord>>;
};

export type RenderedThread = {
  readonly record: ThreadRecord;
  readonly linked: Readonly<Record<string, LinkedRecord>>;
  readonly attachments: Readonly<Record<string, AttachmentRecord>>;
  readonly filesSkipped: ReadonlyArray<ReportEntry>;
  readonly filesFailed: ReadonlyArray<ReportEntry>;
};

export type RenderThreadOutcome = { readonly kind: 'rendered'; readonly thread: RenderedThread } | { readonly kind: 'empty' };

export type RenderThread = (input: RenderThreadInput) => Promise<Result<RenderThreadOutcome, MailReaderError>>;

const LINKED_FOLDER = '_linked';

const bodiesOf = async (deps: RenderThreadDeps, messages: ReadonlyArray<MailMessage>): Promise<Result<ReadonlyArray<ThreadPart>, MailReaderError>> => {
  const parts: ThreadPart[] = [];
  for (const message of messages) {
    const body = await deps.reader.messageMarkdown(message.id);
    if (!body.ok) return err(body.error);
    parts.push({ message, body: body.value });
  }
  return ok(parts);
};

const stampFor = (deps: RenderThreadDeps, input: RenderThreadInput, first: MailMessage, last: MailMessage): DocumentStamp => ({
  source: `conversation ${input.conversationId}`,
  site: 'Mailbox',
  library: 'Mailbox',
  path: threadTitle(first.subject),
  lastModified: last.received,
  modifiedBy: last.from?.name,
  syncedAt: deps.clock.nowIso(),
});

// Paths are written the way a reader opens them: from the folder the conversation sits in.
const relativeTo = (directory: string, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.map((path) => (path.startsWith(`${directory}/`) ? `./${path.slice(directory.length + 1)}` : path));

const threadHeader = (
  input: RenderThreadInput,
  parts: ReadonlyArray<ThreadPart>,
  first: MailMessage,
  last: MailMessage,
  syncedAt: string,
  attachments: ReadonlyArray<string>,
  linked: ReadonlyArray<string>
): string =>
  renderFrontMatter([
    ['source', `conversation ${input.conversationId}`],
    ['site', 'Mailbox'],
    ['subject', threadTitle(first.subject)],
    ['participants', participantsOf(parts)],
    ['first_message', first.received],
    ['last_message', last.received],
    ['message_count', parts.length],
    ['synced_at', syncedAt],
    ['attachments', attachments],
    ['linked_files', linked],
  ]);

// What one linked document came to: the files it produced, or the one line saying why it produced
// none. Same shape as `Placed` for an attachment, so both feed the report the same way.
type Pulled = { readonly record?: LinkedRecord; readonly skipped?: ReportEntry; readonly failed?: ReportEntry };

type LinkedTally = {
  readonly paths: ReadonlyArray<string>;
  readonly linked: Record<string, LinkedRecord>;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
};

// A file already pulled for another thread is referenced, not fetched again: the same weekly report
// linked from thirty mails is one document on disk.
const linkedFiles = async (deps: RenderThreadDeps, input: RenderThreadInput, messages: ReadonlyArray<MailMessage>): Promise<LinkedTally> => {
  const linked: Record<string, LinkedRecord> = { ...input.linked };
  const paths: string[] = [];
  const skipped: ReportEntry[] = [];
  const failed: ReportEntry[] = [];
  for (const message of messages) {
    const found = await deps.reader.sharepointLinks(message.id);
    if (!found.ok) continue;
    for (const link of found.value) {
      const key = `${link.driveId}:${link.itemId}`;
      const already = linked[key];
      const pulled = already === undefined ? await pullLinked(deps, input, link.driveId, link.itemId, link.name) : { record: already };
      if (pulled.skipped !== undefined) skipped.push(pulled.skipped);
      if (pulled.failed !== undefined) failed.push(pulled.failed);
      if (pulled.record === undefined) continue;
      linked[key] = pulled.record;
      for (const path of pulled.record.paths) if (!paths.includes(path)) paths.push(path);
    }
  }
  return { paths, linked, skipped, failed };
};

// The same route a file found by walking a library takes. A linked document is read for its own
// metadata first, because the name in the link cannot say when the file changed, how big it is, or
// what kind of thing it is: the day decides the folder, the size decides whether it is pulled at
// all, and the kind decides whether a deck also renders a PDF beside its text.
const pullLinked = async (deps: RenderThreadDeps, input: RenderThreadInput, driveId: string, itemId: string, name: string): Promise<Pulled> => {
  const found = await deps.drive.item({ driveId, itemId });
  if (!found.ok) {
    deps.logger.warn('linked.failed', { itemId, name, cause: found.error.kind });
    return { failed: { path: name, reason: `${found.error.kind}: ${found.error.message}` } };
  }
  const outcome = await deps.convertFile({
    item: found.value,
    driveId,
    libraryRoot: `${deps.mailboxRoot}/${LINKED_FOLDER}`,
    site: 'Mailbox',
    library: LINKED_FOLDER,
    maxBytes: input.maxBytes,
    ocrLabel: input.ocrLabel,
  });
  if (outcome.kind === 'converted') return { record: { paths: outcome.outputs } };
  deps.logger.warn(outcome.kind === 'skipped' ? 'linked.skipped' : 'linked.failed', { itemId, name, cause: outcome.reason });
  if (outcome.kind === 'failed') return { failed: { path: name, reason: outcome.reason } };
  return { skipped: { path: name, reason: skipReason(outcome.reason, input.maxBytes) } };
};

const ATTACHMENTS_FOLDER = '_attachments';

type AttachmentTally = {
  readonly paths: ReadonlyArray<string>;
  readonly store: Readonly<Record<string, AttachmentRecord>>;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
};

type Placed = { readonly paths: ReadonlyArray<string>; readonly skipped?: ReportEntry; readonly failed?: ReportEntry };

// One attachment into the shared store. Its content address decides everything: a content already
// stored is referenced without being converted again; a new content is converted once, under a name
// that always carries a short slice of that address so the name is fixed by the bytes alone. That is
// what lets conversations render at the same time without ever racing to claim a name on disk.
const placeAttachment = async (
  deps: RenderThreadDeps,
  input: RenderThreadInput,
  store: Record<string, AttachmentRecord>,
  messageId: string,
  attachment: MailAttachment,
  stamp: DocumentStamp
): Promise<Placed> => {
  // The size cap is checked before the bytes are pulled, so a file past it is reported without ever
  // being downloaded. A kind we do not read is caught by the converter, which is the one authority
  // on that; by then the file is already in hand, so the only skip it can report is unsupported.
  if (attachment.size > input.maxBytes) return { paths: [], skipped: { path: attachment.name, reason: tooLargeReason(input.maxBytes) } };
  const raw = await deps.reader.attachmentBytes(messageId, attachment.id);
  if (!raw.ok) return { paths: [], failed: { path: attachment.name, reason: `${raw.error.kind}: ${raw.error.message}` } };
  const hash = contentHash(raw.value);
  const seen = store[hash];
  if (seen !== undefined) return { paths: seen.paths };
  const asName = disambiguateSegment(attachment.name, hash);
  const folder = `${deps.mailboxRoot}/${ATTACHMENTS_FOLDER}`;
  const outcome = await deps.convertAttachment({ messageId, attachment, folder, stamp, maxBytes: input.maxBytes, ocrLabel: input.ocrLabel, asName });
  if (outcome.kind === 'skipped') return { paths: [], skipped: { path: attachment.name, reason: skipReason(outcome.reason, input.maxBytes) } };
  if (outcome.kind === 'failed') return { paths: [], failed: { path: attachment.name, reason: outcome.reason } };
  store[hash] = { name: asName, paths: outcome.outputs };
  return { paths: outcome.outputs };
};

const attachmentsOf = async (deps: RenderThreadDeps, input: RenderThreadInput, parts: ReadonlyArray<ThreadPart>, stamp: DocumentStamp): Promise<AttachmentTally> => {
  const store: Record<string, AttachmentRecord> = { ...input.attachments };
  const paths: string[] = [];
  const skipped: ReportEntry[] = [];
  const failed: ReportEntry[] = [];
  // A signature logo rides on every message of a thread, so the same file is offered many times.
  // Every offer is fetched and hashed rather than recognised beforehand by its name and length: a
  // spreadsheet edited and resent down a thread keeps its name, and an edit that leaves the byte
  // count untouched would pass for the version before it. The content address then dedupes the
  // repeat, here and across every other thread, so the bytes are paid for and the conversion is not.
  for (const part of parts.filter((candidate) => candidate.message.hasAttachments)) {
    const listed = await deps.reader.attachments(part.message.id);
    if (!listed.ok) {
      failed.push({ path: `message ${part.message.id}`, reason: `could not list what it carried: ${listed.error.message}` });
      continue;
    }
    for (const attachment of listed.value) {
      const placed = await placeAttachment(deps, input, store, part.message.id, attachment, stamp);
      for (const path of placed.paths) if (!paths.includes(path)) paths.push(path);
      if (placed.skipped) skipped.push(placed.skipped);
      if (placed.failed) failed.push(placed.failed);
    }
  }
  return { paths, store, skipped, failed };
};

export const createRenderThread =
  (deps: RenderThreadDeps): RenderThread =>
  async (input) => {
    const messages = await deps.reader.conversation(input.conversationId);
    if (!messages.ok) return messages;
    const alive = inReceivedOrder(messages.value.filter((message) => !message.isDeleted));
    const first = alive[0];
    const last = alive[alive.length - 1];
    if (first === undefined || last === undefined) return ok({ kind: 'empty' });
    const parts = await bodiesOf(deps, alive);
    if (!parts.ok) return parts;
    return writeThread(deps, input, parts.value, first, last);
  };

const writeThread = async (
  deps: RenderThreadDeps,
  input: RenderThreadInput,
  parts: ReadonlyArray<ThreadPart>,
  first: MailMessage,
  last: MailMessage
): Promise<Result<RenderThreadOutcome, MailReaderError>> => {
  const fileName = threadFileName({ conversationId: input.conversationId, subject: first.subject });
  const relative = `threads/${threadDay(last.received)}/${fileName}`;
  const stamp = stampFor(deps, input, first, last);
  const attachments = await attachmentsOf(deps, input, parts, stamp);
  const links = await linkedFiles(
    deps,
    input,
    parts.map((part) => part.message)
  );
  // Attachments live in the shared store one level up from the thread, so their references climb out
  // of the thread's own folder rather than sitting beside it.
  const here = `${deps.mailboxRoot}/threads/${threadDay(last.received)}`;
  const attachmentRefs = attachments.paths.map((path) => pathBetween(here, path));
  const header = threadHeader(input, parts, first, last, stamp.syncedAt, attachmentRefs, relativeTo(deps.mailboxRoot, links.paths));
  const written = await deps.files.writeText(
    `${deps.mailboxRoot}/${relative}`,
    `${header}\n\n${renderThread({ conversationId: input.conversationId, subject: first.subject, parts })}\n`
  );
  if (!written.ok) return err({ kind: 'permanent', message: written.error.message });
  // Named with the conversation they arrived in: two threads can each carry an `image002.wmz`, and
  // a report listing the bare name twice tells the reader nothing about which is which.
  const inThread = (entries: ReadonlyArray<ReportEntry>): ReadonlyArray<ReportEntry> => entries.map((entry) => ({ ...entry, path: `${relative}: ${entry.path}` }));
  return ok({
    kind: 'rendered',
    thread: {
      record: { file: relative, messageIds: parts.map((part) => part.message.id), lastMessage: last.received, attachments: attachments.paths },
      linked: links.linked,
      attachments: attachments.store,
      filesSkipped: inThread([...attachments.skipped, ...links.skipped]),
      filesFailed: inThread([...attachments.failed, ...links.failed]),
    },
  });
};
