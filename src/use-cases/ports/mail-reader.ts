import type { MailDeltaPage, MailMessage } from '../../domain/mail-message.ts';
import type { MailFolder } from '../../domain/mail-folder.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError, EmbeddedImage } from './drive-reader.ts';

// Mail fails the same ways SharePoint does: the same Graph client is underneath, and the run reacts
// to a throttle or a lapsed sign-in identically whichever side it came from.
export type MailReaderError = DriveReaderError;

// What Graph calls the attachment, which decides how it is read rather than its name does. A file
// carries bytes; an item is an email, event or contact embedded in the message and carries none, so
// Graph answers a request for its bytes with the item itself; a reference points at a shared file.
export type AttachmentKind = 'file' | 'item' | 'reference';

export type MailAttachment = {
  readonly kind: AttachmentKind;
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly isInline: boolean;
  // The `cid:` an inline image is addressed by in the body it belongs to. Empty when Graph reports
  // none, which is every attachment that is not referenced from the message itself.
  readonly contentId: string;
};

export type LinkedFile = {
  readonly url: string;
  readonly driveId: string;
  readonly itemId: string;
  readonly name: string;
};

export type MailReader = {
  readonly listFolders: () => Promise<Result<ReadonlyArray<MailFolder>, MailReaderError>>;
  readonly listChildFolders: (folderId: string) => Promise<Result<ReadonlyArray<MailFolder>, MailReaderError>>;
  // No page size is asked for: Outlook's message delta truncates when given one, answering with a
  // "you are up to date" cursor and dropping the rest of the folder.
  readonly folderDelta: (folderId: string) => Promise<Result<MailDeltaPage, MailReaderError>>;
  readonly deltaFrom: (cursor: string) => Promise<Result<MailDeltaPage, MailReaderError>>;
  readonly conversation: (conversationId: string) => Promise<Result<ReadonlyArray<MailMessage>, MailReaderError>>;
  readonly messageMarkdown: (messageId: string) => Promise<Result<string, MailReaderError>>;
  readonly attachments: (messageId: string) => Promise<Result<ReadonlyArray<MailAttachment>, MailReaderError>>;
  readonly attachmentMarkdown: (messageId: string, attachmentId: string) => Promise<Result<string, MailReaderError>>;
  readonly attachmentPdf: (messageId: string, attachmentId: string) => Promise<Result<Uint8Array, MailReaderError>>;
  readonly attachmentBytes: (messageId: string, attachmentId: string) => Promise<Result<Uint8Array, MailReaderError>>;
  // The pictures a document attached to a mail holds. Same answer as the drive side gives for a file
  // found by sweeping a library, since a diagram inside a Word file survives nowhere else either.
  readonly attachmentImages: (messageId: string, attachmentId: string) => Promise<Result<ReadonlyArray<EmbeddedImage>, MailReaderError>>;
  readonly sharepointLinks: (messageId: string) => Promise<Result<ReadonlyArray<LinkedFile>, MailReaderError>>;
};
