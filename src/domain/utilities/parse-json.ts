import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { formatError } from './format-error.ts';

export type JsonParseError = { readonly kind: 'invalid-json'; readonly message: string };

export const parseJson = (raw: string): Result<unknown, JsonParseError> => {
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch (error) {
    return err({ kind: 'invalid-json', message: formatError(error) });
  }
};
