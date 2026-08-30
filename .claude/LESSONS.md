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

## 2026-08-16

- [gotcha] A SharePoint Embedded container (a Loop workspace, for one) answers to two site ids and
  only one of them is safe to store. The search index reports a `.pod` manifest's parent as
  `loop.cloud.microsoft,<guid>,<guid>`, while `get-sharepoint-site` on that very id answers with
  `<tenant>.sharepoint.com,<same guids>`. Both address the same container and both work on
  `list-sharepoint-site-drives`, so nothing fails loudly: the site state keys on the id it was given,
  so a workspace discovered through the index and the same workspace named with `--site-id` became
  two sources, and the second one swept every page again into a disambiguated folder. `listSites`
  now resolves each manifest through the site lookup before offering it, so one workspace is one id.

- [gotcha] A container's web address comes in two shapes, and matching the wrong half of it silently
  loses one. A shared workspace sits at `/contentstorage/CSP_<guid>`, a personal one at
  `/contentstorage/<opaque token>` with no `CSP_` at all. That path is what tells a container apart
  from an ordinary site, since Graph hands back the workspace's plain display name and nothing else
  to say the pages are Loop pages. Matching `/contentstorage/CSP_` labelled every shared workspace
  and left the operator's own workspace looking like a site named `My workspace`. Match the path,
  never the id shape that follows it.

## 2026-08-27

- [gotcha] A PP-OCR recognizer can only emit characters its own dictionary holds, so the wrong
  `--ocr-lang` yields confident line noise rather than a failure. `en_PP-OCRv4` holds 95 characters,
  ASCII only, with no CJK and not one accented letter, which is why a Chinese announcement came back
  as `STARZE / 1. / 2.i / 3.A` while its front matter still claimed `ocr: rapidocr (en)`. Never
  assume a model covers a script: the dictionary is inside the ONNX file and takes one line to read,
  `ort.InferenceSession(path).get_modelmeta().custom_metadata_map["character"].splitlines()`.
  Sizes on this machine: `en` v4 95, `latin` v3 185, `latin` v5 502, `ch` v4 6623, `ch` v5 18383.

- [decision] The OCR language is settled per image, by reading it, not by guessing from its path or
  from a run-level flag. `ch` reads first because it is the only recognizer that spans both scripts,
  holding CJK and ASCII alike: its reading is therefore evidence in BOTH directions, where a Latin
  model's proves nothing, since it could not have emitted an ideograph either way. No ideographs
  above a small share of the written characters means the image is read again with `latin`.
  Confidence scores were considered as the discriminator and rejected: the margins are asymmetric,
  `ch` beat `en` by 12 points on a Chinese page but `en` beat `ch` by only 1.2 on an English one.
  The policy lives in TypeScript, not in `rapidocr-run.py`, which `bun test`, coverage and mutation
  cannot reach; the script only learned to take a model version.

- [gotcha] Newer is not better per model, so measure per script instead of upgrading wholesale.
  PP-OCRv5 `ch` scored below v4 on this tenant's Chinese and silently dropped characters mid-word
  (headings came back short a character or two, which reads as plausible text, not as an error),
  while PP-OCRv5 `latin` beat both `latin` v3 and `en` v4 on the same English page and fixed v3's
  habit of reading `O` as `0` inside acronyms. Hence the pair now in use: `ch` at v4, `latin` at v5.

- [mistake] A guard no mutant can kill is usually dead code, not a hole in the tests. Stryker put
  `ocr-language.ts` at 83.33% and one survivor was `if (written.length === 0) return false` sitting
  in front of a division that already yields `NaN` for that input, and `NaN` compares false. The
  guard changed nothing. Reformulating the comparison to multiply instead of divide
  (`ideographs > written.length * SHARE`) removed the guard AND made a second survivor, `>` mutated
  to `>=`, killable by the existing empty-text case, since `0 >= 0` is true where `0 > 0` is not.
  Two survivors and a line of code gone for one rewrite; only the third needed a new test.

