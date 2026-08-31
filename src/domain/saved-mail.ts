import { showPicture } from './inline-image.ts';
import { linkDestination } from './markdown-link.ts';

// A saved email is unpacked into a folder of its own parts, and the document standing for it sat in
// that folder naming none of them. Its signature read `[cid:Logo5_f97c665d-….png]` with the picture
// on disk beside it under exactly that name, and the spreadsheet the mail was written to send,
// `Dane.xlsx`, was converted, stored, and mentioned nowhere: "Attached the format we are able
// to provide" and no way to reach it.

// How a plain-text MIME body points at a picture that travelled with it. The label is the part's
// filename, which is what the part is written under, so the two join up by name alone.
const CID = /\[cid:([^\]]+)\]/g;

// `name` is the file itself; `opens` is what a reader should be sent to, which is the reading of it
// when the converter made one and the file when it did not. `read` is what was got off a picture,
// which the library will not convert and only OCR can answer for.
export type CarriedPart = { readonly name: string; readonly opens: string; readonly picture: boolean; readonly read?: string };

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
    return showPicture(part.name, part.name, part.read);
  });
  const rest = parts.filter((part) => !shown.has(part.name));
  // A picture nothing pointed at is still shown, after the text, exactly as a thread shows one whose
  // placeholder the conversion lost. Only what is not a picture belongs in an inventory.
  const appended = rest.filter((part) => part.picture).map((part) => showPicture(part.name, part.name, part.read));
  const listed = rest.filter((part) => !part.picture).map((part) => `- [${part.name}](${linkDestination(part.opens)})`);
  const inventory = listed.length === 0 ? '' : [LIST_MARKER, ...listed].join('\n');
  return [body.trim(), ...appended, inventory].filter((block) => block.length > 0).join('\n\n');
};
