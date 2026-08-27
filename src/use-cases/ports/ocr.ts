import type { Result } from '../../domain/result.ts';

export type OcrError = { readonly kind: 'unavailable' | 'failed'; readonly message: string };

// Which model read the image, said the way the companion's front matter says it. The language can
// differ from one image to the next, so it travels with the text rather than with the run.
export type OcrReading = { readonly text: string; readonly label: string };

export type Ocr = {
  // Reads the text visible in an image file already on disk. An image holding no text is not a
  // failure: it returns empty text, and the markdown companion says so.
  readonly read: (path: string) => Promise<Result<OcrReading, OcrError>>;
};
