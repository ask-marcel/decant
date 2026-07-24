import { buildDeps } from './composition/build-deps.ts';
import { readConfig } from './composition/config.ts';
import { parseOptions, USAGE } from './composition/options.ts';
import { formatError } from './domain/utilities/format-error.ts';
import { printLine } from './presenter/output.ts';

const MB = 1024 * 1024;

const run = async (): Promise<number> => {
  const options = parseOptions(process.argv.slice(2));
  if (!options.ok) {
    printLine(`${options.error.message}\n\n${USAGE}`);
    return 2;
  }
  const config = readConfig({ env: process.env, ocrLang: options.value.ocrLang, interactive: options.value.command === 'sync' });
  const deps = buildDeps(config);
  const summaries = await deps.runSync({
    command: options.value.command,
    siteId: options.value.siteId,
    siteUrl: options.value.siteUrl,
    driveIds: options.value.driveIds,
    maxBytes: options.value.maxSizeMb * MB,
    ocrLabel: options.value.ocr ? `paddleocr (${options.value.ocrLang})` : 'off',
    dryRun: options.value.dryRun,
    mailbox: options.value.mailbox,
    since: options.value.since,
  });
  if (!summaries.ok) {
    printLine(`failed at ${summaries.error.step}: ${summaries.error.message}`);
    return 1;
  }
  return summaries.value.some((summary) => summary.failed > 0) ? 1 : 0;
};

try {
  process.exit(await run());
} catch (error) {
  printLine(`crashed (unexpected): ${formatError(error)}`);
  process.exit(1);
}
