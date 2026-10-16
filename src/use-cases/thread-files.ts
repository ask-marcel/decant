import { contentHash } from '../domain/content-hash.ts';
import type { DocumentStamp } from '../domain/kb-document.ts';
import { namedForBytes, namedForType } from '../domain/file-kind.ts';
import { disambiguateSegment } from '../domain/kb-path.ts';
import { namesHeldIn } from '../domain/mail-state.ts';
import type { AttachmentRecord } from '../domain/mail-state.ts';
import { carriesInlineImage } from '../domain/inline-image.ts';
import { isOpaqueName } from '../domain/opaque-name.ts';
import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { ReportEntry } from '../domain/report.ts';
import { cutArchiveEntry, skipReason, tooLargeReason } from '../domain/report.ts';
import { freeName } from '../domain/thread-card.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ConvertAttachment } from './convert-attachment.ts';
import type { MailAttachment, MailReader, MailReaderError } from './ports/mail-reader.ts';

// What placing a file costs, named rather than taken whole: this asks the mailbox to list what a
// message carried and the converter to read it. It never touches the drive, never writes a
// document itself, and knows nothing about threads beyond the folder it was handed.
export type FileDeps = {
  readonly reader: Pick<MailReader, 'attachments' | 'attachmentBytes' | 'attachmentMarkdown'>;
  readonly convertAttachment: ConvertAttachment;
  readonly pictures?: PicturesOfRun;
};

// Each picture a run converted into the shared store, by its content address, as the record its
// conversion left, or nothing when the conversion did not land: the store also holds the files of
// other threads by the same address, which are no picture to show. Threads written side by side
// start from one store, and each would otherwise convert the same new logo.
export type PicturesOfRun = Map<string, Promise<AttachmentRecord | undefined>>;

// Where a thread keeps what its messages attached, and where the mailbox keeps what they showed.
export const ATTACHMENTS_FOLDER = '_attachments';

// What the caller has to say for a file to be placed: how big is too big, where this thread's own
// folder is, and where the mailbox keeps the pictures every thread shares.
export type FilePlace = {
  readonly here: string;
  readonly mailboxRoot: string;
  readonly maxBytes: number;
  readonly stored: Readonly<Record<string, AttachmentRecord>>;
  // The name each file a message carried was written under at the thread's last write, by the arrival
  // it came with, and every file the thread's folder held then. Absent for a thread never written,
  // and for one written before they were kept.
  readonly names?: Readonly<Record<string, string>>;
  readonly held?: ReadonlyArray<string>;
  // How long a path may be as decant writes it. Absent, names are not cut for length.
  readonly pathBudget?: number;
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
  // A file the thread held that this write could not read: its card and its files stay as they were.
  readonly kept?: boolean;
  // The content address of what arrived, when it arrived: what tells a linked document that is this
  // same file.
  readonly hash?: string;
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
  // The name each file a message carried was written under, by the arrival it came with, so the next
  // write gives it the same one. A picture shown in a body is stored by its content, and has none.
  readonly names: Readonly<Record<string, string>>;
  // Where in the thread's folder this write could not read what the thread held: a file whose bytes
  // did not come, or every file of a message whose list did not. What sits under them is kept.
  readonly unread: ReadonlyArray<string>;
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
  // The files a zip the library read in part kept back. The zip itself was read, so it keeps its card
  // and its line, and only the report names these.
  readonly leftOut?: ReportEntry;
  readonly kept?: boolean;
  // What the card says of a file that is neither left out nor failed, a share link.
  readonly note?: string;
  readonly hash?: string;
};

// A share link a message carried, a reference to Graph: it holds no bytes, and its size is the size of
// the link Graph keeps. Asked for bytes, it failed on every run. It gets a card and nothing to fetch.
const SHARED_LINK = 'a link to a shared file, not the file: when the message text links to the file, its card is in _linked/';

// One attachment into the shared store. Its content address decides everything: a content already
// stored is referenced without being converted again; a new content is converted once, under a name
// that always carries a short slice of that address so the name is fixed by the bytes alone. That is
// what lets conversations render at the same time without ever racing to claim a name on disk.
// Where an attachment's content address comes from. A file has bytes to take one from. An item
// attachment has none at all, Graph answering a request for them with the item itself, so its
// address is the address of what it renders to: stable for the same embedded mail within a library
// version, which is what lets two threads carrying it share one copy on disk. The rendering is kept
// and handed on, so the conversion does not ask for it a second time.
// A file with bytes is also named by what it is: a picture whose bytes say another kind than its name
// takes the extension of that kind.
type Addressed = { readonly hash: string; readonly rendered?: string; readonly name?: string };

