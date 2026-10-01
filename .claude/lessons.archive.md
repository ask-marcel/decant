# LESSONS archive

Entries a compaction pass retired from `LESSONS.md`, verbatim, newest first, each followed by why it
left. Nothing reads this file at session start; grep it when a question needs the history.

## 2026-09-08

- [gotcha] `src/domain/worklist.ts` carried two NUL bytes where `sortKey` meant spaces, committed in
  `663d2f2` and invisible in every editor since. NUL is completely ignorable in ICU collation, so
  `localeCompare` compared `"\x00${itemId}"` against `"${lastModified} ${id}"` as though the prefix
  were not there, and the archive-first ordering the comment describes held only by luck: real
  SharePoint ids start with `01`, which sorts before `2026` anyway. Verified rather than reasoned,
  `" zzz"` sorts before a timestamp and `"\x00zzz"` after it. A NUL in either blob also makes git
  render the whole file as `Binary files differ`, so the change is invisible to review, which is how
  the bytes survived a scaffold commit in the first place.
  Archived 2026-10-01: archive, fixed: src/domain/worklist.ts holds no NUL byte.

## 2026-08-30

- [gotcha] Exchange sends the FULL RFC `References` chain, CRLF-folded across continuation lines: a
  30-message thread in this mailbox carries 52 ids on its newest reply. Three earlier samples each
  showed a single id equal to `In-Reply-To`, which looked like "Exchange only sends the parent" and
  is not: all three were direct replies to their own root, where parent and root are the same
  message and the two hypotheses are indistinguishable. Sample a thread deep enough to contain a
  reply-to-a-reply before concluding anything about a threading header, and read the first
  angle-bracketed token of the whole folded value rather than splitting on lines or whitespace.
  Archived 2026-10-01: graduate, now stated at src/domain/root-message-id.ts:2-17.

- [decision] Per-thread cards are written in `writeThread`, never inside the conversion. The
  conversion short-circuits on a content the store already holds, which is the common case for
  every thread after the first that carried a given file, so a card written there would exist only
  for whichever thread arrived first and every other thread would name files in its head that its
  own folder said nothing about. The same reasoning covers link cards, since a document another
  thread already pulled is referenced rather than fetched again.
  Archived 2026-10-01: graduate, now stated at src/use-cases/thread-documents.ts:13, the module that
  writes cards and never converts (`writeThread` is gone).

- [decision] An archive's `primary` is its manifest, not the `.zip`. A thread used to point its
  reader at a binary they had to unpack while the text was already on disk beside it, one file per
  member. The archive is still kept and still listed among the outputs; it is no longer the thing
  anything links to.
  Archived 2026-10-01: graduate, now stated at src/use-cases/convert-attachment.ts:268.

- [decision] The mailbox vault deliberately holds August 2026 onward, not the full history. The
  first live run swept every folder but wrote only what `--since 2026-08-05` allowed, and the delta
  cursors then advanced past everything older, so that history is behind the cursors and a plain
  re-run will not bring it back. Recovering it means clearing the `folders` cursors in
  `.sync-state.json` and re-sweeping, which is thousands of round trips and hours of rendering; the
  user weighed that and chose the gap. Long-running threads that got a reply after 5 August ARE
  present and carry their older messages, which is why folder dates reach back to March: the dates
  understate what is missing. Do not "fix" this by re-sweeping without asking.
  Archived 2026-10-01: archive, superseded by the kept reach day: `--since` moves it, and a source
  with a cursor reads the cursor out before a whole read (README.md:84-106, `widens` in
  src/domain/sync-window.ts:43).

- [decision] Group mailboxes are the reachable alternative and are still blocked, on post bodies.
  `list-group-conversations` works today on `Group.Read.All`, verified against a team the account belongs to,
  and returns topic, senders, `hasAttachments` and a PREVIEW truncated mid-word. This sync is bodies
  from end to end: a thread document IS one rendered body per message, and cards, indexes and the
  store all hang off messages already rendered. Listing without bodies would give subject lines with
  nothing under them. Revisit when a command returns post bodies, not before.
  Archived 2026-10-01: archive, superseded: group inboxes are a synced source
  (src/use-cases/sync-group.ts) since 2.6.0.

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
  Archived 2026-10-01: archive, superseded: the library rewrote the heuristic before 2.4.0 and the
  write-up was retired (523cf99, 2026-09-06).

