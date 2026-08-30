import { relative as pathBetween } from 'node:path';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { inReceivedOrder } from '../domain/mail-message.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { AttachmentRecord, LinkedRecord, ThreadRecord } from '../domain/mail-state.ts';
import { renderFrontMatter } from '../domain/front-matter.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { participantsOf, renderThread, threadTitle } from '../domain/thread.ts';
import { bareSubject } from '../domain/thread-subject.ts';
import { threadFolderName } from '../domain/thread-folder.ts';
import type { ThreadId } from '../domain/thread-id.ts';
import { FILE_SLUG_LIMIT, FOLDER_SLUG_LIMIT, slugify } from '../domain/thread-slug.ts';
import { dayIn } from '../domain/zoned-day.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ReportEntry } from '../domain/report.ts';
import type { ConvertAttachment } from './convert-attachment.ts';
import { ATTACHMENTS_FOLDER, attachmentsOf } from './thread-files.ts';
import { rewriteBodies, writeCards } from './thread-documents.ts';
import type { ConvertFile } from './convert-file.ts';
import { linkedFiles, writeLinkCards } from './thread-links.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { MailReader, MailReaderError } from './ports/mail-reader.ts';

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
  // The attachment store as earlier threads left it, keyed by content address. Carried through and
  // handed back so the index in `_meta` names every file the mailbox holds; no longer consulted
  // before converting, since a thread now keeps its own copy of what it carried.
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

const bodiesOf = async (deps: RenderThreadDeps, messages: ReadonlyArray<MailMessage>): Promise<Result<ReadonlyArray<ThreadPart>, MailReaderError>> => {
  const parts: ThreadPart[] = [];
  for (const message of messages) {
    const body = await deps.reader.messageMarkdown(message.id);
    if (!body.ok) return err(body.error);
    parts.push({ message, body: body.value });
  }
  return ok(parts);
};

// The conversation a thread is rooted in, named the same way wherever it is named. A merged thread
// lists every conversation it was assembled from under `conversation_id`; this points at the one it
// began as. Written once because the head and every document the thread writes both carry it, and
// two copies of the expression drift.
const sourceOf = (input: RenderThreadInput): string => `conversation ${input.conversationIds[0] ?? ''}`;

const stampFor = (deps: RenderThreadDeps, input: RenderThreadInput, first: MailMessage, last: MailMessage): DocumentStamp => ({
  source: sourceOf(input),
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
    ['source', sourceOf(input)],
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

export const createRenderThread =
  (deps: RenderThreadDeps): RenderThread =>
  async (input) => {
    const held = await messagesOf(deps, input.conversationIds);
    if (!held.ok) return held;
    const alive = inReceivedOrder(held.value.filter((message) => !message.isDeleted));
    const first = alive[0];
    if (first === undefined) return ok({ kind: 'empty' });
    // Asked once, not twice: a list with a first element has a last one, so testing both said the
    // same thing in two ways and neither way could be wrong on its own. `first` stands in for the
    // case the compiler insists on and nothing can reach.
    const last = alive[alive.length - 1] ?? first;
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
  const attachments = await attachmentsOf(deps, { here: place.here, mailboxRoot: deps.mailboxRoot, maxBytes: input.maxBytes, stored: input.attachments }, parts, stamp);
  const links = await linkedFiles(deps, place.here, input.maxBytes, parts);
  // Everything the thread carried sits inside the thread's own folder, so every reference below is
  // relative to `here` and stays within the directory a reader already has open.
  const here = place.here;
  const cards = `${here}/${ATTACHMENTS_FOLDER}`;
  const bodies = rewriteBodies(here, cards, parts, attachments.byMessage);
  const shown = new Set([...bodies.pictures, ...attachments.media]);
  // The head cites the thread's OWN cards, not the store three levels up, so a reader follows a
  // path that stays inside the folder they already opened.
  const cardPaths = await writeCards(deps, { threadId: input.threadId, here, folder: cards }, parts, attachments.byMessage, shown);
  await writeLinkCards(deps, input.threadId, place.here, links.referenced);
  const attachmentRefs = cardPaths.map((path) => pathBetween(here, path));
  const inlineRefs = bodies.pictures.map((path) => pathBetween(here, path));
  // Linked files are written from the thread's own folder, exactly as attachments are: both climb out
  // of it to a store the whole mailbox shares, and a reader follows either one the same way.
  const linkedRefs = links.paths.map((path) => pathBetween(here, path));
  const header = threadHeader(input, parts, first, last, stamp.syncedAt, attachmentRefs, inlineRefs, linkedRefs);
  const written = await deps.files.writeText(`${deps.mailboxRoot}/${relative}`, `${header}\n\n${renderThread({ subject: first.subject, parts: bodies.parts }, deps.timezone)}\n`);
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