const addressOf = async (deps: FileDeps, messageId: string, attachment: MailAttachment): Promise<Result<Addressed, MailReaderError>> => {
  if (attachment.kind !== 'item') {
    const raw = await deps.reader.attachmentBytes(messageId, attachment.id);
    return raw.ok ? ok({ hash: contentHash(raw.value), name: namedForBytes(attachment.name, raw.value) }) : raw;
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
// healing, where showing it wordlessly would be a silent loss no run ever repaired. So is a record of
// a picture whose reading failed. A picture with no words carries an empty reading, and is stored.
const withText = (record: AttachmentRecord | undefined): AttachmentRecord | undefined => (record?.text === undefined ? undefined : record);

// The first name for a file that no file of this thread holds and no file before it in this write took.
const freeNameIn = (place: FilePlace, filename: string, taken: ReadonlyArray<string>): string => freeName(`${place.here}/${ATTACHMENTS_FOLDER}`, filename, taken, place.pathBudget);

// What placing the files of one write works from, and adds to as it goes.
type Placing = {
  readonly store: Record<string, AttachmentRecord>;
  readonly shared: Record<string, AttachmentRecord>;
  // Every name a file of the thread holds or this write gave out, as it lands on disk.
  readonly taken: string[];
};

// One file as a message carried it, and the name it was written under before, when it was.
type Arrival = { readonly messageId: string; readonly attachment: MailAttachment; readonly recorded?: string };

// A name is held once for the thread, however many files ask for it.
const reserve = (placing: Placing, name: string): string => {
  if (!placing.taken.includes(name)) placing.taken.push(name);
  return name;
};

// The name a file is written under: the one it had before, or the first one free.
const nameOf = (place: FilePlace, placing: Placing, arrival: Arrival): string => arrival.recorded ?? freeNameIn(place, arrival.attachment.name, placing.taken);

// A file the thread held whose bytes could not be fetched keeps what it had, under the name it had: its
// card holds the text read out of the file, and a failure written over it would be read back as the
// text by the next write. A file the thread stored is still what it was, files and all.
const keptAs = (placing: Placing, name: string, failed: ReportEntry): Placed => {
  const stored = Object.values(placing.store).find((record) => record.name === name);
  return { asName: name, paths: stored?.paths ?? [], primary: stored?.primary, media: stored?.media, failed, kept: true };
};

const placeAttachment = async (deps: FileDeps, place: FilePlace, placing: Placing, arrival: Arrival, stamp: DocumentStamp): Promise<Placed> => {
  // The size cap is checked before the bytes are pulled, so a file past it is reported without ever
  // being downloaded. A kind we do not read is caught by the converter, which is the one authority
  // on that; by then the file is already in hand, so the only skip it can report is unsupported.
  // Named before anything is fetched, so a file that never arrives still has somewhere to be
  // recorded. A card for a file too large to pull, or of a kind nothing reads, is the only place
  // its arrival and the reason are written down, and the body needs a name to link at.
  const { messageId, attachment } = arrival;
  const inline = isInlinePicture(attachment);
  if (attachment.kind === 'reference') return { asName: reserve(placing, nameOf(place, placing, arrival)), paths: [], note: SHARED_LINK };
  // Named by its content type before a byte is fetched, so a file too large to fetch is named so too.
  const typed = withName(arrival, typedName(attachment));
  if (attachment.size > place.maxBytes) {
    const asName = reserve(placing, nameOf(place, placing, typed));
    return { asName, paths: [], skipped: { path: attachment.name, reason: tooLargeReason(place.maxBytes) } };
  }
  const address = await addressOf(deps, messageId, typed.attachment);
  if (!address.ok) {
    const failed = { path: attachment.name, reason: `${address.error.kind}: ${address.error.message}` };
    if (arrival.recorded !== undefined) return keptAs(placing, arrival.recorded, failed);
    return { asName: reserve(placing, nameOf(place, placing, typed)), paths: [], failed };
  }
  const hash = address.value.hash;
  // Within this thread only. A signature riding on ten messages of one conversation is converted
  // once; the same file arriving in another thread is written there too, because a thread folder
  // that has to reach into another thread to be read is not self-contained.
  // A picture is shared by the whole mailbox, an attachment by its thread alone. A signature logo
  // rides on every message its sender ever wrote, so storing one per thread would write the same
  // hundred kilobytes into every folder; a spreadsheet belongs to the conversation it was sent in.
  // A record from an older run holding no text is treated as unseen, since the picture would
  // otherwise be shown in this thread with nothing under it.
  const seen = inline ? withText(placing.shared[hash]) : placing.store[hash];
  // A file the thread holds already keeps the name it was written under and takes no second one, so a
  // file joining it is numbered as though both had come in one write. A picture keeps its place in the
  // names however it is stored, so what follows it is numbered the same whether or not it was.
  if (seen !== undefined) {
    if (inline) reserve(placing, nameOf(place, placing, typed));
    return { asName: seen.name, paths: seen.paths, primary: seen.primary, picture: inline ? seen.primary : undefined, text: seen.text, media: seen.media, hash };
  }
  // A content new to the thread is named by what it is. A name the thread gave it before stays.
  const named = withName(typed, address.value.name);
  const asName = reserve(placing, freshName(place, placing, named));
  const fresh: Fresh = { messageId, attachment: named.attachment, sentAs: attachment.name, stamp, asName, hash, inline, rendered: address.value.rendered };
  if (inline) return convertPicture(deps, place, placing, fresh);
  return convertFresh(deps, place, placing.store, fresh);
};

// A picture is converted once for the run: a thread that meets one another thread converts, or did,
// takes the record that conversion left, words or none.
const convertPicture = async (deps: FileDeps, place: FilePlace, placing: Placing, fresh: Fresh): Promise<Placed> => {
  const pending = deps.pictures?.get(fresh.hash);
  const done = pending === undefined ? undefined : await pending;
  if (done !== undefined) {
    placing.shared[fresh.hash] = done;
    return { asName: done.name, paths: done.paths, primary: done.primary, picture: done.primary, text: done.text, media: done.media, hash: fresh.hash };
  }
  const converting = convertFresh(deps, place, placing.shared, fresh);
  // A conversion that throws is a bug, which reaches the caller of this thread; the threads waiting on
  // it convert the picture themselves.
  deps.pictures?.set(
    fresh.hash,
    converting.then(
      (placed) => (placed.primary === undefined ? undefined : placing.shared[fresh.hash]),
      () => undefined
    )
  );
  return converting;
};

const withName = (arrival: Arrival, name: string | undefined): Arrival => (name === undefined ? arrival : { ...arrival, attachment: { ...arrival.attachment, name } });

// A file with no extension in its name takes the one its content type goes by. An embedded mail and a
// share link are not files, and keep the names they came by.
const typedName = (attachment: MailAttachment): string | undefined => (attachment.kind === 'file' ? namedForType(attachment.name, attachment.contentType) : undefined);

// The name a content the thread does not hold yet is written under. Not the name it had before when
// the thread stores another content under that name: two messages can carry one RFC id, and a draft's
// file can be replaced under its own name, and each content keeps a file of its own.
const freshName = (place: FilePlace, placing: Placing, arrival: Arrival): string => {
  const taken = Object.values(placing.store).some((record) => record.name === arrival.recorded);
  return taken ? freeNameIn(place, arrival.attachment.name, placing.taken) : nameOf(place, placing, arrival);
};

// A content no store holds yet, and what is known of it by the time it is converted.
type Fresh = {
  readonly messageId: string;
  readonly attachment: MailAttachment;
  // The name the sender gave it, which the report names it by, as the card and the message index do.
  readonly sentAs: string;
  readonly stamp: DocumentStamp;
  readonly asName: string;
  readonly hash: string;
  readonly inline: boolean;
  readonly rendered: string | undefined;
};

// The name a picture holds in the shared folder, when the store keeps it there. The same bytes kept
// as a file of a thread hold a name that is free only in that thread's folder.
const sharedNameOf = (place: FilePlace, record: AttachmentRecord | undefined): string | undefined =>
  record?.primary.startsWith(`${place.mailboxRoot}/${INLINE_FOLDER}/`) === true ? record.name : undefined;

// Converted once, then recorded in the store it belongs to: the mailbox's for a picture, the
// thread's for anything else.
const convertFresh = async (deps: FileDeps, place: FilePlace, into: Record<string, AttachmentRecord>, fresh: Fresh): Promise<Placed> => {
  const { messageId, attachment, sentAs, stamp, asName, hash, inline, rendered } = fresh;
  const folder = inline ? `${place.mailboxRoot}/${INLINE_FOLDER}` : `${place.here}/${ATTACHMENTS_FOLDER}`;
  // A shared folder needs names that cannot collide across every thread that writes into it, which
  // is what the content address gives. Inside one thread only a same-name-different-content pair
  // needs separating, and a number says that more plainly than ten hex. A picture stored with no
  // reading is read again under the name it was stored under, so the store keeps one copy of it
  // whatever name it comes by.
  const storedAs = inline ? (sharedNameOf(place, into[hash]) ?? disambiguateSegment(attachment.name, hash)) : asName;
  const outcome = await deps.convertAttachment({ messageId, attachment, folder, stamp, maxBytes: place.maxBytes, asName: storedAs, rendered, textOnly: inline });
  if (outcome.kind === 'skipped') return { asName, paths: [], skipped: { path: sentAs, reason: skipReason(outcome.reason, place.maxBytes, attachment.name) } };
  if (outcome.kind === 'failed') return { asName, paths: [], failed: { path: sentAs, reason: outcome.reason } };
  into[hash] = { name: storedAs, paths: outcome.outputs, primary: outcome.primary, media: outcome.media, text: outcome.text };
  // An archive the library read in part lands, and what it left in the archive goes to the report.
  const leftOut = outcome.leftOut === undefined ? {} : { leftOut: cutArchiveEntry(sentAs, outcome.leftOut) };
  return {
    asName: storedAs,
    paths: outcome.outputs,
    primary: outcome.primary,
    picture: inline ? outcome.primary : undefined,
    text: outcome.text,
    media: outcome.media,
    hash,
    ...leftOut,
  };
};

// Each path once, in the order first met.
const addAll = (into: string[], paths: ReadonlyArray<string>): void => {
  for (const path of paths) if (!into.includes(path)) into.push(path);
};

const messageFileOf = (attachment: MailAttachment, placed: Placed): MessageFile => ({
  attachment,
  asName: placed.asName,
  paths: placed.paths,
  primary: placed.primary,
  picture: placed.picture,
  text: placed.text,
  note: placed.skipped?.reason ?? placed.failed?.reason ?? placed.note,
  kept: placed.kept,
  hash: placed.hash,
});

// The files this thread already holds, as the run that wrote it last recorded them. A thread written
// again for a reply then converts only what it did not carry before.
const heldBy = (stored: Readonly<Record<string, AttachmentRecord>>, here: string): Record<string, AttachmentRecord> =>
  Object.fromEntries(Object.entries(stored).filter(([, record]) => record.primary.startsWith(`${here}/`)));

// Which message brought a file, and which of the files of that name in it. A mail is known by its RFC
// id, which stays the same when the mail moves to another folder where its Graph id does not; a post in
// a group inbox has none, and its own id never changes.
const arrivalOf = (message: MailMessage, name: string, nth: number): string => `${messageKeyOf(message)}|${name}|${nth}`;

const messageKeyOf = (message: MailMessage): string => {
  const rfc = message.internetMessageId ?? '';
  return rfc.length > 0 ? rfc : message.id;
};

// The files a message carried before, by arrival and name, which a write that cannot list them must
// not take for gone.
const recordedFor = (place: FilePlace, message: MailMessage): ReadonlyArray<readonly [string, string]> =>
  Object.entries(place.names ?? {}).filter(([arrival]) => arrival.startsWith(`${messageKeyOf(message)}|`));

// What the files of a write add up to as they are placed.
type Tally = {
  readonly paths: string[];
  readonly media: string[];
  readonly skipped: ReportEntry[];
  readonly failed: ReportEntry[];
  readonly byMessage: Record<string, MessageFile[]>;
  readonly names: Record<string, string>;
  readonly unread: string[];
};

// What a placed file adds to the report: a file left out, the files a zip kept back, a failure.
const tallyReport = (tally: Tally, placed: Placed): void => {
  if (placed.skipped) tally.skipped.push(placed.skipped);
  if (placed.leftOut) tally.skipped.push(placed.leftOut);
  if (placed.failed) tally.failed.push(placed.failed);
};

// One file a message carried, placed and added up; nothing for a file left out whole.
const placeCarried = async (deps: FileDeps, place: FilePlace, placing: Placing, carrying: Carrying, stamp: DocumentStamp, tally: Tally): Promise<MessageFile | undefined> => {
  const { attachment, arrival } = carrying;
  // Named as this write named it already, for a message held twice, as a mail copied to two folders.
  const recorded = tally.names[arrival] ?? place.names?.[arrival];
  const placed = await placeAttachment(deps, place, placing, { messageId: carrying.messageId, attachment, recorded }, stamp);
  addAll(tally.paths, placed.paths);
  // Dropped entirely, and not reported: a file nothing can read, named by a machine id, is the
  // decoration a sharing notification is built from. It gets no card and no line in the thread,
  // and reporting it contradicts that: a report is what a reader should look into, and thirteen
  // lines saying an icon had no extension were the whole of one run's report while nothing had
  // gone wrong at all. It keeps its place in `taken`, so the numbering of what follows does not
  // shift with a decision about what to show.
  if (placed.skipped !== undefined && isOpaqueName(attachment.name)) return undefined;
  tallyReport(tally, placed);
  addAll(tally.media, placed.media ?? []);
  if (!isInlinePicture(attachment)) tally.names[arrival] = placed.asName;
  if (placed.kept === true) tally.unread.push(`${place.here}/${ATTACHMENTS_FOLDER}/${placed.asName}`);
  return messageFileOf(attachment, placed);
};

// A file as one message carried it, and the arrival it is known by.
type Carrying = { readonly messageId: string; readonly attachment: MailAttachment; readonly arrival: string };

const placeMessage = async (deps: FileDeps, place: FilePlace, placing: Placing, part: ThreadPart, stamp: DocumentStamp, tally: Tally): Promise<void> => {
  const listed = await deps.reader.attachments(part.message.id);
  // Every file the message carried before keeps its name and its files: none is taken for gone.
  if (!listed.ok) {
    tally.failed.push({ path: `message ${part.message.id}`, reason: `could not list what it carried: ${listed.error.message}` });
    for (const [arrival, name] of recordedFor(place, part.message)) {
      tally.names[arrival] = name;
      tally.unread.push(`${place.here}/${ATTACHMENTS_FOLDER}/${name}`);
    }
    return;
  }
  const carried: MessageFile[] = [];
  const counted = new Map<string, number>();
  for (const attachment of listed.value) {
    const nth = counted.get(attachment.name) ?? 0;
    counted.set(attachment.name, nth + 1);
    const carrying = { messageId: part.message.id, attachment, arrival: arrivalOf(part.message, attachment.name, nth) };
    const file = await placeCarried(deps, place, placing, carrying, stamp, tally);
    if (file !== undefined) carried.push(file);
  }
  tally.byMessage[part.message.id] = carried;
};

export const attachmentsOf = async (deps: FileDeps, place: FilePlace, parts: ReadonlyArray<ThreadPart>, stamp: DocumentStamp): Promise<AttachmentTally> => {
  const store = heldBy(place.stored, place.here);
  // Pictures shown inside message bodies, which the whole mailbox shares, seeded with what earlier
  // threads stored so a signature logo is written once rather than once per conversation. The names
  // the thread's files hold come first, so a new file never takes one: a name that came free when its
  // message went still holds that message's file until the run moves it aside.
  const placing: Placing = {
    store,
    shared: { ...place.stored },
    // A file of a message gone that would not move aside, or one waiting on a read, is on disk until a
    // run moves it, and its name with it.
    taken: [...Object.values(place.names ?? {}), ...Object.values(store).map((record) => record.name), ...namesHeldIn(`${place.here}/${ATTACHMENTS_FOLDER}`, place.held)],
  };
  // A signature logo rides on every message of a thread, so the same file is offered many times.
  // Every offer is fetched and hashed rather than recognised beforehand by its name and length: a
  // spreadsheet edited and resent down a thread keeps its name, and an edit that leaves the byte
  // count untouched would pass for the version before it. The content address then dedupes the
  // repeat, here and across every other thread, so the bytes are paid for and the conversion is not.
  const tally: Tally = { paths: [], media: [], skipped: [], failed: [], byMessage: {}, names: {}, unread: [] };
  // Graph reports `hasAttachments: false` for a message whose only attachment is an inline image, so
  // a signature or a pasted screenshot would never be listed at all. A body showing a picture it does
  // not carry is the other half of the question, and asking it costs nothing on a message with neither.
  for (const part of parts.filter((candidate) => candidate.message.hasAttachments || carriesInlineImage(candidate.body))) {
    await placeMessage(deps, place, placing, part, stamp, tally);
  }
  // A thread written before the names were kept cannot tell what a failure was: none of its files is
  // taken for gone until a write that reads everything.
  if (place.names === undefined && tally.failed.length > 0) tally.unread.push(`${place.here}/${ATTACHMENTS_FOLDER}`);
  // Both stores fold into the one the run remembers: the shared pictures so a later thread finds
  // them, this thread's files so the mailbox index names everything on disk. Only what this write
  // added or used: the fold goes by key, and a held file whose message is gone would otherwise come
  // back after the run put it aside.
  const written = new Set(tally.paths);
  const pictures = Object.fromEntries(Object.entries(placing.shared).filter(([hash, record]) => place.stored[hash] !== record));
  const kept = Object.fromEntries(Object.entries(store).filter(([, record]) => written.has(record.primary)));
  return { ...tally, store: { ...pictures, ...kept } };
};
