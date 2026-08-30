import { contentHash } from '../domain/content-hash.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import type { AttachmentRecord } from '../domain/mail-state.ts';
import { carriesInlineImage } from '../domain/inline-image.ts';
import { isOpaqueName } from '../domain/opaque-name.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { ReportEntry } from '../domain/report.ts';
import { skipReason, tooLargeReason } from '../domain/report.ts';
import { uniqueName } from '../domain/thread-card.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ConvertAttachment } from './convert-attachment.ts';
import type { MailAttachment, MailReader, MailReaderError } from './ports/mail-reader.ts';

// What placing a file costs, named rather than taken whole: this asks the mailbox to list what a
// message carried and the converter to read it. It never touches the drive, never writes a
// document itself, and knows nothing about threads beyond the folder it was handed.
export type FileDeps = {
  readonly reader: Pick<MailReader, 'attachments' | 'attachmentBytes' | 'attachmentMarkdown'>;
  readonly convertAttachment: ConvertAttachment;
};

// Where a thread keeps what its messages attached, and where the mailbox keeps what they showed.
export const ATTACHMENTS_FOLDER = '_attachments';

// What the caller has to say for a file to be placed: how big is too big, where this thread's own
// folder is, and where the mailbox keeps the pictures every thread shares.
export type FilePlace = {
  readonly here: string;
  readonly mailboxRoot: string;
  readonly maxBytes: number;
  readonly stored: Readonly<Record<string, AttachmentRecord>>;
};

// What one message carried, kept per message rather than per thread: the body that message rendered
// to is the one place a reader looks for it, and a thread-wide list cannot say which message it came
// with. A file the thread already stored for an earlier message is recorded again here, pointing at
// the same copy on disk, so every message that carried it names it.
export type MessageFile = {
  readonly attachment: MailAttachment;
  // The name the file was written under inside this thread's folder. Always present, taken before a
  // single byte is fetched, so a file that never arrives still has a card to be recorded on and a
  // name for the body to link at. The card is this plus `.md`, so the two cannot drift.
  readonly asName: string;
  readonly paths: ReadonlyArray<string>;
  readonly primary?: string;
  // Set only for a picture the message showed inside itself: the file to display, and the words
  // read off it. Both travel with the message rather than with the thread, because a body is the
  // one place either is named.
  readonly picture?: string;
  readonly text?: string;
  readonly note?: string;
};

type Media = ReadonlyArray<string>;

export type AttachmentTally = {
  readonly paths: ReadonlyArray<string>;
  readonly store: Readonly<Record<string, AttachmentRecord>>;
  readonly byMessage: Readonly<Record<string, ReadonlyArray<MessageFile>>>;
  // Pictures taken out of the documents themselves. Written, recorded, and left out of the head of
  // the thread: the document's own markdown links them under `## Images`.
  readonly media: Media;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
};

type Placed = {
  readonly asName: string;
  readonly paths: ReadonlyArray<string>;
  readonly primary?: string;
  readonly picture?: string;
  readonly text?: string;
  readonly media?: Media;
  readonly skipped?: ReportEntry;
  readonly failed?: ReportEntry;
};

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

const addressOf = async (deps: FileDeps, messageId: string, attachment: MailAttachment): Promise<Result<Addressed, MailReaderError>> => {
  if (attachment.kind !== 'item') {
    const raw = await deps.reader.attachmentBytes(messageId, attachment.id);
    return raw.ok ? ok({ hash: contentHash(raw.value) }) : raw;
  }
  const rendered = await deps.reader.attachmentMarkdown(messageId, attachment.id);
  return rendered.ok ? ok({ hash: contentHash(new TextEncoder().encode(rendered.value)), rendered: rendered.value }) : rendered;
};

// A picture the message showed inside itself, as against a file it attached. Both arrive as
// attachments and Graph tells them apart by `isInline`, which it sets for anything the body points
// at by `cid:`. Only an image is treated this way: a `cid:`-referenced PDF is still a document.
const isInlinePicture = (attachment: MailAttachment): boolean => attachment.isInline && attachment.contentType.startsWith('image/');

const INLINE_FOLDER = '_inline';

// A record written before pictures carried their reading has nothing to put in a body, so it is
// treated as though the picture had never been stored: converting it again is cheap and self-
// healing, where showing it wordlessly would be a silent loss no run ever repaired.
const withText = (record: AttachmentRecord | undefined): AttachmentRecord | undefined => (record?.text === undefined ? undefined : record);

