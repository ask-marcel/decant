import { join as pathUnder, relative as pathBetween } from 'node:path';
import { contentHash } from '../domain/content-hash.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { inReceivedOrder } from '../domain/mail-message.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { AttachmentRecord, LinkedRecord, ThreadRecord } from '../domain/mail-state.ts';
import { renderFrontMatter } from '../domain/front-matter.ts';
import { carriesInlineImage } from '../domain/inline-image.ts';
import type { CarriedFile } from '../domain/mail-body.ts';
import { rewriteMessageBody } from '../domain/mail-body.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import { participantsOf, renderThread, threadTitle } from '../domain/thread.ts';
import { bareSubject } from '../domain/thread-subject.ts';
import { cardFileName, renderThreadCard } from '../domain/thread-card.ts';
import { threadFolderName } from '../domain/thread-folder.ts';
import type { ThreadId } from '../domain/thread-id.ts';
import { FILE_SLUG_LIMIT, FOLDER_SLUG_LIMIT, slugify } from '../domain/thread-slug.ts';
import { dayIn } from '../domain/zoned-day.ts';
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
  // The zone a thread's day is counted in. Config for the run rather than per conversation, since
  // every folder in one vault must be dated the same way or two runs would disagree.
  readonly timezone: string;
};

export type RenderThreadInput = {
  readonly threadId: string;
  // Every Graph conversation this thread was assembled from. More than one when Graph opened a
  // second conversation for the same exchange, which it does when an external party replies from
  // outside Exchange. They are rendered as one document, because they are one exchange.
  readonly conversationIds: ReadonlyArray<string>;
  readonly root: string;
  // The folder this thread was already filed under, empty when it has never been filed. Reused
  // verbatim rather than recomputed, so a change to the naming rules cannot move a folder that is
  // already written and already linked to.
  readonly folder: string;
  readonly maxBytes: number;
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
  source: `conversation ${input.conversationIds[0] ?? ''}`,
  site: 'Mailbox',
  library: 'Mailbox',
  path: threadTitle(first.subject),
  lastModified: last.received,
  modifiedBy: last.from?.name,
  syncedAt: deps.clock.nowIso(),
});

const threadHeader = (
  input: RenderThreadInput,
  parts: ReadonlyArray<ThreadPart>,
  first: MailMessage,
  last: MailMessage,
  syncedAt: string,
  attachments: ReadonlyArray<string>,
  inlineImages: ReadonlyArray<string>,
  linked: ReadonlyArray<string>
): string =>
  renderFrontMatter([
    // What the thread IS, and what its folder is named after. `conversation_id` stays for a Graph
    // round trip; it is not what anything is keyed on, since Graph reassigns it when an external
    // party replies from outside Exchange.
    ['thread_id', input.threadId],
    ['root_message_id', input.root],
    ['conversation_id', input.conversationIds],
    ['source', `conversation ${input.conversationIds[0] ?? ''}`],
    ['site', 'Mailbox'],
    ['subject', threadTitle(first.subject)],
    ['participants', participantsOf(parts)],
    ['first_message', first.received],
    ['last_message', last.received],
    ['message_count', parts.length],
    ['synced_at', syncedAt],
    ['attachments', attachments],
    ['inline_images', inlineImages],
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
  });
  if (outcome.kind === 'converted') return { record: { paths: outcome.outputs } };
  deps.logger.warn(outcome.kind === 'skipped' ? 'linked.skipped' : 'linked.failed', { itemId, name, cause: outcome.reason });
  if (outcome.kind === 'failed') return { failed: { path: name, reason: outcome.reason } };
  return { skipped: { path: name, reason: skipReason(outcome.reason, input.maxBytes) } };
};

const ATTACHMENTS_FOLDER = '_attachments';

// What one message carried, kept per message rather than per thread: the body that message rendered
// to is the one place a reader looks for it, and a thread-wide list cannot say which message it came
// with. A file the thread already stored for an earlier message is recorded again here, pointing at
// the same copy on disk, so every message that carried it names it.
type MessageFile = { readonly attachment: MailAttachment; readonly paths: ReadonlyArray<string>; readonly primary?: string; readonly note?: string };

type Media = ReadonlyArray<string>;