- [gotcha] The card is written OVER the converter's extract, on purpose: both want
  `_attachments/<name>.<ext>.md`, so `writeCards` reads the extract, carries the body forward and
  replaces the library's stamp with the arrival facts. One document per file in the folder, not a
  card and an extract saying the same thing. The consequence for tests is that the path is written
  twice per file, so a "written once, not once per message" test asserts a write count of exactly 2
  and a third write is the bug. Asserting `written.has(path)` instead passes against a card written
  once per arrival, which is the mutant the test exists to catch: an assertion weakened to make a
  test green stops testing the thing it was named for.
  Archived 2026-10-01: graduate, now stated at src/use-cases/thread-documents.ts:107-111.

- [gotcha] Never read a bare `bunx stryker run`. `stryker.conf.json` sets `incremental: true`, and
  the repo's own `mutate:changed` and `mutate:staged` delete `reports/stryker-incremental.json`
  first for exactly that reason. Running stryker directly does not, so it reports cached verdicts
  for mutants your new tests were written to kill: this file read five survivors that were already
  dead, and the real count was one. Use the scripts, or remove the incremental file yourself.
  Archived 2026-10-01: archive, Stryker runs without incremental mode now (stryker.conf.json
  `_incremental_comment`).

- [lesson] A dependency advisory that no published version can clear is a fact about the registry,
  not a reason to drop the gate. SheetJS left npm, so `xlsx@0.18.5` was the newest there while the
  advisories wanted 0.19.3 and 0.20.2, which live only on the SheetJS CDN. The gate ignored those
  two by id with the reason and the fix written beside them, kept failing on everything else, and
  found thirteen real upgrades the same day. When `ask-marcel-office-cli` 2.4.0 pointed `xlsx` at
  the CDN tarball, the ignores came out and the audit was clean with no exceptions at all.
  Archived 2026-10-01: archive, closed: 2.4.0 pointed `xlsx` at the CDN and the ignores came out
  (its own last sentence); ci.yml:60 audits with none.

- [decision] The group inbox source was measured before it was built, and the measurement is why it
  was not built. `list-my-memberships` answers three unified groups, and every other group on the
  tenant refuses with 0xD10, so three is the whole reachable scope. They hold 16 threads, three of
  them "The new X group is ready", and of the 13 that remain, all in one group, eleven previews are
  the bare underscore rule of a calendar invitation and the rest say things like "Will re-schedule in
  outlook". That is a reader port, a picker entry, per-group state and an npm publish, to add a
  meeting calendar to a vault already holding 54 real mail threads. The library side stands as
  written in `docs/report-group-thread-posts-verified.md` and the six commands work; what is absent
  is traffic worth mirroring, which is a fact about this tenant and could change.
  Archived 2026-10-01: archive, superseded: the group inbox source was built
  (src/use-cases/sync-group.ts; three group inboxes in `kb/_sync-report.md`).

## 2026-08-28

- [decision] `mime.ts` and `mime-text.ts` are two modules because the shape of a message and the
  encodings its pieces travelled in are two subjects. The split fell out of the commit-size gate and
  turned out to be the better design: each file is under a hundred lines, each has its own tests, and
  the encodings module is the one with all the awkward native-throwing calls.
  Archived 2026-10-01: graduate, now stated at src/domain/mime.ts:1-4 and
  src/domain/mime-text.ts:1-3 each state their own subject.

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
  Archived 2026-10-01: graduate, now stated at scripts/mutate-changed.sh:19-23.

## 2026-08-27

- [decision] The OCR language is settled per image, by reading it, not by guessing from its path or
  from a run-level flag. `ch` reads first because it is the only recognizer that spans both scripts,
  holding CJK and ASCII alike: its reading is therefore evidence in BOTH directions, where a Latin
  model's proves nothing, since it could not have emitted an ideograph either way. No ideographs
  above a small share of the written characters means the image is read again with `latin`.
  Confidence scores were considered as the discriminator and rejected: the margins are asymmetric,
  `ch` beat `en` by 12 points on a Chinese page but `en` beat `ch` by only 1.2 on an English one.
  The policy lives in TypeScript, not in `rapidocr-run.py`, which `bun test`, coverage and mutation
  cannot reach; the script only learned to take a model version.
  Archived 2026-10-01: graduate, now stated at src/domain/ocr-language.ts:1-5 and
  src/infra/ocr-rapid.ts:40-48 (the policy is now: probe with `ch` v5, then read with the model
  built for the script found).

