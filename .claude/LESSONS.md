# LESSONS

Append-only session memory. Three kinds of entry: `[mistake]`, `[decision]`, `[gotcha]`.
Never edit or delete a past entry; supersede it with a new `[decision]`.

## 2026-07-23

- [gotcha] Outlook's message delta silently truncates when given a page size. On a 67-message
  Inbox, `list-mail-folder-messages-delta` with `top: 2` returned 2 messages and a `deltaLink`
  (not a `nextLink`), and following that cursor returned zero: the other 65 were unreachable and
  the sync believed itself complete. Without `top` the same call pages correctly, ten at a time.
  Never pass `top` to a mail delta. Drive delta is the opposite, where `top: 1000` is safe and
  saves round trips. A fix was planned in ask-marcel-office-cli itself; the sweep omits `top`
  either way, so the only thing that fix buys here is fewer requests.

- [gotcha] `commands[...].execute` in ask-marcel-office-cli is typed as returning a `Result` but
  can still throw: it decodes base64 with `atob`, which raises `InvalidCharacterError: The string
  contains invalid characters` on a malformed payload. A live mailbox run died on one attachment.
  Every call from an adapter needs a `try`/`catch` translating a throw into an error for that item;
  a typed `Result` return is not a promise that nothing throws.

- [gotcha] Graph v1.0 does not expose `wellKnownName` on a mailFolder, so Junk, Deleted Items,
  Drafts and Outbox can only be recognised by the display name Outlook shows, which is localised.
  `src/domain/mail-folder.ts` matches English and French; another locale needs its names added
  there. Note "Sent Items" is kept and only "Outbox" (French "Boîte d'envoi") is skipped, since a
  message sits in the outbox for seconds and then reappears in sent mail.

- [gotcha] Stryker's `incremental: true` reports a stale score after new test files are added: it
  showed 93.2% where the truth was 100%. Delete `reports/stryker-incremental.json` before trusting
  a mutation score after adding tests. Its clear-text reporter also truncates the survivor list, so
  to see them all, run `bunx stryker run --mutate '<one file>'` on the file you care about.

- [gotcha] The atelier bun-typescript bootstrap checklist omits `lint:staged`, but pre-commit gate
  4 runs `bun run lint:staged`. Copy `assets/lint-staged.sh` into `scripts/` and add the script, or
  every commit dies at gate 4 of 5.

- [decision] A conversation records no folder in its front matter. A thread spans folders by nature
  (the question sits in Inbox, the answer in Sent Items), so naming one of them would mislead.

- [decision] `--since` filters which conversations get written, not which get swept. Outlook's
  message delta takes no date filter, so the sweep costs the same either way and only the expensive
  half (conversion) is narrowed.

- [decision] Attachments dedupe on name **and** length within a conversation. Name alone silently
  dropped a revised file resent under the same name; the pair keeps both, the second under a
  disambiguated name. Deliberately not deduped across threads, which would move attachments out of
  the per-thread folder the layout is built on.

- [mistake] `--site-id` filed a site under its raw id instead of its display name, quietly building
  a second knowledge base for a site already synced. Anything used as a folder name must be
  resolved to the name the source itself uses before it reaches the filesystem.

- [mistake] Wrote a plan detail as truth without checking it: the reply-prefix regex and several
  sanitizer patterns were built from assumption, and lint caught two as backtracking risks. When a
  regex is the checkpoint in front of a filesystem sink, prefer explicit character sets and loops
  over a clever pattern.

## 2026-07-24

- [gotcha] ask-marcel-office-cli 2.3.0 is breaking under a minor version bump. It removed all 77
  flag aliases and 4 deprecated command names, and every command now hard-refuses a parameter it
  does not declare, returning `validation_error` with code `unknown_parameter` where the library
  surface used to silently strip the key and return data that looked like it had obeyed. Calls that
  already used one canonical command name and one specific id flag each were untouched; anything on
  an `--id`-style alias would have broken. Pin-read the CHANGELOG on any future bump of this package.

- [decision] The mail sweep sends `top: 100` on the folder delta again, as of 2.3.0. This supersedes
  the 2026-07-23 [gotcha] that said never pass `top` to a mail delta: 2.3.0 sends `top` as a
  `Prefer: odata.maxpagesize` header, a page-size hint that pages through `nextLink`, not the `$top`
  that used to read as "sync complete" and strand the rest of the folder. Drive delta stays at 1000,
  mail at 100 to keep each response small; paging still continues if Graph caps the page lower.

