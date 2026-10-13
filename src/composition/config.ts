export type Config = {
  readonly logLevel: string;
  readonly kbRoot: string;
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
  readonly ocrLang: string;
  readonly ocr?: boolean;
  readonly interactive: boolean;
  // What `--timezone` asked for, empty when it asked for nothing, and the zone this machine keeps.
  // Both arrive as parameters so nothing here reads the clock or the environment for itself.
  readonly timezone: string;
  readonly machineTimezone: string;
};

// Every path under the knowledge base is joined with `/`. Windows accepts that separator, so a
// folder named there with `\` is spelled with `/` too, and no path holds both. Elsewhere a backslash
// is an ordinary character in a name, and is kept.
const kbRootFor = (named: string, platform: string | undefined): string => (platform === 'win32' ? named.replaceAll('\\', '/') : named);

// The only module that reads the environment: every other layer takes its values as parameters, so
// nothing downstream depends on process.env, and the composition root stays testable.
export const readConfig = (input: ConfigInput): Config => ({
  logLevel: input.env['KB_LOG_LEVEL'] ?? 'error',
  kbRoot: kbRootFor(input.out ?? input.env['KB_ROOT'] ?? 'kb', input.platform),
  ocrLang: input.ocrLang,
  ocr: input.ocr ?? true,
  interactive: input.interactive,
  timezone: input.timezone === '' ? input.machineTimezone : input.timezone,
});
