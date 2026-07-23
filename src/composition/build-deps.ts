import { buildDeps as buildMarcelDeps, commands } from 'ask-marcel-office-cli';
import type { SiteRef } from '../domain/site-state.ts';
import { createSystemClock } from '../infra/clock-system.ts';
import type { MarcelApi, MarcelCommand } from '../infra/drive-reader-marcel.ts';
import { createDriveReaderFromApi } from '../infra/drive-reader-marcel.ts';
import { createBunFiles } from '../infra/files-bun.ts';
import { createWinstonLogger } from '../infra/logger.ts';
import { createBunShell, createPaddleOcr } from '../infra/ocr-paddle.ts';
import { createStdinPrompt } from '../infra/prompt-stdin.ts';
import { createConvertFile } from '../use-cases/convert-file.ts';
import { createListSyncedSources } from '../use-cases/list-synced-sources.ts';
import type { Clock } from '../use-cases/ports/clock.ts';
import type { DriveReader, DriveSummary } from '../use-cases/ports/drive-reader.ts';
import type { Files } from '../use-cases/ports/files.ts';
import type { Logger } from '../use-cases/ports/logger.ts';
import type { Ocr } from '../use-cases/ports/ocr.ts';
import type { Prompt } from '../use-cases/ports/prompt.ts';
import { createRunSync } from '../use-cases/run-sync.ts';
import type { RunSync } from '../use-cases/run-sync.ts';
import { createSyncSite, loadState, STATE_FILE_NAME } from '../use-cases/sync-site.ts';
import { safeSegment } from '../domain/kb-path.ts';
import type { Config } from './config.ts';

export type BuiltDeps = {
  readonly runSync: RunSync;
  readonly logger: Logger;
};

export type DepOverrides = {
  readonly logger?: Logger;
  readonly files?: Files;
  readonly reader?: DriveReader;
  readonly ocr?: Ocr;
  readonly prompt?: Prompt;
  readonly clock?: Clock;
};

// `interactive: false` keeps a lapsed sign-in from opening a browser mid-run: the call fails with
// an auth error the run reports, which is what a scheduled `update` needs.
const realReader = (interactive: boolean): DriveReader => {
  const marcel = buildMarcelDeps({ interactive });
  const api: MarcelApi = { graph: marcel.graph, fs: marcel.fs, commands: commands as Readonly<Partial<Record<string, MarcelCommand>>> };
  return createDriveReaderFromApi(api);
};

const savedDrivesFrom =
  (files: Files, logger: Logger, kbRoot: string) =>
  async (site: SiteRef): Promise<ReadonlyArray<DriveSummary>> => {
    const state = await loadState(files, `${kbRoot}/${safeSegment(site.name)}/${STATE_FILE_NAME}`, site, logger);
    return Object.entries(state.drives).map(([id, drive]) => ({ id, name: drive.name }));
  };

export const buildDeps = (config: Config, overrides: DepOverrides = {}): BuiltDeps => {
  const logger = overrides.logger ?? createWinstonLogger(config.logLevel);
  const files = overrides.files ?? createBunFiles();
  const clock = overrides.clock ?? createSystemClock();
  const reader = overrides.reader ?? realReader(config.interactive);
  const ocr = overrides.ocr ?? createPaddleOcr({ shell: createBunShell(), lang: config.ocrLang });
  const prompt = overrides.prompt ?? createStdinPrompt(() => console);
  const convertFile = createConvertFile({ reader, files, ocr, clock });
  const syncSite = createSyncSite({ reader, files, convertFile, clock, logger, kbRoot: config.kbRoot });
  const listSyncedSources = createListSyncedSources({ files, logger, kbRoot: config.kbRoot });
  return { logger, runSync: createRunSync({ reader, prompt, logger, syncSite, listSyncedSources, savedDrives: savedDrivesFrom(files, logger, config.kbRoot) }) };
};
