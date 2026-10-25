// Every path a sync records starts with the folder of the knowledge base, as the run that wrote it
// named the folder: `kb/Calendar/2026-10-12/Offsite planning.md`. Copied to another folder, or read
// through another name of the same one, the knowledge base holds paths into the old one. Each state
// therefore names the folder it was written in, and is read with that folder replaced by the current.
export const KB_ROOT_KEY = '$kbRoot';

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnder = (folder: string, text: string): boolean => text === folder || text.startsWith(`${folder}/`);

const moved = (text: string, from: string, to: string): string => (isUnder(from, text) ? `${to}${text.slice(from.length)}` : text);

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

// The folder a path names before `<place>/`, the folder of the state inside the knowledge base. An
// address is not a path, though it may carry the same words.
const folderBefore = (text: string, place: string): string | undefined => {
  if (text.includes('://')) return undefined;
  const at = text.indexOf(`/${place}/`);
  return at > 0 ? text.slice(0, at) : undefined;
};

// A state saved before it named its folder: the folder that most of its paths start with, ahead of
// the place of the state itself. None, when it records no path there.
export const inferredRoot = (state: unknown, place: string): string | undefined => {
  const counts = new Map<string, number>();
  for (const folder of stringsOf(state).flatMap((text) => folderBefore(text, place) ?? [])) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
};

// The state as a sync reads it: without the name of its folder, and with each path in the current one.
export const rootedState = (state: unknown, place: string, kbRoot: string): unknown => {
  if (!isRecord(state)) return state;
  const { [KB_ROOT_KEY]: recorded, ...rest } = state;
  const root = typeof recorded === 'string' ? recorded : inferredRoot(rest, place);
  return root === undefined || root === kbRoot ? rest : rebasePaths(rest, root, kbRoot);
};

// The state as it is saved: with the name of the folder it was written in.
export const withRoot = (state: unknown, kbRoot: string): unknown => (isRecord(state) ? { ...state, [KB_ROOT_KEY]: kbRoot } : state);
