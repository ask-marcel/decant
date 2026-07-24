export type MailFolder = {
  readonly id: string;
  readonly name: string;
  readonly childCount: number;
  readonly itemCount: number;
};

// Graph v1.0 does not tell us which folder is which well-known one (there is no `wellKnownName` on
// the v1.0 mailFolder), so the four folders that hold no correspondence worth keeping are matched
// by the name Outlook shows, in English and in French. Add a locale here if a mailbox in another
// language starts syncing its bin.
//
// Sent mail is NOT excluded: "Sent Items" / "Éléments envoyés" is where a message lands once it has
// gone out, and those are worth keeping. "Outbox" / "Boîte d'envoi" is the queue a message sits in
// for the seconds before delivery, so anything there reappears in Sent Items on its own.
const EXCLUDED = new Set([
  'deleted items',
  'éléments supprimés',
  'elements supprimes',
  'junk email',
  'courrier indésirable',
  'courrier indesirable',
  'drafts',
  'brouillons',
  'outbox',
  "boîte d'envoi",
  "boite d'envoi",
]);

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
