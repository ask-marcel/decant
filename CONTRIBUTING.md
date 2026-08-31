# Contributing

Thanks for looking. A few things about this repo will be unusual, so they are worth stating before
you spend time on a change.

## The standard is enforced, not suggested

The code follows the [atelier](https://github.com/vdelacou/atelier) standard, which is stricter than
most: no `class`, no `interface`, no `function` declarations, `Result<T, E>` at every IO boundary,
branded types at trust boundaries, and hand-written fakes rather than a mocking library. The layout
is `src/{domain,use-cases,infra,presenter,composition}` and dependencies point inward.

You do not have to like it, but a change that ignores it will not pass the gates, and the gates are
the same for everyone.

## The gates

```bash
bun test          # the suite
bun run typecheck # tsc --noEmit
bun run lint      # eslint, zero warnings allowed
bun run coverage  # 100% on domain and use-cases, 80% on infra and composition
bun run mutate:changed   # Stryker, 90% per changed file
```

CI runs all of them on every push and pull request. The pre-commit hook runs the fast ones. Neither
is optional: `--no-verify` exists for mass-moves and generated files, and the commit body has to say
why it was used.

Read the **per-file** column of the mutation report, not the total. A file can sit under 90 while
the aggregate passes, and that file is where the next bug will live.

## Tests

Tests drive the design here rather than following it. A few habits that matter:

- Test through the primary port, not the internals. If a test reaches past the use case to poke a
  helper, the helper probably wants to be its own module with its own tests.
- Fakes are hand-written and live in `src/test-helpers`. No mocking library.
- Where the output is a document, pin at least one complete rendering with `toBe`. A renderer can
  sit at 67% with eight passing `toContain` tests, and this repo has the scar to prove it.
- A mutation survivor after a behaviour change usually means dead code, not a missing test. Read it
  before writing a test to kill it: several times the honest fix was to delete the branch.

## Commits

Conventional Commits, and small: 10 files or 300 lines, whichever comes first. The body is for the
reasoning, and it is worth writing. Most of what is hard about this codebase is why something is the
way it is, and `git log` is where that lives.

`.claude/LESSONS.md` is the long-form version of the same thing: an append-only record of what the
code learned the hard way. Add to it when a change teaches you something a future reader would
otherwise rediscover.

## Reporting a bug

Say what you ran, what you expected and what happened. If it involves a specific mail or document,
please do not paste anything confidential: the shape of the problem is almost always enough, and if
it is not, we will ask.
