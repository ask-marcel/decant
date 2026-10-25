import { WINDOWS_PATH_LIMIT } from '../domain/kb-path.ts';

export type Config = {
  readonly logLevel: string;
  readonly kbRoot: string;
  // How long a path may be as decant writes it: what Windows accepts, less the folders in front of
  // the knowledge base on disk. Absent when the run was given no way to resolve the folder.
  readonly pathBudget?: number;
  readonly ocrLang: string;
  readonly ocr: boolean;
  readonly interactive: boolean;
  readonly timezone: string;
};

export type ConfigInput = {
  readonly env: Readonly<Record<string, string | undefined>>;
  // What `--out` named for this run. It wins over `KB_ROOT`, which is kept for every run.
  readonly out?: string;
  // `process.platform`, given rather than read here, so a test can say it runs on Windows.
  readonly platform?: string;
  // Turns the knowledge base folder into the absolute path it is on disk. Given rather than called
  // here, since the answer depends on the folder the run was started in.
  readonly resolvePath?: (path: string) => string;
  readonly ocrLang: string;
  readonly ocr?: boolean;
  readonly interactive: boolean;
  // What `--timezone` asked for, empty when it asked for nothing, the zone the knowledge base keeps,
  // and the zone this machine keeps. They arrive as parameters so nothing here reads the clock, the
  // environment or the disk for itself.
  readonly timezone: string;
  readonly storedTimezone?: string;
  readonly machineTimezone: string;
};

// Every path under the knowledge base is joined with `/`. Windows accepts that separator, so a
// folder named there with `\` is spelled with `/` too, and no path holds both. Elsewhere a backslash
// is an ordinary character in a name, and is kept.
// One folder also has one name: `./kb` and `kb/` are `kb`, as the states record the paths under it.
const withoutTail = (named: string): string => {
  let end = named.length;
  while (end > 1 && named[end - 1] === '/') end -= 1;
  return named.slice(0, end);
};

const kbRootFor = (named: string, platform: string | undefined): string => {
  const slashed = withoutTail(platform === 'win32' ? named.replaceAll('\\', '/') : named);
  const trimmed = slashed.replace(/^(?:\.\/)+/, '');
  return trimmed.length === 0 ? slashed : trimmed;
};

// Windows counts a path from the drive letter, so the folders in front of the knowledge base come
// off its limit before any name inside it is planned.
const pathBudgetFor = (kbRoot: string, resolvePath: ((path: string) => string) | undefined): number | undefined =>
  resolvePath === undefined ? undefined : WINDOWS_PATH_LIMIT - (resolvePath(kbRoot).length - kbRoot.length);

// The only module that reads the environment: every other layer takes its values as parameters, so
// nothing downstream depends on process.env, and the composition root stays testable.
export const readConfig = (input: ConfigInput): Config => {
  const kbRoot = kbRootFor(input.out ?? input.env['KB_ROOT'] ?? 'kb', input.platform);
  return {
    logLevel: input.env['KB_LOG_LEVEL'] ?? 'error',
    kbRoot,
    pathBudget: pathBudgetFor(kbRoot, input.resolvePath),
    ocrLang: input.ocrLang,
    ocr: input.ocr ?? true,
    interactive: input.interactive,
    timezone: input.timezone === '' ? (input.storedTimezone ?? input.machineTimezone) : input.timezone,
  };
};
