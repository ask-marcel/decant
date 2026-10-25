import { CALENDAR_NAME } from './calendar-state.ts';
import { CATEGORY_FOLDER } from './kb-category.ts';
import { MAILBOX_NAME } from './mail-state.ts';
import { PEOPLE_NAME } from './people-state.ts';

// Every path a sync records starts with the folder of the knowledge base, as the run that wrote it
// named the folder: `kb/Calendar/2026-10-12/Offsite planning.md`. Copied to another folder, or read
// through another name of the same one, the knowledge base holds paths into the old one. Each state
// therefore names the folder it was written in, and is read with that folder replaced by the current.
export const KB_ROOT_KEY = '$kbRoot';

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// The folders a run writes at the top of the knowledge base. A path a state records goes into one of
// them; the place of a document in its library, `kb/Plan.docx` under a SharePoint folder named `kb`,
// does not, though it starts with the same name.
const TOP_FOLDERS: ReadonlyArray<string> = [...Object.values(CATEGORY_FOLDER), MAILBOX_NAME, CALENDAR_NAME, PEOPLE_NAME, '_archive', '_meta'];

const topOf = (text: string, from: string): string | undefined => (text.startsWith(`${from}/`) ? text.slice(from.length + 1).split('/')[0] : undefined);

const isKbPath = (text: string, from: string): boolean => TOP_FOLDERS.includes(topOf(text, from) ?? '');

// A path into a folder of the knowledge base, never the bare name of it, which a subject can hold.
const moved = (text: string, from: string, to: string): string => (isKbPath(text, from) ? `${to}${text.slice(from.length)}` : text);

// Each string a state holds, its keys too, since a map can be keyed by the paths it records.
const stringsOf = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  return isRecord(value) ? Object.entries(value).flatMap(([key, inner]) => [key, ...stringsOf(inner)]) : [];
};

// The value with each path under `from` moved under `to`, in its keys and in its values.
export const rebasePaths = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === 'string') return moved(value, from, to);
  if (Array.isArray(value)) return value.map((inner) => rebasePaths(inner, from, to));
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [moved(key, from, to), rebasePaths(inner, from, to)])) : value;
};

// The folder a path names before the first folder of the knowledge base in it. An address is not a
// path, though it may carry the same words.
const folderBefore = (text: string): string | undefined => {
  if (text.includes('://')) return undefined;
  const found = TOP_FOLDERS.map((top) => text.indexOf(`/${top}/`)).filter((at) => at > 0);
  return found.length === 0 ? undefined : text.slice(0, Math.min(...found));
};

// A state saved before it named its folder: the folder that most of its paths start with, ahead of a
// folder of the knowledge base. None, when it records no such path.
export const inferredRoot = (state: unknown): string | undefined => {
  const counts = new Map<string, number>();
  for (const folder of stringsOf(state).flatMap((text) => folderBefore(text) ?? [])) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
};

// The state as a sync reads it: without the name of its folder, and with each path in the current one.
export const rootedState = (state: unknown, kbRoot: string): unknown => {
  if (!isRecord(state)) return state;
  const { [KB_ROOT_KEY]: recorded, ...rest } = state;
  const root = typeof recorded === 'string' ? recorded : inferredRoot(rest);
  return root === undefined || root === kbRoot ? rest : rebasePaths(rest, root, kbRoot);
};

// The state as it is saved: with the name of the folder it was written in.
export const withRoot = (state: unknown, kbRoot: string): unknown => (isRecord(state) ? { ...state, [KB_ROOT_KEY]: kbRoot } : state);
