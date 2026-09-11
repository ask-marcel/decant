import type { Notebook, NotebookPage, NotebookSection, NotebookSite } from '../../domain/onenote.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError } from './drive-reader.ts';

export type NotebookReaderError = DriveReaderError;

// Finding the notebooks, walking one, and reading a page as markdown. A notebook is reached through
// the site it belongs to, or through the signed-in user's own route when it belongs to nobody's
// site, which is why every read takes the notebook and not merely an id.
export type NotebookReader = {
  // The signed-in user's own notebooks and those of the sites handed in, which are the sites the
  // picker already knows: a site is asked in its turn, side by side, and one that refuses costs its
  // own notebooks and not the listing.
  readonly listNotebooks: (sites: ReadonlyArray<NotebookSite>) => Promise<Result<ReadonlyArray<Notebook>, NotebookReaderError>>;
  readonly sections: (notebook: Notebook) => Promise<Result<ReadonlyArray<NotebookSection>, NotebookReaderError>>;
  readonly pages: (notebook: Notebook, sectionId: string) => Promise<Result<ReadonlyArray<NotebookPage>, NotebookReaderError>>;
  readonly pageMarkdown: (notebook: Notebook, pageId: string) => Promise<Result<string, NotebookReaderError>>;
};
