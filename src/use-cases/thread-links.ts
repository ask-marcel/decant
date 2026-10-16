import { relative as pathBetween } from 'node:path/posix';
import { withoutFrontMatter } from '../domain/front-matter.ts';
import { unwrapSafelinks } from '../domain/safelink.ts';
import { renderLinkCard } from '../domain/link-card.ts';
import { namesHeldIn, underName } from '../domain/mail-state.ts';
import type { LinkedRecord } from '../domain/mail-state.ts';
import type { MailMessage } from '../domain/mail-message.ts';
import type { ArchiveCut, ReportEntry } from '../domain/report.ts';
import { cutArchiveEntry, skipReason } from '../domain/report.ts';
import { contentHash } from '../domain/content-hash.ts';
import { fitSegment, safeSegment, sameIgnoringCase } from '../domain/kb-path.ts';
import { linkDestination } from '../domain/markdown-link.ts';
import { freeName } from '../domain/thread-card.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ConvertFile } from './convert-file.ts';
import type { DriveItem } from '../domain/drive-item.ts';
import { versionOf } from '../domain/drive-item.ts';
import type { DriveReader } from './ports/drive-reader.ts';
import { ATTACHMENTS_FOLDER } from './thread-files.ts';
import type { Files } from './ports/files.ts';
import type { LinkedFile, MailReader } from './ports/mail-reader.ts';
import type { Logger } from './ports/logger.ts';

// What following a link costs, named rather than taken whole: this asks the mailbox for the links a
// message holds, the drive for one document's own metadata, and its bytes when a message carried a
// file of that name, and the converter for its text. It never reads a message, never lists an
// attachment, and never touches the mailbox root.
export type LinkDeps = {
  readonly reader: Pick<MailReader, 'sharepointLinks'>;
  readonly drive: Pick<DriveReader, 'item' | 'bytes'>;
  readonly files: Pick<Files, 'readText' | 'writeText'>;
  readonly convertFile: ConvertFile;
  readonly logger: Logger;
  // The source this thread came from, which is what a pulled document is stamped with. One vault
  // holds a mailbox and any number of group inboxes, and a document naming the wrong one sends a
  // reader looking in a folder it never came from.
  readonly sourceName: string;
  // The zone the knowledge base counts its days in, which a card tells its day in.
  readonly timezone: string;
  // How long a path may be as decant writes it. Absent, names are not cut for length.
  readonly pathBudget?: number;
};

// The folder a thread keeps what it pointed at in, holding the documents and the cards standing for
// them together: one entry per thing depended on, whether or not the thing itself could be pulled.
const LINKED_FOLDER = '_linked';

type Pulled = {
  readonly record?: LinkedRecord;
  // Said on the card without being counted as something that went wrong. A share that points at a
  // folder is the ordinary case, not a document the converter could not read.
  readonly note?: string;
  // Read off the document at the source, so the card can say which version of it the thread meant.
  readonly lastModified?: string;
  readonly modifiedBy?: string;
  readonly skipped?: ReportEntry;
  readonly failed?: ReportEntry;
  // The files a zip the library read in part kept back, which only the report names: the zip was read.
  readonly leftOut?: ReportEntry;
  // The version of the document whose files this write holds, pulled now or kept from the write before.
  readonly version?: string;
  // Kept as the write before left it: the source has the version the thread pulled then.
  readonly held?: true;
};

// What one message pointed at, kept per message so a card can say when the thread referenced it.
type MessageLink = {
  readonly link: LinkedFile;
  // Which message pointed at it, so the message index can list what each message linked to.
  readonly messageId: string;
  readonly received: string;
  // What the document was called inside this thread's folder. The card is this plus `.md`, so the
  // pair is one decision taken once, before the pull, and a document nobody could fetch still has a
  // name for its card to be written under.
  readonly asName: string;
  readonly paths: ReadonlyArray<string>;
  readonly lastModified?: string;
  readonly modifiedBy?: string;
  readonly note?: string;
  // A document the thread pulled before that this write could not pull: its card stays as it was.
  readonly kept?: boolean;
  // A document the thread holds from a write before, at the version the source has now: not pulled
  // again, and its card stays as it was.
  readonly held?: boolean;
};

