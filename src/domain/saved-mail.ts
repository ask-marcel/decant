import { linkDestination } from './markdown-link.ts';

// A saved email is unpacked into a folder of its own parts, and the document standing for it sat in
// that folder naming none of them. Its signature read `[cid:Logo5_f97c665d-….png]` with the picture
// on disk beside it under exactly that name, and the spreadsheet the mail was written to send,
// `Dane.xlsx`, was converted, stored, and mentioned nowhere: "Attached the format that Pepco is able
// to provide" and no way to reach it.

// How a plain-text MIME body points at a picture that travelled with it. The label is the part's
// filename, which is what the part is written under, so the two join up by name alone.
const CID = /\[cid:([^\]]+)\]/g;

// `name` is the file itself; `opens` is what a reader should be sent to, which is the reading of it
// when the converter made one and the file when it did not.
export type CarriedPart = { readonly name: string; readonly opens: string };

const LIST_MARKER = '**Carried by this message:**';

// Shown where the message showed it, listed where it did not. The same rule a thread body follows,
// for the same reason: a signature logo put back in the signature is not also an inventory entry,
// and a spreadsheet nothing pointed at is nothing BUT an inventory entry.
export const savedMailBody = (text: string, parts: ReadonlyArray<CarriedPart>): string => {
  const shown = new Set<string>();
  const body = text.replace(CID, (marker, label: string) => {
    const part = parts.find((candidate) => candidate.name === label);
    if (part === undefined) return marker;
    shown.add(part.name);
    return `![${part.name}](${linkDestination(part.name)})`;
  });
  const listed = parts.filter((part) => !shown.has(part.name)).map((part) => `- [${part.name}](${linkDestination(part.opens)})`);
  return listed.length === 0 ? body : [body.trimEnd(), '', LIST_MARKER, ...listed].join('\n');
};
