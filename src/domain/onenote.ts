// A OneNote notebook, a section in it and a page in that, as Graph answers for them. A notebook
// belongs to a SharePoint site or to the signed-in user, and every read of a site's notebook goes
// through that site's route, so the notebook remembers which site it came from.
export type NotebookSite = { readonly id: string; readonly name: string };

export type Notebook = { readonly id: string; readonly name: string; readonly webUrl: string; readonly site: NotebookSite | undefined };

// The group a section sits in names a folder above the section; a section at the top of the
// notebook has none.
export type NotebookSection = { readonly id: string; readonly name: string; readonly group: string };

export type NotebookPage = { readonly id: string; readonly title: string; readonly created: string; readonly lastModified: string; readonly webUrl: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
};

// Graph nests the address one level down, `links.oneNoteWebUrl.href`.
const webUrlOf = (raw: Record<string, unknown>): string => {
  const links = raw['links'];
  return readString(isRecord(links) ? links['oneNoteWebUrl'] : undefined, 'href') ?? '';
};

export const parseNotebook = (raw: unknown, site: NotebookSite | undefined): Notebook | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  return { id, name: readString(raw, 'displayName') ?? id, webUrl: webUrlOf(raw), site };
};

export const parseNotebookSection = (raw: unknown): NotebookSection | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  return { id, name: readString(raw, 'displayName') ?? id, group: readString(raw['parentSectionGroup'], 'displayName') ?? '' };
};

const UNTITLED = 'Untitled page';

export const parseNotebookPage = (raw: unknown): NotebookPage | undefined => {
  const id = readString(raw, 'id');
  if (!isRecord(raw) || id === undefined) return undefined;
  const title = readString(raw, 'title') ?? '';
  return {
    id,
    title: title.length > 0 ? title : UNTITLED,
    created: readString(raw, 'createdDateTime') ?? '',
    lastModified: readString(raw, 'lastModifiedDateTime') ?? '',
    webUrl: webUrlOf(raw),
  };
};
