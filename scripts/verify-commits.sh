#!/usr/bin/env bash
#
# Build every commit of a landing on its own before it leaves this machine. The pre-commit hook
# typechecks the working tree, not the commit, so a landing split into "the consumer gains a
# dependency" then "the composition supplies it" passes the hook twice and leaves a commit on main
# that does not compile (lessons.archive.md, 2026-09-11). Each commit is checked out alone in a
# detached worktree, with this checkout's node_modules linked in, and has to typecheck and pass the
# suite. A split that cannot build alone is folded into one commit, taking the size-gate bypass with
# the reason in its body.
#
#   bash scripts/verify-commits.sh                  # every commit in origin/main..HEAD
#   bash scripts/verify-commits.sh <base>..<tip>    # any range; the pre-push hook passes its own
#
# A commit touching nothing but prose (*.md, .claude/, docs/) cannot break the build, so it is
# named and skipped. VERIFY_COMMITS_CHECK replaces the check itself, which is how the test proves
# this script can fail.

set -euo pipefail

# Git hands a hook GIT_DIR and its kin, an absolute path when the push comes from a linked worktree,
# and everything this script starts inherits them: `git -C "$tree" checkout` would detach the pushing
# worktree's HEAD, and a check that makes a repository of its own, as the test suite does, would
# reinitialize the pushing one as bare. githooks(5) asks a hook that works elsewhere to clear them.
unset $(git rev-parse --local-env-vars)

range="${1:-origin/main..HEAD}"
check="${VERIFY_COMMITS_CHECK:-bun run typecheck && bun test}"
root=$(git rev-parse --show-toplevel)
shas=$(git -C "$root" rev-list --reverse "$range")

if [ -z "$shas" ]; then
  echo "verify-commits: no commit in ${range}"
  exit 0
fi

work=$(mktemp -d)
tree="$work/tree"
cleanup() {
  git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git -C "$root" worktree add --quiet --detach "$tree" "$(head -n 1 <<<"$shas")"
if [ -d "$root/node_modules" ]; then ln -s "$root/node_modules" "$tree/node_modules"; fi

echo "verify-commits: building each commit in ${range} on its own"
for sha in $shas; do
  label=$(git -C "$root" log -n 1 --format='%h %s' "$sha")
  # Read into a variable, not piped: `grep -q` stops at its first match, and under pipefail the
  # writer it cut off would turn a code commit into a skipped one.
  changed=$(git -C "$root" diff-tree -m --root --no-commit-id --name-only -r "$sha")
  if ! grep -qvE '(\.md$|^\.claude/|^docs/)' <<<"$changed"; then
    echo "  skip  ${label} (prose only)"
    continue
  fi
  git -C "$tree" checkout --quiet --detach "$sha"
  if ! (cd "$tree" && eval "$check") >"$work/log" 2>&1; then
    echo "  FAIL  ${label}" >&2
    tail -n 30 "$work/log" >&2
    exit 1
  fi
  echo "  ok    ${label}"
done
