import type { Result } from '../domain/result.ts';
import { isKnownZone } from '../domain/zoned-day.ts';
import { SINCE_SHAPE, parseSince } from '../domain/sync-window.ts';
import { err, ok } from '../domain/result.ts';

export type Command = 'sync' | 'update';

export type Options = {
  readonly command: Command;
  readonly siteId?: string;
  readonly siteUrl?: string;
  readonly groupId?: string;
  readonly todoListId?: string;
  readonly teamId?: string;
  readonly notebookId?: string;
  readonly listsSite?: string;
  readonly planId?: string;
  readonly driveIds: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly maxSizeMb: number;
  readonly ocr: boolean;
  readonly refresh: boolean;
  readonly ocrLang: string;
  readonly concurrency: number;
  readonly assumeYes: boolean;
  readonly mailbox: boolean;
  readonly people: boolean;
  readonly calendar: boolean;
  // Asked for the usage and nothing else. A flag rather than a command, because it can be asked
  // beside real work and has to win there: printing the usage and doing nothing is the safe reading
  // of `decant --mailbox --help`, where the alternative is a sync nobody meant to start.
  readonly help: boolean;
  readonly since?: string;
  // Empty means the machine's own zone, resolved where the run is composed rather than here: a
  // default read at module load would be a runtime value frozen into a constant.
  readonly timezone: string;
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
  people: false,
  calendar: false,
  help: false,
  timezone: '',
};

// RapidOCR's recognizer catalogue, plus the `auto` that picks from it per image. Kept here so a
// typo is refused at the command line: an unknown language reaches Python, throws once per image,
// and turns a whole sync into "no text" notes while still reporting itself as a success.
const OCR_LANGUAGES = ['auto', 'ch', 'ch_doc', 'en', 'arabic', 'chinese_cht', 'cyrillic', 'devanagari', 'japan', 'korean', 'ka', 'latin', 'ta', 'te', 'eslav', 'th', 'el'];

const FLAGS_WITH_VALUE = new Set([
  '--site-id',
  '--site-url',
  '--group-id',
  '--todo-list',
  '--team',
  '--notebook',
  '--lists',
  '--plan',
  '--drive-id',
  '--max-size-mb',
  '--ocr-lang',
  '--concurrency',
  '--since',
  '--timezone',
]);

const withOcrLang = (options: Options, value: string): Result<Options, OptionsError> =>
  OCR_LANGUAGES.includes(value) ? ok({ ...options, ocrLang: value }) : err({ kind: 'bad-option', message: `--ocr-lang expects one of ${OCR_LANGUAGES.join(', ')}, got: ${value}` });

// Refused here rather than at the first message, the way an OCR language is. A tenant reports its
// zone in Windows spelling ("China Standard Time") unless it is set to IANA, and that spelling
// names no zone: a run that took it would file every thread under a day counted in UTC.
const withTimezone = (options: Options, value: string): Result<Options, OptionsError> =>
  isKnownZone(value) ? ok({ ...options, timezone: value }) : err({ kind: 'bad-option', message: `--timezone expects an IANA zone such as Asia/Shanghai, got: ${value}` });

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

// A day, not a moment, or all: what the run reaches back to, kept for every run after it.
const withSince = (options: Options, value: string): Result<Options, OptionsError> => {
  const since = parseSince(value);
  return since.ok ? ok({ ...options, since: since.value }) : err({ kind: 'bad-option', message: `--since expects ${SINCE_SHAPE}, got: ${value}` });
};

type ValueFlag = (options: Options, value: string) => Result<Options, OptionsError>;

// What each flag that takes a value does with it, one row a flag. `--max-size-mb` is the one left
// out: a flag that takes a value and has no row here takes a size.
const VALUE_FLAGS: ReadonlyMap<string, ValueFlag> = new Map<string, ValueFlag>([
  ['--site-id', (options, value) => ok({ ...options, siteId: value })],
  ['--site-url', (options, value) => ok({ ...options, siteUrl: value })],
  ['--group-id', (options, value) => ok({ ...options, groupId: value })],
  ['--todo-list', (options, value) => ok({ ...options, todoListId: value })],
  ['--team', (options, value) => ok({ ...options, teamId: value })],
  ['--notebook', (options, value) => ok({ ...options, notebookId: value })],
  ['--lists', (options, value) => ok({ ...options, listsSite: value })],
  ['--plan', (options, value) => ok({ ...options, planId: value })],
  ['--drive-id', (options, value) => ok({ ...options, driveIds: [...options.driveIds, value] })],
  ['--ocr-lang', withOcrLang],
  ['--concurrency', withConcurrency],
  ['--since', withSince],
  ['--timezone', withTimezone],
]);

const withValue = (options: Options, flag: string, value: string): Result<Options, OptionsError> => (VALUE_FLAGS.get(flag) ?? withSize)(options, value);

// What each flag that takes no value sets, one row a flag and one for each short form.
const FLAGS: ReadonlyMap<string, Partial<Options>> = new Map<string, Partial<Options>>([
  ['--dry-run', { dryRun: true }],
  ['--no-ocr', { ocr: false }],
  ['--refresh', { refresh: true }],
  ['--mailbox', { mailbox: true }],
  ['--people', { people: true }],
  ['--calendar', { calendar: true }],
  ['--yes', { assumeYes: true }],
  ['-y', { assumeYes: true }],
  ['--help', { help: true }],
  ['-h', { help: true }],
]);

const withFlag = (options: Options, flag: string): Result<Options, OptionsError> => {
  const set = FLAGS.get(flag);
  return set === undefined ? err({ kind: 'bad-option', message: `unknown option: ${flag}` }) : ok({ ...options, ...set });
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
  'Usage: decant [update] [options]',
  '',
  '  update              sync every source already in kb/, without asking anything',
  '  --site-id <id>      sync this site without showing the picker',
  '  --site-url <url>    sync the site at this address (for sites the search index misses)',
  '  --drive-id <id>     sync only this library; repeat for several',
  '  --mailbox           sync your Outlook mailbox without showing the picker',
  '  --people            sync the people directory, everyone in your Teams, without the picker',
  '  --calendar          sync your Outlook calendar without showing the picker',
  '  --since <day|all>   reach back to this day, or through everything, and keep it for every later run',
  '  --dry-run           show what would be done, write nothing',
  '  --max-size-mb <n>   skip files larger than this (default 50)',
  '  --concurrency <n>   how many items to convert at once (default 4)',
  '  --no-ocr            do not read text out of images or scanned PDFs',
  '  --group-id <id>     sync one group inbox, by its id or its address, without the picker',
  '  --todo-list <name>  sync one To Do list, by its name or its id, without the picker',
  '  --team <name>       sync every channel of one Team, by its name or its id, without the picker',
  '  --notebook <name>   sync one OneNote notebook, by its name or its id, without the picker',
  '  --lists <site>      sync the lists of one SharePoint site, by its name, id or address, without the picker',
  '  --plan <title>      sync one Planner plan, by its title or its id, without the picker',
  '  --refresh           list the sites afresh instead of showing the ones last seen',
  '  --ocr-lang <code>   force one language for images and scanned PDFs (default auto, per image)',
  "  --timezone <zone>   IANA zone the mailbox counts its days in (default this machine's)",
  '  --yes, -y           take the saved choices instead of asking',
  '  --help, -h          print this and do nothing else',
].join('\n');
