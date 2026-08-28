import { buildDeps as buildMarcelDeps, commands } from 'ask-marcel-office-cli';
import type { SiteRef } from '../domain/site-state.ts';
import { createSystemClock } from '../infra/clock-system.ts';
import type { MarcelApi, MarcelCommand } from '../infra/drive-reader-marcel.ts';
import { createDriveReaderFromApi, createMarcelCall } from '../infra/drive-reader-marcel.ts';
import { createMailReaderFromCall } from '../infra/mail-reader-marcel.ts';
import { createBunFiles } from '../infra/files-bun.ts';
import { createWinstonLogger } from '../infra/logger.ts';
import { createBunShell, createNoOcr, createRapidOcr } from '../infra/ocr-rapid.ts';
import { createStderrProgress, createStderrStatus } from '../infra/progress-bar.ts';
import { createStdinPrompt } from '../infra/prompt-stdin.ts';
import { createConvertAttachment } from '../use-cases/convert-attachment.ts';
import { createConvertFile } from '../use-cases/convert-file.ts';
import { createListSyncedSources } from '../use-cases/list-synced-sources.ts';
import type { Clock } from '../use-cases/ports/clock.ts';
import type { DriveReader, DriveSummary, SiteSummary } from '../use-cases/ports/drive-reader.ts';
import type { MailReader } from '../use-cases/ports/mail-reader.ts';
import type { Files } from '../use-cases/ports/files.ts';
import type { Logger } from '../use-cases/ports/logger.ts';
import type { Ocr } from '../use-cases/ports/ocr.ts';
import type { Progress } from '../use-cases/ports/progress.ts';
import type { Prompt } from '../use-cases/ports/prompt.ts';
import { createRunSync } from '../use-cases/run-sync.ts';
import type { RunSync } from '../use-cases/run-sync.ts';
import { createRenderThread } from '../use-cases/render-thread.ts';
import { createSyncMailbox } from '../use-cases/sync-mailbox.ts';
import { createWriteGlobalReport } from '../use-cases/write-global-report.ts';
import { createSyncSite, resolveSite } from '../use-cases/sync-site.ts';
import type { SiteCache } from '../domain/site-cache.ts';
import { parseSiteCache, serializeSiteCache } from '../domain/site-cache.ts';
import type { Config } from './config.ts';

export type BuiltDeps = {
  readonly runSync: RunSync;
  readonly logger: Logger;
};

export type DepOverrides = {
  readonly logger?: Logger;
  readonly files?: Files;
  readonly reader?: DriveReader;
  readonly mail?: MailReader;
  readonly ocr?: Ocr;
  readonly prompt?: Prompt;
  readonly clock?: Clock;
  readonly progress?: Progress;
};

// `interactive: false` keeps a lapsed sign-in from opening a browser mid-run: the call fails with
// an auth error the run reports, which is what a scheduled `update` needs.
const realApi = (interactive: boolean): MarcelApi => {
  const marcel = buildMarcelDeps({ interactive });
  const status = createStderrStatus();
  return { graph: marcel.graph, fs: marcel.fs, commands: commands as Readonly<Partial<Record<string, MarcelCommand>>>, notify: status };
};

// Resolved the same way the sync itself resolves it: two sites can share a display name, and the
// name alone would hand the second site the first one's libraries to refresh.
const savedDrivesFrom =
  (files: Files, logger: Logger, kbRoot: string) =>
  async (site: SiteRef): Promise<ReadonlyArray<DriveSummary>> => {
    const { state } = await resolveSite({ files, logger, kbRoot }, site);
    return Object.entries(state.drives).map(([id, drive]) => ({ id, name: drive.name }));
  };

// Kept beside the knowledge base it describes, so clearing `kb/` clears it too: a list of sites is
// only ever a convenience, never something to carry over a deliberate reset.
const SITE_CACHE_FILE = '.sites.json';

type SiteCacheStore = {
  readonly cached: () => Promise<SiteCache | undefined>;
  readonly remember: (sites: ReadonlyArray<SiteSummary>) => Promise<void>;
};

const siteCacheAt = (files: Files, kbRoot: string, clock: Clock): SiteCacheStore => ({
  cached: async (): Promise<SiteCache | undefined> => {
    const text = await files.readText(`${kbRoot}/${SITE_CACHE_FILE}`);
    return text.ok ? parseSiteCache(text.value) : undefined;
  },
  remember: async (sites: ReadonlyArray<SiteSummary>): Promise<void> => {
    await files.writeText(`${kbRoot}/${SITE_CACHE_FILE}`, serializeSiteCache(sites, clock.nowIso()));
  },
});

export const buildDeps = (config: Config, overrides: DepOverrides = {}): BuiltDeps => {
  const logger = overrides.logger ?? createWinstonLogger(config.logLevel);
  const files = overrides.files ?? createBunFiles();
  const clock = overrides.clock ?? createSystemClock();
  // Constructing the API reaches nothing: the sign-in ladder only runs on the first Graph call.
  const api = realApi(config.interactive);
  const reader = overrides.reader ?? createDriveReaderFromApi(api);
  const mail = overrides.mail ?? createMailReaderFromCall(createMarcelCall(api));
  const ocr = overrides.ocr ?? (config.ocr ? createRapidOcr({ shell: createBunShell(), lang: config.ocrLang }) : createNoOcr());
  const prompt = overrides.prompt ?? createStdinPrompt(() => console);
  const progress = overrides.progress ?? createStderrProgress();
  const convertFile = createConvertFile({ reader, files, ocr, clock, logger, progress });
  const syncSite = createSyncSite({ reader, files, convertFile, clock, logger, progress, kbRoot: config.kbRoot });
  const listSyncedSources = createListSyncedSources({ files, logger, kbRoot: config.kbRoot });
  const convertAttachment = createConvertAttachment({ reader: mail, files, ocr, logger, unpackArchive: reader.localArchive, convertLocal: reader.localMarkdown });
  const renderThread = createRenderThread({ reader: mail, drive: reader, files, convertAttachment, convertFile, clock, logger, mailboxRoot: `${config.kbRoot}/Mailbox` });
  const syncMailbox = createSyncMailbox({ reader: mail, files, renderThread, clock, logger, progress, kbRoot: config.kbRoot });
  const savedDrives = savedDrivesFrom(files, logger, config.kbRoot);
  const { cached: cachedSites, remember: rememberSites } = siteCacheAt(files, config.kbRoot, clock);
  // Kept to few lines on purpose: Bun's line coverage reports the inner lines of a multi-line
  // expression as never executed, so spreading this call out reads as a third of the file going
  // uncovered. See the journal entry for the same trap in `progress-bar.ts`.
  const writeGlobalReport = createWriteGlobalReport({ files, clock, logger, listSyncedSources, kbRoot: config.kbRoot });
  const runSync = createRunSync({ reader, prompt, logger, syncSite, listSyncedSources, savedDrives, syncMailbox, cachedSites, rememberSites, writeGlobalReport });
  return { logger, runSync };
};