type AttachmentTally = {
  readonly paths: ReadonlyArray<string>;
  readonly store: Readonly<Record<string, AttachmentRecord>>;
  readonly byMessage: Readonly<Record<string, ReadonlyArray<MessageFile>>>;
  // Pictures taken out of the documents themselves. Written, recorded, and left out of the head of
  // the thread: the document's own markdown links them under `## Images`.
  readonly media: Media;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
};

type Placed = { readonly paths: ReadonlyArray<string>; readonly primary?: string; readonly media?: Media; readonly skipped?: ReportEntry; readonly failed?: ReportEntry };

// One attachment into the shared store. Its content address decides everything: a content already
// stored is referenced without being converted again; a new content is converted once, under a name
// that always carries a short slice of that address so the name is fixed by the bytes alone. That is
// what lets conversations render at the same time without ever racing to claim a name on disk.
// Where an attachment's content address comes from. A file has bytes to take one from. An item
// attachment has none at all, Graph answering a request for them with the item itself, so its
// address is the address of what it renders to: stable for the same embedded mail within a library
// version, which is what lets two threads carrying it share one copy on disk. The rendering is kept
// and handed on, so the conversion does not ask for it a second time.
type Addressed = { readonly hash: string; readonly rendered?: string };

const addressOf = async (deps: RenderThreadDeps, messageId: string, attachment: MailAttachment): Promise<Result<Addressed, MailReaderError>> => {
  if (attachment.kind !== 'item') {
    const raw = await deps.reader.attachmentBytes(messageId, attachment.id);
    return raw.ok ? ok({ hash: contentHash(raw.value) }) : raw;
  }
  const rendered = await deps.reader.attachmentMarkdown(messageId, attachment.id);
  return rendered.ok ? ok({ hash: contentHash(new TextEncoder().encode(rendered.value)), rendered: rendered.value }) : rendered;
};

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
  const address = await addressOf(deps, messageId, attachment);
  if (!address.ok) return { paths: [], failed: { path: attachment.name, reason: `${address.error.kind}: ${address.error.message}` } };
  const hash = address.value.hash;
  const seen = store[hash];
  if (seen !== undefined) return { paths: seen.paths, primary: seen.primary, media: seen.media };
  const asName = disambiguateSegment(attachment.name, hash);
  const folder = `${deps.mailboxRoot}/${ATTACHMENTS_FOLDER}`;
  const rendered = address.value.rendered;
  const outcome = await deps.convertAttachment({ messageId, attachment, folder, stamp, maxBytes: input.maxBytes, asName, rendered });
  if (outcome.kind === 'skipped') return { paths: [], skipped: { path: attachment.name, reason: skipReason(outcome.reason, input.maxBytes) } };
  if (outcome.kind === 'failed') return { paths: [], failed: { path: attachment.name, reason: outcome.reason } };
  store[hash] = { name: asName, paths: outcome.outputs, primary: outcome.primary, media: outcome.media };
  return { paths: outcome.outputs, primary: outcome.primary, media: outcome.media };
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
  const byMessage: Record<string, MessageFile[]> = {};
  const media: string[] = [];
  // Graph reports `hasAttachments: false` for a message whose only attachment is an inline image, so
  // a signature or a pasted screenshot would never be listed at all. A body showing a picture it does
  // not carry is the other half of the question, and asking it costs nothing on a message with neither.
  for (const part of parts.filter((candidate) => candidate.message.hasAttachments || carriesInlineImage(candidate.body))) {
    const listed = await deps.reader.attachments(part.message.id);
    if (!listed.ok) {
      failed.push({ path: `message ${part.message.id}`, reason: `could not list what it carried: ${listed.error.message}` });
      continue;
    }
    const carried: MessageFile[] = [];
    for (const attachment of listed.value) {
      const placed = await placeAttachment(deps, input, store, part.message.id, attachment, stamp);
      for (const path of placed.paths) if (!paths.includes(path)) paths.push(path);
      if (placed.skipped) skipped.push(placed.skipped);
      if (placed.failed) failed.push(placed.failed);
      for (const path of placed.media ?? []) if (!media.includes(path)) media.push(path);
      carried.push({ attachment, paths: placed.paths, primary: placed.primary, note: placed.skipped?.reason ?? placed.failed?.reason });
    }
    byMessage[part.message.id] = carried;
  }
  return { paths, store, byMessage, media, skipped, failed };
};

