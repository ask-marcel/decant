import { parseMailFolders } from '../domain/mail-folder.ts';
import { parseMailDelta } from '../domain/mail-message.ts';
import type { MailDeltaPage, MailMessage } from '../domain/mail-message.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { AttachmentKind, LinkedFile, MailAttachment, MailReader, MailReaderError } from '../use-cases/ports/mail-reader.ts';
import { mediaOf } from './drive-reader-marcel.ts';
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

const KIND_BY_TYPE: Readonly<Partial<Record<string, AttachmentKind>>> = {
  '#microsoft.graph.itemAttachment': 'item',
  '#microsoft.graph.referenceAttachment': 'reference',
};

// Graph returns the discriminator whatever the select asks for, and a shape it does not name is a
// file: that is the common case and the only one carrying bytes.
const kindOf = (value: unknown): AttachmentKind => KIND_BY_TYPE[readString(value, '@odata.type') ?? ''] ?? 'file';

const toAttachment = (value: unknown): ReadonlyArray<MailAttachment> => {
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  if (id === undefined || name === undefined || !isRecord(value)) return [];
  const size = value['size'];
  return [
    {
      kind: kindOf(value),
      id,
      name,
      contentType: readString(value, 'contentType') ?? '',
      size: typeof size === 'number' ? size : 0,
      isInline: value['isInline'] === true,
      contentId: readString(value, 'contentId') ?? '',
    },
  ];
};

// The library's own default select leaves `contentId` out, so an inline image would arrive with no
// way to tell which `cid:` in the body it answers to. The cast is what Graph requires to reach a
// field that only file attachments carry, and it is the same string the library uses internally.
const ATTACHMENT_FIELDS = 'id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId';

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

  // Graph answers a message collection a page at a time, so everything a thread holds is only in hand
  // once its cursor runs out. The `seen` set is the same guard the folder sweep keeps: a cursor that
  // points at itself would otherwise loop forever.
  const messagesFrom = async (name: string, params: Record<string, string>): Promise<Result<ReadonlyArray<MailMessage>, MailReaderError>> => {
    const first = await delta(name, params);
    if (!first.ok) return first;
    const messages: MailMessage[] = [...first.value.messages];
    const seen = new Set<string>();
    let page = first.value;
    while (page.nextLink !== undefined && !seen.has(page.nextLink)) {
      seen.add(page.nextLink);
      const next = await delta('next-page', { url: page.nextLink });
      if (!next.ok) return next;
      messages.push(...next.value.messages);
      page = next.value;
    }
    return ok(messages);
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
    // A page hint of 100 rather than the ten Graph gives by default, which is safe here in a way it is
    // not on a delta: this is an ordinary collection, so a page smaller than asked for still answers
    // with a cursor, and the loop above follows it.
    conversation: async (conversationId) =>
      messagesFrom('list-conversation-messages', { conversationId, top: '100', select: 'id,conversationId,subject,receivedDateTime,hasAttachments,from,toRecipients' }),
    messageMarkdown: async (messageId) => textOf('convert-mail-to-markdown', { messageId }),
    attachments: async (messageId) => {
      const raw = await call('list-mail-attachments', { messageId, select: ATTACHMENT_FIELDS });
      return raw.ok ? ok(listOf(raw.value).flatMap(toAttachment)) : raw;
    },
    attachmentMarkdown: async (messageId, attachmentId) => textOf('convert-mail-attachment-to-markdown', { messageId, attachmentId, includeMetadata: 'true' }),
    attachmentPdf: async (messageId, attachmentId) => bytesOf('convert-mail-attachment-to-pdf', { messageId, attachmentId }),
    attachmentBytes: async (messageId, attachmentId) => bytesOf('get-mail-attachment', { messageId, attachmentId }),
    attachmentImages: async (messageId, attachmentId) => {
      const raw = await call('extract-mail-attachment-images', { messageId, attachmentId });
      return raw.ok ? ok(mediaOf(raw.value)) : raw;
    },
    sharepointLinks: async (messageId) => {
      const raw = await call('extract-sharepoint-links-in-mail', { messageId });
      return raw.ok ? ok(toLinks(raw.value)) : raw;
    },
  };
};
