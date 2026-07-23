import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type SyncedMark = { readonly lastRun: string; readonly fileCount: number };

export type PickerRow = {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly synced?: SyncedMark;
};

export type Choosable = { readonly id: string; readonly name: string; readonly webUrl?: string };

export type Selection =
  | { readonly kind: 'rows'; readonly indices: ReadonlyArray<number> }
  | { readonly kind: 'address'; readonly url: string }
  | { readonly kind: 'update-all' }
  | { readonly kind: 'quit' };

export type SelectionError = { readonly kind: 'bad-choice'; readonly message: string };

// A source already in the knowledge base is marked so the operator sees at a glance what is new,
// what is stale, and how much each one already holds.
export const annotate = (sources: ReadonlyArray<Choosable>, synced: Readonly<Record<string, SyncedMark>>): ReadonlyArray<PickerRow> =>
  sources.map((source) => {
    const mark = synced[source.id];
    return { id: source.id, name: source.name, webUrl: source.webUrl ?? '', ...(mark === undefined ? {} : { synced: mark }) };
  });

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
  if (trimmed === 'all') return ok({ kind: 'rows', indices: [...Array.from({ length: count }, (_unused, index) => index)] });
  if (trimmed.startsWith('http')) return ok({ kind: 'address', url: trimmed });
  return parseIndices(trimmed, count);
};