- [gotcha] Newer is not better per model, so measure per script instead of upgrading wholesale.
  PP-OCRv5 `ch` scored below v4 on this tenant's Chinese and silently dropped characters mid-word
  (headings came back short a character or two, which reads as plausible text, not as an error),
  while PP-OCRv5 `latin` beat both `latin` v3 and `en` v4 on the same English page and fixed v3's
  habit of reading `O` as `0` inside acronyms. Hence the pair now in use: `ch` at v4, `latin` at v5.
  Archived 2026-10-01: graduate, now stated at src/infra/ocr-rapid.ts:40-48.

- [gotcha] Graph reports `hasAttachments: false` on a message whose only attachment is inline, so a
  signature logo or a pasted screenshot is invisible to any code that gates a listing on that flag.
  `list-mail-attachments` on the very same message returns the picture. Confirmed live on two
  messages of this mailbox. The body is the other half of the question: `convert-mail-to-markdown`
  renders every unresolved `cid:` image as `[inline image: <label>]`, so a message worth listing is
  one where the flag is true OR the body carries that marker.
  Archived 2026-10-01: graduate, now stated at src/use-cases/thread-files.ts:207.

- [gotcha] The label in `[inline image: <label>]` is not reliably a file name. The library falls back
  through the attachment name, the `alt` text, the content id truncated at its `@`, then the whole
  content id, and it only has names to use when Graph said `hasAttachments`, which for an inline-only
  message it does not. Match a placeholder on all of those, and ask
  `list-mail-attachments --select ...,microsoft.graph.fileAttachment/contentId` to have the id at
  all: the library's default select leaves it out.
  Archived 2026-10-01: graduate, now stated at src/domain/inline-image.ts:2-5 and
  src/infra/mail-reader-marcel.ts:66-69.

- [decision] Two string literals from `ask-marcel-office-cli` are load-bearing in `domain/`:
  `**Attachments:**` and `[inline image: `. Both live as named constants, and every parse degrades to
  leaving the body exactly as it came rather than mangling it, so a reworded release costs the new
  behaviour and never the text. The dependency is pinned `^2.3.0`; a minor bump is the thing to check
  when a thread body suddenly stops linking its attachments.
  Archived 2026-10-01: graduate, now stated at src/domain/thread.ts:50-53.

- [gotcha] `get-mail-attachment` on an `itemAttachment` returns the item, not bytes, so anything that
  fetches bytes first fails it with "Graph returned no bytes" and retries it every run. `@odata.type`
  is the discriminator and Graph returns it whatever the `$select` asks for. Route on that, not on
  the file name: an item attachment's name is a subject with no extension, so extension routing has
  nothing to work with either.
  Archived 2026-10-01: graduate, now stated at src/infra/mail-reader-marcel.ts:39-42 (`KIND_BY_TYPE`
  routes on `@odata.type`).

- [decision] An attachment with no bytes is content-addressed by the SHA-256 of what the library
  renders it to. The address is then only stable within a library version, which is the price of
  having one at all, and it is what lets a conversation that forwarded the same mail five times store
  it once. Written down because a future reader will wonder why one address is taken from bytes and
  another from text.
  Archived 2026-10-01: graduate, now stated at src/use-cases/convert-attachment.ts:47-48.

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
  Archived 2026-10-01: graduate, now stated at src/infra/progress-bar.ts:3-8 and 34-35.

## 2026-08-16

- [gotcha] A SharePoint Embedded container (a Loop workspace, for one) answers to two site ids and
  only one of them is safe to store. The search index reports a `.pod` manifest's parent as
  `loop.cloud.microsoft,<guid>,<guid>`, while `get-sharepoint-site` on that very id answers with
  `<tenant>.sharepoint.com,<same guids>`. Both address the same container and both work on
  `list-sharepoint-site-drives`, so nothing fails loudly: the site state keys on the id it was given,
  so a workspace discovered through the index and the same workspace named with `--site-id` became
  two sources, and the second one swept every page again into a disambiguated folder. `listSites`
  now resolves each manifest through the site lookup before offering it, so one workspace is one id.
  Archived 2026-10-01: graduate, now stated at src/infra/drive-reader-marcel.ts:297-300.

