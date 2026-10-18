import type { Files } from './ports/files.ts';
import type { Logger } from './ports/logger.ts';
import type { Move } from './put-aside.ts';

export type RefileDeps = { readonly files: Pick<Files, 'move' | 'exists'>; readonly logger: Logger };

// A file no longer at its old place left it already: a run moved it and stopped before it saved the
// state, or someone took it away by hand. Neither is a move still owed, nor a failure to warn about.
const gone = async (files: Pick<Files, 'exists'>, path: string): Promise<boolean> => {
  const held = await files.exists(path);
  return held.ok && !held.value;
};

// Each file an earlier layout filed, moved to where the current layout files it. A file that will not
// move stays where it is: another program holds it open on Windows, or a file still stands at its new
// place. The answer maps the new place of each such file back to the place it still has, so the state
// records it there, and the next run tries the move again. A file already gone from its old place
// takes its new place in the record, or the layout would never settle.
export const refileAll = async (deps: RefileDeps, moves: ReadonlyArray<Move>): Promise<ReadonlyMap<string, string>> => {
  const stuck = new Map<string, string>();
  for (const move of moves) {
    const moved = await deps.files.move(move.from, move.to);
    if (moved.ok) continue;
    if (await gone(deps.files, move.from)) {
      deps.logger.info('refile.gone', { path: move.from });
      continue;
    }
    deps.logger.warn('refile.failed', { path: move.from, cause: moved.error.kind });
    stuck.set(move.to, move.from);
  }
  return stuck;
};
