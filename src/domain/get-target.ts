import { safeRelPath } from './kb-path.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

// The one thing `decant get` is asked for, told apart by what was typed: the address of a file on
// SharePoint or OneDrive, the address of a mail in Outlook on the web, or the id of a mail. One value
// is enough for each, since a file's address says which drive it is on and which item it is.
export type GetTarget = { readonly kind: 'file'; readonly url: string } | { readonly kind: 'mail-link'; readonly url: string } | { readonly kind: 'mail'; readonly id: string };

export type GetTargetError = { readonly kind: 'empty' } | { readonly kind: 'unknown-address'; readonly host: string };

const isAddress = (text: string): boolean => /^https?:\/\//i.test(text) && URL.canParse(text);

// Every tenant's SharePoint and every personal OneDrive sit under `sharepoint.com`, and `1drv.ms` is
// the short form of a link to one.
const holdsFiles = (host: string): boolean => host.endsWith('.sharepoint.com') || host === '1drv.ms';

const holdsMail = (host: string): boolean => host.startsWith('outlook.');

const addressed = (url: string): Result<GetTarget, GetTargetError> => {
  const host = new URL(url).hostname.toLowerCase();
  if (holdsFiles(host)) return ok({ kind: 'file', url });
  return holdsMail(host) ? ok({ kind: 'mail-link', url }) : err({ kind: 'unknown-address', host });
};

export const parseGetTarget = (value: string): Result<GetTarget, GetTargetError> => {
  const text = value.trim();
  if (text.length === 0) return err({ kind: 'empty' });
  return isAddress(text) ? addressed(text) : ok({ kind: 'mail', id: text });
};

// The words a site address opens with before the name of the site, which name nothing.
const SITE_KINDS = new Set(['sites', 'teams', 'personal']);

// decodeURIComponent throws on a lone `%`. A pure-domain fallback (rule 17): a part that cannot be
// decoded is used as it came.
const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

// The folder a picked file goes under, read off the address of its library: the site, or the owner
// of a personal OneDrive, then the library. None when the address names no folder.
export const libraryFolderOf = (libraryUrl: string): string | undefined => {
  if (!isAddress(libraryUrl)) return undefined;
  const parts = new URL(libraryUrl).pathname.split('/').filter((part) => part.length > 0);
  const named = SITE_KINDS.has(parts[0] ?? '') ? parts.slice(1) : parts;
  return named.length === 0 ? undefined : safeRelPath(named.map(decoded));
};

// The document an Office address names: its id, in lower case and without braces, and its file name.
export type OfficeDocument = { readonly id: string; readonly name: string };

const OFFICE_PAGE = /\/_layouts\/\d+\/doc\.aspx$/i;

// The address Office gives a document it opens (`.../_layouts/15/Doc.aspx?sourcedoc={id}&file=name`).
// It says which document and not where it sits, and Graph does not resolve it the way it resolves a
// sharing link, so the document is found by its name and told apart by this id.
export const officeDocumentOf = (url: string): OfficeDocument | undefined => {
  if (!isAddress(url)) return undefined;
  const address = new URL(url);
  const id = address.searchParams.get('sourcedoc');
  const name = address.searchParams.get('file');
  if (!OFFICE_PAGE.test(address.pathname) || id === null || name === null) return undefined;
  return { id: id.replaceAll(/[{}]/g, '').toLowerCase(), name };
};
