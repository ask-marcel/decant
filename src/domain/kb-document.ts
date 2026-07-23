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

export const stampOf = (stamp: DocumentStamp): string =>
  renderFrontMatter([
    ['source', stamp.source],
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
