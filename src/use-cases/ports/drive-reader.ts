import type { Result } from '../../domain/result.ts';
import type { DriveDeltaPage } from '../../domain/drive-item.ts';

// How a call against Microsoft Graph can fail, in the terms this sync reacts to: `throttled` and
// `transient` are worth retrying, `permanent` is not, and `auth` ends the run.
export type DriveReaderError =
  | { readonly kind: 'auth'; readonly message: string }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds?: number; readonly message: string }
  | { readonly kind: 'transient'; readonly message: string }
  | { readonly kind: 'permanent'; readonly status?: number; readonly message: string };

export type SiteSummary = { readonly id: string; readonly name: string; readonly webUrl: string };

export type DriveSummary = { readonly id: string; readonly name: string };

export type ItemRef = { readonly driveId: string; readonly itemId: string };

// One file found inside an archive. `text` is its conversion; `note` explains an entry that could
// not be converted, so nothing inside a zip disappears silently.
export type ArchiveEntry = { readonly path: string; readonly text?: string; readonly note?: string };

export type DriveReader = {
  readonly listSites: () => Promise<Result<ReadonlyArray<SiteSummary>, DriveReaderError>>;
  readonly siteByUrl: (url: string) => Promise<Result<SiteSummary, DriveReaderError>>;
  // Named sites are looked up before syncing: the site's own name is the folder the knowledge base
  // uses, so taking the id for a name would file the same site twice.
  readonly siteById: (siteId: string) => Promise<Result<SiteSummary, DriveReaderError>>;
  readonly listDrives: (siteId: string) => Promise<Result<ReadonlyArray<DriveSummary>, DriveReaderError>>;
  readonly rootItemId: (driveId: string) => Promise<Result<string, DriveReaderError>>;
  readonly delta: (ref: ItemRef) => Promise<Result<DriveDeltaPage, DriveReaderError>>;
  readonly deltaFrom: (cursor: string) => Promise<Result<DriveDeltaPage, DriveReaderError>>;
  readonly markdown: (ref: ItemRef) => Promise<Result<string, DriveReaderError>>;
  readonly pdf: (ref: ItemRef) => Promise<Result<Uint8Array, DriveReaderError>>;
  readonly bytes: (ref: ItemRef) => Promise<Result<Uint8Array, DriveReaderError>>;
  readonly localMarkdown: (path: string) => Promise<Result<string, DriveReaderError>>;
  readonly localArchive: (path: string) => Promise<Result<ReadonlyArray<ArchiveEntry>, DriveReaderError>>;
};