// The picture itself rather than the text read out of it: a raw image is the first file its
// conversion wrote, and only an image kind has one worth showing in a body.
const pictureOf = (here: string, file: MessageFile): string | undefined => {
  const raw = file.paths[0];
  return raw === undefined || raw === file.primary || !file.attachment.contentType.startsWith('image/') ? undefined : pathBetween(here, raw);
};

// Paths are written the way a reader follows them: from the folder the conversation sits in.
const carriedBy = (here: string, files: ReadonlyArray<MessageFile>): ReadonlyArray<CarriedFile> =>
  files.map((file) => ({
    name: file.attachment.name,
    size: file.attachment.size,
    contentType: file.attachment.contentType,
    contentId: file.attachment.contentId,
    isInline: file.attachment.isInline,
    path: file.primary === undefined ? undefined : pathBetween(here, file.primary),
    picture: pictureOf(here, file),
    note: file.note,
  }));

type ThreadBodies = { readonly parts: ReadonlyArray<ThreadPart>; readonly pictures: ReadonlyArray<string> };

// A picture shown in a body is named nowhere else, so both files it produced, the picture and the
// text read out of it, leave the attachment list and go under `inline_images` instead.
const shownPaths = (here: string, carried: ReadonlyArray<CarriedFile>, pictures: ReadonlyArray<string>): ReadonlyArray<string> =>
  carried
    .filter((file) => file.picture !== undefined && pictures.includes(file.picture))
    .flatMap((file) => [file.picture, file.path].flatMap((ref) => (ref === undefined ? [] : [pathUnder(here, ref)])));

const rewriteBodies = (here: string, parts: ReadonlyArray<ThreadPart>, byMessage: Readonly<Record<string, ReadonlyArray<MessageFile>>>): ThreadBodies => {
  const pictures: string[] = [];
  const rewritten = parts.map((part) => {
    const carried = carriedBy(here, byMessage[part.message.id] ?? []);
    const body = rewriteMessageBody(part.body, carried);
    for (const path of shownPaths(here, carried, body.pictures)) if (!pictures.includes(path)) pictures.push(path);
    return { message: part.message, body: body.body };
  });
  return { parts: rewritten, pictures };
};

export const createRenderThread =
  (deps: RenderThreadDeps): RenderThread =>
  async (input) => {
    const held = await messagesOf(deps, input.conversationIds);
    if (!held.ok) return held;
    const alive = inReceivedOrder(held.value.filter((message) => !message.isDeleted));
    const first = alive[0];
    const last = alive[alive.length - 1];
    if (first === undefined || last === undefined) return ok({ kind: 'empty' });
    const parts = await bodiesOf(deps, alive);
    if (!parts.ok) return parts;
    return writeThread(deps, input, parts.value, first, last);
  };

// Every conversation the thread was assembled from, read in turn and written as one document. Graph
// opens a second conversation for one exchange when an external party replies from outside Exchange;
// rendering those apart would have each overwrite the other, since they share a file.
const messagesOf = async (deps: RenderThreadDeps, conversationIds: ReadonlyArray<string>): Promise<Result<ReadonlyArray<MailMessage>, MailReaderError>> => {
  const held: MailMessage[] = [];
  for (const conversationId of conversationIds) {
    const found = await deps.reader.conversation(conversationId);
    if (!found.ok) return found;
    held.push(...found.value);
  }
  return ok(held);
};

// Where a thread lives, settled once from its FIRST message and never recomputed. The day sorts,
// the id identifies, the slug reads. A reply arriving two years later appends to the document and
// leaves the folder alone, which is what stops the old file being stranded with nothing pointing at
// it: the previous layout filed a thread under its LATEST message, so every reply wrote it
// somewhere new and left the copy before it behind.
type ThreadPlace = { readonly folder: string; readonly relative: string; readonly here: string };

const placeOf = (deps: RenderThreadDeps, input: RenderThreadInput, first: MailMessage): ThreadPlace => {
  const bare = bareSubject(first.subject);
  const named = threadFolderName(dayIn(first.received, deps.timezone), input.threadId as ThreadId, slugify(bare, FOLDER_SLUG_LIMIT));
  const folder = input.folder.length === 0 ? String(named) : input.folder;
  return { folder, relative: `threads/${folder}/${slugify(bare, FILE_SLUG_LIMIT)}.md`, here: `${deps.mailboxRoot}/threads/${folder}` };
};

const CARDS_FOLDER = '_attachments';

