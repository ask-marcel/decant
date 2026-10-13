import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Move } from './put-aside.ts';

export type RefileDeps = { readonly files: Pick<Files, 'move'>; readonly logger: Logger };

// Each file an earlier layout filed, moved to where the current layout files it. A file that will not
// move stays where it is: another program holds it open on Windows, or a file still stands at its new
// place. The answer maps the new place of each such file back to the place it still has, so the state
// records it there, and the next run tries the move again.
export const refileAll = async (deps: RefileDeps, moves: ReadonlyArray<Move>): Promise<ReadonlyMap<string, string>> => {
  const stuck = new Map<string, string>();
  for (const move of moves) {
    const moved = await deps.files.move(move.from, move.to);
    if (moved.ok) continue;
    deps.logger.warn('refile.failed', { path: move.from, cause: moved.error.kind });
    stuck.set(move.to, move.from);
  }
  return stuck;
};