const placeAttachment = async (
  deps: FileDeps,
  place: FilePlace,
  store: Record<string, AttachmentRecord>,
  shared: Record<string, AttachmentRecord>,
  taken: string[],
  messageId: string,
  attachment: MailAttachment,
  stamp: DocumentStamp
): Promise<Placed> => {
  // The size cap is checked before the bytes are pulled, so a file past it is reported without ever
  // being downloaded. A kind we do not read is caught by the converter, which is the one authority
  // on that; by then the file is already in hand, so the only skip it can report is unsupported.
  // Named before anything is fetched, so a file that never arrives still has somewhere to be
  // recorded. A card for a file too large to pull, or of a kind nothing reads, is the only place
  // its arrival and the reason are written down, and the body needs a name to link at.
  const inline = isInlinePicture(attachment);
  const asName = uniqueName(attachment.name, taken);
  taken.push(asName);
  if (attachment.size > place.maxBytes) return { asName, paths: [], skipped: { path: attachment.name, reason: tooLargeReason(place.maxBytes) } };
  const address = await addressOf(deps, messageId, attachment);
  if (!address.ok) return { asName, paths: [], failed: { path: attachment.name, reason: `${address.error.kind}: ${address.error.message}` } };
  const hash = address.value.hash;
  // Within this thread only. A signature riding on ten messages of one conversation is converted
  // once; the same file arriving in another thread is written there too, because a thread folder
  // that has to reach into another thread to be read is not self-contained.
  // A picture is shared by the whole mailbox, an attachment by its thread alone. A signature logo
  // rides on every message its sender ever wrote, so storing one per thread would write the same
  // hundred kilobytes into every folder; a spreadsheet belongs to the conversation it was sent in.
  // A record from an older run holding no text is treated as unseen, since the picture would
  // otherwise be shown in this thread with nothing under it.
  const seen = inline ? withText(shared[hash]) : store[hash];
  if (seen !== undefined) return { asName: seen.name, paths: seen.paths, primary: seen.primary, picture: inline ? seen.primary : undefined, text: seen.text, media: seen.media };
  const folder = inline ? `${place.mailboxRoot}/${INLINE_FOLDER}` : `${place.here}/${ATTACHMENTS_FOLDER}`;
  // A shared folder needs names that cannot collide across every thread that writes into it, which
  // is what the content address gives. Inside one thread only a same-name-different-content pair
  // needs separating, and a number says that more plainly than ten hex.
  const storedAs = inline ? disambiguateSegment(attachment.name, hash) : asName;
  const rendered = address.value.rendered;
  const outcome = await deps.convertAttachment({ messageId, attachment, folder, stamp, maxBytes: place.maxBytes, asName: storedAs, rendered, textOnly: inline });
  if (outcome.kind === 'skipped') return { asName, paths: [], skipped: { path: attachment.name, reason: skipReason(outcome.reason, place.maxBytes, attachment.name) } };
  if (outcome.kind === 'failed') return { asName, paths: [], failed: { path: attachment.name, reason: outcome.reason } };
  const record = { name: storedAs, paths: outcome.outputs, primary: outcome.primary, media: outcome.media, text: outcome.text };
  if (inline) shared[hash] = record;
  else store[hash] = record;
  return { asName: storedAs, paths: outcome.outputs, primary: outcome.primary, picture: inline ? outcome.primary : undefined, text: outcome.text, media: outcome.media };
};

export const attachmentsOf = async (deps: FileDeps, place: FilePlace, parts: ReadonlyArray<ThreadPart>, stamp: DocumentStamp): Promise<AttachmentTally> => {
  const store: Record<string, AttachmentRecord> = {};
  // Pictures shown inside message bodies, which the whole mailbox shares, seeded with what earlier
  // threads stored so a signature logo is written once rather than once per conversation.
  const shared: Record<string, AttachmentRecord> = { ...place.stored };
  const taken: string[] = [];
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
      const placed = await placeAttachment(deps, place, store, shared, taken, part.message.id, attachment, stamp);
      for (const path of placed.paths) if (!paths.includes(path)) paths.push(path);
      if (placed.skipped) skipped.push(placed.skipped);
      if (placed.failed) failed.push(placed.failed);
      for (const path of placed.media ?? []) if (!media.includes(path)) media.push(path);
      // Counted above and then dropped: a file nothing can read, named by a machine id, has no fact
      // left to record. Sharing notifications carry a handful each, and a card apiece buried the
      // real attachments of the same vault. It keeps its place in `taken`, so the numbering of what
      // follows does not shift with a decision about what to show.
      if (placed.skipped !== undefined && isOpaqueName(attachment.name)) continue;
      carried.push({
        attachment,
        asName: placed.asName,
        paths: placed.paths,
        primary: placed.primary,
        picture: placed.picture,
        text: placed.text,
        note: placed.skipped?.reason ?? placed.failed?.reason,
      });
    }
    byMessage[part.message.id] = carried;
  }
  // Both stores fold into the one the run remembers: the shared pictures so a later thread finds
  // them, this thread's files so the mailbox index names everything on disk.
  return { paths, store: { ...shared, ...store }, byMessage, media, skipped, failed };
};
