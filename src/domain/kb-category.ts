import type { AddressKind } from './address-kind.ts';
import { addressKindOf } from './address-kind.ts';

// `kb/` is shelved the way the picker is. A flat vault put a Loop workspace, a colleague's OneDrive
// and a team site side by side under names that do not say which is which, so finding a source again
// meant remembering what it was. Filed under the heading it was chosen under, it does not.
// The presenter builds its headings from this same table, which is what keeps a folder and the
// heading that offered it from drifting apart.
export const CATEGORY_FOLDER: Readonly<Record<AddressKind, string>> = {
  site: 'SharePoint sites',
  loop: 'Loop workspaces',
  onedrive: 'OneDrive',
  group: 'Group inboxes',
  todo: 'To Do',
};

// The address is what settles the category, never the display name: a Loop workspace and a team site
// are both SharePoint underneath and can be titled alike.
export const categoryFolderOf = (webUrl: string): string => CATEGORY_FOLDER[addressKindOf(webUrl)];