export type LinkedTally = {
  readonly paths: ReadonlyArray<string>;
  readonly linked: Record<string, LinkedRecord>;
  readonly referenced: ReadonlyArray<MessageLink>;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
  // The name each document was written under, by the item it is at the source, so the next write
  // gives it the same one.
  readonly names: Readonly<Record<string, string>>;
  // Where in the thread's folder this write could not read what the thread held: a document it could
  // not pull, or every document when a message's links could not be listed. What sits under them is
  // kept.
  readonly unread: ReadonlyArray<string>;
  // The version of each document whose files the thread holds after this write, by the item.
  readonly versions: Readonly<Record<string, string>>;
};

// What the thread held when it was last written: the name each linked document was written under,
// every file of its folder, and the version of each document it pulled. Empty for a thread never
// written.
export type LinksHeld = {
  readonly links?: Readonly<Record<string, string>>;
  readonly held?: ReadonlyArray<string>;
  readonly versions?: Readonly<Record<string, string>>;
};

// A file a message of this write carried, by the name it came by: a linked document with its bytes is
// that file, and is not pulled a second time.
export type AttachedCopy = { readonly name: string; readonly hash: string; readonly card: string };

// Where this write's linked documents go, how big one may be, and what its messages carried.
export type LinksPlace = { readonly here: string; readonly maxBytes: number; readonly carried: ReadonlyArray<AttachedCopy> };

// Asked only of a message whose text carries one. `extract-sharepoint-links-in-mail` costs a Graph
// call per message and fetches the message again to scan it, and a full run over this mailbox spent
// a thousand of those to find thirty-six links. The body is already in hand, so it decides.
//
// The guard reads the CONVERTED markdown while the extractor reads the body Graph holds, so in
// principle a link surviving only in an HTML attribute the conversion dropped would now be missed.
// Measured against the vault before this landed: all thirty-six links sat in threads whose text
// carries the URL, none would have been lost. Any host, not the tenant's own: half this mailbox is
// vendors and partners sharing from their own SharePoint.
const POINTS_SOMEWHERE = /sharepoint\./i;

// Each path once, in the order first met.
const addAll = (into: string[], paths: ReadonlyArray<string>): void => {
  for (const path of paths) if (!into.includes(path)) into.push(path);
};

// A document this write already read is referenced again rather than read again, whatever came of it:
// its card is written from the first mention, and one that failed is tried again on the next run, as
// the thread is. A later mention counts nothing a second time. One the thread holds from a write
// before under the same name is offered to the read, which keeps it when the source still has the
// version the thread pulled.
const pulledOnce = async (deps: LinkDeps, following: Following, link: LinkedFile, key: string, asName: string): Promise<Pulled> => {
  if (following.pulled[key] !== undefined) return {};
  const document = following.documents[key];
  const pulled = await pullLinked(deps, following.place, link, asName, document?.name === asName ? document : undefined);
  following.pulled[key] = pulled;
  return pulled;
};

const referenceOf = (link: LinkedFile, message: MailMessage, asName: string, pulled: Pulled): MessageLink => ({
  link,
  messageId: message.id,
  received: message.received,
  asName,
  paths: pulled.record?.paths ?? [],
  lastModified: pulled.lastModified,
  modifiedBy: pulled.modifiedBy,
  note: (pulled.skipped ?? pulled.failed)?.reason ?? pulled.note,
});

// The name a document was given already, in this write or the one before, if it was.
const nameFor = (key: string, names: Readonly<Record<string, string>>, recorded: Readonly<Record<string, string>>): string | undefined => names[key] ?? recorded[key];

// What following the links of one write works from, and adds to as it goes.
type Following = {
  readonly place: LinksPlace;
  readonly here: string;
  // The name each document was written under before, and every name the folder holds on disk.
  readonly recorded: Readonly<Record<string, string>>;
  readonly held: ReadonlyArray<string>;
  readonly linked: Record<string, LinkedRecord>;
  // What came of reading each document in this write, by item.
  readonly pulled: Record<string, Pulled>;
  // The documents the thread holds from a write before, by item, with the name their files go by.
  readonly documents: Readonly<Record<string, HeldDocument>>;
  // The version each document was pulled at in the write before, and in this one.
  readonly before: Readonly<Record<string, string>>;
  readonly versions: Record<string, string>;
  readonly names: Record<string, string>;
  readonly paths: string[];
  readonly skipped: ReportEntry[];
  readonly failed: ReportEntry[];
  readonly referenced: MessageLink[];
  readonly unread: string[];
};