- [gotcha] Graph reports `hasAttachments: false` on a message whose only attachment is inline, so a
  signature logo or a pasted screenshot is invisible to any code that gates a listing on that flag.
  `list-mail-attachments` on the very same message returns the picture. Confirmed live on two
  messages of this mailbox. The body is the other half of the question: `convert-mail-to-markdown`
  renders every unresolved `cid:` image as `[inline image: <label>]`, so a message worth listing is
  one where the flag is true OR the body carries that marker.

- [gotcha] The label in `[inline image: <label>]` is not reliably a file name. The library falls back
  through the attachment name, the `alt` text, the content id truncated at its `@`, then the whole
  content id, and it only has names to use when Graph said `hasAttachments`, which for an inline-only
  message it does not. Match a placeholder on all of those, and ask
  `list-mail-attachments --select ...,microsoft.graph.fileAttachment/contentId` to have the id at
  all: the library's default select leaves it out.

- [decision] Two string literals from `ask-marcel-office-cli` are load-bearing in `domain/`:
  `**Attachments:**` and `[inline image: `. Both live as named constants, and every parse degrades to
  leaving the body exactly as it came rather than mangling it, so a reworded release costs the new
  behaviour and never the text. The dependency is pinned `^2.3.0`; a minor bump is the thing to check
  when a thread body suddenly stops linking its attachments.

- [mistake] A test whose subject has a fallback path can pass without ever exercising its subject.
  Every inline-image identity test used one candidate picture, so the one-to-one last resort produced
  the right pair whatever the matching returned: green tests, 28 surviving mutants, 65% on a new
  module. Two candidates in the fixture is what makes an identity match the only explanation for the
  result. Mutation testing found this; coverage was already 100%.

- [gotcha] `get-mail-attachment` on an `itemAttachment` returns the item, not bytes, so anything that
  fetches bytes first fails it with "Graph returned no bytes" and retries it every run. `@odata.type`
  is the discriminator and Graph returns it whatever the `$select` asks for. Route on that, not on
  the file name: an item attachment's name is a subject with no extension, so extension routing has
  nothing to work with either.

- [decision] An attachment with no bytes is content-addressed by the SHA-256 of what the library
  renders it to. The address is then only stable within a library version, which is the price of
  having one at all, and it is what lets a conversation that forwarded the same mail five times store
  it once. Written down because a future reader will wonder why one address is taken from bytes and
  another from text.

- [gotcha] The mutation gate compares the AGGREGATE against the break threshold, not each file. A new
  module can sit under 90 while the run passes. Worth checking the per-file column after adding one:
  `icalendar.ts` first landed at 73.6% inside a passing run.

- [decision] `ThreadRecord.attachments` records what the messages carried, not every file the run
  wrote for them. Pictures taken out of a document, and a raw file written beside its markdown, are
  in the shared store record instead, which is what dedupe reads. The rule is that the record mirrors
  what a reader sees in the front matter; the store holds the whole production.

- [gotcha] The commit-size gate is 10 files AND 300 lines, and a step that touches a domain module
  plus its wiring will breach one of them. Splitting by file works when the new module has no caller
  yet: commit the pure part first, the wiring second. Three of the eight steps here needed it.

- [gotcha] `expect([undefined]).toEqual([])` PASSES in Bun. Verified in isolation, not inferred: an
  array holding one `undefined` satisfies an assertion that it is empty. Three assertions in
  `shared-site.test.ts` read as "nothing came back" while a stray `undefined` would have satisfied
  them, which is why a guard clause (`if (site === undefined) continue`) survived mutation with the
  whole condition replaced by `false`: the mutant pushed `undefined` into the result and every test
  still agreed. `toHaveLength(0)` beside the `toEqual` is what kills it. Anywhere a function can
  return `undefined` into a collection, pin the count as well as the contents.

