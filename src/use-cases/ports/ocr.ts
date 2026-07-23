import type { Result } from '../../domain/result.ts';

export type OcrError = { readonly kind: 'unavailable' | 'failed'; readonly message: string };

export type Ocr = {
  // Reads the text visible in an image file already on disk. An image holding no text is not a
  // failure: it returns empty text, and the markdown companion says so.
  readonly read: (path: string) => Promise<Result<string, OcrError>>;
};
