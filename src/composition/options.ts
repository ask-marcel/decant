import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';

export type Command = 'sync' | 'update';

export type Options = {
  readonly command: Command;
  readonly siteId?: string;
  readonly siteUrl?: string;
  readonly driveIds: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly maxSizeMb: number;
  readonly ocr: boolean;
  readonly ocrLang: string;
  readonly assumeYes: boolean;
};

export type OptionsError = { readonly kind: 'bad-option'; readonly message: string };

const DEFAULTS: Options = {
  command: 'sync',
  driveIds: [],
  dryRun: false,
  maxSizeMb: 50,
  ocr: true,
  ocrLang: 'en',
  assumeYes: false,
};

const FLAGS_WITH_VALUE = new Set(['--site-id', '--site-url', '--drive-id', '--max-size-mb', '--ocr-lang']);

const withValue = (options: Options, flag: string, value: string): Result<Options, OptionsError> => {
  if (flag === '--site-id') return ok({ ...options, siteId: value });
  if (flag === '--site-url') return ok({ ...options, siteUrl: value });
  if (flag === '--drive-id') return ok({ ...options, driveIds: [...options.driveIds, value] });
  if (flag === '--ocr-lang') return ok({ ...options, ocrLang: value });
  return withSize(options, value);
};

const withSize = (options: Options, value: string): Result<Options, OptionsError> => {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return err({ kind: 'bad-option', message: `--max-size-mb expects a positive number, got: ${value}` });
  return ok({ ...options, maxSizeMb: size });
};

const withFlag = (options: Options, flag: string): Result<Options, OptionsError> => {
  if (flag === '--dry-run') return ok({ ...options, dryRun: true });
  if (flag === '--no-ocr') return ok({ ...options, ocr: false });
  if (flag === '--yes' || flag === '-y') return ok({ ...options, assumeYes: true });
  return err({ kind: 'bad-option', message: `unknown option: ${flag}` });
};

const parseToken = (options: Options, token: string, value: string | undefined): Result<Options, OptionsError> => {
  if (token === 'update' || token === 'sync') return ok({ ...options, command: token });
  if (!token.startsWith('-')) return err({ kind: 'bad-option', message: `unexpected argument: ${token}` });
  if (!FLAGS_WITH_VALUE.has(token)) return withFlag(options, token);
  return value === undefined ? err({ kind: 'bad-option', message: `${token} expects a value` }) : withValue(options, token, value);
};

export const parseOptions = (argv: ReadonlyArray<string>): Result<Options, OptionsError> => {
  let options = DEFAULTS;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const parsed = parseToken(options, token, argv[index + 1]);
    if (!parsed.ok) return parsed;
    options = parsed.value;
    if (FLAGS_WITH_VALUE.has(token)) index += 1;
  }
  return ok(options);
};

export const USAGE = [
  'Usage: bun run sync [update] [options]',
  '',
  '  update              sync every source already in kb/, without asking anything',
  '  --site-id <id>      sync this site without showing the picker',
  '  --site-url <url>    sync the site at this address (for sites the search index misses)',
  '  --drive-id <id>     sync only this library; repeat for several',
  '  --dry-run           show what would be done, write nothing',
  '  --max-size-mb <n>   skip files larger than this (default 50)',
  '  --no-ocr            do not read text out of images',
  '  --ocr-lang <code>   language for reading images (default en)',
  '  --yes, -y           take the saved choices instead of asking',
].join('\n');
