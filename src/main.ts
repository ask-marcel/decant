#!/usr/bin/env bun
import { resolve } from 'node:path';
import { buildDeps } from './composition/build-deps.ts';
import { EXIT_BAD_OPTIONS, EXIT_DONE, EXIT_STOPPED, exitCodeOf } from './composition/exit-code.ts';
import { readKeptConfig } from './composition/kept-zone.ts';
import { parseOptions, USAGE } from './composition/options.ts';
import { formatError } from './domain/utilities/format-error.ts';
import { createBunFiles } from './infra/files-bun.ts';
import { printLine } from './infra/output.ts';

const MB = 1024 * 1024;

const run = async (): Promise<number> => {
  const options = parseOptions(process.argv.slice(2));
  if (!options.ok) {
    printLine(`${options.error.message}\n\n${USAGE}`);
    return EXIT_BAD_OPTIONS;
  }
  // Asked for, so answering it is success. It used to fall to the branch above and exit 2, which
  // reads as a broken install to anything that checks.
  if (options.value.help) {
    printLine(USAGE);
    return EXIT_DONE;
  }
  const config = await readKeptConfig(
    {
      env: process.env,
      out: options.value.out,
      platform: process.platform,
      resolvePath: resolve,
      ocrLang: options.value.ocrLang,
      ocr: options.value.ocr,
      interactive: options.value.command === 'sync',
      timezone: options.value.timezone,
      machineTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    createBunFiles()
  );
  const deps = buildDeps(config);
  const summaries = await deps.runSync({
    command: options.value.command,
    siteId: options.value.siteId,
    siteUrl: options.value.siteUrl,
    groupId: options.value.groupId,
    todoListId: options.value.todoListId,
    teamId: options.value.teamId,
    notebookId: options.value.notebookId,
    listsSite: options.value.listsSite,
    planId: options.value.planId,
    driveIds: options.value.driveIds,
    maxBytes: options.value.maxSizeMb * MB,
    concurrency: options.value.concurrency,
    dryRun: options.value.dryRun,
    mailbox: options.value.mailbox,
    people: options.value.people,
    calendar: options.value.calendar,
    since: options.value.since,
    refresh: options.value.refresh,
  });
  if (!summaries.ok) printLine(`failed at ${summaries.error.step}: ${summaries.error.message}`);
  return exitCodeOf(summaries);
};

try {
  process.exit(await run());
} catch (error) {
  printLine(`crashed (unexpected): ${formatError(error)}`);
  process.exit(EXIT_STOPPED);
}
