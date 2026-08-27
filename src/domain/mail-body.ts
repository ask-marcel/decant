// What a message body says about the files it carried. The library renders that body for a caller
// holding its CLI, so it closes with a list naming each file, its raw Graph attachment id, and the
// command to fetch it. By the time a thread is written those files are converted and on disk, so
// the instruction is stale and the ids are noise: the list is cut and rewritten to link what landed.
const LIST_MARKER = '**Attachments:**';

// The library joins headers, body and list in that order, so the list is always the tail. Matching
// a whole line rather than the text anywhere keeps a message that merely mentions the words intact.
export const withoutAttachmentList = (body: string): string => {
  const lines = body.split('\n');
  const marker = lines.lastIndexOf(LIST_MARKER);
  return marker === -1 ? body : lines.slice(0, marker).join('\n').trimEnd();
};

// One file a message carried: where it landed if it was converted, or why it was left alone.
export type AttachmentLink = {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly path?: string;
  readonly note?: string;
};

const KILO = 1024;

const formatBytes = (size: number): string => {
  if (size < KILO) return `${size} B`;
  const kilobytes = size / KILO;
  return kilobytes < KILO ? `${kilobytes.toFixed(1)} KB` : `${(kilobytes / KILO).toFixed(1)} MB`;
};

// Graph reports no content type for an item attachment, and an empty one beside a size reads as a
// mistake rather than as an absence.
const detail = (entry: AttachmentLink): string => [formatBytes(entry.size), entry.contentType].filter((part) => part.length > 0).join(', ');

const line = (entry: AttachmentLink): string => {
  const named = entry.path === undefined ? entry.name : `[${entry.name}](${entry.path})`;
  const note = entry.note === undefined ? '' : `, ${entry.note}`;
  return `- ${named} (${detail(entry)})${note}`;
};

export const renderAttachmentList = (entries: ReadonlyArray<AttachmentLink>): string => (entries.length === 0 ? '' : [LIST_MARKER, ...entries.map(line)].join('\n'));
