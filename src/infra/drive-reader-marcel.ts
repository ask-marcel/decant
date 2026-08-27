import { parseDriveDelta, parseItem } from '../domain/drive-item.ts';
import type { DriveDeltaPage } from '../domain/drive-item.ts';
import type { Result } from '../domain/result.ts';
import { unlistedSiteUrls } from '../domain/shared-site.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { ArchiveEntry, DriveReader, DriveReaderError, DriveSummary, EmbeddedImage, ItemRef, SiteSummary } from '../use-cases/ports/drive-reader.ts';

// The slice of the ask-marcel-office-cli surface this adapter drives. Typed against what the
// package really exposes (a command registry whose results are `unknown`), so a test can hand in
// a stand-in registry without the SDK, and the narrowing below stays the only place that guesses.
export type GraphErrorShape = {
  readonly type: 'api_error' | 'auth_failed' | 'network_error' | 'validation_error';
  readonly status?: number;
  readonly message: string;
  readonly retryAfterSeconds?: number;
};

export type MarcelCommand = {
  readonly execute: (graph: unknown, params: Record<string, string>) => Promise<Result<unknown, GraphErrorShape>>;
  readonly executeLocal?: (fs: unknown, params: Record<string, string>) => Promise<Result<unknown, GraphErrorShape>>;
};

export type MarcelApi = {
  readonly graph: unknown;
  readonly fs: unknown;
  readonly commands: Readonly<Partial<Record<string, MarcelCommand>>>;
  readonly sleep?: (ms: number) => Promise<void>;
  // Says what a long listing is doing while it does it. Optional the way `sleep` is: a test hands in
  // a collector, production hands in a terminal line, and everything else needs neither.
  readonly notify?: (what: string) => void;
};

const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

// A document nobody can open without a password fails inside the library's own parsers, which
// report it the way they report a crash: `api_error` at status 500, which would otherwise read as a
// server having a bad minute and be retried three times, every run, forever. The message is the only
// thing that tells the two apart, and both the spreadsheet and the PDF reader say `password` in it.
const isProtected = (error: GraphErrorShape): boolean => /password/i.test(error.message);

const translate = (error: GraphErrorShape): DriveReaderError => {
  if (error.type === 'auth_failed') return { kind: 'auth', message: error.message };
  if (isProtected(error)) return { kind: 'protected', message: error.message };
  if (error.type === 'network_error') return { kind: 'transient', message: error.message };
  if (error.type !== 'api_error') return { kind: 'permanent', message: error.message };
  if (error.status === 429) return { kind: 'throttled', retryAfterSeconds: error.retryAfterSeconds, message: error.message };
  // Graph answers the render endpoint with 406 when it will not convert that file to that format,
  // whatever the reason on its side: the file is readable, the format is simply not on offer.
  if (error.status === 406) return { kind: 'unrenderable', message: error.message };
  return error.status !== undefined && error.status >= 500 ? { kind: 'transient', message: error.message } : { kind: 'permanent', status: error.status, message: error.message };
};

const isWorthRetrying = (error: DriveReaderError): boolean => error.kind === 'throttled' || error.kind === 'transient';

// Graph's own client already carries a request deadline (60s, 5min on binaries), so this adds only
// the retry policy: bounded, jittered, and never on an error that will fail the same way again.
const MAX_JITTER_MS = 500;

// Jitter so several runs throttled at once do not come back in step. Taken from the platform's
// random source rather than Math.random, which lint reads as a security smell wherever it appears.
const jitter = (): number => (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) % MAX_JITTER_MS;

