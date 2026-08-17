import type { Result } from '../../domain/result.ts';
import type { DriveDeltaPage, DriveItem } from '../../domain/drive-item.ts';

// How a call against Microsoft Graph can fail, in the terms this sync reacts to: `throttled` and
// `transient` are worth retrying, `permanent` is not, and `auth` ends the run. `protected` is not a
// failure of the call at all: the file arrived and cannot be read without a password nobody here
// has, so it is left out the way an unsupported type is, rather than asked for again forever.
export type DriveReaderError =
  | { readonly kind: 'auth'; readonly message: string }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds?: number; readonly message: string }
  | { readonly kind: 'transient'; readonly message: string }
  | { readonly kind: 'protected'; readonly message: string }
  // The file is readable, but the source will not hand it over in the format that was asked for.
  | { readonly kind: 'unrenderable'; readonly message: string }
  | { readonly kind: 'permanent'; readonly status?: number; readonly message: string };

export type SiteSummary = { readonly id: string; readonly name: string; readonly webUrl: string };

export type DriveSummary = { readonly id: string; readonly name: string };

export type ItemRef = { readonly driveId: string; readonly itemId: string };

// One file found inside an archive. `text` is its conversion; `note` explains an entry that could
// not be converted, so nothing inside a zip disappears silently.
export type ArchiveEntry = { readonly path: string; readonly text?: string; readonly note?: string };

// One picture embedded in a document. `path` is the part it was stored under (`word/media/image1.png`),
// which is what makes two pictures of a document tellable apart when neither carries a name.
export type EmbeddedImage = { readonly path: string; readonly bytes: Uint8Array };

export type DriveReader = {
  readonly listSites: () => Promise<Result<ReadonlyArray<SiteSummary>, DriveReaderError>>;
  readonly siteByUrl: (url: string) => Promise<Result<SiteSummary, DriveReaderError>>;
  // Named sites are looked up before syncing: the site's own name is the folder the knowledge base
  // uses, so taking the id for a name would file the same site twice.
  readonly siteById: (siteId: string) => Promise<Result<SiteSummary, DriveReaderError>>;
  readonly listDrives: (siteId: string) => Promise<Result<ReadonlyArray<DriveSummary>, DriveReaderError>>;
  readonly rootItemId: (driveId: string) => Promise<Result<string, DriveReaderError>>;
  // One item on its own, for a file reached by a link rather than by sweeping a library: the name,
  // size and date decide where it is filed and whether it is converted at all.
  readonly item: (ref: ItemRef) => Promise<Result<DriveItem, DriveReaderError>>;
  readonly delta: (ref: ItemRef) => Promise<Result<DriveDeltaPage, DriveReaderError>>;
  readonly deltaFrom: (cursor: string) => Promise<Result<DriveDeltaPage, DriveReaderError>>;
  readonly markdown: (ref: ItemRef) => Promise<Result<string, DriveReaderError>>;
  readonly pdf: (ref: ItemRef) => Promise<Result<Uint8Array, DriveReaderError>>;
  readonly bytes: (ref: ItemRef) => Promise<Result<Uint8Array, DriveReaderError>>;
  // The pictures a document embeds, which its markdown drops as a bare placeholder. A document that
  // embeds none answers with an empty list: nothing went wrong, there was simply nothing to take.
  readonly images: (ref: ItemRef) => Promise<Result<ReadonlyArray<EmbeddedImage>, DriveReaderError>>;
  readonly localMarkdown: (path: string) => Promise<Result<string, DriveReaderError>>;
  readonly localArchive: (path: string) => Promise<Result<ReadonlyArray<ArchiveEntry>, DriveReaderError>>;
};
