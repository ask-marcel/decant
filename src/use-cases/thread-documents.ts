import { join as pathUnder, relative as pathBetween } from 'node:path';
import { withoutFrontMatter } from '../domain/front-matter.ts';
import { unwrapSafelinks } from '../domain/safelink.ts';
import type { CarriedFile } from '../domain/mail-body.ts';
import { rewriteMessageBody } from '../domain/mail-body.ts';
import { renderThreadCard } from '../domain/thread-card.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { MessageFile } from './thread-files.ts';

// What turning placed files into documents costs: reading back what the converter wrote, and
// writing the cards. Nothing else. It never fetches, never converts, and never asks Graph anything.
export type DocumentDeps = {
  readonly files: Pick<Files, 'readText' | 'writeText'>;
  readonly logger: Logger;
};

// Who the cards are written for, and where. `threadId` is what a card says it belongs to; `here` is
// the thread's own folder, which every path a card holds is relative to.
export type CardsFor = {
  readonly threadId: string;
  readonly here: string;
  readonly folder: string;
};

// What one linked document came to: the files it produced, or the one line saying why it produced
// none. Same shape as `Placed` for an attachment, so both feed the report the same way.

// Decided where the file was placed, not worked out again from its outputs: a picture shown in a
// body is converted differently from everything else, and the placement is what knows that.
const pictureOf = (here: string, file: MessageFile): string | undefined => (file.picture === undefined ? undefined : pathBetween(here, file.picture));

// Paths are written the way a reader follows them: from the folder the conversation sits in.
// Named in one pure pass before anything is rewritten, so the link a body carries and the file on
// disk are decided together and cannot disagree. A picture shown in the body still takes a name it
// will not use, which keeps the numbering of everything after it stable whether or not it is shown.
// The card sits beside the file it stands for and takes its name, so neither the body's link nor the
// write below has to look anything up: both ask the file what it was called.
const cardNameOf = (file: MessageFile): string => `${file.asName}.md`;

// `cards` is the card folder's own path, not the segment: `pathBetween` resolves its second argument
// against the working directory, so handing it `_attachments` climbs out of the vault entirely.
// The card and the file it stands for, kept together rather than lined up by index: what a body
// links to and what the record counts as shown are two views of one file, and pairing them is what
// stops a guard standing in for an invariant that already holds.
type Carried = { readonly carried: CarriedFile; readonly stored?: string };

const carriedBy = (here: string, cards: string, files: ReadonlyArray<MessageFile>): ReadonlyArray<Carried> =>
  files.map((file) => ({
    stored: file.primary,
    carried: {
      name: file.attachment.name,
      size: file.attachment.size,
      contentType: file.attachment.contentType,
      contentId: file.attachment.contentId,
      isInline: file.attachment.isInline,
      // Only a file that reaches the attachment list uses this, and a picture never does: it is
      // shown in the body, whether or not a placeholder claimed it, so it is never listed.
      path: pathBetween(here, `${cards}/${cardNameOf(file)}`),
      picture: pictureOf(here, file),
      text: file.text,
      note: file.note,
    },
  }));

export type ThreadBodies = { readonly parts: ReadonlyArray<ThreadPart>; readonly pictures: ReadonlyArray<string> };

// A picture shown in a body is named nowhere else, so it leaves the attachment list and goes under
// `inline_images` instead. Reported as a STORE path, not as the relative one a body links by: this
// is what filters the record's attachment list, and that list names what is on disk.
//
// One path, not two. It used to report the text read out of the picture as well, back when that was
// a document beside it; the words are in the thread now, so the picture is the whole of what a
// shown file produced.
const shownPaths = (here: string, carried: ReadonlyArray<Carried>): ReadonlyArray<string> =>
  carried.flatMap((pair) => {
    // Every picture is shown now, where one shown had to be told from one merely carried, so having
    // a picture at all is the whole of the question.
    const picture = pair.carried.picture;
    return picture === undefined ? [] : [pathUnder(here, picture)];
  });

export const rewriteBodies = (here: string, cards: string, parts: ReadonlyArray<ThreadPart>, byMessage: Readonly<Record<string, ReadonlyArray<MessageFile>>>): ThreadBodies => {
  const pictures: string[] = [];
  const rewritten = parts.map((part) => {
    const carried = carriedBy(here, cards, byMessage[part.message.id] ?? []);
    const body = rewriteMessageBody(
      part.body,
      carried.map((pair) => pair.carried)
    );
    for (const path of shownPaths(here, carried)) if (!pictures.includes(path)) pictures.push(path);
    return { message: part.message, body: body.body };
  });
  return { parts: rewritten, pictures };
};

// One card per file the thread carried, written HERE rather than inside the conversion. The
// conversion is short-circuited whenever a content is already in the store, which is the common
// case for everything after the first thread that carried it, so a card written there would exist
// only for the thread that happened to arrive first. Every other thread would then name files in
// its head that its own folder said nothing about.
export const writeCards = async (
  deps: DocumentDeps,
  cards: CardsFor,
  parts: ReadonlyArray<ThreadPart>,
  byMessage: Readonly<Record<string, ReadonlyArray<MessageFile>>>,
  shown: ReadonlySet<string>
): Promise<ReadonlyArray<string>> => {
  const folder = cards.folder;
  const written: string[] = [];
  const carded = new Set<string>();
  for (const part of parts) {
    for (const file of byMessage[part.message.id] ?? []) {
      if (file.picture !== undefined) continue;
      if (file.primary !== undefined && shown.has(file.primary)) continue;
      // One card per FILE, not per arrival: a signature riding on ten messages of one thread is one
      // file on disk and reads as one entry in the folder beside it.
      const name = cardNameOf(file);
      if (carded.has(name)) continue;
      carded.add(name);
      // The output that IS the file, told by its name rather than by not being the extract. A mail
      // attached to a mail unpacks into a folder of its own parts, and a document has its pictures
      // pulled out beside it, so "the first output that is not the extract" named whichever came
      // first: a logo, in the one real case. Nothing matches when the original was not kept, and no
      // `original:` line is the truthful answer there.
      const raw = file.paths.find((path) => path.endsWith(`/${file.asName}`));
      // Read, then written back over the same path, deliberately. The converter puts the extracted
      // text at `<name>.<ext>.md` inside this folder and the card wants that exact name, because a
      // reader opening the folder should find ONE document per file, not a card and an extract
      // saying the same thing. Reading first is what makes the overwrite safe: the body comes
      // forward, and the arrival facts, who sent it and under which message, replace a stamp that
      // said which library it came from, which is the wrong question for mail.
      const stored = file.primary === undefined ? undefined : await deps.files.readText(file.primary);
      const card = renderThreadCard({
        threadId: cards.threadId,
        messageId: part.message.id,
        filename: file.attachment.name,
        sender: part.message.from?.name,
        received: part.message.received,
        bytes: file.attachment.size,
        body: stored?.ok === true ? unwrapSafelinks(withoutFrontMatter(stored.value)) : undefined,
        original: raw === undefined ? undefined : pathBetween(folder, raw),
        note: file.note,
      });
      const saved = await deps.files.writeText(`${folder}/${name}`, card);
      if (saved.ok) written.push(`${folder}/${name}`);
      else deps.logger.warn('card.failed', { filename: file.attachment.name, cause: saved.error.kind });
    }
  }
  return written;
};
