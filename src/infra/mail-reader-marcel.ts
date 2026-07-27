import { parseMailFolders } from '../domain/mail-folder.ts';
import { parseMailDelta, parseMessage } from '../domain/mail-message.ts';
import type { MailDeltaPage, MailMessage } from '../domain/mail-message.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { LinkedFile, MailAttachment, MailReader, MailReaderError } from '../use-cases/ports/mail-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

const listOf = (value: unknown): ReadonlyArray<unknown> => (isRecord(value) && Array.isArray(value['value']) ? value['value'] : []);

const toBytes = (value: unknown): Result<Uint8Array, MailReaderError> => {
  const base64 = readString(value, 'base64');
  if (base64 !== undefined) return ok(new Uint8Array(Buffer.from(base64, 'base64')));
  const text = readString(value, 'text');
  return text === undefined ? err({ kind: 'permanent', message: 'Graph returned no bytes' }) : ok(new TextEncoder().encode(text));
};

const toAttachment = (value: unknown): ReadonlyArray<MailAttachment> => {
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  if (id === undefined || name === undefined || !isRecord(value)) return [];
  const size = value['size'];
  return [{ id, name, contentType: readString(value, 'contentType') ?? '', size: typeof size === 'number' ? size : 0, isInline: value['isInline'] === true }];
};

// `extract-sharepoint-links-in-mail` reports a link it could not resolve with an `error` instead of
// a driveItem; those are dropped rather than chased.
const toLinks = (value: unknown): ReadonlyArray<LinkedFile> => {
  if (!isRecord(value) || !Array.isArray(value['links'])) return [];
  return value['links'].flatMap((entry) => {
    const driveId = readString(entry, 'driveId');
    const itemId = readString(entry, 'itemId');
    if (driveId === undefined || itemId === undefined) return [];
    return [{ url: readString(entry, 'url') ?? '', driveId, itemId, name: readString(entry, 'name') ?? itemId }];
  });
};

export const createMailReaderFromCall = (call: MarcelCall): MailReader => {
  const delta = async (name: string, params: Record<string, string>): Promise<Result<MailDeltaPage, MailReaderError>> => {
    const raw = await call(name, params);
    if (!raw.ok) return raw;
    const page = parseMailDelta(raw.value);
    return page.ok ? ok(page.value) : err({ kind: 'permanent', message: page.error.message });
  };

  const textOf = async (name: string, params: Record<string, string>): Promise<Result<string, MailReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? ok(readString(raw.value, 'text') ?? '') : raw;
  };

  const bytesOf = async (name: string, params: Record<string, string>): Promise<Result<Uint8Array, MailReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? toBytes(raw.value) : raw;
  };

  return {
    listFolders: async () => {
      const raw = await call('list-mail-folders', { top: '200' });
      return raw.ok ? ok(parseMailFolders(raw.value)) : raw;
    },
    listChildFolders: async (folderId) => {
      const raw = await call('list-mail-child-folders', { mailFolderId: folderId, top: '200' });
      return raw.ok ? ok(parseMailFolders(raw.value)) : raw;
    },
    // `top` is safe since ask-marcel-office-cli 2.3.0: it is sent as `Prefer: odata.maxpagesize`, a
    // page-size hint that pages correctly, not the `$top` that used to read as "sync complete" and
    // drop the rest of the folder. A page of 100 cuts round trips on a large folder while keeping
    // each response small; paging continues through `nextLink` if Graph caps the page lower.
    folderDelta: async (folderId) =>
      delta('list-mail-folder-messages-delta', { mailFolderId: folderId, top: '100', select: 'id,conversationId,subject,receivedDateTime,hasAttachments,from,toRecipients' }),
    deltaFrom: async (cursor) => delta('next-page', { url: cursor }),
    conversation: async (conversationId) => {
      const raw = await call('list-conversation-messages', { conversationId, select: 'id,conversationId,subject,receivedDateTime,hasAttachments,from,toRecipients' });
      if (!raw.ok) return raw;
      return ok(
        listOf(raw.value)
          .map(parseMessage)
          .filter((message): message is MailMessage => message !== undefined)
      );
    },
    messageMarkdown: async (messageId) => textOf('convert-mail-to-markdown', { messageId }),
    attachments: async (messageId) => {
      const raw = await call('list-mail-attachments', { messageId });
      return raw.ok ? ok(listOf(raw.value).flatMap(toAttachment)) : raw;
    },
    attachmentMarkdown: async (messageId, attachmentId) => textOf('convert-mail-attachment-to-markdown', { messageId, attachmentId, includeMetadata: 'true' }),
    attachmentPdf: async (messageId, attachmentId) => bytesOf('convert-mail-attachment-to-pdf', { messageId, attachmentId }),
    attachmentBytes: async (messageId, attachmentId) => bytesOf('get-mail-attachment', { messageId, attachmentId }),
    sharepointLinks: async (messageId) => {
      const raw = await call('extract-sharepoint-links-in-mail', { messageId });
      return raw.ok ? ok(toLinks(raw.value)) : raw;
    },
  };
};
