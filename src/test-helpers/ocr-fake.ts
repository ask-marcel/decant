import { err, ok } from '../domain/result.ts';
import type { Ocr, OcrError, OcrMissing } from '../use-cases/ports/ocr.ts';

export type OcrSeed = {
  readonly texts?: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly failWith?: OcrError;
  // What the machine lacks for OCR. None means the fake is asked nothing before the run, as OCR that
  // is off is not.
  readonly missing?: OcrMissing;
};

const READ_BY = 'rapidocr (latin)';

export const createOcrFake = (seed: OcrSeed = {}): Ocr => ({
  ...(seed.missing === undefined ? {} : { ready: async () => err(seed.missing as OcrMissing) }),
  read: async (path) => (seed.failWith ? err(seed.failWith) : ok({ text: seed.texts?.[path] ?? '', label: seed.label ?? READ_BY })),
});
