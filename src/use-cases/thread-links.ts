import { relative as pathBetween } from 'node:path';
import { withoutFrontMatter } from '../domain/front-matter.ts';
import { renderLinkCard } from '../domain/link-card.ts';
import type { LinkedRecord } from '../domain/mail-state.ts';
import type { ReportEntry } from '../domain/report.ts';
import { skipReason } from '../domain/report.ts';
import { uniqueName } from '../domain/thread-card.ts';
import type { ThreadPart } from '../domain/thread.ts';
import type { ConvertFile } from './convert-file.ts';
import type { DriveReader } from './ports/drive-reader.ts';
import type { Files } from './ports/files.ts';
import type { LinkedFile, MailReader } from './ports/mail-reader.ts';
import type { Logger } from './ports/logger.ts';

// What following a link costs, named rather than taken whole: this asks the mailbox for the links a
// message holds, the drive for one document's own metadata, and the converter for its text. It
// never reads a message, never lists an attachment, and never touches the mailbox root.
export type LinkDeps = {
  readonly reader: Pick<MailReader, 'sharepointLinks'>;
  readonly drive: Pick<DriveReader, 'item'>;
  readonly files: Pick<Files, 'readText' | 'writeText'>;
  readonly convertFile: ConvertFile;
  readonly logger: Logger;
};

// The folder a thread keeps what it pointed at in, holding the documents and the cards standing for
// them together: one entry per thing depended on, whether or not the thing itself could be pulled.
const LINKED_FOLDER = '_linked';

type Pulled = {
  readonly record?: LinkedRecord;
  // Read off the document at the source, so the card can say which version of it the thread meant.
  readonly lastModified?: string;
  readonly modifiedBy?: string;
  readonly skipped?: ReportEntry;
  readonly failed?: ReportEntry;
};

// What one message pointed at, kept per message so a card can say when the thread referenced it.
type MessageLink = {
  readonly link: LinkedFile;
  readonly received: string;
  // What the document was called inside this thread's folder. The card is this plus `.md`, so the
  // pair is one decision taken once, before the pull, and a document nobody could fetch still has a
  // name for its card to be written under.
  readonly asName: string;
  readonly paths: ReadonlyArray<string>;
  readonly lastModified?: string;
  readonly modifiedBy?: string;
  readonly note?: string;
};

export type LinkedTally = {
  readonly paths: ReadonlyArray<string>;
  readonly linked: Record<string, LinkedRecord>;
  readonly referenced: ReadonlyArray<MessageLink>;
  readonly skipped: ReadonlyArray<ReportEntry>;
  readonly failed: ReadonlyArray<ReportEntry>;
};

// A file already pulled for another thread is referenced, not fetched again: the same weekly report
// linked from thirty mails is one document on disk.
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

export const linkedFiles = async (deps: LinkDeps, here: string, maxBytes: number, parts: ReadonlyArray<ThreadPart>): Promise<LinkedTally> => {
  // Within this thread only, the way its attachments are. The same weekly report linked from thirty
  // mails across ten threads is pulled once per thread rather than once for the mailbox: a folder
  // that has to reach into another thread to be read is not self-contained, and the document is the
  // cheap half of what a thread costs.
  const linked: Record<string, LinkedRecord> = {};
  // One name per document, not per mention: a deck cited in four replies is one file. The names
  // already handed out are what a new one has to avoid, so the map is the taken list.
  const names: Record<string, string> = {};
  const paths: string[] = [];
  const skipped: ReportEntry[] = [];
  const failed: ReportEntry[] = [];
  const referenced: MessageLink[] = [];
  for (const part of parts) {
    if (!POINTS_SOMEWHERE.test(part.body)) continue;
    const message = part.message;
    const found = await deps.reader.sharepointLinks(message.id);
    if (!found.ok) continue;
    for (const link of found.value) {
      const key = `${link.driveId}:${link.itemId}`;
      const asName = names[key] ?? uniqueName(link.name, Object.values(names));
      names[key] = asName;
      const already = linked[key];
      const pulled = already === undefined ? await pullLinked(deps, here, maxBytes, link, asName) : { record: already };
      if (pulled.skipped !== undefined) skipped.push(pulled.skipped);
      if (pulled.failed !== undefined) failed.push(pulled.failed);
      // Recorded whether or not it came: a card for a document nobody could pull is the only place
      // the thread's dependence on it is written down.
      referenced.push({
        link,
        received: message.received,
        asName,
        paths: pulled.record?.paths ?? [],
        lastModified: pulled.lastModified,
        modifiedBy: pulled.modifiedBy,
        note: (pulled.skipped ?? pulled.failed)?.reason,
      });
      if (pulled.record === undefined) continue;
      linked[key] = pulled.record;
      for (const path of pulled.record.paths) if (!paths.includes(path)) paths.push(path);
    }
  }
  return { paths, linked, referenced, skipped, failed };
};

// The same route a file found by walking a library takes. A linked document is read for its own
// metadata first, because the name in the link cannot say when the file changed, how big it is, or
// what kind of thing it is: the day decides the folder, the size decides whether it is pulled at
// all, and the kind decides whether a deck also renders a PDF beside its text.
const pullLinked = async (deps: LinkDeps, here: string, maxBytes: number, link: LinkedFile, asName: string): Promise<Pulled> => {
  const { driveId, itemId, name } = link;
  const found = await deps.drive.item({ driveId, itemId });
  if (!found.ok) {
    deps.logger.warn('linked.failed', { itemId, name, cause: found.error.kind });
    return { failed: { path: name, reason: `${found.error.kind}: ${found.error.message}` } };
  }
  const into = `${here}/${LINKED_FOLDER}`;
  const outcome = await deps.convertFile({
    item: found.value,
    driveId,
    libraryRoot: into,
    site: 'Mailbox',
    library: LINKED_FOLDER,
    maxBytes,
    into,
    asName,
  });
  const { lastModified, modifiedBy } = found.value;
  if (outcome.kind === 'converted') return { record: { paths: outcome.outputs }, lastModified, modifiedBy };
  deps.logger.warn(outcome.kind === 'skipped' ? 'linked.skipped' : 'linked.failed', { itemId, name, cause: outcome.reason });
  if (outcome.kind === 'failed') return { failed: { path: name, reason: outcome.reason } };
  return { skipped: { path: name, reason: skipReason(outcome.reason, maxBytes) } };
};

// One card per document the thread pointed at, beside the thread rather than in the store the
// document itself sits in. Written here for the same reason the attachment cards are: a document
// another thread already pulled is referenced without being fetched again, so a card written where
// the fetching happens would exist only for the thread that got there first.
export const writeLinkCards = async (deps: LinkDeps, threadId: string, here: string, referenced: ReadonlyArray<MessageLink>): Promise<void> => {
  const folder = `${here}/${LINKED_FOLDER}`;
  // One card per document, not per mention. A deck cited in four replies is one thing the thread
  // depended on, and the card says when it was first pointed at.
  const seen = new Set<string>();
  for (const entry of referenced) {
    const key = `${entry.link.driveId}:${entry.link.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = `${entry.asName}.md`;
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
      lastModified: entry.lastModified,
      modifiedBy: entry.modifiedBy,
      body: stored?.ok === true ? withoutFrontMatter(stored.value) : undefined,
      original: original === undefined ? undefined : pathBetween(folder, original),
      note: entry.note,
    });
    const saved = await deps.files.writeText(`${folder}/${name}`, card);
    if (!saved.ok) deps.logger.warn('card.failed', { filename: entry.link.name, cause: saved.error.kind });
  }
};
