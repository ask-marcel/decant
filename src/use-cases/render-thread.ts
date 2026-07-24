import type { DocumentStamp } from '../domain/kb-document.ts';
import { kbDocument } from '../domain/kb-document.ts';
import { inReceivedOrder } from '../domain/mail-message.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { ThreadRecord } from '../domain/mail-state.ts';
import { renderFrontMatter } from '../domain/front-matter.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { participantsOf, renderThread, threadFileName, threadTitle, threadYear } from '../domain/thread.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ConvertAttachment } from './convert-attachment.ts';
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
  readonly clock: Clock;
  readonly logger: Logger;
  readonly mailboxRoot: string;
};

export type RenderThreadInput = {
  readonly conversationId: string;
  readonly maxBytes: number;
  readonly ocrLabel: string;
  // Files already pulled from SharePoint by an earlier thread, so one link is fetched once.
  readonly linked: Readonly<Record<string, { readonly path: string }>>;
};

export type RenderedThread = {
  readonly record: ThreadRecord;
  readonly linked: Readonly<Record<string, { readonly path: string }>>;
  readonly attachmentsSkipped: number;
  readonly attachmentsFailed: number;
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

// A file already pulled for another thread is referenced, not fetched again: the same weekly report
// linked from thirty mails is one document on disk.
const linkedFiles = async (
  deps: RenderThreadDeps,
  input: RenderThreadInput,
  messages: ReadonlyArray<MailMessage>
): Promise<{ readonly paths: ReadonlyArray<string>; readonly linked: Record<string, { readonly path: string }> }> => {
  const linked: Record<string, { path: string }> = { ...input.linked };
  const paths: string[] = [];
  for (const message of messages) {
    const found = await deps.reader.sharepointLinks(message.id);
    if (!found.ok) continue;
    for (const link of found.value) {
      const key = `${link.driveId}:${link.itemId}`;
      const known = linked[key] ?? (await pullLinked(deps, link.driveId, link.itemId, link.name));
      if (known === undefined) continue;
      linked[key] = known;
      if (!paths.includes(known.path)) paths.push(known.path);
    }
  }
  return { paths, linked };
};

const pullLinked = async (deps: RenderThreadDeps, driveId: string, itemId: string, name: string): Promise<{ readonly path: string } | undefined> => {
  const converted = await deps.drive.markdown({ driveId, itemId });
  if (!converted.ok) {
    deps.logger.warn('linked.failed', { itemId, cause: converted.error.kind });
    return undefined;
  }
  const path = `${deps.mailboxRoot}/${LINKED_FOLDER}/${name}.md`;
  const stamp: DocumentStamp = { source: `drive ${driveId}`, site: 'Mailbox', library: LINKED_FOLDER, path: name, lastModified: '', syncedAt: deps.clock.nowIso() };
  const written = await deps.files.writeText(path, kbDocument(stamp, converted.value));
  if (!written.ok) {
    deps.logger.warn('linked.failed', { itemId, cause: written.error.kind });
    return undefined;
  }
  return { path };
};

type AttachmentTally = { readonly paths: ReadonlyArray<string>; readonly skipped: number; readonly failed: number };

const attachmentsOf = async (
  deps: RenderThreadDeps,
  input: RenderThreadInput,
  parts: ReadonlyArray<ThreadPart>,
  folder: string,
  stamp: DocumentStamp
): Promise<AttachmentTally> => {
  const paths: string[] = [];
  // A signature logo rides on every message of a thread, so the same file is offered many times.
  // Converting it once is both correct and far cheaper: the name is what identifies it on disk.
  const seen = new Set<string>();
  let skipped = 0;
  let failed = 0;
  for (const part of parts.filter((candidate) => candidate.message.hasAttachments)) {
    const listed = await deps.reader.attachments(part.message.id);
    if (!listed.ok) {
      failed += 1;
      continue;
    }
    for (const attachment of listed.value.filter((candidate) => !seen.has(candidate.name))) {
      seen.add(attachment.name);
      const outcome = await deps.convertAttachment({ messageId: part.message.id, attachment, folder, stamp, maxBytes: input.maxBytes, ocrLabel: input.ocrLabel });
      if (outcome.kind === 'converted') paths.push(...outcome.outputs);
      if (outcome.kind === 'skipped') skipped += 1;
      if (outcome.kind === 'failed') failed += 1;
    }
  }
  return { paths, skipped, failed };
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
  const fileName = threadFileName({ conversationId: input.conversationId, subject: first.subject, firstReceived: first.received });
  const relative = `threads/${threadYear(first.received)}/${fileName}`;
  const folder = `${deps.mailboxRoot}/threads/${threadYear(first.received)}/${fileName.replace(/\.md$/, '')}_attachments`;
  const stamp = stampFor(deps, input, first, last);
  const attachments = await attachmentsOf(deps, input, parts, folder, stamp);
  const links = await linkedFiles(
    deps,
    input,
    parts.map((part) => part.message)
  );
  const here = `${deps.mailboxRoot}/threads/${threadYear(first.received)}`;
  const header = threadHeader(input, parts, first, last, stamp.syncedAt, relativeTo(here, attachments.paths), relativeTo(deps.mailboxRoot, links.paths));
  const written = await deps.files.writeText(
    `${deps.mailboxRoot}/${relative}`,
    `${header}\n\n${renderThread({ conversationId: input.conversationId, subject: first.subject, parts })}\n`
  );
  if (!written.ok) return err({ kind: 'permanent', message: written.error.message });
  return ok({
    kind: 'rendered',
    thread: {
      record: { file: relative, messageIds: parts.map((part) => part.message.id), lastMessage: last.received, attachments: attachments.paths },
      linked: links.linked,
      attachmentsSkipped: attachments.skipped,
      attachmentsFailed: attachments.failed,
    },
  });
};
