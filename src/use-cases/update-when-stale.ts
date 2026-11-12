import { parseLastUpdate, serializeLastUpdate } from '../domain/last-update.ts';
import type { Clock } from './ports/clock.ts';
import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { PickerView } from './ports/picker-view.ts';
import type { Prompt } from './ports/prompt.ts';
import type { RunSync, RunSyncInput } from './run-sync.ts';

export const LAST_UPDATE_FILE = '.last-update.json';

export type UpdateInput = RunSyncInput & { readonly maxAgeMinutes?: number };

export type UpdateWhenStale = (input: UpdateInput) => ReturnType<RunSync>;

export type UpdateWhenStaleDeps = {
  readonly runSync: RunSync;
  readonly files: Files;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly prompt: Prompt;
  readonly view: Pick<PickerView, 'stillFresh'>;
  readonly kbRoot: string;
};

const MINUTE = 60_000;

// Whole minutes since the last update started, or none when there is no record or its time is ahead
// of the clock: a clock set back must not turn every update after it off.
const minutesSinceLast = async (deps: UpdateWhenStaleDeps, now: string): Promise<number | undefined> => {
  const text = await deps.files.readText(`${deps.kbRoot}/${LAST_UPDATE_FILE}`);
  const at = text.ok ? parseLastUpdate(text.value) : undefined;
  if (at === undefined) return undefined;
  const elapsed = Date.parse(now) - Date.parse(at);
  return elapsed < 0 ? undefined : Math.floor(elapsed / MINUTE);
};

// Kept for every update that finished, failed items included: a source that fails on every run would
// otherwise turn the skip off for good. A run that stopped, a dry run and a sync from the picker keep
// nothing.
const keep = async (deps: UpdateWhenStaleDeps, input: UpdateInput, at: string): Promise<void> => {
  if (input.command !== 'update' || input.dryRun) return;
  const written = await deps.files.writeText(`${deps.kbRoot}/${LAST_UPDATE_FILE}`, serializeLastUpdate(at));
  if (!written.ok) deps.logger.warn('lastUpdate.unkept', { cause: written.error.kind });
};

// An agent can ask for an update before each question it answers: with a max age, an update that
// follows one a short time ago does nothing, asks Graph nothing, and leaves the last report in place.
export const createUpdateWhenStale =
  (deps: UpdateWhenStaleDeps): UpdateWhenStale =>
  async (input) => {
    const now = deps.clock.nowIso();
    const ago = input.maxAgeMinutes === undefined ? undefined : await minutesSinceLast(deps, now);
    if (ago !== undefined && input.maxAgeMinutes !== undefined && ago < input.maxAgeMinutes) {
      deps.prompt.show(deps.view.stillFresh(ago, input.maxAgeMinutes));
      return { ok: true, value: [] };
    }
    const outcome = await deps.runSync(input);
    if (outcome.ok) await keep(deps, input, now);
    return outcome;
  };
