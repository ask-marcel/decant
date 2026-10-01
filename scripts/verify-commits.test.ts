import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'verify-commits.sh');

type Ran = { readonly code: number; readonly out: string; readonly err: string };

// What one commit does to the tree: a file written, or a file taken away.
type Change = { readonly write: string } | { readonly remove: string };

type Repo = {
  // Commits one change and answers the commit's id.
  readonly commit: (subject: string, change: Change) => string;
  // Runs the script over a range, with the check each commit must pass replaced by `check`.
  readonly verify: (range: string, check: string) => Ran;
  // Opens a linked worktree on a new branch at the current commit and answers its path.
  readonly linkWorktree: (branch: string) => string;
};

const git = (dir: string, args: ReadonlyArray<string>): string =>
  Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir })
    .stdout.toString()
    .trim();

const apply = (dir: string, change: Change): void => {
  if ('write' in change) writeFileSync(join(dir, change.write), change.write);
  else rmSync(join(dir, change.remove));
};

// A throwaway repository, gone once the scenario is over whatever it found.
const inRepo = (scenario: (repo: Repo) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-commits-'));
  const worktrees: string[] = [];
  try {
    git(dir, ['init', '-q']);
    scenario({
      commit: (subject, change) => {
        apply(dir, change);
        git(dir, ['add', '-A']);
        git(dir, ['commit', '-q', '-m', subject]);
        return git(dir, ['rev-parse', 'HEAD']);
      },
      verify: (range, check) => {
        const ran = Bun.spawnSync(['bash', SCRIPT, range], { cwd: dir, env: { ...process.env, VERIFY_COMMITS_CHECK: check } });
        return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() };
      },
      linkWorktree: (branch) => {
        const path = mkdtempSync(join(tmpdir(), 'verify-commits-worktree-'));
        worktrees.push(path);
        git(dir, ['worktree', 'add', '-q', '-b', branch, path]);
        return path;
      },
    });
  } finally {
    for (const path of [dir, ...worktrees]) rmSync(path, { recursive: true, force: true });
  }
};

// The script run the way git runs the pre-push hook for a push made from a linked worktree: in that
// worktree, with GIT_DIR exported as the worktree's absolute git directory (githooks(5)).
const verifyAsHook = (worktree: string, range: string, check: string): Ran => {
  const env = { ...process.env, GIT_DIR: git(worktree, ['rev-parse', '--absolute-git-dir']), VERIFY_COMMITS_CHECK: check };
  const ran = Bun.spawnSync(['bash', SCRIPT, range], { cwd: worktree, env });
  return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() };
};

describe('building every commit of a push on its own', () => {
  it('a commit that fails the check on its own stops the push and is named', () => {
    inRepo((repo) => {
      const base = repo.commit('start', { write: 'main.ts' });
      repo.commit('break the build', { write: 'broken.ts' });
      repo.commit('mend the build', { remove: 'broken.ts' });

      const ran = repo.verify(`${base}..HEAD`, 'test ! -e broken.ts');

      expect(ran.code).toBe(1);
      expect(ran.err).toContain('break the build');
      expect(ran.out).not.toContain('mend the build');
    });
  });

  it('a commit touching only prose is skipped', () => {
    inRepo((repo) => {
      const base = repo.commit('start', { write: 'main.ts' });
      repo.commit('reword the readme', { write: 'README.md' });

      const ran = repo.verify(`${base}..HEAD`, 'false');

      expect(ran.code).toBe(0);
      expect(ran.out).toContain('skip');
      expect(ran.out).toContain('reword the readme');
    });
  });

  it('a range where every commit passes lets it through', () => {
    inRepo((repo) => {
      const base = repo.commit('start', { write: 'main.ts' });
      repo.commit('add a reader', { write: 'reader.ts' });
      repo.commit('add a writer', { write: 'writer.ts' });

      const ran = repo.verify(`${base}..HEAD`, 'true');

      expect(ran.code).toBe(0);
      expect(ran.out).toContain('ok    ');
      expect(ran.out).toContain('add a reader');
      expect(ran.out).toContain('add a writer');
    });
  });

  // The check makes a repository of its own, the way this suite does.
  it('a push from a linked worktree leaves that worktree on its branch and its repository not bare', () => {
    inRepo((repo) => {
      const base = repo.commit('start', { write: 'main.ts' });
      repo.commit('add a reader', { write: 'reader.ts' });
      const worktree = repo.linkWorktree('feature');

      const ran = verifyAsHook(worktree, `${base}..HEAD`, 'scratch=$(mktemp -d) && git init -q "$scratch" && rm -rf "$scratch"');

      expect(ran.code).toBe(0);
      expect(git(worktree, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature');
      expect(git(worktree, ['config', 'core.bare'])).toBe('false');
    });
  });
});
