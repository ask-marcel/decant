import type { SyncedSource } from '../domain/sync-state.ts';
import { NEVER_RUN } from '../domain/sync-state.ts';

const describeRun = (source: SyncedSource): string => (source.lastRun === NEVER_RUN ? 'never completed a run' : `synced ${source.lastRun}, ${source.fileCount} files`);

const renderOne = (source: SyncedSource, index: number): string => `${index + 1}) ${source.name} (${describeRun(source)})`;

export const renderSyncedSources = (sources: ReadonlyArray<SyncedSource>): string => {
  if (sources.length === 0) return 'No source synced yet.';
  return ['Already synced:', ...sources.map(renderOne)].join('\n');
};
