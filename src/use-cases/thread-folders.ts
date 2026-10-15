import type { ThreadRecord } from '../domain/mail-state.ts';
import { findThreadFolder } from '../domain/thread-folder.ts';
import type { ThreadId } from '../domain/thread-id.ts';
import type { Files } from './ports/files.ts';

// The thread folders already on disk under a mailbox or a group inbox, listed once a run. None when
// the folder is not there yet, which is every first run.
export const threadFoldersOn = async (files: Pick<Files, 'listDirectoryNames'>, root: string): Promise<ReadonlyArray<string>> => {
  const listed = await files.listDirectoryNames(`${root}/threads`);
  return listed.ok ? listed.value : [];
};

// The folder a thread is written into: the one its record holds, else the one on disk that carries
// its id, else none, and the naming rules decide. A state lost or started over holds no record, and
// the rules can name a thread otherwise than when its folder was made; the id cannot.
export const folderFor = (record: ThreadRecord | undefined, onDisk: ReadonlyArray<string>, threadId: string): string =>
  record?.folder ?? findThreadFolder(onDisk, threadId as ThreadId) ?? '';
