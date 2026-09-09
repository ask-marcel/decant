import type { Result } from '../domain/result.ts';
import { ok } from '../domain/result.ts';
import type { SyncedSource } from '../domain/sync-state.ts';
import { parseSyncedSource } from '../domain/sync-state.ts';
import { parseJson } from '../domain/utilities/parse-json.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { StepError } from './ports/step-error.ts';

export const STATE_FILE_NAME = '.sync-state.json';

export type ListSyncedSourcesDeps = {
  readonly files: Files;
  readonly logger: Logger;
  readonly kbRoot: string;
};

export type ListSyncedSources = () => Promise<Result<ReadonlyArray<SyncedSource>, StepError>>;

const readOne = async (deps: ListSyncedSourcesDeps, folder: string): Promise<SyncedSource | undefined> => {
  const path = `${deps.kbRoot}/${folder}/${STATE_FILE_NAME}`;
  const text = await deps.files.readText(path);
  if (!text.ok) return undefined;
  const parsed = parseJson(text.value);
  if (!parsed.ok) return warnUnreadable(deps, folder, parsed.error.kind);
  const source = parseSyncedSource(parsed.value);
  return source.ok ? source.value : warnUnreadable(deps, folder, source.error.kind);
};

const warnUnreadable = (deps: ListSyncedSourcesDeps, folder: string, cause: string): undefined => {
  deps.logger.warn('sync-state.unreadable', { folder, cause });
  return undefined;
};

// A top-level folder is either a source itself, which the mailbox is, or a category holding them,
// which every other one is. Trying the state file before listing the children tells the two apart
// without naming the categories here, so a category added to the picker needs no change in this file.
const sourcesUnder = async (deps: ListSyncedSourcesDeps, folder: string): Promise<ReadonlyArray<SyncedSource>> => {
  const direct = await readOne(deps, folder);
  if (direct !== undefined) return [direct];
  const children = await deps.files.listDirectoryNames(`${deps.kbRoot}/${folder}`);
  if (!children.ok) return [];
  const found = await Promise.all(children.value.map((child) => readOne(deps, `${folder}/${child}`)));
  return found.filter((source): source is SyncedSource => source !== undefined);
};

export const createListSyncedSources =
  (deps: ListSyncedSourcesDeps): ListSyncedSources =>
  async () => {
    const folders = await deps.files.listDirectoryNames(deps.kbRoot);
    if (!folders.ok) return ok([]);
    const found = await Promise.all(folders.value.map((folder) => sourcesUnder(deps, folder)));
    return ok(found.flat());
  };
