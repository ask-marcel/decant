import type { GetTarget } from '../domain/get-target.ts';
import type { Result } from '../domain/result.ts';
import type { GetFile, Got } from './get-file.ts';
import type { GetMail } from './get-mail.ts';
import type { StepError } from './ports/step-error.ts';

// `decant get`: one file or one mail conversation, by the one value that names it, where a sync
// takes a whole source. What kind of thing the value names was settled when it was read.
export type GetOneInput = { readonly target: GetTarget; readonly maxBytes: number };

export type GetOne = (input: GetOneInput) => Promise<Result<Got, StepError>>;

export type GetOneDeps = { readonly getFile: GetFile; readonly getMail: GetMail };

export const createGetOne =
  (deps: GetOneDeps): GetOne =>
  async (input) =>
    input.target.kind === 'file' ? deps.getFile({ url: input.target.url, maxBytes: input.maxBytes }) : deps.getMail({ target: input.target, maxBytes: input.maxBytes });
