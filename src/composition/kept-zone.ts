import { parseKeptZone, parseSettings, serializeSettings } from '../domain/sync-window.ts';
import type { Files } from '../use-cases/ports/files.ts';
import type { Logger } from '../use-cases/ports/logger.ts';
import type { Config, ConfigInput } from './config.ts';
import { readConfig } from './config.ts';

// What a knowledge base keeps beside it for the runs after: how far back they reach, and the zone
// they count their days in.
export const SETTINGS_FILE = '.decant.json';

// Read before the run is built, since every source is built counting its days in one zone. The
// folder comes first: the file sits in whichever knowledge base this run writes to.
export const readKeptConfig = async (input: ConfigInput, files: Files): Promise<Config> => {
  const text = await files.readText(`${readConfig(input).kbRoot}/${SETTINGS_FILE}`);
  return readConfig({ ...input, storedTimezone: text.ok ? parseKeptZone(text.value) : undefined });
};

// A knowledge base that keeps a reach keeps its zone beside it: written when none is kept yet, as in
// one made before the zone was kept, or when the run named another. One with no reach yet gets both
// at once, when its first run is told how far back to reach.
export const keepZone = async (files: Files, logger: Logger, kbRoot: string, zone: string): Promise<void> => {
  const path = `${kbRoot}/${SETTINGS_FILE}`;
  const text = await files.readText(path);
  if (!text.ok || parseKeptZone(text.value) === zone) return;
  const since = parseSettings(text.value);
  if (!since.ok) return;
  const written = await files.writeText(path, serializeSettings(since.value, zone));
  if (!written.ok) logger.warn('zone.unkept', { cause: written.error.kind });
};
