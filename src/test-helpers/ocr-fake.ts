import { err, ok } from '../domain/result.ts';
import type { Ocr, OcrError } from '../use-cases/ports/ocr.ts';

export type OcrSeed = {
  readonly texts?: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly failWith?: OcrError;
};

const READ_BY = 'rapidocr (latin)';

export const createOcrFake = (seed: OcrSeed = {}): Ocr => ({
  read: async (path) => (seed.failWith ? err(seed.failWith) : ok({ text: seed.texts?.[path] ?? '', label: seed.label ?? READ_BY })),
});
