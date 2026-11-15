import type { ChatKind } from '../domain/chat.ts';
import { renderDayNote } from '../domain/chat-document.ts';
import type { DayMessages, FileLine, NotedMessage, PictureLink } from '../domain/chat-document.ts';
import type { ChatFile, ChatMessage } from '../domain/chat-message.ts';
import { dayHash } from '../domain/chat-state.ts';
import type { DayRecord } from '../domain/chat-state.ts';
import { extensionOf } from '../domain/conversion-plan.ts';
import { safeSegment } from '../domain/kb-path.ts';
import { underName } from '../domain/mail-state.ts';
import type { ReportEntry } from '../domain/report.ts';
import { ok } from '../domain/result.ts';
import type { ConvertFile } from './convert-file.ts';
import type { ChatReader } from './ports/chat-reader.ts';
import type { Clock } from './ports/clock.ts';
import type { DriveReader, EmbeddedImage } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { LinkedFile } from './ports/mail-reader.ts';
import type { Ocr } from './ports/ocr.ts';
import type { Progress } from './ports/progress.ts';
import { heldInPlace, letGo, putAside, putBack, setAside } from './put-aside.ts';
import type { WriteDown } from './put-aside.ts';
import { linkedFiles, writeLinkCards } from './thread-links.ts';
import type { LinkedTally } from './thread-links.ts';

// What filing one day of a chat asks of the outside: the pictures and the file links of a message,
// the drive and the converter for a file a message shared, the disk, and OCR for a picture.
export type ChatDayDeps = {
  readonly reader: Pick<ChatReader, 'pictures' | 'fileLink'>;
  readonly drive: Pick<DriveReader, 'item' | 'bytes'>;
  readonly convertFile: ConvertFile;
  readonly files: Files;
  readonly ocr: Ocr;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly progress: Pick<Progress, 'detail'>;
  readonly kbRoot: string;
  // The zone the knowledge base counts its days in.
  readonly timezone: string;
  // How long a path may be as decant writes it. Absent, names are not cut for length.
  readonly pathBudget?: number;
  // Where the files a day lets go that would not move under the archive are written down.
  readonly writeDown?: WriteDown;
};

// The chat a day belongs to: what the note says of it, where its folder is, and what the progress
// line calls it.
export type DayPlace = {
  readonly chatId: string;
  readonly name: string;
  readonly kind: ChatKind;
  readonly members: ReadonlyArray<string>;
  readonly root: string;
  readonly maxBytes: number;
};

// What filing a day came to. No record means the note itself did not land, and the day is as it was.
export type DayDone = { readonly record?: DayRecord; readonly failed: ReadonlyArray<ReportEntry>; readonly skipped: ReadonlyArray<ReportEntry> };

const SOURCE_NAME = 'Chats';
const LINKED_FOLDER = '_linked';
const INLINE_FOLDER = '_inline';

// A file a message shared, once the source was asked where it sits: the drive item it is, or why not.
type Resolved = { readonly messageId: string; readonly file: ChatFile; readonly link?: LinkedFile; readonly reason?: string };

const resolveFiles = async (deps: ChatDayDeps, messages: ReadonlyArray<ChatMessage>): Promise<ReadonlyArray<Resolved>> => {
  const resolved: Resolved[] = [];
  for (const message of messages) {
    for (const file of message.files) {
      const link = await deps.reader.fileLink(file);
      if (!link.ok) deps.logger.warn('chat.file-unresolved', { message: message.id, cause: link.error.kind });
      resolved.push(link.ok ? { messageId: message.id, file, link: link.value } : { messageId: message.id, file, reason: `${link.error.kind}: ${link.error.message}` });
    }
  }
  return resolved;
};

// The one word the link helper looks for before it asks what a message links to. A mail is asked only
// when its text holds an address. A chat message says what it shared, so each one is asked.
const POINTS_SOMEWHERE = 'sharepoint.';

type Pulled = { readonly tally: LinkedTally; readonly cards: ReadonlyArray<string> };

// Each file goes the way a file linked from a mail goes: read for its own metadata, converted beside
// its original, and given a card. The day's folder stands where a thread's folder does.
const pullFiles = async (
  deps: ChatDayDeps,
  place: DayPlace,
  here: string,
  noteName: string,
  day: DayMessages,
  resolved: ReadonlyArray<Resolved>,
  before: DayRecord | undefined
): Promise<Pulled> => {
  const following = {
    ...deps,
    sourceName: SOURCE_NAME,
    reader: { sharepointLinks: async (messageId: string) => ok(resolved.flatMap((one) => (one.messageId === messageId && one.link !== undefined ? [one.link] : []))) },
    convertFile: async (converting: Parameters<ConvertFile>[0]) => {
      deps.progress.detail(place.name, `reading ${converting.item.name}`);
      return deps.convertFile(converting);
    },
  };
  const parts = day.messages.map((message) => ({ message: { id: message.id, received: message.sent }, body: POINTS_SOMEWHERE }));
  const tally = await linkedFiles(following, { here, maxBytes: place.maxBytes, carried: [] }, parts, { links: before?.links, held: before?.held, versions: before?.versions });
  return { tally, cards: await writeLinkCards(following, noteName, here, tally.referenced) };
};

