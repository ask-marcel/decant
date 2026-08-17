import { renderFrontMatter, withFrontMatter } from './front-matter.ts';

// Where a generated markdown file came from, stamped at its head so an agent reading it later can
// cite the source, judge how fresh it is, and open the PDF or image sitting beside it.
export type DocumentStamp = {
  readonly source: string;
  readonly site: string;
  readonly library: string;
  readonly path: string;
  readonly lastModified: string;
  readonly syncedAt: string;
  readonly modifiedBy?: string;
  readonly pdf?: string;
  readonly image?: string;
  readonly ocr?: string;
  readonly zipEntry?: string;
};

// A drive-item source is a real SharePoint/OneDrive link; a mail conversation or linked-drive source
// is a synthetic label (`conversation <id>`, `drive <id>`), never a URL, and is left exactly as
// given. `web=1` opens SharePoint's browser viewer directly rather than prompting for the desktop app.
const withWebParam = (source: string): string => {
  if (!source.startsWith('http://') && !source.startsWith('https://')) return source;
  const url = new URL(source);
  url.searchParams.set('web', '1');
  return url.toString();
};

export const stampOf = (stamp: DocumentStamp): string =>
  renderFrontMatter([
    ['source', withWebParam(stamp.source)],
    ['site', stamp.site],
    ['library', stamp.library],
    ['path', stamp.path],
    ['last_modified', stamp.lastModified],
    ['modified_by', stamp.modifiedBy],
    ['synced_at', stamp.syncedAt],
    ['pdf', stamp.pdf],
    ['image', stamp.image],
    ['ocr', stamp.ocr],
    ['zip_entry', stamp.zipEntry],
  ]);

export const kbDocument = (stamp: DocumentStamp, body: string): string => withFrontMatter(stampOf(stamp), body);

export const NO_TEXT_NOTE = '_No text could be read from this file. Open the file beside this note._';

export const SCANNED_PDF_NOTE = '_This PDF carries no text layer. Open the PDF beside this note with a reader that can see the page._';

export const VECTOR_NOTE = '_This drawing is XML. Open the file beside this note to read it._';

// The text of a deck arrives from the source directly, the picture of its slides only from the
// render the source refused. Saying so beside the text stops a reader hunting for a PDF that was
// never written, and keeps the two reasons apart: this deck was read, its slides were not drawn.
export const NO_SLIDES_NOTE = '_The slides of this deck could not be rendered, so only their text is here. Open the deck at the source to see them._';
