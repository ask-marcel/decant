// The one place a thread is rendered for a test. Every module the renderer was split into is
// exercised through it, because what each of them does is only visible in the documents the whole
// run writes: a card names a file the placement chose, and a body links a card the writing made.
// Wiring them apart with narrower fakes would test the seams rather than the vault.

import type { AttachmentRecord } from '../domain/mail-state.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import { threadIdOf } from '../domain/thread-id.ts';
import { createClockFake } from './clock-fake.ts';
import { createDriveReaderFake } from './drive-reader-fake.ts';
import type { DriveReaderSeed } from './drive-reader-fake.ts';
import type { FilesFake, FilesFakeSeed } from './files-fake.ts';
import { createFilesFake } from './files-fake.ts';
import { createLoggerFake } from './logger-fake.ts';
import type { LoggerFake } from './logger-fake.ts';
import type { MailReaderSeed } from './mail-reader-fake.ts';
import { createMailReaderFake } from './mail-reader-fake.ts';
import { createOcrFake } from './ocr-fake.ts';
import type { OcrSeed } from './ocr-fake.ts';
import { createProgressFake } from './progress-fake.ts';
import { createConvertAttachment } from '../use-cases/convert-attachment.ts';
import { createConvertFile } from '../use-cases/convert-file.ts';
import { createRenderThread } from '../use-cases/render-thread.ts';
import type { MailReaderError } from '../use-cases/ports/mail-reader.ts';
import type { RenderThreadOutcome } from '../use-cases/render-thread.ts';

export const CONV = 'AAQkADk0...=';
// Named once, from the thread's FIRST message, and never again: the day it began, the id its root
// message hashes to, and what it is about. A reply no longer moves it, which is why one constant
// serves where a replied-to thread used to need its own.
export const ROOT = '<AM0PR04MB6f21@example.com>';
export const THREAD_ID = threadIdOf(ROOT);
export const THREAD_FOLDER = `2026-05-12-${THREAD_ID}-contrat-contoso`;
export const THREAD_RELATIVE = `threads/${THREAD_FOLDER}/contrat-contoso.md`;
export const THREAD_FILE = `kb/Mailbox/${THREAD_RELATIVE}`;
// Everything a thread received lives beside it: the file and the card that stands for it, in the
// thread's own folder. There is no store shared across threads any more.
export const ATTACHMENTS_STORE = `kb/Mailbox/threads/${THREAD_FOLDER}/_attachments`;
export const INLINE_STORE = 'kb/Mailbox/_inline';
// A body that carries a SharePoint address, since that is what makes the run ask a message what it
// points at. Real mail carries the address in its text; a message with none is never asked.
export const LINK_BODIES = { m1: 'See https://tenant.sharepoint.com/sites/team/Rapport.docx', m2: 'See https://tenant.sharepoint.com/sites/team/Rapport.docx' };
// The bytes the mail-reader fake hands back for an attachment, so a test can address its store copy.
export const bytesOf = (attachmentId: string): Uint8Array => new TextEncoder().encode(`bytes ${attachmentId}`);
// The name an attachment lands under. No content address in it: one thread's folder only has to
// separate a same-name-different-content pair, which a number says more plainly than a hash.
export const storedName = (name: string): string => name;

export const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm1',
  conversationId: CONV,
  subject: 'Contrat Contoso',
  received: '2026-05-12T09:31:00Z',
  hasAttachments: false,
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ name: 'Vincent DELACOURT', address: 'vincent@example.com' }],
  isDeleted: false,
  ...over,
});

export const run = async (
  seeds: {
    reader?: MailReaderSeed;
    drive?: DriveReaderSeed;
    files?: FilesFakeSeed;
    conversationIds?: string[];
    folder?: string;
    linked?: Record<string, { paths: string[] }>;
    attachments?: Record<string, AttachmentRecord>;
    ocr?: OcrSeed;
  } = {}
): Promise<{
  outcome: RenderThreadOutcome | undefined;
  files: FilesFake;
  logger: LoggerFake;
  reader: ReturnType<typeof createMailReaderFake>;
  drive: ReturnType<typeof createDriveReaderFake>;
  error: MailReaderError | undefined;
  ok: boolean;
}> => {
  const files = createFilesFake(seeds.files);
  const logger = createLoggerFake();
  const reader = createMailReaderFake(seeds.reader);
  const drive = createDriveReaderFake(seeds.drive);
  const render = createRenderThread({
    reader,
    drive,
    files,
    logger,
    clock: createClockFake(),
    mailboxRoot: 'kb/Mailbox',
    timezone: 'Europe/Paris',
    convertAttachment: createConvertAttachment({ reader, files, ocr: createOcrFake(seeds.ocr), logger, unpackArchive: drive.localArchive, convertLocal: drive.localMarkdown }),
    convertFile: createConvertFile({ reader: drive, files, ocr: createOcrFake(), clock: createClockFake(), logger, progress: createProgressFake() }),
  });
  const result = await render({
    threadId: THREAD_ID,
    conversationIds: seeds.conversationIds ?? [CONV],
    root: ROOT,
    folder: seeds.folder ?? '',
    maxBytes: 50 * 1024 * 1024,
    linked: seeds.linked ?? {},
    attachments: seeds.attachments ?? {},
  });
  return { outcome: result.ok ? result.value : undefined, error: result.ok ? undefined : result.error, files, logger, reader, drive, ok: result.ok };
};