- [mistake] Estimated a parallelisation win from timings taken by shelling out to the CLI, and was
  wrong by an order of magnitude. `bunx ask-marcel-office list-accessible-drives` measured 39s and
  `search-all-accessible-sites` 10s, so running them together looked like it would take a minute
  down to forty seconds. In-process, through the library with a warm token and connection, the whole
  listing was already 33s and became 30s: about 10%, not 50%. A process-spawn measurement carries
  cold auth and module loading that the real call path does not pay. Time the code as it actually
  runs before promising a number, or promise no number.

- [gotcha] A terminal block that rewrites itself in place climbs by the height of the PREVIOUS draw,
  never the one it is about to make, which is why `src/infra/progress-bar.ts` keeps a `drawn`
  counter. A third `begin()` grows the block from three rows to four and the escape it writes is
  `\x1b[2A`, climbing the three already on screen, not `\x1b[3A`. Writing the new height instead
  lands the cursor a row above the block, and every redraw walks it further up the screen. The
  matching trap is a climb of zero: a terminal reads `\x1b[0A` as `\x1b[1A`, so the first draw must
  emit no climb sequence at all rather than a zero one. `\x1b[J` after the last row is what wipes the
  rows a shrinking block no longer fills, since `\x1b[K` only clears the row the cursor sits on. The
  `\n` between rows lands at column 0 because `onlcr` is set on a pty, and libuv keeps it set even in
  raw mode, so no `\r` is needed per row.

## 2026-08-28

- [mistake] A parser tested with fixtures I wrote myself is tested against my idea of the format, not
  the format. The MIME boundary was escaped into a pattern and the escaping was wrong; every fixture
  used `BOUND` or `B`, so the tests passed for a parser that would have broken on the first real
  Outlook message, whose boundaries carry `.` and `+`. When a value comes from somewhere else, put
  what that somewhere else actually sends in the fixture.

- [gotcha] The mutation gate scores the aggregate of the staged files, so a new module can sit well
  under 90 inside a passing run, and a big weak file can fail a run where everything else is fine. It
  took five rounds to get this one over the line: exact assertions instead of `toContain`, then the
  input shapes the fixtures never used (LF endings, unquoted parameters, a space-folded header), then
  simplifying the code so there were fewer defensive branches to kill in the first place. Read the
  per-file column, not just the total.

- [decision] `mime.ts` and `mime-text.ts` are two modules because the shape of a message and the
  encodings its pieces travelled in are two subjects. The split fell out of the commit-size gate and
  turned out to be the better design: each file is under a hundred lines, each has its own tests, and
  the encodings module is the one with all the awkward native-throwing calls.

- [gotcha] `mutate:changed` built its file list from `git diff` alone, which never lists an untracked
  file, so a module that had never been added was skipped and the run printed a passing score for
  everything else. `global-report.ts` landed at 67.74% against a break threshold of 90 and was found
  only by running Stryker against it by hand. The blind spot is exactly the case the script exists
  for: its header says it runs before staging, and new code is where surviving mutants live. Fixed by
  adding `git ls-files --others --exclude-standard` to the collection. `mutate:staged` never had the
  hole, since `--diff-filter=A` covers staged additions, which is all a commit gate must judge. Worth
  knowing why this mattered here rather than being caught later: mutation is not in the pre-commit
  hook (the five fast gates only), it runs in `ci.yml`, and this repo has no remote, so CI never runs
  and that local script is the only mutation gate that actually executes.

- [gotcha] A suite built entirely from `toContain` leaves a renderer's layout untested, and mutation
  is what says so. `global-report.ts` had eight passing tests and scored 67.74%: every survivor was a
  blank-line separator turned into a string, `join('\n')` turned into `join('')`, or `trimEnd` turned
  into `trimStart`. Each one changes the document a reader opens, and no fragment assertion could see
  any of them. One `toBe` against a whole small rendering killed all ten and took the file to 100%.
  Where the output IS a document, pin at least one complete example; keep the fragment tests for the
  scenarios they name, but never let them be the only thing holding the shape.