const delayFor = (error: DriveReaderError, attempt: number): number => {
  const base = error.kind === 'throttled' && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : (RETRY_DELAYS_MS[attempt] ?? 30_000);
  return base + jitter();
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

const listOf = (value: unknown): ReadonlyArray<unknown> => (isRecord(value) && Array.isArray(value['value']) ? value['value'] : []);

const missing = (what: string): Result<never, DriveReaderError> => err({ kind: 'permanent', message: `Graph returned no ${what}` });

// A document embedding no pictures answers `{ count: 0, media: [] }`, which is an answer and not a
// failure, so an absent or unreadable entry is dropped rather than ending the conversion.
const mediaOf = (value: unknown): ReadonlyArray<EmbeddedImage> => {
  const media = isRecord(value) && Array.isArray(value['media']) ? value['media'] : [];
  return media.flatMap((entry) => {
    const path = readString(entry, 'path');
    const base64 = readString(entry, 'base64');
    return path === undefined || base64 === undefined ? [] : [{ path, bytes: new Uint8Array(Buffer.from(base64, 'base64')) }];
  });
};

const toBytes = (value: unknown): Result<Uint8Array, DriveReaderError> => {
  const base64 = readString(value, 'base64');
  if (base64 !== undefined) return ok(new Uint8Array(Buffer.from(base64, 'base64')));
  const text = readString(value, 'text');
  return text === undefined ? missing('bytes') : ok(new TextEncoder().encode(text));
};

// One command call, with the retry policy and the error translation applied. Both the SharePoint
// and the mailbox readers run through this, so a throttle is handled the same way on either side.
export type MarcelCall = (name: string, params: Record<string, string>, local?: boolean) => Promise<Result<unknown, DriveReaderError>>;

// A command is expected to answer with a Result, but it can still throw: decoding malformed base64
// raises `InvalidCharacterError` from inside the library, for one. A throw here would end the whole
// run over a single unreadable file, so it is turned into an error for that one call instead.
const attempt = async (command: MarcelCommand, api: MarcelApi, params: Record<string, string>, local: boolean): Promise<Result<unknown, DriveReaderError>> => {
  try {
    const raw = local && command.executeLocal ? await command.executeLocal(api.fs, params) : await command.execute(api.graph, params);
    return raw.ok ? ok(raw.value) : err(translate(raw.error));
  } catch (error) {
    return err({ kind: 'permanent', message: formatError(error) });
  }
};

export const createMarcelCall = (api: MarcelApi): MarcelCall => {
  const pause = api.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (name, params, local = false) => {
    const command = api.commands[name];
    if (command === undefined) return err({ kind: 'permanent', message: `unknown command: ${name}` });
    let last: DriveReaderError = { kind: 'permanent', message: `${name} never ran` };
    for (let tries = 0; tries <= RETRY_DELAYS_MS.length; tries += 1) {
      const outcome = await attempt(command, api, params, local);
      if (outcome.ok) return outcome;
      last = outcome.error;
      if (!isWorthRetrying(last) || tries === RETRY_DELAYS_MS.length) return err(last);
      await pause(delayFor(last, tries));
    }
    return err(last);
  };
};

export const createDriveReaderFromApi = (api: MarcelApi): DriveReader => {
  const call = createMarcelCall(api);
  const say = api.notify ?? ((): void => undefined);

  const delta = async (params: Record<string, string>): Promise<Result<DriveDeltaPage, DriveReaderError>> => {
    const raw = await call('get-drive-delta', params);
    if (!raw.ok) return raw;
    const page = parseDriveDelta(raw.value);
    return page.ok ? ok(page.value) : err({ kind: 'permanent', message: page.error.message });
  };

  const markdownOf = async (name: string, params: Record<string, string>, local = false): Promise<Result<string, DriveReaderError>> => {
    const raw = await call(name, params, local);
    if (!raw.ok) return raw;
    return ok(readString(raw.value, 'text') ?? '');
  };

  const bytesOf = async (name: string, ref: ItemRef): Promise<Result<Uint8Array, DriveReaderError>> => {
    const raw = await call(name, { driveId: ref.driveId, itemId: ref.itemId });
    return raw.ok ? toBytes(raw.value) : raw;
  };

  const siteOf = async (siteId: string): Promise<Result<SiteSummary, DriveReaderError>> => {
    const raw = await call('get-sharepoint-site', { siteId });
    if (!raw.ok) return raw;
    const site = toSite(raw.value)[0];
    return site === undefined ? missing('site') : ok(site);
  };

  const siteAt = async (url: string): Promise<Result<SiteSummary, DriveReaderError>> => {
    const parsed = parseSiteUrl(url);
    if (!parsed.ok) return parsed;
    const raw = await call('get-sharepoint-site-by-path', parsed.value);
    if (!raw.ok) return raw;
    const site = toSite(raw.value)[0];
    return site === undefined ? missing('site') : ok(site);
  };

  // A library shared with you reaches the drive sweep even when its site never reaches the index.
  // Each such site costs one lookup, so the ones already listed are dropped before any call is made.
  const sharedSitesOf = async (drives: ReadonlyArray<unknown>, known: ReadonlyArray<SiteSummary>): Promise<Result<ReadonlyArray<SiteSummary>, DriveReaderError>> => {
    const libraries = drives
      .filter((drive) => readString(drive, 'driveType') === 'documentLibrary')
      .flatMap((drive) => {
        const webUrl = readString(drive, 'webUrl');
        return webUrl === undefined ? [] : [webUrl];
      });
    const unlisted = unlistedSiteUrls(
      libraries,
      known.map((site) => site.webUrl)
    );
    if (unlisted.length > 0) say(`Looking up ${unlisted.length} site${unlisted.length === 1 ? '' : 's'} the index did not name…`);
    const found: SiteSummary[] = [];
    for (const url of unlisted) {
      const site = await siteAt(url);
      if (!site.ok) return site;
      found.push(site.value);
    }
    return ok(found);
  };

  const workspacesOf = async (pods: ReadonlyArray<unknown>): Promise<Result<ReadonlyArray<SiteSummary>, DriveReaderError>> => {
    const found: SiteSummary[] = [];
    for (const id of pods.flatMap(containerId)) {
      const workspace = await siteOf(id);
      if (!workspace.ok) return workspace;
      found.push(workspace.value);
    }
    return ok(found);
  };

  return {
    // Three listings answer the same question from three directions, and none needs the others, so
    // they are asked together and the wait is the slowest rather than the sum: the drive sweep alone
    // is around forty seconds. Only the lookups that follow depend on what came back. `call` never
    // rejects (it turns a throw into an error), so `Promise.all` cannot either, and reading the
    // three results in a fixed order keeps the reported failure the same one on every run.
    listSites: async () => {
      say('Looking for every site you can read…');
      const [raw, pods, drives] = await Promise.all([
        call('search-all-accessible-sites', { query: '*' }),
        call('search-all-files', { query: `filetype:${POD_EXTENSION}` }),
        call('list-accessible-drives', {}),
      ]);
      if (!raw.ok) return raw;
      if (!pods.ok) return pods;
      if (!drives.ok) return drives;
      const workspaces = await workspacesOf(listOf(pods.value));
      if (!workspaces.ok) return workspaces;
      const listed = [...listOf(raw.value).flatMap(toSite), ...workspaces.value];
      const shared = await sharedSitesOf(listOf(drives.value), listed);
      if (!shared.ok) return shared;
      say('');
      return ok([...listed, ...shared.value]);
    },
    siteByUrl: siteAt,
    siteById: siteOf,
    listDrives: async (siteId) => {
      const raw = await call('list-sharepoint-site-drives', { siteId });
      if (!raw.ok) return raw;
      return ok(listOf(raw.value).flatMap(toDrive));
    },
    rootItemId: async (driveId) => {
      const raw = await call('get-drive-root-item', { driveId, select: 'id' });
      if (!raw.ok) return raw;
      const id = readString(raw.value, 'id');
      return id === undefined ? missing('root item id') : ok(id);
    },
    item: async (ref) => {
      const raw = await call('get-drive-item', { driveId: ref.driveId, itemId: ref.itemId });
      if (!raw.ok) return raw;
      const parsed = parseItem(raw.value);
      return parsed === undefined ? missing('drive item') : ok(parsed);
    },
    delta: async (ref) => delta({ driveId: ref.driveId, itemId: ref.itemId, top: '1000' }),
    deltaFrom: async (cursor) => {
      const raw = await call('next-page', { url: cursor });
      if (!raw.ok) return raw;
      const page = parseDriveDelta(raw.value);
      return page.ok ? ok(page.value) : err({ kind: 'permanent', message: page.error.message });
    },
    markdown: async (ref) => markdownOf('download-drive-item-as-markdown', { driveId: ref.driveId, itemId: ref.itemId, includeMetadata: 'true' }),
    pdf: async (ref) => bytesOf('download-drive-item-as-pdf', ref),
    bytes: async (ref) => bytesOf('download-drive-item-content', ref),
    images: async (ref) => {
      const raw = await call('extract-drive-item-images', { driveId: ref.driveId, itemId: ref.itemId });
      if (!raw.ok) return raw;
      return ok(mediaOf(raw.value));
    },
    localMarkdown: async (path) => markdownOf('convert-local-file-to-markdown', { path }, true),
    localArchive: async (path) => {
      const raw = await call('convert-local-file-to-markdown', { path }, true);
      if (!raw.ok) return raw;
      return ok(toArchiveEntries(raw.value));
    },
  };
};

// A Loop workspace holds its pages in a SharePoint Embedded container, which no site listing
// returns: neither the search over sites nor the drives a site declares knows the container exists.
// What every workspace does keep is one `.pod` manifest beside its pages, and the file index has
// that, so one manifest found is one workspace. Graph addresses the container as a site all the
// same, so the row below goes through the picker, the sweep and the state file unchanged.
const POD_EXTENSION = 'pod';

const WORKSPACE_PREFIX = 'Loop - ';

// A container answers as a site under `/contentstorage/`, carrying the workspace's display name and
// nothing to say the pages are Loop pages. Named by id rather than chosen from the list, it would
// otherwise be filed under a second name, and one workspace would become two folders. The segment
// after that path is a container id in one of two shapes (`CSP_<guid>` for a shared workspace, an
// opaque token for a personal one), so the path itself is the only part worth matching on.
const CONTAINER_PATH = '/contentstorage/';

const siteName = (name: string, webUrl: string): string => (webUrl.includes(CONTAINER_PATH) ? `${WORKSPACE_PREFIX}${name}` : name);

const toSite = (value: unknown): ReadonlyArray<SiteSummary> => {
  const id = readString(value, 'id');
  const name = readString(value, 'displayName') ?? readString(value, 'name');
  const webUrl = readString(value, 'webUrl') ?? '';
  return id === undefined || name === undefined ? [] : [{ id, name: siteName(name, webUrl), webUrl }];
};

// The manifest names its container in Loop's own host form (`loop.cloud.microsoft,<guid>,<guid>`),
// while a site lookup answers with the tenant-host form. Both address the same container, so the id
// found here is resolved before it is used: an id from the index and an id from a lookup would
// otherwise be two sources for one workspace, and the second one would sync it all over again.
const containerId = (value: unknown): ReadonlyArray<string> => {
  const parent = isRecord(value) ? value['parentReference'] : undefined;
  const siteId = readString(parent, 'siteId');
  return siteId === undefined ? [] : [siteId];
};

const toDrive = (value: unknown): ReadonlyArray<DriveSummary> => {
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  return id === undefined || name === undefined ? [] : [{ id, name }];
};

const toArchiveEntries = (value: unknown): ReadonlyArray<ArchiveEntry> => {
  if (!isRecord(value) || !Array.isArray(value['files'])) return [];
  return value['files'].flatMap((entry) => {
    const path = readString(entry, 'path');
    return path === undefined ? [] : [{ path, text: readString(entry, 'text'), note: readString(entry, 'note') }];
  });
};

// A site is addressed by hostname plus server-relative path, which is what a copied site URL holds.
const parseSiteUrl = (url: string): Result<{ hostname: string; path: string }, DriveReaderError> => {
  try {
    const parsed = new URL(url);
    return ok({ hostname: parsed.hostname, path: parsed.pathname.replace(/\/$/, '') });
  } catch {
    return err({ kind: 'permanent', message: `not a site address: ${url}` });
  }
};