// How the note names each file of a message: by its card when the file was found at the source, with
// what became of it when it did not arrive, and by its bare name when the source did not know it.
const fileLines = (day: string, message: ChatMessage, resolved: ReadonlyArray<Resolved>, tally: LinkedTally): ReadonlyArray<FileLine> =>
  resolved
    .filter((one) => one.messageId === message.id)
    .map((one) => {
      if (one.link === undefined) return { name: one.file.name, note: one.reason };
      const { driveId, itemId } = one.link;
      const entry = tally.referenced.find((found) => found.link.driveId === driveId && found.link.itemId === itemId);
      return { name: one.file.name, link: `${day}/${LINKED_FOLDER}/${entry?.asName ?? one.link.name}.md`, note: entry?.note };
    });

// The pictures a message already has on disk from the write before, in the order they were saved,
// which is their order in the message.
const heldPictures = (before: DayRecord | undefined, prefix: string): ReadonlyArray<string> => (before?.held ?? []).filter((path) => path.startsWith(prefix));

// With OCR off a picture is kept and nothing reads it, so its row says it is saved.
const announce = (deps: ChatDayDeps, place: DayPlace, name: string): void => deps.progress.detail(place.name, `${deps.ocr.off === true ? 'saving' : 'reading'} ${name}`);

type Saved = { readonly path?: string; readonly reason?: string };

const savePicture = async (deps: ChatDayDeps, place: DayPlace, prefix: string, at: number, image: EmbeddedImage | undefined): Promise<Saved> => {
  if (image === undefined) return { reason: 'the source did not hand it back' };
  const extension = extensionOf(image.path);
  const path = [`${prefix}${at + 1}`, ...(extension === undefined ? [] : [safeSegment(extension)])].join('.');
  announce(deps, place, path.slice(path.lastIndexOf('/') + 1));
  const written = await deps.files.writeBytes(path, image.bytes);
  return written.ok ? { path } : { reason: written.error.message };
};

type Fetched = { readonly paths: ReadonlyArray<string | undefined>; readonly reason: string | undefined };

// Every picture of the message has a place in the list, one that did not arrive an empty one, so the
// note can say so where the picture stood.
const fetchPictures = async (deps: ChatDayDeps, place: DayPlace, prefix: string, message: ChatMessage): Promise<Fetched> => {
  const fetched = await deps.reader.pictures(place.chatId, message.id);
  const saved: Saved[] = [];
  for (let at = 0; at < message.pictures; at += 1) {
    saved.push(fetched.ok ? await savePicture(deps, place, prefix, at, fetched.value[at]) : { reason: `${fetched.error.kind}: ${fetched.error.message}` });
  }
  return { paths: saved.map((one) => one.path), reason: saved.find((one) => one.reason !== undefined)?.reason };
};

// The pictures of one message of the day, each at its place, and why one did not arrive.
type MessagePictures = Fetched & { readonly message: ChatMessage };

// A picture a message holds from the write before is not fetched again: a message does not change the
// pictures it shows without the day reading as changed, and then every one of them is fetched.
const savePictures = async (deps: ChatDayDeps, place: DayPlace, here: string, day: DayMessages, before: DayRecord | undefined): Promise<ReadonlyArray<MessagePictures>> => {
  const saved: MessagePictures[] = [];
  for (const message of day.messages) {
    // The id and the extension come from the source, so each is made safe before it names a file.
    const prefix = `${here}/${INLINE_FOLDER}/${safeSegment(message.id)}-`;
    const held = heldPictures(before, prefix);
    const fetched: Fetched = held.length === message.pictures ? { paths: held, reason: undefined } : await fetchPictures(deps, place, prefix, message);
    if (fetched.reason !== undefined) deps.logger.warn('chat.picture-failed', { message: message.id });
    saved.push({ message, ...fetched });
  }
  return saved;
};

// What OCR read in a picture on disk, which is nothing when it read none or is off.
const pictureLink = async (deps: ChatDayDeps, root: string, path: string | undefined): Promise<PictureLink | undefined> => {
  if (path === undefined) return undefined;
  const read = await deps.ocr.read(path);
  return { link: path.slice(root.length + 1), text: read.ok ? read.value.text.trim() : '' };
};

const notedMessages = async (
  deps: ChatDayDeps,
  place: DayPlace,
  day: string,
  resolved: ReadonlyArray<Resolved>,
  tally: LinkedTally,
  pictures: ReadonlyArray<MessagePictures>
): Promise<ReadonlyArray<NotedMessage>> => {
  const noted: NotedMessage[] = [];
  for (const { message, paths } of pictures) {
    const links: Array<PictureLink | undefined> = [];
    for (const path of paths) links.push(await pictureLink(deps, place.root, path));
    noted.push({ message, pictures: links, files: fileLines(day, message, resolved, tally) });
  }
  return noted;
};