// One card per file the thread carried, written HERE rather than inside the conversion. The
// conversion is short-circuited whenever a content is already in the store, which is the common
// case for everything after the first thread that carried it, so a card written there would exist
// only for the thread that happened to arrive first. Every other thread would then name files in
// its head that its own folder said nothing about.
const writeCards = async (
  deps: RenderThreadDeps,
  input: RenderThreadInput,
  place: ThreadPlace,
  parts: ReadonlyArray<ThreadPart>,
  byMessage: Readonly<Record<string, ReadonlyArray<MessageFile>>>,
  shown: ReadonlySet<string>
): Promise<void> => {
  const folder = `${place.here}/${CARDS_FOLDER}`;
  const taken: string[] = [];
  for (const part of parts) {
    for (const file of byMessage[part.message.id] ?? []) {
      if (file.primary !== undefined && shown.has(file.primary)) continue;
      const name = cardFileName(file.attachment.name, taken);
      taken.push(name);
      const raw = file.paths.find((path) => path !== file.primary);
      const card = renderThreadCard({
        threadId: input.threadId,
        messageId: part.message.id,
        filename: file.attachment.name,
        sender: part.message.from?.name,
        received: part.message.received,
        bytes: file.attachment.size,
        holds: file.primary === undefined ? undefined : pathBetween(folder, file.primary),
        original: raw === undefined ? undefined : pathBetween(folder, raw),
        note: file.note,
      });
      const saved = await deps.files.writeText(`${folder}/${name}`, card);
      if (!saved.ok) deps.logger.warn('card.failed', { filename: file.attachment.name, cause: saved.error.kind });
    }
  }
};

const writeThread = async (
  deps: RenderThreadDeps,
  input: RenderThreadInput,
  parts: ReadonlyArray<ThreadPart>,
  first: MailMessage,
  last: MailMessage
): Promise<Result<RenderThreadOutcome, MailReaderError>> => {
  const place = placeOf(deps, input, first);
  const relative = place.relative;
  const stamp = stampFor(deps, input, first, last);
  const attachments = await attachmentsOf(deps, input, parts, stamp);
  const links = await linkedFiles(
    deps,
    input,
    parts.map((part) => part.message)
  );
  // Attachments live in the shared store one level up from the thread, so their references climb out
  // of the thread's own folder rather than sitting beside it.
  const here = place.here;
  const bodies = rewriteBodies(here, parts, attachments.byMessage);
  const shown = new Set([...bodies.pictures, ...attachments.media]);
  await writeCards(deps, input, place, parts, attachments.byMessage, shown);
  const attachmentRefs = attachments.paths.filter((path) => !shown.has(path)).map((path) => pathBetween(here, path));
  const inlineRefs = bodies.pictures.map((path) => pathBetween(here, path));
  // Linked files are written from the thread's own folder, exactly as attachments are: both climb out
  // of it to a store the whole mailbox shares, and a reader follows either one the same way.
  const linkedRefs = links.paths.map((path) => pathBetween(here, path));
  const header = threadHeader(input, parts, first, last, stamp.syncedAt, attachmentRefs, inlineRefs, linkedRefs);
  const written = await deps.files.writeText(`${deps.mailboxRoot}/${relative}`, `${header}\n\n${renderThread({ subject: first.subject, parts: bodies.parts })}\n`);
  if (!written.ok) return err({ kind: 'permanent', message: written.error.message });
  // Named with the conversation they arrived in: two threads can each carry an `image002.wmz`, and
  // a report listing the bare name twice tells the reader nothing about which is which.
  const inThread = (entries: ReadonlyArray<ReportEntry>): ReadonlyArray<ReportEntry> => entries.map((entry) => ({ ...entry, path: `${relative}: ${entry.path}` }));
  return ok({
    kind: 'rendered',
    thread: {
      record: {
        folder: place.folder,
        conversationIds: input.conversationIds,
        file: relative,
        messageIds: parts.map((part) => part.message.id),
        lastMessage: last.received,
        attachments: attachments.paths.filter((path) => !shown.has(path)),
        inlineImages: bodies.pictures,
      },
      linked: links.linked,
      attachments: attachments.store,
      filesSkipped: inThread([...attachments.skipped, ...links.skipped]),
      filesFailed: inThread([...attachments.failed, ...links.failed]),
    },
  });
};
