import type { Result } from '../../domain/result.ts';

export type FilesError =
  | { readonly kind: 'not-found'; readonly path: string; readonly message: string }
  | { readonly kind: 'read-failed'; readonly path: string; readonly message: string }
  | { readonly kind: 'write-failed'; readonly path: string; readonly message: string };

export type Files = {
  readonly readText: (path: string) => Promise<Result<string, FilesError>>;
  readonly listDirectoryNames: (path: string) => Promise<Result<ReadonlyArray<string>, FilesError>>;
  readonly writeText: (path: string, content: string) => Promise<Result<void, FilesError>>;
  readonly writeBytes: (path: string, bytes: Uint8Array) => Promise<Result<void, FilesError>>;
  readonly move: (from: string, to: string) => Promise<Result<void, FilesError>>;
  readonly exists: (path: string) => Promise<Result<boolean, FilesError>>;
};