## 2026-08-30

- [gotcha] Exchange sends the FULL RFC `References` chain, CRLF-folded across continuation lines: a
  30-message thread in this mailbox carries 52 ids on its newest reply. Three earlier samples each
  showed a single id equal to `In-Reply-To`, which looked like "Exchange only sends the parent" and
  is not: all three were direct replies to their own root, where parent and root are the same
  message and the two hypotheses are indistinguishable. Sample a thread deep enough to contain a
  reply-to-a-reply before concluding anything about a threading header, and read the first
  angle-bracketed token of the whole folded value rather than splitting on lines or whitespace.

- [gotcha] `expect(rendered).toContain('- name')` cannot tell a bare list entry from that entry with
  a suffix appended, so every mutant that appends something survives it. Five survivors in
  `zip-manifest.ts` and two in `thread-card.ts` were all of this shape: a member with nothing read
  out of it must list as its name ALONE, and only a whole-document `toBe` says so. This is the same
  lesson as the 2026-08-28 entry on fragment assertions, met from the other direction: there the
  fragments missed a collapsed layout, here they miss an added suffix.

- [mistake] An ordering test whose keys the engine already orders proves nothing. The first version
  of the `mail-meta` sort test used `'1234567890'` and `'ffff000000'`, and passed against an
  implementation with no sort at all, because JavaScript hoists integer-like keys to the front of an
  object whatever order it was built in. That hoisting was the very hazard the sort existed for, so
  the test was written from the right instinct and still tested nothing. Two keys that are NOT
  integer-like, inserted in reverse, is what makes the sort the only explanation for the result.

- [gotcha] `eslint --cache` reports findings against paths that no longer hold them. Several rounds
  went into a `prettier/prettier` warning attributed to `mail-meta.test.ts` that actually lived in
  `mail-meta.ts`, and `--fix` on the named file changed nothing because nothing there was wrong.
  When a warning points at a file you have already corrected, re-run with `--no-cache` before
  believing the location.

- [decision] Per-thread cards are written in `writeThread`, never inside the conversion. The
  conversion short-circuits on a content the store already holds, which is the common case for
  every thread after the first that carried a given file, so a card written there would exist only
  for whichever thread arrived first and every other thread would name files in its head that its
  own folder said nothing about. The same reasoning covers link cards, since a document another
  thread already pulled is referenced rather than fetched again.

- [decision] An archive's `primary` is its manifest, not the `.zip`. A thread used to point its
  reader at a binary they had to unpack while the text was already on disk beside it, one file per
  member. The archive is still kept and still listed among the outputs; it is no longer the thing
  anything links to.

- [decision] The mailbox vault deliberately holds August 2026 onward, not the full history. The
  first live run swept every folder but wrote only what `--since 2026-08-05` allowed, and the delta
  cursors then advanced past everything older, so that history is behind the cursors and a plain
  re-run will not bring it back. Recovering it means clearing the `folders` cursors in
  `.sync-state.json` and re-sweeping, which is thousands of round trips and hours of rendering; the
  user weighed that and chose the gap. Long-running threads that got a reply after 5 August ARE
  present and carry their older messages, which is why folder dates reach back to March: the dates
  understate what is missing. Do not "fix" this by re-sweeping without asking.

- [decision] `internetMessageHeaders` IS honored on `list-conversation-messages --select`, verified
  live, and the per-conversation `get-mail-message` call stays anyway. The header read happens in
  the SWEEP, off delta data, before any conversation has been fetched, so there is no existing call
  to fold the select into: both cost one call per conversation, and `get-mail-message` returns one
  message's headers (~4 KB) where the conversation call returns every message's (~120 KB on a
  30-message thread). A capability being available is not the same as it being the cheaper option;
  check which call is actually being made at that point in the run before folding anything into it.

