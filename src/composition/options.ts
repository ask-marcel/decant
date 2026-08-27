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
  readonly refresh: boolean;
  readonly ocrLang: string;
  readonly concurrency: number;
  readonly assumeYes: boolean;
  readonly mailbox: boolean;
  readonly since?: string;
};

export type OptionsError = { readonly kind: 'bad-option'; readonly message: string };

const DEFAULTS: Options = {
  command: 'sync',
  driveIds: [],
  dryRun: false,
  maxSizeMb: 50,
  ocr: true,
  refresh: false,
  ocrLang: 'auto',
  concurrency: 4,
  assumeYes: false,
  mailbox: false,
};

const FLAGS_WITH_VALUE = new Set(['--site-id', '--site-url', '--drive-id', '--max-size-mb', '--ocr-lang', '--concurrency', '--since']);

const withValue = (options: Options, flag: string, value: string): Result<Options, OptionsError> => {
  if (flag === '--site-id') return ok({ ...options, siteId: value });
  if (flag === '--site-url') return ok({ ...options, siteUrl: value });
  if (flag === '--drive-id') return ok({ ...options, driveIds: [...options.driveIds, value] });
  if (flag === '--ocr-lang') return ok({ ...options, ocrLang: value });
  if (flag === '--concurrency') return withConcurrency(options, value);
  if (flag === '--since') return withSince(options, value);
  return withSize(options, value);
};

const withSize = (options: Options, value: string): Result<Options, OptionsError> => {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return err({ kind: 'bad-option', message: `--max-size-mb expects a positive number, got: ${value}` });
  return ok({ ...options, maxSizeMb: size });
};

// A whole number of items in flight at once. One means the old strictly-sequential behaviour.
const withConcurrency = (options: Options, value: string): Result<Options, OptionsError> => {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) return err({ kind: 'bad-option', message: `--concurrency expects a whole number of at least 1, got: ${value}` });
  return ok({ ...options, concurrency: count });
};

// A day, not a moment: mail is filtered on the date it arrived.
const SINCE_DAY = /^\d{4}-\d{2}-\d{2}$/;

const withSince = (options: Options, value: string): Result<Options, OptionsError> =>
  SINCE_DAY.test(value) ? ok({ ...options, since: value }) : err({ kind: 'bad-option', message: `--since expects a day like 2026-01-31, got: ${value}` });

const withFlag = (options: Options, flag: string): Result<Options, OptionsError> => {
  if (flag === '--dry-run') return ok({ ...options, dryRun: true });
  if (flag === '--no-ocr') return ok({ ...options, ocr: false });
  if (flag === '--refresh') return ok({ ...options, refresh: true });
  if (flag === '--mailbox') return ok({ ...options, mailbox: true });
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
  '  --mailbox           sync your Outlook mailbox without showing the picker',
  '  --since <day>       with --mailbox, only conversations touched since this day',
  '  --dry-run           show what would be done, write nothing',
  '  --max-size-mb <n>   skip files larger than this (default 50)',
  '  --concurrency <n>   how many items to convert at once (default 4)',
  '  --no-ocr            do not read text out of images or scanned PDFs',
  '  --refresh           list the sites afresh instead of showing the ones last seen',
  '  --ocr-lang <code>   force one language for images and scanned PDFs (default auto, per image)',
  '  --yes, -y           take the saved choices instead of asking',
].join('\n');
