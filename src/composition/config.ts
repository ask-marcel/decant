export type Config = {
  readonly logLevel: string;
  readonly kbRoot: string;
  readonly ocrLang: string;
  readonly ocr: boolean;
  readonly interactive: boolean;
};

export type ConfigInput = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly ocrLang: string;
  readonly ocr?: boolean;
  readonly interactive: boolean;
};

// The only module that reads the environment: every other layer takes its values as parameters, so
// nothing downstream depends on process.env, and the composition root stays testable.
export const readConfig = (input: ConfigInput): Config => ({
  logLevel: input.env['MOOV_KB_LOG_LEVEL'] ?? 'error',
  kbRoot: input.env['MOOV_KB_ROOT'] ?? 'kb',
  ocrLang: input.ocrLang,
  ocr: input.ocr ?? true,
  interactive: input.interactive,
});
