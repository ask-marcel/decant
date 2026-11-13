import type { Result } from '../domain/result.ts';
import { isKnownZone } from '../domain/zoned-day.ts';
import { SINCE_SHAPE, parseSince } from '../domain/sync-window.ts';
import { err, ok } from '../domain/result.ts';
import type { WholeKind } from '../use-cases/run-sync.ts';

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
  // How long one file may take to convert before it is stopped. None means the composition decides.
  readonly convertTimeoutSeconds?: number;
  readonly assumeYes: boolean;
  readonly mailbox: boolean;
  readonly people: boolean;
  readonly calendar: boolean;
  readonly onedrive: boolean;
  // The kinds of source taken whole, every one of each, in the order the flags came.
  readonly every: ReadonlyArray<WholeKind>;
  // Asked for the usage and nothing else. A flag rather than a command, because it can be asked
  // beside real work and has to win there: printing the usage and doing nothing is the safe reading
  // of `decant --mailbox --help`, where the alternative is a sync nobody meant to start.
  readonly help: boolean;
  readonly since?: string;
  // An update that finished less than this many minutes ago makes this one do nothing.
  readonly maxAgeMinutes?: number;
  // The folder the knowledge base is written to. None means the configuration decides, which reads
  // `KB_ROOT` and falls back to `kb`.
  readonly out?: string;
  // Empty means the zone the knowledge base keeps, else the machine's own, resolved where the run is
  // composed rather than here: a default read at module load would be a runtime value frozen into a
  // constant.
  readonly timezone: string;
};

export type OptionsError = { readonly kind: 'bad-option'; readonly message: string };

const DEFAULTS: Options = {
  command: 'sync',
  driveIds: [],
  dryRun: false,
  maxSizeMb: 50,
  ocr: false,
  refresh: false,
  ocrLang: 'latin',
  concurrency: 4,
  assumeYes: false,
  mailbox: false,
  people: false,
  calendar: false,
  onedrive: false,
  every: [],
  help: false,
  timezone: '',
};

// Reading the text out of images and scanned PDFs is asked for, with `--ocr` or by naming a language:
// it needs Python and two packages a machine may not have, and an agent that reads a picture can
// follow the link to it instead. `latin` is the model for a run that names none, since it keeps the
// accents and the spaces between words; `auto` still settles the language image by image.
// RapidOCR's recognizer catalogue, plus the `auto` that picks from it per image. Kept here so a
// typo is refused at the command line: an unknown language reaches Python, throws once per image,
// and turns a whole sync into "no text" notes while still reporting itself as a success.
const OCR_LANGUAGES = ['auto', 'ch', 'ch_doc', 'en', 'arabic', 'chinese_cht', 'cyrillic', 'devanagari', 'japan', 'korean', 'ka', 'latin', 'ta', 'te', 'eslav', 'th', 'el'];

// The flags that take a whole kind of source, and the kind each takes. Each takes `all` and nothing
// else for now: a value leaves room for names later, where a bare flag would not.
const WHOLE_FLAGS: ReadonlyMap<string, WholeKind> = new Map<string, WholeKind>([
  ['--sites', 'site'],
  ['--loop', 'loop'],
  ['--teams', 'team'],
  ['--groups', 'group'],
  ['--todo-lists', 'todo'],
  ['--notebooks', 'notebook'],
  ['--plans', 'plan'],
]);

const FLAGS_WITH_VALUE = new Set([
  '--site-id',
  '--site-url',
  '--group-id',
  '--todo-list',
  '--team',
  '--notebook',
  '--lists',
  '--plan',
  ...WHOLE_FLAGS.keys(),
  '--drive-id',
  '--max-size-mb',
  '--ocr-lang',
  '--concurrency',
  '--convert-timeout',
  '--since',
  '--max-age',
  '--timezone',
  '--out',
]);

const withOcrLang = (options: Options, value: string): Result<Options, OptionsError> =>
  OCR_LANGUAGES.includes(value)
    ? ok({ ...options, ocr: true, ocrLang: value })
    : err({ kind: 'bad-option', message: `--ocr-lang expects one of ${OCR_LANGUAGES.join(', ')}, got: ${value}` });

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

const withMaxAge = (options: Options, value: string): Result<Options, OptionsError> => {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1) return err({ kind: 'bad-option', message: `--max-age expects a whole number of minutes, at least 1, got: ${value}` });
  return ok({ ...options, maxAgeMinutes: minutes });
};

const withConvertTimeout = (options: Options, value: string): Result<Options, OptionsError> => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return err({ kind: 'bad-option', message: `--convert-timeout expects a positive number of seconds, got: ${value}` });
  return ok({ ...options, convertTimeoutSeconds: seconds });
};

// A day, not a moment, or all: what the run reaches back to, kept for every run after it.
const withSince = (options: Options, value: string): Result<Options, OptionsError> => {
  const since = parseSince(value);
  return since.ok ? ok({ ...options, since: since.value }) : err({ kind: 'bad-option', message: `--since expects ${SINCE_SHAPE}, got: ${value}` });
};

// A slash on the end names the same folder and is dropped, since every path below is joined with
// one. A name that is only slashes is refused: it is the root of the disk, never a knowledge base.
const withoutEndSlash = (text: string): string => (text.endsWith('/') ? withoutEndSlash(text.slice(0, -1)) : text);