// The name a document is written under, cut as the converter cuts it to fit a deep disk: the card takes
// the name the document's text was written under, and reads the text back from it. A name recorded
// before names were cut is cut the same way.
const linkedName = (deps: LinkDeps, following: Following, key: string, link: LinkedFile): string => {
  const folder = `${following.here}/${LINKED_FOLDER}`;
  const named = nameFor(key, following.names, following.recorded);
  if (named !== undefined) return fitSegment(folder, safeSegment(named), deps.pathBudget);
  return freeName(folder, link.name, [...following.held, ...Object.values(following.names)], deps.pathBudget);
};

// The version of the files the thread holds for a document. A document the thread could not pull now
// keeps the card it had, and so the version that card came from. A source that gave no version gives
// nothing to keep a document by.
const keepVersion = (following: Following, key: string, version: string | undefined): void => {
  if (version !== undefined && version !== '') following.versions[key] = version;
};

// One document a message pointed at. A document the thread pulled before that cannot be pulled now
// keeps the card it had, which holds its text, and what it had beside the card is named as unread.
const followLink = async (deps: LinkDeps, following: Following, message: MailMessage, link: LinkedFile): Promise<void> => {
  const key = `${link.driveId}:${link.itemId}`;
  const asName = linkedName(deps, following, key, link);
  following.names[key] = asName;
  const pulled = await pulledOnce(deps, following, link, key, asName);
  if (pulled.skipped !== undefined) following.skipped.push(pulled.skipped);
  if (pulled.leftOut !== undefined) following.skipped.push(pulled.leftOut);
  if (pulled.failed !== undefined) following.failed.push(pulled.failed);
  const kept = pulled.failed !== undefined && following.recorded[key] !== undefined;
  if (kept) addAll(following.unread, [`${following.here}/${LINKED_FOLDER}/${asName}`]);
  keepVersion(following, key, kept ? following.before[key] : pulled.version);
  // Recorded whether or not it came: a card for a document nobody could pull is the only place the
  // thread's dependence on it is written down.
  following.referenced.push({ ...referenceOf(link, message, asName, pulled), kept, held: pulled.held === true });
  if (pulled.record === undefined) return;
  following.linked[key] = pulled.record;
  addAll(following.paths, pulled.record.paths);
};

// A document is named by its item, so a message whose links went unread cannot say which were its
// own: every document the thread linked keeps its name until a write that lists them all.
const keepRecorded = (following: Following): void => {
  for (const [key, name] of Object.entries(following.recorded)) {
    if (following.names[key] !== undefined) continue;
    following.names[key] = name;
    keepVersion(following, key, following.before[key]);
  }
};

const followMessage = async (deps: LinkDeps, following: Following, part: ThreadPart): Promise<void> => {
  if (!POINTS_SOMEWHERE.test(part.body)) return;
  const found = await deps.reader.sharepointLinks(part.message.id);
  // Named as failed, as a message whose attachments cannot be listed is: the thread is written again
  // on the next run. Any document the thread pointed at may still be linked from this message, so
  // none is taken for gone in the meantime.
  if (!found.ok) {
    following.failed.push({ path: `message ${part.message.id}`, reason: `could not list what it links to: ${found.error.message}` });
    addAll(following.unread, [`${following.here}/${LINKED_FOLDER}`]);
    keepRecorded(following);
    return;
  }
  for (const link of found.value) await followLink(deps, following, part.message, link);
};

// A document the thread holds from a write before: the name it was written under, the version it was
// pulled at, and its files.
type HeldDocument = { readonly name: string; readonly version?: string; readonly record: LinkedRecord };

// The name a file of the linked folder belongs to: the file of that name, what sits beside it under the
// name (its card, its pictures, a deck's PDF), and what an archive or a saved mail of that name
// unpacked into a folder named for it. Another document can have a name that opens the same way, so
// the longest one wins.
const ownerOf = (folder: string, names: ReadonlyArray<string>, path: string): string | undefined =>
  names
    .filter((name) => underName(path, `${folder}/${name}`))
    .reduce<string | undefined>((longest, name) => (longest === undefined || name.length > longest.length ? name : longest), undefined);

