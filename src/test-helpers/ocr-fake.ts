import { err, ok } from '../domain/result.ts';
import type { Ocr, OcrError } from '../use-cases/ports/ocr.ts';

export type OcrSeed = {
  readonly texts?: Readonly<Record<string, string>>;
  readonly failWith?: OcrError;
};

export const createOcrFake = (seed: OcrSeed = {}): Ocr => ({
  read: async (path) => (seed.failWith ? err(seed.failWith) : ok(seed.texts?.[path] ?? '')),
});
