import type { ThreadRecord } from '../domain/mail-state.ts';
import { findThreadFolder } from '../domain/thread-folder.ts';
import type { ThreadId } from '../domain/thread-id.ts';
import type { Result } from '../domain/result.ts';
import type { Files, FilesError } from './ports/files.ts';
import type { RenderThreadInput } from './render-thread.ts';

// The thread folders already on disk under a mailbox or a group inbox, listed once a run. A listing
// that fails, as it does before the first run made the folder, finds none.
export type FoldersOnDisk = Result<ReadonlyArray<string>, FilesError>;

export const threadFoldersOn = async (files: Pick<Files, 'listDirectoryNames'>, root: string): Promise<FoldersOnDisk> => files.listDirectoryNames(`${root}/threads`);

// The folder a thread is written into: the one its record holds, else the one on disk that carries
// its id, else none, and the naming rules decide. A state lost or started over holds no record, an
// older one can hold a record with no folder, and the rules can name a thread otherwise than when its
// folder was made; the id cannot change.
export const folderFor = (record: ThreadRecord | undefined, onDisk: FoldersOnDisk, threadId: string): string => {
  const recorded = record?.folder ?? '';
  if (recorded.length > 0) return recorded;
  return (onDisk.ok ? findThreadFolder(onDisk.value, threadId as ThreadId) : undefined) ?? '';
};

// What a write takes from the thread's record besides its folder: the note's path, the names its files
// and linked documents were written under, the version each document was pulled at, and every file its
// folder holds. Nothing for a thread never written.
export const writtenBefore = (record: ThreadRecord | undefined): Pick<RenderThreadInput, 'file' | 'names' | 'links' | 'linkedVersions' | 'held'> => ({
  file: record?.file,
  names: record?.names,
  links: record?.links,
  linkedVersions: record?.linkedVersions,
  held: record?.files,
});