// The documents a thread written again can keep as its last write left them: one whose card is among
// the files it holds, with the version it was pulled at. One the source has at another version, or at
// none the thread recorded, is pulled again, as is every document of a thread written before the
// versions were kept.
const heldDocuments = (folder: string, before: LinksHeld): Record<string, HeldDocument> => {
  const named = Object.entries(before.links ?? {});
  const names = named.map(([, name]) => name);
  return Object.fromEntries(
    named.flatMap(([key, name]) => {
      const paths = (before.held ?? []).filter((path) => ownerOf(folder, names, path) === name);
      return paths.includes(`${folder}/${name}.md`) ? [[key, { name, version: before.versions?.[key], record: { paths } }] as const] : [];
    })
  );
};

export const linkedFiles = async (deps: LinkDeps, place: LinksPlace, parts: ReadonlyArray<ThreadPart>, before: LinksHeld): Promise<LinkedTally> => {
  const { here } = place;
  // Within this thread only, the way its attachments are. The same weekly report linked from thirty
  // mails across ten threads is pulled once per thread rather than once for the mailbox: a folder
  // that has to reach into another thread to be read is not self-contained, and the document is the
  // cheap half of what a thread costs.
  // One name per document, not per mention: a deck cited in four replies is one file. A document keeps
  // the name it was written under before; a new one avoids every name handed out, recorded, or held
  // on disk, so it never takes the name of a document whose message went.
  const recorded = before.links ?? {};
  const held = [...Object.values(recorded), ...namesHeldIn(`${here}/${LINKED_FOLDER}`, before.held)];
  const documents = heldDocuments(`${here}/${LINKED_FOLDER}`, before);
  const following: Following = {
    place,
    here,
    recorded,
    held,
    linked: {},
    pulled: {},
    documents,
    before: before.versions ?? {},
    versions: {},
    names: {},
    paths: [],
    skipped: [],
    failed: [],
    referenced: [],
    unread: [],
  };
  for (const part of parts) await followMessage(deps, following, part);
  // A thread written before the names were kept cannot tell what a failure was: none of its linked
  // documents is taken for gone until a write that reads everything.
  if (before.links === undefined && following.failed.length > 0) addAll(following.unread, [`${here}/${LINKED_FOLDER}`]);
  const { paths, linked, referenced, skipped, failed, names, unread, versions } = following;
  return { paths, linked, referenced, skipped, failed, names, unread, versions };
};

// A document a message of the thread also carried, when its bytes are that file's: the name says when
// to compare, since Graph's size for an attachment is not its byte count, and the bytes decide. A file
// the thread kept was within the size cap, so a document past it is never downloaded to compare.
const carriedAs = async (deps: LinkDeps, place: LinksPlace, link: LinkedFile, item: DriveItem): Promise<AttachedCopy | undefined> => {
  const named = place.carried.filter((file) => sameIgnoringCase(file.name, item.name));
  if (named.length === 0 || item.size > place.maxBytes) return undefined;
  const bytes = await deps.drive.bytes({ driveId: link.driveId, itemId: link.itemId });
  const hash = bytes.ok ? contentHash(bytes.value) : undefined;
  return named.find((file) => file.hash === hash);
};

const carriedNote = (file: AttachedCopy): string => {
  const card = linkDestination(['..', ATTACHMENTS_FOLDER, file.card].join('/'));
  return `It is the same file as one a message of this thread carried, so it is not kept twice: [${file.name}](${card}).`;
};

// What the library left in an archive it read in part, named for the report by the file's name.
const leftOutOf = (name: string, leftOut: ArchiveCut | undefined): Pick<Pulled, 'leftOut'> => (leftOut === undefined ? {} : { leftOut: cutArchiveEntry(name, leftOut) });

// The same route a file found by walking a library takes. A linked document is read for its own
// metadata first, because the name in the link cannot say which version it is, how big it is, or what
// kind of thing it is: the version decides whether a thread that holds it pulls it again, the size
// whether it is pulled at all, and the kind whether a deck also renders a PDF beside its text.

