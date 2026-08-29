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
  readonly ocrLang: string;
  readonly ocr?: boolean;
  readonly interactive: boolean;
  // What `--timezone` asked for, empty when it asked for nothing, and the zone this machine keeps.
  // Both arrive as parameters so nothing here reads the clock or the environment for itself.
  readonly timezone: string;
  readonly machineTimezone: string;
};

// The only module that reads the environment: every other layer takes its values as parameters, so
// nothing downstream depends on process.env, and the composition root stays testable.
export const readConfig = (input: ConfigInput): Config => ({
  logLevel: input.env['KB_LOG_LEVEL'] ?? 'error',
  kbRoot: input.env['KB_ROOT'] ?? 'kb',
  ocrLang: input.ocrLang,
  ocr: input.ocr ?? true,
  interactive: input.interactive,
  timezone: input.timezone === '' ? input.machineTimezone : input.timezone,
});
