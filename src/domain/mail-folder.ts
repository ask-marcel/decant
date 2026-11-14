export type MailFolder = {
  readonly id: string;
  readonly name: string;
  readonly childCount: number;
  readonly itemCount: number;
};

// Every folder is read, the bin, the junk and the drafts included: what a mailbox holds is for its
// owner to say, and a draft or a deleted mail is still something they wrote or were sent. The one
// folder passed over is the outbox, the queue a message sits in for the seconds before delivery:
// anything there reappears in Sent Items on its own.
//
// Graph v1.0 does not tell us which folder is which well-known one (there is no `wellKnownName` on
// the v1.0 mailFolder), so the outbox is matched by the name Outlook shows, in English and in French.
// Add a locale here if a mailbox in another language starts syncing its outbox.
const EXCLUDED = new Set(['outbox', "boîte d'envoi", "boite d'envoi"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  return typeof value === 'number' ? value : 0;
};

const parseFolder = (raw: unknown): MailFolder | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = raw['id'];
  const name = raw['displayName'];
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  return { id, name, childCount: readNumber(raw, 'childFolderCount'), itemCount: readNumber(raw, 'totalItemCount') };
};

export const parseMailFolders = (raw: unknown): ReadonlyArray<MailFolder> => {
  if (!isRecord(raw) || !Array.isArray(raw['value'])) return [];
  return raw['value'].map(parseFolder).filter((folder): folder is MailFolder => folder !== undefined);
};

export const isExcludedFolder = (name: string): boolean => EXCLUDED.has(name.trim().toLowerCase());

export const syncableFolders = (folders: ReadonlyArray<MailFolder>): ReadonlyArray<MailFolder> => folders.filter((folder) => !isExcludedFolder(folder.name));
