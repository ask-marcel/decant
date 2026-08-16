import type { DriveDeltaPage, DriveItem } from '../domain/drive-item.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { ArchiveEntry, DriveReader, DriveReaderError, DriveSummary, EmbeddedImage, ItemRef, SiteSummary } from '../use-cases/ports/drive-reader.ts';

export type DriveReaderFake = DriveReader & {
  readonly calls: Array<string>;
};

export type DriveReaderSeed = {
  readonly sites?: ReadonlyArray<SiteSummary>;
  readonly drives?: ReadonlyArray<DriveSummary>;
  readonly rootItemId?: string;
  // Items answered for by id, for the single-item read a linked file uses. An id with no entry is
  // reported missing, the way Graph answers for a file the caller cannot reach.
  readonly items?: Readonly<Record<string, DriveItem>>;
  // Pictures answered for by item id. An id with no entry embeds none, which is the common case.
  readonly images?: Readonly<Record<string, ReadonlyArray<EmbeddedImage>>>;
  // Fails the picture read alone, leaving the document's own conversion working, so a test can show
  // that losing the pictures does not cost the text.
  readonly failImages?: DriveReaderError;
  // Delta pages served in order: the first call gets the first page, and so on.
  readonly pages?: ReadonlyArray<DriveDeltaPage>;
  readonly markdown?: Readonly<Record<string, string>>;
  readonly archiveEntries?: ReadonlyArray<ArchiveEntry>;
  readonly failItems?: Readonly<Record<string, DriveReaderError>>;
  readonly failWith?: DriveReaderError;
  // Fails only the calls that follow a cursor, so a sweep can break halfway through its pages.
  readonly failFrom?: DriveReaderError;
};

const missing = (what: string): Result<never, DriveReaderError> => err({ kind: 'permanent', status: 404, message: `fake has no ${what}` });

export const createDriveReaderFake = (seed: DriveReaderSeed = {}): DriveReaderFake => {
  const calls: string[] = [];
  let pageIndex = 0;
  const nextPage = (): Result<DriveDeltaPage, DriveReaderError> => {
    const page = seed.pages?.[pageIndex];
    pageIndex += 1;
    return page === undefined ? ok({ items: [], skipped: 0 }) : ok(page);
  };
  const forItem = (ref: ItemRef, label: string): Result<string, DriveReaderError> => {
    calls.push(`${label}:${ref.itemId}`);
    const failure = seed.failItems?.[ref.itemId] ?? seed.failWith;
    if (failure) return err(failure);
    return ok(seed.markdown?.[ref.itemId] ?? `converted ${ref.itemId}`);
  };
  return {
    calls,
    listSites: async () => (seed.failWith ? err(seed.failWith) : ok(seed.sites ?? [])),
    siteByUrl: async (url) => {
      const site = seed.sites?.find((candidate) => candidate.webUrl === url);
      return site === undefined ? missing(`site at ${url}`) : ok(site);
    },
    siteById: async (siteId) => {
      const site = seed.sites?.find((candidate) => candidate.id === siteId);
      return site === undefined ? missing(`site ${siteId}`) : ok(site);
    },
    listDrives: async () => (seed.failWith ? err(seed.failWith) : ok(seed.drives ?? [])),
    rootItemId: async () => (seed.failWith ? err(seed.failWith) : ok(seed.rootItemId ?? '01ROOT')),
    images: async (ref) => {
      calls.push(`images:${ref.itemId}`);
      const failure = seed.failImages ?? seed.failWith;
      return failure ? err(failure) : ok(seed.images?.[ref.itemId] ?? []);
    },
    item: async (ref) => {
      calls.push(`item:${ref.itemId}`);
      if (seed.failWith) return err(seed.failWith);
      const found = seed.items?.[ref.itemId];
      return found === undefined ? missing(`item ${ref.itemId}`) : ok(found);
    },
    delta: async () => {
      calls.push('delta');
      return seed.failWith ? err(seed.failWith) : nextPage();
    },
    deltaFrom: async (cursor) => {
      calls.push(`deltaFrom:${cursor}`);
      if (seed.failWith) return err(seed.failWith);
      if (seed.failFrom && pageIndex > 0) return err(seed.failFrom);
      return nextPage();
    },
    markdown: async (ref) => forItem(ref, 'markdown'),
    pdf: async (ref) => {
      const rendered = forItem(ref, 'pdf');
      return rendered.ok ? ok(new TextEncoder().encode(`%PDF ${ref.itemId}`)) : rendered;
    },
    bytes: async (ref) => {
      const fetched = forItem(ref, 'bytes');
      return fetched.ok ? ok(new TextEncoder().encode(`bytes ${ref.itemId}`)) : fetched;
    },
    localMarkdown: async (path) => {
      calls.push(`localMarkdown:${path}`);
      return seed.failWith ? err(seed.failWith) : ok(`converted ${path}`);
    },
    localArchive: async (path) => {
      calls.push(`localArchive:${path}`);
      return seed.failWith ? err(seed.failWith) : ok(seed.archiveEntries ?? []);
    },
  };
};