const withOut = (options: Options, value: string): Result<Options, OptionsError> => {
  const out = withoutEndSlash(value);
  return out === '' ? err({ kind: 'bad-option', message: `--out expects a folder, got: ${value}` }) : ok({ ...options, out });
};

type ValueFlag = (options: Options, value: string) => Result<Options, OptionsError>;

// A kind asked for twice is taken once.
const withWhole = (flag: string, kind: WholeKind): [string, ValueFlag] => [
  flag,
  (options, value) => {
    if (value !== 'all') return err({ kind: 'bad-option', message: `${flag} expects all, got: ${value}` });
    return ok({ ...options, every: options.every.includes(kind) ? options.every : [...options.every, kind] });
  },
];

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
  ...[...WHOLE_FLAGS].map(([flag, kind]) => withWhole(flag, kind)),
  ['--drive-id', (options, value) => ok({ ...options, driveIds: [...options.driveIds, value] })],
  ['--ocr-lang', withOcrLang],
  ['--concurrency', withConcurrency],
  ['--convert-timeout', withConvertTimeout],
  ['--since', withSince],
  ['--max-age', withMaxAge],
  ['--timezone', withTimezone],
  ['--out', withOut],
]);

const withValue = (options: Options, flag: string, value: string): Result<Options, OptionsError> => (VALUE_FLAGS.get(flag) ?? withSize)(options, value);

// What each flag that takes no value sets, one row a flag and one for each short form.
const FLAGS: ReadonlyMap<string, Partial<Options>> = new Map<string, Partial<Options>>([
  ['--dry-run', { dryRun: true }],
  ['--ocr', { ocr: true }],
  ['--no-ocr', { ocr: false }],
  ['--refresh', { refresh: true }],
  ['--mailbox', { mailbox: true }],
  ['--people', { people: true }],
  ['--calendar', { calendar: true }],
  ['--onedrive', { onedrive: true }],
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

// Checked once every token is read, since `--max-age 60 update` names the command after the flag.
const checked = (options: Options): Result<Options, OptionsError> =>
  options.maxAgeMinutes !== undefined && options.command !== 'update' ? err({ kind: 'bad-option', message: '--max-age works only with update' }) : ok(options);

export const parseOptions = (argv: ReadonlyArray<string>): Result<Options, OptionsError> => {
  let options = DEFAULTS;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const parsed = parseToken(options, token, argv[index + 1]);
    if (!parsed.ok) return parsed;
    options = parsed.value;
    if (FLAGS_WITH_VALUE.has(token)) index += 1;
  }
  return checked(options);
};

export const USAGE = [
  'Usage: decant [update] [options]',
  '',
  '  update              sync every source already in the export folder, without asking anything',
  '  --site-id <id>      sync this site without showing the picker',
  '  --site-url <url>    sync the site at this address (for sites the search index misses)',
  '  --drive-id <id>     sync only this library; repeat for several',
  '  --mailbox           sync your Outlook mailbox without showing the picker',
  '  --people            sync the people directory, everyone in your Teams, without the picker',
  '  --calendar          sync your Outlook calendar without showing the picker',
  '  --since <day|all>   reach back to this day, or through everything, and keep it for every later run',
  '                      a date as YYYY-MM-DD, not a count of days: --since 2026-01-31, or --since all',
  '  --max-age <minutes> with update: do nothing if the last update started less than this many minutes ago',
  '  --out <folder>      write the knowledge base to this folder (default kb, or KB_ROOT)',
  '  --dry-run           show what would be done, write nothing',
  '  --max-size-mb <n>   skip files larger than this (default 50)',
  '  --concurrency <n>   how many items to convert at once (default 4)',
  '  --convert-timeout <seconds>',
  '                      stop the conversion of one file after this time, and try it again next run (default 120)',
  '  --ocr               read the text out of images and scanned PDFs (needs Python 3 with rapidocr and onnxruntime)',
  '  --group-id <id>     sync one group inbox, by its id or its address, without the picker',
  '  --todo-list <name>  sync one To Do list, by its name or its id, without the picker',
  '  --team <name>       sync every channel of one Team, by its name or its id, without the picker',
  '  --notebook <name>   sync one OneNote notebook, by its name or its id, without the picker',
  '  --lists <site>      sync the lists of one SharePoint site, by its name, id or address, without the picker',
  '  --plan <title>      sync one Planner plan, by its title or its id, without the picker',
  '  --sites all         sync every SharePoint site with all its libraries (not Loop, not OneDrive)',
  '  --loop all          sync every Loop workspace',
  '  --onedrive          sync your OneDrive',
  '  --teams all         sync every Team with all its channels',
  '  --groups all        sync every group inbox',
  '  --todo-lists all    sync every To Do list',
  '  --notebooks all     sync every OneNote notebook',
  '  --plans all         sync every Planner plan',
  '                      source flags combine: decant --teams all --sites all --mailbox syncs all three',
  '  --refresh           list the sites afresh instead of showing the ones last seen',
  '  --ocr-lang <code>   turn --ocr on with this language (default latin; auto chooses for each image)',
  '  --timezone <zone>   IANA zone the knowledge base counts its days in, and keep it for every later run',
  "                      (default the zone an earlier run kept, else this machine's)",
  '  --yes, -y           take the saved choices instead of asking',
  '  --help, -h          print this and do nothing else',
].join('\n');