- [gotcha] The big use-case files carry pre-existing sub-90% mutation debt (run-sync ~81%, sync-site
  ~86%, convert-file/convert-attachment/render-thread ~85-88% before cleanup). The scaffold's
  "90.77%" is the all-files aggregate, lifted by many 100% domain files; `mutate:changed` gates on
  the aggregate of the *changed* files only, so touching a single large use-case file often trips the
  90 break threshold even when the change itself is mutation-clean. Budget for either cleaning the
  file to 90 or tracking the debt; the survivors are mostly unkilled guard clauses (`if (!x.ok)`
  mutated to `if (false)`), logger-payload object literals mutated to `{}`, and `?.` optional chains.

- [gotcha] `crypto.subtle.digest('SHA-256', bytes)` fails typecheck under this repo's TS: a plain
  `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which is not assignable to `BufferSource` (the
  SharedArrayBuffer case), and it is async besides. `new Bun.CryptoHasher('sha256').update(bytes)
  .digest('hex')` is synchronous, allocation-free, and typechecks. Prefer it for hashing in this Bun
  repo (`src/domain/content-hash.ts`).

- [decision] Mailbox attachments in the shared `_attachments` store are always named
  `<name>-<hash8>.<ext>`, never readable-name-with-a-suffix-only-on-clash. The on-clash form needed a
  sequential `usedNames` set to detect a collision, which races under `--concurrency`: two different
  files of the same name in one window would both write `<name>` and one would overwrite the other. A
  name fixed purely by the content address lets conversations place files in parallel without
  colliding. See [[content-hash]] / `render-thread.ts` `placeAttachment`.

- [decision] `--concurrency` parallelises the IO per window and folds pure state deltas afterwards,
  the same shape in `sync-site` `processQueue` and `sync-mailbox` `drainQueue`: `applyWork` /
  `renderOne` return an update *function* `(state) => state`, a window of them runs N-wide through
  `Promise.all`, then the updates reduce onto the manifest/mailbox-state and the state saves once per
  window. A window interrupted mid-flight re-runs, and every write is idempotent (same bytes to the
  same paths), so a partial window costs a redo, never a corruption. Default 4; `--concurrency 1` is
  the old strictly-sequential behaviour.

- [gotcha] A per-iteration save-guard in a loop that also saves once at the end cannot be killed by
  asserting the run failed, when the fake fails every write. In `sync-site` `processQueue` the guard
  `if (!saved.ok) return saved` (and the same shape in `sync-mailbox` `drainQueue`) survived mutation
  to `if (false)`: under `files-fake` `failWriteWith` the window save AND the final `createSyncSite`
  save both fail, so `ok === false` holds whether the loop stops at the window or runs to the end and
  trips the final save. The distinguishing observable is how much work was attempted: seed two pending
  items at `concurrency: 1` and assert exactly one `convert.failed` was logged. The real run stops
  after window one; the mutant runs into window two and logs a second. This is the technique for the
  run-sync/sync-site mutation debt flagged in the earlier 2026-07-24 [gotcha]: both files are now at
  94.83% / 93.90%. The remaining survivors there are genuinely equivalent, chiefly the six `add`
  `+`->`-` mutants, which cancel because `add` is always applied to `EMPTY` twice (processQueue then
  createSyncSite), so `0 - (0 - n) === n`; do not chase them without refactoring `add` out of the
  double-negation.

- [gotcha] Splitting a one-line `if (!saved.ok) return saved` into a multi-line block (here to add a
  `deps.progress.done()` before the return) drops line coverage even though behaviour is unchanged:
  Bun counts a one-line `if` as covered the moment it executes, condition false every time, but once
  the body is on its own lines those lines are tracked separately and read as uncovered because the
  true branch was never taken. A mechanical refactor can therefore fail the 100% use-case gate. To
  cover the window-save failure in `sync-mailbox` `drainQueue` (and `sync-site` `processQueue`), load
  a resumed state with `pending` already set: `queueWork` returns early without its own save, so the
  window save is the first write and `files-fake` `failWriteWith` makes it fail, reaching the branch.

- [decision] Run progress is a `Progress` port (`start`/`step`/`done`), not the `Logger`. The counter
  is user-facing status, drawn once per item as each window resolves; logs are diagnostics at `error`
  level on stderr. The real adapter (`createStderrProgress`) rewrites one stderr line with `\r\x1b[K`
  and no-ops when stderr is not a TTY, so piped and headless runs stay clean. The `process.stderr`
  read lives in infra, not the composition root, so `build-deps` stays testable; the TTY-true branch
  and its writer arrow are the only uncoverable spots, left as equivalent mutants.

## 2026-07-26

- [gotcha] A batch rename across test fixtures can collide with a real identifier that happens to
  share the same substring. Renaming the "Espace MOOV" site-name fixture to "Espace Contoso" across
  21 test files, `build-deps.test.ts` also held `MOOV_KB_LOG_LEVEL`/`MOOV_KB_ROOT`, the actual env
  var names read by `config.ts` and documented in `README.md`. A blind find-and-replace would have
  renamed those too, breaking the test without touching the production contract to match. Before a
  batch string rename, grep the substring together with its neighbours (here `MOOV_KB`) to separate
  fixture text from something that is actually a contract, then handle the contract as its own
  confirmed change.

- [decision] Landing a branch whose commits already fit the pre-commit size gate (10 files / 300
  lines) onto a `main` that has diverged, with files touched on both sides: rebase onto the new
  `main` tip rather than making one merge commit. A single merge commit carries the whole branch's
  cumulative diff and re-trips the same size gate every original commit already respected; rebasing
  replays the original commits one at a time, so only the commit(s) that actually touch a conflicting
  file need conflict resolution, and every replayed commit still lands under the gate. `git merge
  --no-ff --no-commit` first is a cheap way to see the true conflict set before choosing rebase, then
  `git merge --abort` and rebase for real.

- [gotcha] This repo has no git remote at all (confirmed via `git remote -v` and `gh repo view`):
  two local worktrees share one checkout, the primary one holding `main`. "Push" here means
  fast-forwarding or merging into that local `main` checkout, not a network push; there is nowhere
  else for commits to go until a remote is deliberately added.

## 2026-08-14

- [gotcha] `disambiguateSegment(name, id)` takes the first 8 characters of the id, which
  disambiguates nothing when ids share a prefix, and Graph ids do. Every item in one drive starts
  `01W25LGY...`, and a site id is `<tenant>.sharepoint.com,<guid>,<guid>`, so two sites in the same
  tenant agree for the first 20-odd characters. Two same-named sites would have landed in the same
  folder either way, which is the bug the suffix was added to fix. `siteIdHash` (sha256, in
  `src/domain/site-state.ts`) is what makes the suffix distinguishing. Hash before slicing whenever
  a shared-prefix identifier is the source of a short suffix.

- [gotcha] Deleting well-tested code can fail the mutation gate even when nothing newly written is
  weak. Moving the day-folder logic out of `thread.ts` dropped the aggregate to 89.67% against a
  break threshold of 90, though every line written that day was mutation-clean: the removed block was
  the well-covered share of that file, so what remained (subject trimming, the header-line anchor,
  participant sorting) became a much larger fraction of a smaller file and its PRE-EXISTING debt
  surfaced. The fix is tests for the debt the deletion exposed, not for the change itself: 4 tests in
  `output-paths.test.ts` (88.10 -> 97.62%) and 4 in `thread.test.ts` (85.86 -> 88.89%) brought the
  aggregate to 90.59%. Expect this on any commit that removes a tested block from a mixed-coverage
  file, and read the per-file table before assuming the new code is at fault.

- [decision] The terminal is a sink with a checkpoint in front of it, the same way the filesystem has
  one in `kb-path.ts`. `printLine` (`src/presenter/output.ts`) drops C0 except tab and newline, plus
  DEL and C1, from everything it prints. The bug that motivated it: the operator's picker answer
  echoed back into a refusal carried a raw ESC from an arrow key, so `no such choice: ^[[Au` moved
  the cursor up a row and overwrote the line above with itself, leaving `bun run sync` exiting 1 with
  nothing visible on screen. Text reaching stdout comes either from Graph (a site or file name) or
  from the operator's own input, so neither is trusted. Printable characters in any script pass
  through untouched, so a name like 工作组网站 still prints as itself.

- [gotcha] RapidOCR's dotted-path params take enum members, never strings.
  `RapidOCR(params={"Rec.lang_type": "en"})` raises `TypeError: The value of Rec.lang_type must be
  Enum Type.`; it needs `LangRec("en")` from `rapidocr.utils.typings`, which is what
  `src/infra/rapidocr-run.py` does. `Cls.lang_type` has to be left at its default: RapidOCR's own
  `default_models.yaml` ships only a `ch` classifier, so overriding it fails at construction. `Det`
  has both, but the shared detector locates Latin-script text fine, so only `Rec` is set. Simplifying
  that file back to a plain string breaks OCR at engine construction, before an image is ever read.

- [gotcha] Slide or PDF markdown that arrives as one run-on wall of text with no spaces between words
  comes from upstream's PDF text extraction (`unpdf`, inside ask-marcel-office-cli), not from
  anything here. Checked against a real synced file: line 12 was 34,252 characters on a single line.
  The only whitespace folding in this repo is `front-matter.ts` `/\s+/g -> ' '` applied to front
  matter *values*; a document body goes through `withFrontMatter` untouched. Do not look for the
  cause in `convert-file.ts` or `kb-document.ts`. A fix belongs in the library, or in a
  post-extraction word-splitter this repo does not have and has not been asked for.