- [gotcha] A container's web address comes in two shapes, and matching the wrong half of it silently
  loses one. A shared workspace sits at `/contentstorage/CSP_<guid>`, a personal one at
  `/contentstorage/<opaque token>` with no `CSP_` at all. That path is what tells a container apart
  from an ordinary site, since Graph hands back the workspace's plain display name and nothing else
  to say the pages are Loop pages. Matching `/contentstorage/CSP_` labelled every shared workspace
  and left the operator's own workspace looking like a site named `My workspace`. Match the path,
  never the id shape that follows it.
  Archived 2026-10-01: graduate, now stated at src/infra/drive-reader-marcel.ts:281-285.

## 2026-08-14

- [decision] The terminal is a sink with a checkpoint in front of it, the same way the filesystem has
  one in `kb-path.ts`. `printLine` (`src/presenter/output.ts`) drops C0 except tab and newline, plus
  DEL and C1, from everything it prints. The bug that motivated it: the operator's picker answer
  echoed back into a refusal carried a raw ESC from an arrow key, so `no such choice: ^[[Au` moved
  the cursor up a row and overwrote the line above with itself, leaving `bun run sync` exiting 1 with
  nothing visible on screen. Text reaching stdout comes either from Graph (a site or file name) or
  from the operator's own input, so neither is trusted. Printable characters in any script pass
  through untouched, so a name like 工作组网站 still prints as itself.
  Archived 2026-10-01: graduate, now stated at src/infra/output.ts:1-14 (the
  `src/presenter/output.ts` path it names is stale).

## 2026-07-26

- [gotcha] This repo has no git remote at all (confirmed via `git remote -v` and `gh repo view`):
  two local worktrees share one checkout, the primary one holding `main`. "Push" here means
  fast-forwarding or merging into that local `main` checkout, not a network push; there is nowhere
  else for commits to go until a remote is deliberately added.
  Archived 2026-10-01: archive, no longer true: `origin` is on GitHub (`git remote -v`) and CI runs
  there.

## 2026-07-24

- [decision] The mail sweep sends `top: 100` on the folder delta again, as of 2.3.0. This supersedes
  the 2026-07-23 [gotcha] that said never pass `top` to a mail delta: 2.3.0 sends `top` as a
  `Prefer: odata.maxpagesize` header, a page-size hint that pages through `nextLink`, not the `$top`
  that used to read as "sync complete" and strand the rest of the folder. Drive delta stays at 1000,
  mail at 100 to keep each response small; paging still continues if Graph caps the page lower.
  Archived 2026-10-01: graduate, now stated at src/infra/mail-reader-marcel.ts:139-143.

- [decision] Mailbox attachments in the shared `_attachments` store are always named
  `<name>-<hash8>.<ext>`, never readable-name-with-a-suffix-only-on-clash. The on-clash form needed a
  sequential `usedNames` set to detect a collision, which races under `--concurrency`: two different
  files of the same name in one window would both write `<name>` and one would overwrite the other. A
  name fixed purely by the content address lets conversations place files in parallel without
  colliding. See [[content-hash]] / `render-thread.ts` `placeAttachment`.
  Archived 2026-10-01: archive, superseded: attachments sit in each thread's folder under their own
  name, and only inline pictures take a hash suffix, in `_inline/`
  (src/use-cases/thread-files.ts:168).

- [decision] `--concurrency` parallelises the IO per window and folds pure state deltas afterwards,
  the same shape in `sync-site` `processQueue` and `sync-mailbox` `drainQueue`: `applyWork` /
  `renderOne` return an update *function* `(state) => state`, a window of them runs N-wide through
  `Promise.all`, then the updates reduce onto the manifest/mailbox-state and the state saves once per
  window. A window interrupted mid-flight re-runs, and every write is idempotent (same bytes to the
  same paths), so a partial window costs a redo, never a corruption. Default 4; `--concurrency 1` is
  the old strictly-sequential behaviour.
  Archived 2026-10-01: graduate, now stated at src/use-cases/sync-site.ts:56-57,
  src/use-cases/sync-mailbox.ts:63-65, README.md:127.

- [decision] Run progress is a `Progress` port (`start`/`step`/`done`), not the `Logger`. The counter
  is user-facing status, drawn once per item as each window resolves; logs are diagnostics at `error`
  level on stderr. The real adapter (`createStderrProgress`) rewrites one stderr line with `\r\x1b[K`
  and no-ops when stderr is not a TTY, so piped and headless runs stay clean. The `process.stderr`
  read lives in infra, not the composition root, so `build-deps` stays testable; the TTY-true branch
  and its writer arrow are the only uncoverable spots, left as equivalent mutants.
  Archived 2026-10-01: graduate, now stated at src/use-cases/ports/progress.ts:1-3 and
  src/infra/progress-bar.ts:138; the one-line `\r\x1b[K` adapter it describes is gone.