- [decision] Shared mailboxes are not reachable through this CLI and the sync will not chase them.
  The `/users/{id}/...` commands exist but need the delegated `Mail.Read.Shared` scope, which
  neither token the CLI can obtain carries, across two tenants: the ceiling is Microsoft's app
  registration, not something a tenant admin can grant. Outlook on the Web is not a way round it
  either, since the token holding the shared-mail scope is bound to an Exchange audience the CLI
  cannot call. Treat those commands as present but inert; they answer `ErrorAccessDenied`.

- [decision] Group mailboxes are the reachable alternative and are still blocked, on post bodies.
  `list-group-conversations` works today on `Group.Read.All`, verified against MOOV Leadership Team,
  and returns topic, senders, `hasAttachments` and a PREVIEW truncated mid-word. This sync is bodies
  from end to end: a thread document IS one rendered body per message, and cards, indexes and the
  store all hang off messages already rendered. Listing without bodies would give subject lines with
  nothing under them. Revisit when a command returns post bodies, not before.

- [gotcha] `list-groups` returns every group in the TENANT, not the ones the signed-in user belongs
  to, so the obvious first call hands back groups that then answer `ErrorAccessDenied` on any read.
  That reads like a permissions bug and is not one. `list-joined-teams` gives the groups the user is
  actually in: three here, against a tenant list still paging after ten.

- [gotcha] The tenant's zone and the machine's diverge the moment an account changes, and the folder
  date is frozen at creation. The first account was a China tenant read from a Shanghai machine, so
  the machine default was accidentally right; the second is a Paris tenant (`Romance Standard Time`)
  read from the same machine, where the default would have filed every thread under a Shanghai day.
  `my-quick-context` reports the tenant zone in Windows spelling, which `--timezone` refuses, so the
  mapping is a human step: Romance Standard Time is `Europe/Paris`.
  Ask it per run rather than carrying the answer forward. On 2026-08-30 the signed-in account was
  `vincent.delacourt@moovlogistics.com` reporting `China Standard Time`, so the machine default was
  right and a run "corrected" to `Europe/Paris` on the strength of this note would have been wrong.
  One call settles it; the note above records what one account said once.

- [gotcha] Concurrency 4 is proven clean against real mail: 169 threads, 169 documents, no thread id
  in two folders. The race the sequential folder resolution guards against did not occur, and the
  test needed threads being CREATED, since a re-run over threads already written writes nothing and
  exercises no parallel folder creation at all. Run it into a scratch `KB_ROOT` with the OCR cache
  symlinked in, which keeps it off the real vault and off a cold cache.

- [gotcha] `convert-mail-to-markdown` can strip an ENTIRE body as a "quoted reply chain" and report
  success. Measured on a 7-day sync: 10 of 42 message sections, 24%, reduced to one short line. The
  same message with `keepQuoted: true` returns 6912 bytes over 109 lines with ZERO lines starting
  with `>`, so nothing was quoted; the heuristic misread an Outlook HTML body with headings and
  numbered lists. The bias is the worst part: a two-line reply survives, a scoped proposal with
  sections and a sign-off is destroyed. Nothing in the result tells the two apart, since the `note`
  fires identically whether one line or a hundred was removed.
  A genuine chain is NOT `>`-quoted either: it is delimited by a second `**From:**` header block
  partway down the document, which is what a reliable rule would cut at. Written up for the
  maintainer in `docs/bug-convert-mail-to-markdown-strips-body.md`.
  **Decision: not worked around here.** Asking for `keepQuoted` and cutting at that header block was
  proposed and declined in favour of an upstream fix, so the vault under-reports message bodies
  until the library changes. Anything reading these threads should be told that, and a thread whose
  section is a single line is a candidate for re-fetching rather than a short message.