const pullLinked = async (deps: LinkDeps, place: LinksPlace, link: LinkedFile, asName: string, held: HeldDocument | undefined): Promise<Pulled> => {
  const { here, maxBytes } = place;
  const { driveId, itemId, name } = link;
  const found = await deps.drive.item({ driveId, itemId });
  if (!found.ok) {
    deps.logger.warn('linked.failed', { itemId, name, cause: found.error.kind });
    return { failed: { path: name, reason: `${found.error.kind}: ${found.error.message}` } };
  }
  const { lastModified, modifiedBy } = found.value;
  // What somebody shares is as often a folder as a file, and a folder is not a document that failed:
  // there is nothing to pull and nothing went wrong. It was reaching the converter, which refused it
  // for having no extension, so a thread saying plainly that a folder was shared reported a file it
  // could not read. The card still stands, being the record that the thread depended on it.
  if (found.value.kind === 'folder') return { note: 'It is a folder at the source, so there was nothing to pull.', lastModified, modifiedBy };
  const twin = await carriedAs(deps, place, link, found.value);
  if (twin !== undefined) return { note: carriedNote(twin), lastModified, modifiedBy };
  // The metadata read is what a thread written again for a flag or a reply pays for a document it holds:
  // the same version at the source is not pulled or converted a second time. A file a message attached
  // came first: the attachment is the copy a thread keeps.
  const version = versionOf(found.value);
  if (held !== undefined && held.version === version) return { record: held.record, lastModified, modifiedBy, version, held: true };
  const outcome = await deps.convertFile({
    item: found.value,
    driveId,
    site: deps.sourceName,
    library: LINKED_FOLDER,
    maxBytes,
    into: `${here}/${LINKED_FOLDER}`,
    asName,
  });
  // An archive the library read in part lands, and what it left in the archive goes to the report.
  if (outcome.kind === 'converted') return { record: { paths: outcome.outputs }, lastModified, modifiedBy, version, ...leftOutOf(name, outcome.leftOut) };
  deps.logger.warn(outcome.kind === 'skipped' ? 'linked.skipped' : 'linked.failed', { itemId, name, cause: outcome.reason });
  if (outcome.kind === 'failed') return { failed: { path: name, reason: outcome.reason } };
  // The reason names the file at the SOURCE, not the link. A message can point at a document under
  // any words it likes, and `.docx, which this tool does not read` about a recording is a lie the
  // link's own label would have told.
  return { skipped: { path: name, reason: skipReason(outcome.reason, maxBytes, found.value.name) } };
};

// One card per document the thread pointed at, beside the thread rather than in the store the
// document itself sits in. Written here for the same reason the attachment cards are: a document
// another thread already pulled is referenced without being fetched again, so a card written where
// the fetching happens would exist only for the thread that got there first. Hands back the cards it
// wrote, which the thread records with the rest of what its folder holds.
export const writeLinkCards = async (deps: LinkDeps, threadId: string, here: string, referenced: ReadonlyArray<MessageLink>): Promise<ReadonlyArray<string>> => {
  const folder = `${here}/${LINKED_FOLDER}`;
  const written: string[] = [];
  // One card per document, not per mention. A deck cited in four replies is one thing the thread
  // depended on, and the card says when it was first pointed at.
  const seen = new Set<string>();
  for (const entry of referenced) {
    const key = `${entry.link.driveId}:${entry.link.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = `${entry.asName}.md`;
    // A document the write could not pull keeps the card it had, which holds the text read out of it,
    // and so does one the thread holds from a write before.
    if (entry.kept === true || entry.held === true) {
      written.push(`${folder}/${name}`);
      continue;
    }
    // Read, then written back over the same path, the way an attachment card is: the converter puts
    // the document's text at `<name>.md` in this folder and the card wants that exact name, so a
    // reader opening the folder finds ONE document per thing the thread pointed at. Reading first
    // is what makes the overwrite safe, the text coming forward under the thread's own facts.
    const held = entry.paths.find((path) => path.endsWith('.md'));
    const stored = held === undefined ? undefined : await deps.files.readText(held);
    const original = entry.paths.find((path) => path.endsWith(`/${entry.asName}`));
    const card = renderLinkCard({
      threadId,
      title: entry.link.name,
      url: entry.link.url,
      inMessage: entry.received,
      zone: deps.timezone,
      lastModified: entry.lastModified,
      modifiedBy: entry.modifiedBy,
      body: stored?.ok === true ? unwrapSafelinks(withoutFrontMatter(stored.value)) : undefined,
      original: original === undefined ? undefined : pathBetween(folder, original),
      note: entry.note,
    });
    const saved = await deps.files.writeText(`${folder}/${name}`, card);
    if (saved.ok) written.push(`${folder}/${name}`);
    else deps.logger.warn('card.failed', { filename: entry.link.name, cause: saved.error.kind });
  }
  return written;
};