## 2026-07-23

- [gotcha] Outlook's message delta silently truncates when given a page size. On a 67-message
  Inbox, `list-mail-folder-messages-delta` with `top: 2` returned 2 messages and a `deltaLink`
  (not a `nextLink`), and following that cursor returned zero: the other 65 were unreachable and
  the sync believed itself complete. Without `top` the same call pages correctly, ten at a time.
  Never pass `top` to a mail delta. Drive delta is the opposite, where `top: 1000` is safe and
  saves round trips. A fix was planned in ask-marcel-office-cli itself; the sweep omits `top`
  either way, so the only thing that fix buys here is fewer requests.
  Archived 2026-10-01: archive, superseded by the 2026-07-24 [decision] on `top`, which says so
  itself.

- [gotcha] `commands[...].execute` in ask-marcel-office-cli is typed as returning a `Result` but
  can still throw: it decodes base64 with `atob`, which raises `InvalidCharacterError: The string
  contains invalid characters` on a malformed payload. A live mailbox run died on one attachment.
  Every call from an adapter needs a `try`/`catch` translating a throw into an error for that item;
  a typed `Result` return is not a promise that nothing throws.
  Archived 2026-10-01: graduate, now stated at src/infra/drive-reader-marcel.ts:105-107 (`attempt`),
  which every reader reaches through `MarcelCall`.

- [gotcha] Graph v1.0 does not expose `wellKnownName` on a mailFolder, so Junk, Deleted Items,
  Drafts and Outbox can only be recognised by the display name Outlook shows, which is localised.
  `src/domain/mail-folder.ts` matches English and French; another locale needs its names added
  there. Note "Sent Items" is kept and only "Outbox" (French "Boîte d'envoi") is skipped, since a
  message sits in the outbox for seconds and then reappears in sent mail.
  Archived 2026-10-01: graduate, now stated at src/domain/mail-folder.ts:8-10.

- [gotcha] Stryker's `incremental: true` reports a stale score after new test files are added: it
  showed 93.2% where the truth was 100%. Delete `reports/stryker-incremental.json` before trusting
  a mutation score after adding tests. Its clear-text reporter also truncates the survivor list, so
  to see them all, run `bunx stryker run --mutate '<one file>'` on the file you care about.
  Archived 2026-10-01: archive, Stryker runs without incremental mode now (stryker.conf.json
  `_incremental_comment`), and the html report lists every survivor.

- [gotcha] The atelier bun-typescript bootstrap checklist omits `lint:staged`, but pre-commit gate
  4 runs `bun run lint:staged`. Copy `assets/lint-staged.sh` into `scripts/` and add the script, or
  every commit dies at gate 4 of 5.
  Archived 2026-10-01: archive, done: `scripts/lint-staged.sh` exists and runs as gate 4 of the
  pre-commit hook.

- [decision] `--since` filters which conversations get written, not which get swept. Outlook's
  message delta takes no date filter, so the sweep costs the same either way and only the expensive
  half (conversion) is narrowed.
  Archived 2026-10-01: graduate, now stated at src/use-cases/sync-mailbox.ts:67-68.

- [decision] Attachments dedupe on name **and** length within a conversation. Name alone silently
  dropped a revised file resent under the same name; the pair keeps both, the second under a
  disambiguated name. Deliberately not deduped across threads, which would move attachments out of
  the per-thread folder the layout is built on.
  Archived 2026-10-01: archive, superseded by content addressing (src/domain/content-hash.ts:1-3); a
  file two threads carry is written into each (src/use-cases/thread-files.test.ts:83).

- [mistake] Wrote a plan detail as truth without checking it: the reply-prefix regex and several
  sanitizer patterns were built from assumption, and lint caught two as backtracking risks. When a
  regex is the checkpoint in front of a filesystem sink, prefer explicit character sets and loops
  over a clever pattern.
  Archived 2026-10-01: graduate, now stated at eslint.config.js:196, whose `sonarjs` recommended set
  makes `sonarjs/slow-regex` an error.
