import { parseDriveDelta } from '../domain/drive-item.ts';
import type { DriveDeltaPage } from '../domain/drive-item.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import { formatError } from '../domain/utilities/format-error.ts';
import type { ArchiveEntry, DriveReader, DriveReaderError, DriveSummary, ItemRef, SiteSummary } from '../use-cases/ports/drive-reader.ts';

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
};

const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

const translate = (error: GraphErrorShape): DriveReaderError => {
  if (error.type === 'auth_failed') return { kind: 'auth', message: error.message };
  if (error.type === 'network_error') return { kind: 'transient', message: error.message };
  if (error.type !== 'api_error') return { kind: 'permanent', message: error.message };
  if (error.status === 429) return { kind: 'throttled', retryAfterSeconds: error.retryAfterSeconds, message: error.message };
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

  return {
    listSites: async () => {
      const raw = await call('search-all-accessible-sites', { query: '*' });
      if (!raw.ok) return raw;
      return ok(listOf(raw.value).flatMap(toSite));
    },
    siteByUrl: async (url) => {
      const parsed = parseSiteUrl(url);
      if (!parsed.ok) return parsed;
      const raw = await call('get-sharepoint-site-by-path', parsed.value);
      if (!raw.ok) return raw;
      const site = toSite(raw.value)[0];
      return site === undefined ? missing('site') : ok(site);
    },
    siteById: async (siteId) => {
      const raw = await call('get-sharepoint-site', { siteId });
      if (!raw.ok) return raw;
      const site = toSite(raw.value)[0];
      return site === undefined ? missing('site') : ok(site);
    },
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
    delta: async (ref) => delta({ driveId: ref.driveId, itemId: ref.itemId, top: '1000' }),
    deltaFrom: async (cursor) => {
      const raw = await call('next-page', { url: cursor });
      if (!raw.ok) return raw;
      const page = parseDriveDelta(raw.value);
      return page.ok ? ok(page.value) : err({ kind: 'permanent', message: page.error.message });
    },
    markdown: async (ref) => markdownOf('download-drive-item-as-markdown', { driveId: ref.driveId, itemId: ref.itemId }),
    pdf: async (ref) => bytesOf('download-drive-item-as-pdf', ref),
    bytes: async (ref) => bytesOf('download-drive-item-content', ref),
    localMarkdown: async (path) => markdownOf('convert-local-file-to-markdown', { path }, true),
    localArchive: async (path) => {
      const raw = await call('convert-local-file-to-markdown', { path }, true);
      if (!raw.ok) return raw;
      return ok(toArchiveEntries(raw.value));
    },
  };
};

const toSite = (value: unknown): ReadonlyArray<SiteSummary> => {
  const id = readString(value, 'id');
  const name = readString(value, 'displayName') ?? readString(value, 'name');
  return id === undefined || name === undefined ? [] : [{ id, name, webUrl: readString(value, 'webUrl') ?? '' }];
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