const writeRefused = async (deps: ChatDayDeps, file: string, document: string): Promise<string | undefined> => {
  const written = await deps.files.writeText(file, document);
  return written.ok ? undefined : written.error.message;
};

// The note as it was goes aside first, under the day of the run, and comes back when the write fails.
// One that would not move aside, held open most often, would be lost to a write at its own path, so
// the day waits. Answers why the note did not land, or nothing when it did.
const writeNote = async (deps: ChatDayDeps, file: string, before: DayRecord | undefined, document: string): Promise<string | undefined> => {
  const aside = await setAside(deps, before === undefined ? [] : [before.file]);
  for (const missed of aside.failed) deps.logger.warn('supersede.failed', { path: missed.path, cause: missed.error.kind });
  const refused = (await heldInPlace(deps, aside)) ?? (await writeRefused(deps, file, document));
  if (refused === undefined) {
    await letGo(deps, aside);
    return undefined;
  }
  for (const missed of await putBack(deps, aside)) deps.logger.warn('restore.failed', { path: missed.path, cause: missed.error.kind });
  return refused;
};

// What the day held before and holds no more goes under the archive, those still on disk. What sits
// under a name the read could not reach is kept: nothing says it is gone.
const letStaleGo = async (deps: ChatDayDeps, before: DayRecord | undefined, now: ReadonlyArray<string>, unread: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const left = (before?.held ?? []).filter((path) => !now.includes(path));
  const kept = left.filter((path) => unread.some((name) => underName(path, name)));
  const present: string[] = [];
  for (const path of left.filter((one) => !kept.includes(one))) {
    const held = await deps.files.exists(path);
    if (held.ok && held.value) present.push(path);
  }
  for (const missed of await putAside(deps, present)) deps.logger.warn('archive.failed', { path: missed.path, cause: missed.error.kind });
  return kept;
};

const inDay = (place: DayPlace, day: string, entries: ReadonlyArray<ReportEntry>): ReadonlyArray<ReportEntry> =>
  entries.map((entry) => ({ ...entry, path: `${place.name}/${day}: ${entry.path}` }));

// One day of one chat: its files pulled, its pictures saved, then its note. A file or a picture that
// did not arrive is named in the note and in the report, and leaves the day to be made again.
export const writeDay = async (deps: ChatDayDeps, place: DayPlace, day: DayMessages, before: DayRecord | undefined): Promise<DayDone> => {
  const here = `${place.root}/${day.day}`;
  const file = `${here}.md`;
  const resolved = await resolveFiles(deps, day.messages);
  const pulled = await pullFiles(deps, place, here, file.slice(deps.kbRoot.length + 1), day, resolved, before);
  const pictures = await savePictures(deps, place, here, day, before);
  const messages = await notedMessages(deps, place, day.day, resolved, pulled.tally, pictures);
  const document = renderDayNote({ chat: place.name, kind: place.kind, members: place.members, day: day.day, zone: deps.timezone, messages, syncedAt: deps.clock.nowIso() });
  const unresolved = resolved.flatMap((one) => (one.reason === undefined ? [] : [{ path: one.file.name, reason: one.reason }]));
  const unsaved = pictures.flatMap((one) => (one.reason === undefined ? [] : [{ path: `a picture of ${one.message.author}`, reason: one.reason }]));
  const failed = inDay(place, day.day, [...unresolved, ...pulled.tally.failed, ...unsaved]);
  const refused = await writeNote(deps, file, before, document);
  if (refused !== undefined) return { failed: [...failed, { path: `${place.name}/${day.day}`, reason: refused }], skipped: [] };
  const saved = pictures.flatMap((one) => one.paths.filter((path): path is string => path !== undefined));
  const now = [...pulled.tally.paths, ...pulled.cards, ...saved];
  // A file the source could not place this time may be one the day pulled before: nothing under the
  // linked folder is taken for gone, and what it was named and pulled at is kept, until a write that
  // places every file.
  const waiting = unresolved.length > 0;
  const kept = await letStaleGo(deps, before, now, waiting ? [...pulled.tally.unread, `${here}/${LINKED_FOLDER}`] : pulled.tally.unread);
  const record: DayRecord = {
    file,
    hash: failed.length === 0 ? dayHash(day.messages) : '',
    messages: day.messages.length,
    held: [...new Set([...now, ...kept])],
    links: waiting ? { ...before?.links, ...pulled.tally.names } : pulled.tally.names,
    versions: waiting ? { ...before?.versions, ...pulled.tally.versions } : pulled.tally.versions,
  };
  return { record, failed, skipped: inDay(place, day.day, pulled.tally.skipped) };
};