- [lesson] Deleting a shared store leaves dead code that only mutation testing sees. Moving
  attachments from one content-addressed store at the mailbox root into each thread's own folder
  dropped `render-thread.ts` from 91.13 to 88.60, under the per-file gate, with the whole suite
  green and line coverage at 100. Every new survivor pointed at the same thing: naming the file
  before its bytes are fetched made `asName` total, so an optional field, two `=== undefined`
  guards, a `Record<string, string>` of card names and the three function parameters that carried it
  were all answering a question that could no longer be asked. Removing them, rather than writing
  tests for paths nothing can reach, put the file back over 90. Read a mutation drop after a
  deletion as a map of what the deletion orphaned.

- [gotcha] The card is written OVER the converter's extract, on purpose: both want
  `_attachments/<name>.<ext>.md`, so `writeCards` reads the extract, carries the body forward and
  replaces the library's stamp with the arrival facts. One document per file in the folder, not a
  card and an extract saying the same thing. The consequence for tests is that the path is written
  twice per file, so a "written once, not once per message" test asserts a write count of exactly 2
  and a third write is the bug. Asserting `written.has(path)` instead passes against a card written
  once per arrival, which is the mutant the test exists to catch: an assertion weakened to make a
  test green stops testing the thing it was named for.

- [lesson] `isInline` does not mean picture. Graph sets it for anything the body points at by `cid:`,
  a PDF included, so the test for "show this in the thread rather than card it" is `isInline` AND an
  `image/` content type. The mirror of the older gotcha that Graph reports `hasAttachments: false`
  for a message whose only attachment is inline: neither flag means on its own what its name
  suggests, and both need the other half.

- [lesson] Moving a picture's text into the thread means the state has to remember it. Once no
  document holds the reading, a second thread meeting the same picture has nothing to put under it,
  so `AttachmentRecord` carries `text` and the shared `_inline/` store is what makes the dedup pay.
  A record written before that change holds no text, and honouring it would show the picture
  wordlessly for ever, so a record with no text is treated as unstored: one extra fetch, and it
  repairs itself. Prefer that shape to a state version bump whenever the repair is cheap, since a
  bump makes every user rebuild for a field most of them could have refilled in a second.

- [gotcha] The same note can be right in one place and wrong in another. `_No text could be read
  from this file_` is what a document holding nothing has to say; quoted under a picture in a thread
  it tells the reader to open a file that no longer exists, once per signature down a long thread.
  A converter that returns text rather than a document has to drop it.

- [gotcha] `mutate:changed` scores the ALL FILES aggregate, so its exit code passes while a single
  file sits under 90. `render-thread.ts` has now gone 91.13 → 88.60 → 90.08 → 89.92 → 88.24 → 90.03
  across four changes, each time pulled back by tests written against the survivors. Read the
  per-file row and treat that file's number as the gate; the aggregate only says the others are
  carrying it.

- [lesson] A file too big to score is a file too big to trust. `render-thread.ts` reached 692 lines
  doing five jobs, and the mutation number said so before anything else did: it crossed under 90 on
  three of four changes in one session, each time pulled back by tests written against whatever had
  survived. Splitting it into the jobs it was doing put every piece over 90 on its own, and the
  survivors that had been hiding in the aggregate became attributable to one module each. The split
  itself found three pieces of dead code: a path reported for a document that no longer exists, a
  constant declared twice under two names, and a failure path the fake could not even produce.

- [gotcha] Extracting a module is where narrow dependencies pay. Each piece took a `Pick<>` of the
  ports it actually calls rather than the whole `RenderThreadDeps` bag, which is free at every call
  site under structural typing and states, in the type, that following a link never reads a message
  and that writing a card never fetches anything. The alternative, one shared context module every
  piece imports whole, keeps the coupling and merely moves it.

- [gotcha] `scripts/check-commit-size.sh` allows `--no-verify` for a mass-move, and a file split is
  one: moving 690 lines counts as some 750 changed however the commits are cut, so splitting the
  commit does not help. Run lint, typecheck, the suite, coverage and mutation by hand first, and say
  in the body that you did.
