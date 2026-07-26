import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type SyncedMark = { readonly lastRun: string; readonly fileCount: number };

export type PickerRow = {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly synced?: SyncedMark;
  readonly hint?: string;
};

export type Choosable = { readonly id: string; readonly name: string; readonly webUrl?: string };

// Two different sites can carry the same display name (an unedited template title, most often), and
// with it look identical in a numbered list. Anything sharing a name with another source in the same
// listing is hinted with its own address, so the operator can tell them apart before choosing.
const collidingNames = (sources: ReadonlyArray<Choosable>): ReadonlySet<string> => {
  const seen = new Set<string>();
  const collided = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.name)) collided.add(source.name);
    seen.add(source.name);
  }
  return collided;
};

export type Selection =
  | { readonly kind: 'rows'; readonly indices: ReadonlyArray<number> }
  | { readonly kind: 'address'; readonly url: string }
  | { readonly kind: 'mailbox' }
  | { readonly kind: 'update-all' }
  | { readonly kind: 'quit' };

export type SelectionError = { readonly kind: 'bad-choice'; readonly message: string };

// A source already in the knowledge base is marked so the operator sees at a glance what is new,
// what is stale, and how much each one already holds.
export const annotate = (sources: ReadonlyArray<Choosable>, synced: Readonly<Record<string, SyncedMark>>): ReadonlyArray<PickerRow> => {
  const collided = collidingNames(sources);
  return sources.map((source) => {
    const mark = synced[source.id];
    const webUrl = source.webUrl ?? '';
    return { id: source.id, name: source.name, webUrl, ...(mark === undefined ? {} : { synced: mark }), ...(collided.has(source.name) ? { hint: webUrl } : {}) };
  });
};

const parseIndex = (token: string, count: number): Result<number, SelectionError> => {
  const index = Number(token);
  if (!Number.isInteger(index) || index < 1 || index > count) return err({ kind: 'bad-choice', message: `no such choice: ${token}` });
  return ok(index - 1);
};

const parseIndices = (input: string, count: number): Result<Selection, SelectionError> => {
  const tokens = input
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const indices: number[] = [];
  for (const token of tokens) {
    const parsed = parseIndex(token, count);
    if (!parsed.ok) return parsed;
    indices.push(parsed.value);
  }
  return ok({ kind: 'rows', indices });
};

export const parseSelection = (input: string, count: number): Result<Selection, SelectionError> => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return err({ kind: 'bad-choice', message: 'nothing chosen' });
  if (trimmed === 'q') return ok({ kind: 'quit' });
  if (trimmed === 'u') return ok({ kind: 'update-all' });
  if (trimmed === 'm') return ok({ kind: 'mailbox' });
  if (trimmed === 'all') return ok({ kind: 'rows', indices: [...Array.from({ length: count }, (_unused, index) => index)] });
  if (trimmed.startsWith('http')) return ok({ kind: 'address', url: trimmed });
  return parseIndices(trimmed, count);
};
