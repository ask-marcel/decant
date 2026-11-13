import type { Result } from '../../domain/result.ts';

export type OcrError = { readonly kind: 'unavailable' | 'failed'; readonly message: string };

// Which model read the image, said the way the companion's front matter says it. The language can
// differ from one image to the next, so it travels with the text rather than with the run.
export type OcrReading = { readonly text: string; readonly label: string };

// What a machine lacks for OCR: no Python at all, or a Python (named as the command that starts it)
// that cannot load the packages.
export type OcrMissing = { readonly kind: 'no-python' } | { readonly kind: 'no-packages'; readonly python: string };

export type Ocr = {
  // Reads the text visible in an image file already on disk. An image holding no text is not a
  // failure: it returns empty text, and the markdown companion says so.
  readonly read: (path: string) => Promise<Result<OcrReading, OcrError>>;
  // Set when the run turned OCR off: every read answers `unavailable` on purpose, so a picture it met
  // counts as read with no words, where one OCR could not read is read again by a later run.
  readonly off?: true;
  // Asked once before a run that wants OCR, so a machine that cannot do it stops the run with what to
  // install. Absent when there is nothing to ask, as when OCR is off.
  readonly ready?: () => Promise<Result<void, OcrMissing>>;
};
