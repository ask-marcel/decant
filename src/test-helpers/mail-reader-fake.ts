import type { MailFolder } from '../domain/mail-folder.ts';
import type { MailDeltaPage, MailMessage } from '../domain/mail-message.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { LinkedFile, MailAttachment, MailReader, MailReaderError } from '../use-cases/ports/mail-reader.ts';

export type MailReaderSeed = {
  readonly folders?: ReadonlyArray<MailFolder>;
  readonly children?: Readonly<Record<string, ReadonlyArray<MailFolder>>>;
  // Delta pages served in order across every folder, the way a run consumes them.
  readonly pages?: ReadonlyArray<MailDeltaPage>;
  readonly conversations?: Readonly<Record<string, ReadonlyArray<MailMessage>>>;
  readonly bodies?: Readonly<Record<string, string>>;
  readonly attachments?: Readonly<Record<string, ReadonlyArray<MailAttachment>>>;
  // Keyed by attachment id, so one attachment can convert to nothing while its bytes still arrive.
  readonly attachmentTexts?: Readonly<Record<string, string>>;
  readonly links?: Readonly<Record<string, ReadonlyArray<LinkedFile>>>;
  readonly failWith?: MailReaderError;
  readonly failMessages?: Readonly<Record<string, MailReaderError>>;
  // Fails only the listing of what a message carried, leaving its body readable.
  readonly failAttachmentList?: MailReaderError;
  // Fails one kind of call only, keyed by its name, so a single guard can be exercised alone.
  readonly failCalls?: Readonly<Record<string, MailReaderError>>;
};

export type MailReaderFake = MailReader & { readonly calls: Array<string> };

export const createMailReaderFake = (seed: MailReaderSeed = {}): MailReaderFake => {
  const calls: string[] = [];
  let pageIndex = 0;
  const nextPage = (): MailDeltaPage => {
    const page = seed.pages?.[pageIndex];
    pageIndex += 1;
    return page ?? { messages: [], skipped: 0 };
  };
  const forMessage = <T>(messageId: string, label: string, value: T): Result<T, MailReaderError> => {
    calls.push(`${label}:${messageId}`);
    const failure = seed.failMessages?.[messageId] ?? seed.failWith;
    return failure ? err(failure) : ok(value);
  };
  return {
    calls,
    listFolders: async () => (seed.failWith ? err(seed.failWith) : ok(seed.folders ?? [])),
    listChildFolders: async (folderId) => {
      const refused = seed.failCalls?.['listChildFolders'] ?? seed.failWith;
      return refused ? err(refused) : ok(seed.children?.[folderId] ?? []);
    },
    folderDelta: async (folderId) => {
      calls.push(`folderDelta:${folderId}`);
      const refused = seed.failCalls?.['folderDelta'] ?? seed.failWith;
      return refused ? err(refused) : ok(nextPage());
    },
    deltaFrom: async (cursor) => {
      calls.push(`deltaFrom:${cursor}`);
      return seed.failWith ? err(seed.failWith) : ok(nextPage());
    },
    conversation: async (conversationId) => {
      calls.push(`conversation:${conversationId}`);
      if (seed.failWith) return err(seed.failWith);
      return ok(seed.conversations?.[conversationId] ?? []);
    },
    messageMarkdown: async (messageId) => forMessage(messageId, 'body', seed.bodies?.[messageId] ?? `body of ${messageId}`),
    attachments: async (messageId) => {
      if (seed.failAttachmentList) {
        calls.push(`attachments:${messageId}`);
        return err(seed.failAttachmentList);
      }
      return forMessage(messageId, 'attachments', seed.attachments?.[messageId] ?? []);
    },
    attachmentMarkdown: async (messageId, attachmentId) => {
      const refused = seed.failCalls?.['attachmentMarkdown'];
      return refused ? err(refused) : forMessage(messageId, `attachmentMarkdown:${attachmentId}`, seed.attachmentTexts?.[attachmentId] ?? `converted ${attachmentId}`);
    },
    attachmentPdf: async (messageId, attachmentId) => {
      const refused = seed.failCalls?.['attachmentPdf'];
      return refused ? err(refused) : forMessage(messageId, `attachmentPdf:${attachmentId}`, new TextEncoder().encode(`%PDF ${attachmentId}`));
    },
    attachmentBytes: async (messageId, attachmentId) => {
      const refused = seed.failCalls?.['attachmentBytes'];
      return refused ? err(refused) : forMessage(messageId, `attachmentBytes:${attachmentId}`, new TextEncoder().encode(`bytes ${attachmentId}`));
    },
    sharepointLinks: async (messageId) => forMessage(messageId, 'links', seed.links?.[messageId] ?? []),
  };
};
