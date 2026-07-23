import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type SourceKind = 'site' | 'mailbox';

export type SyncedSource = {
  readonly kind: SourceKind;
  readonly id: string;
  readonly name: string;
  readonly lastRun: string;
  readonly fileCount: number;
};

export type SyncStateError = { readonly kind: 'malformed'; readonly message: string };

type SourceIdentity = { readonly kind: SourceKind; readonly id: string; readonly name: string };

export const NEVER_RUN = 'never';

const malformed = (message: string): Result<never, SyncStateError> => err({ kind: 'malformed', message });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const countDriveItems = (drive: unknown): number => {
  if (!isRecord(drive)) return 0;
  const items = drive['items'];
  return isRecord(items) ? Object.keys(items).length : 0;
};

const countItems = (drives: unknown): number => {
  if (!isRecord(drives)) return 0;
  return Object.values(drives).reduce<number>((total, drive) => total + countDriveItems(drive), 0);
};

const parseIdentity = (source: Record<string, unknown>): Result<SourceIdentity, SyncStateError> => {
  const kind = readString(source, 'kind');
  const id = readString(source, 'id');
  const name = readString(source, 'name');
  if (kind !== 'site' && kind !== 'mailbox') return malformed(`unknown source kind: ${String(kind)}`);
  if (id === undefined || name === undefined) return malformed('source is missing id or name');
  return ok({ kind, id, name });
};

export const parseSyncedSource = (raw: unknown): Result<SyncedSource, SyncStateError> => {
  if (!isRecord(raw)) return malformed('sync state is not an object');
  const source = raw['source'];
  if (!isRecord(source)) return malformed('sync state has no source object');
  const identity = parseIdentity(source);
  if (!identity.ok) return identity;
  return ok({ ...identity.value, lastRun: readString(raw, 'lastRun') ?? NEVER_RUN, fileCount: countItems(raw['drives']) });
};
