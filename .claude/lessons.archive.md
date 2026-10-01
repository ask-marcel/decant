# LESSONS archive

Entries a compaction pass retired from `LESSONS.md`, verbatim, newest first, each followed by why it
left. Nothing reads this file at session start; grep it when a question needs the history.

## 2026-09-26

- [gotcha] `toEqual([])` passes on `[undefined]`: `toEqual` ignores undefined array items and
  properties. A test asserting that nothing was remembered let a mutant through that remembered
  `undefined`; `toHaveLength(0)` (or `toStrictEqual`) is the emptiness check that can fail.
  Archived 2026-10-01: merge, into the `toEqual` entry (2026-09-26).

- [gotcha] Moving a delta source's reach earlier cannot just drop its cursor: a fresh delta lists
  only what exists now, so anything deleted since the last run is never reported, never archived,
  and its document stays in `kb/` for good. Read the old cursor out first (its deletions and its
  changes), then read the source whole, and merge the two by id with the whole read winning
  (`latestById` in `sync-window.ts`). The mailbox needs no read-out: it never archives on deletion.
  Archived 2026-10-01: graduate, now stated at src/domain/sync-window.ts:45-47 and
  README.md:100-103.

- [gotcha] Outlook's events delta returns a recurring series as one `seriesMaster` event whose
  `start` is the series' first occurrence, not its next. A filter on the day an event starts drops
  a weekly meeting that began before the day while it is still running, so series masters are
  exempt (`inReach` in `sync-calendar.ts`).
  Archived 2026-10-01: graduate, now stated at src/use-cases/sync-calendar.ts:192-195.

## 2026-09-11

- [gotcha] The pre-commit typecheck runs on the working tree, not on the commit, so a landing split
  into "the consumer gains a dependency" and "the composition supplies it" passes the hook twice
  and leaves a commit on `main` that does not compile. It happened here on the Teams picker: the
  `run-sync` commit added `syncTeam`, `teams` and `savedChannels` to `RunSyncDeps`, `build-deps`
  supplied them one commit later, and the hook was green on both because the tree had everything.
  Found by the check the earlier `[mistake]` entry prescribes and this session made a habit: build
  every commit of a multi-commit landing in a detached worktree (`git worktree add --detach`, a
  symlinked `node_modules`, `tsc` and `bun test` per sha) BEFORE pushing, not only the last one.
  The fix was to fold the two into one commit and take the size-gate bypass, with the reason in
  the body: a commit that compiles beats two that meet a line count.
  Archived 2026-10-01: merge, into the prove-the-commit entry (2026-09-11).

## 2026-09-09

- [gotcha] A `?? fallback` behind a lookup that cannot miss is dead code the coverage gate cannot see
  and mutation testing can. `syncTodo` planned each task's path into a `Map` and then wrote
  `files.get(task.id) ?? ''` in the loop over the very tasks that built it. Line and function
  coverage read 100%, because the line runs every time; the fallback is simply unreachable, so a
  mutant replacing it survives and the module scored 87 against a 90 break. The fix was not a test:
  pairing each item with its computed value (`planTaskFiles` returning `{ task, file }[]` instead of
  a map to look the file up in) removed the lookup, the fallback and the mutant together. Wherever a
  plan is built from a collection and then consumed by iterating the same collection, hand back the
  pairs rather than an index into them.
  Archived 2026-10-01: merge, into the dead-code entry (2026-09-09).

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

- [decision] A file given up on stays in the ledger and is named in every report from then on, under
  a heading of its own saying it will not be tried again. Dropping the entry at the cap was the
  obvious alternative and it recreates the original bug three runs later instead of one: the file
  goes quiet, and quiet is the failure this whole mechanism exists to prevent. The cost is a report
  written every night for as long as the file sits there unconvertible, which is the honest price and
  the thing that makes someone go and look at it. An edit at the source clears it, since the sweep
  returns the file with a new cTag and a fresh conversion drops the entry.
  Archived 2026-10-01: graduate, now stated at src/domain/retry-policy.ts:16-19.

- [mistake] Ran the gates on the working tree, then committed the index, and reported the gates as
  proof of what landed. `git merge --no-commit` stages the merge result; edits made after it, which
  is where the reconciliation for a type that changed on the branch lives, stay unstaged, and a bare
  `git commit` writes the staged merge without them. Every gate passed on the files on disk, so
  nothing looked wrong: 1291 tests, tsc clean, lint clean, all true of a tree that was never
  committed. `main` then carried a `sync-group.ts` that did not typecheck for four commits, and it
  was found only when a later commit was checked out into a fresh worktree and tested there.
  Two habits close it. `git add -A` before running the gates, so what is tested is what is staged.
  And when a commit is the one that lands on a shared branch, prove the COMMIT rather than the tree:
  `git worktree add --detach <dir> <sha>`, install, run the gates there. The tell that was available
  and went unread: the commit's own summary line said 35 files while the reconciliation had touched
  two more, and a diff smaller than the change just verified is never right.
  Archived 2026-10-01: merge, into the prove-the-commit entry (2026-09-11).

- [decision] Where a source cannot do what its sibling does, the adapter answers honestly and the gap
  goes upstream, rather than being worked around locally. A group post has no command to render an
  attachment to PDF, to extract the pictures inside one, or to resolve the SharePoint links in a
  body, all three of which a mail message has. The adapter returns `unrenderable` for the first and
  an empty list for the other two, each with the reason written beside it, so a thread records that
  no PDF exists rather than implying one was refused. Fetching the bytes and converting them here
  would have duplicated a conversion the library owns and drifted from it within a release or two.
  The request is `docs/request-group-post-parity.md`; when the commands land, the change is confined
  to those three methods and nothing else moves, because the rendering path is already shared.
  Archived 2026-10-01: merge, into the answer-honestly entry (2026-09-08).

- [gotcha] `expect(result).toEqual({ ok: true, value: [] })` does not prove a list is empty: Bun reads
  `[undefined]` as equal to `[]`, so a `filter` that drops holes out of an array can be deleted
  outright and every such assertion still passes. Two mutants survived on one line of
  `listSyncedSources` for exactly that reason, both of them the filter that keeps an unreadable
  source from leaking into the list as a hole, and the tests covering that line read as if they had
  it pinned. `toHaveLength(0)` sees the difference and kills both. Where a test asserts that
  something was filtered OUT, assert the length, or assert on a mapped projection
  (`value.map((source) => source.name)`) where a hole shows up as `undefined` rather than vanishing.
  Archived 2026-10-01: merge, into the `toEqual` entry (2026-09-26).

- [decision] Answering a missing upstream command honestly, and writing the gap up rather than
  working around it, paid back exactly as predicted. 2.6.0 landed all three group-post commands as
  siblings of the mail ones, sharing their pipeline and taking the same parameters every other group
  command takes, and wiring them was three method bodies in `group-reader-marcel.ts` plus one test.
  No use-case, no domain module, no rendering code moved, because the honest `unrenderable` and the
  honest empty list had kept the shape of the real answer. Supersedes nothing: it confirms the
  earlier entry on the same adapter. The general form: when a dependency cannot do something, return
  the shape the real answer will have, say why in the error, and file the request. A local
  workaround would have had to be unpicked here instead.
  Archived 2026-10-01: merge, into the answer-honestly entry (2026-09-08).

## 2026-08-30

- [gotcha] Exchange sends the FULL RFC `References` chain, CRLF-folded across continuation lines: a
  30-message thread in this mailbox carries 52 ids on its newest reply. Three earlier samples each
  showed a single id equal to `In-Reply-To`, which looked like "Exchange only sends the parent" and
  is not: all three were direct replies to their own root, where parent and root are the same
  message and the two hypotheses are indistinguishable. Sample a thread deep enough to contain a
  reply-to-a-reply before concluding anything about a threading header, and read the first
  angle-bracketed token of the whole folded value rather than splitting on lines or whitespace.
  Archived 2026-10-01: graduate, now stated at src/domain/root-message-id.ts:2-17.

- [gotcha] `expect(rendered).toContain('- name')` cannot tell a bare list entry from that entry with
  a suffix appended, so every mutant that appends something survives it. Five survivors in
  `zip-manifest.ts` and two in `thread-card.ts` were all of this shape: a member with nothing read
  out of it must list as its name ALONE, and only a whole-document `toBe` says so. This is the same
  lesson as the 2026-08-28 entry on fragment assertions, met from the other direction: there the
  fragments missed a collapsed layout, here they miss an added suffix.
  Archived 2026-10-01: merge, into the whole-document entry (2026-08-30).

- [mistake] An ordering test whose keys the engine already orders proves nothing. The first version
  of the `mail-meta` sort test used `'1234567890'` and `'ffff000000'`, and passed against an
  implementation with no sort at all, because JavaScript hoists integer-like keys to the front of an
  object whatever order it was built in. That hoisting was the very hazard the sort existed for, so
  the test was written from the right instinct and still tested nothing. Two keys that are NOT
  integer-like, inserted in reverse, is what makes the sort the only explanation for the result.
  Archived 2026-10-01: merge, into the only-explanation entry (2026-08-30).

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

- [decision] `internetMessageHeaders` IS honored on `list-conversation-messages --select`, verified
  live, and the per-conversation `get-mail-message` call stays anyway. The header read happens in
  the SWEEP, off delta data, before any conversation has been fetched, so there is no existing call
  to fold the select into: both cost one call per conversation, and `get-mail-message` returns one
  message's headers (~4 KB) where the conversation call returns every message's (~120 KB on a
  30-message thread). A capability being available is not the same as it being the cheaper option;
  check which call is actually being made at that point in the run before folding anything into it.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-30 (the comment at
  src/infra/mail-reader-marcel.ts:154-156 is narrower ("does not document returning it"), so the
  verified fact stays here).

- [decision] Group mailboxes are the reachable alternative and are still blocked, on post bodies.
  `list-group-conversations` works today on `Group.Read.All`, verified against a team the account belongs to,
  and returns topic, senders, `hasAttachments` and a PREVIEW truncated mid-word. This sync is bodies
  from end to end: a thread document IS one rendered body per message, and cards, indexes and the
  store all hang off messages already rendered. Listing without bodies would give subject lines with
  nothing under them. Revisit when a command returns post bodies, not before.
  Archived 2026-10-01: archive, superseded: group inboxes are a synced source
  (src/use-cases/sync-group.ts) since 2.6.0.

- [gotcha] The tenant's zone and the machine's diverge the moment an account changes, and the folder
  date is frozen at creation. The first account was a China tenant read from a Shanghai machine, so
  the machine default was accidentally right; the second is a Paris tenant (`Romance Standard Time`)
  read from the same machine, where the default would have filed every thread under a Shanghai day.
  `my-quick-context` reports the tenant zone in Windows spelling, which `--timezone` refuses, so the
  mapping is a human step: Romance Standard Time is `Europe/Paris`.
  Ask it per run rather than carrying the answer forward. On 2026-08-30 the signed-in account was
  an account on another tenant reporting `China Standard Time`, so the machine default was
  right and a run "corrected" to `Europe/Paris` on the strength of this note would have been wrong.
  One call settles it; the note above records what one account said once.
  Archived 2026-10-01: merge, into the `my-quick-context` entry (2026-08-30).

- [gotcha] Concurrency 4 is proven clean against real mail: 169 threads, 169 documents, no thread id
  in two folders. The race the sequential folder resolution guards against did not occur, and the
  test needed threads being CREATED, since a re-run over threads already written writes nothing and
  exercises no parallel folder creation at all. Run it into a scratch `KB_ROOT` with the OCR cache
  symlinked in, which keeps it off the real vault and off a cold cache.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-30 (the technique outlives the
  proof).

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

- [lesson] Deleting a shared store leaves dead code that only mutation testing sees. Moving
  attachments from one content-addressed store at the mailbox root into each thread's own folder
  dropped `render-thread.ts` from 91.13 to 88.60, under the per-file gate, with the whole suite
  green and line coverage at 100. Every new survivor pointed at the same thing: naming the file
  before its bytes are fetched made `asName` total, so an optional field, two `=== undefined`
  guards, a `Record<string, string>` of card names and the three function parameters that carried it
  were all answering a question that could no longer be asked. Removing them, rather than writing
  tests for paths nothing can reach, put the file back over 90. Read a mutation drop after a
  deletion as a map of what the deletion orphaned.
  Archived 2026-10-01: merge, into the dead-code entry (2026-09-09).

- [gotcha] The card is written OVER the converter's extract, on purpose: both want
  `_attachments/<name>.<ext>.md`, so `writeCards` reads the extract, carries the body forward and
  replaces the library's stamp with the arrival facts. One document per file in the folder, not a
  card and an extract saying the same thing. The consequence for tests is that the path is written
  twice per file, so a "written once, not once per message" test asserts a write count of exactly 2
  and a third write is the bug. Asserting `written.has(path)` instead passes against a card written
  once per arrival, which is the mutant the test exists to catch: an assertion weakened to make a
  test green stops testing the thing it was named for.
  Archived 2026-10-01: graduate, now stated at src/use-cases/thread-documents.ts:107-111.

- [lesson] `isInline` does not mean picture. Graph sets it for anything the body points at by `cid:`,
  a PDF included, so the test for "show this in the thread rather than card it" is `isInline` AND an
  `image/` content type. The mirror of the older gotcha that Graph reports `hasAttachments: false`
  for a message whose only attachment is inline: neither flag means on its own what its name
  suggests, and both need the other half.
  Archived 2026-10-01: graduate, now stated at src/use-cases/thread-files.ts:101.

- [lesson] Moving a picture's text into the thread means the state has to remember it. Once no
  document holds the reading, a second thread meeting the same picture has nothing to put under it,
  so `AttachmentRecord` carries `text` and the shared `_inline/` store is what makes the dedup pay.
  A record written before that change holds no text, and honouring it would show the picture
  wordlessly for ever, so a record with no text is treated as unstored: one extra fetch, and it
  repairs itself. Prefer that shape to a state version bump whenever the repair is cheap, since a
  bump makes every user rebuild for a field most of them could have refilled in a second.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-30 (the instance is stated at
  src/use-cases/thread-files.ts:141, the general rule is not; retagged from `[lesson]`).

- [gotcha] `mutate:changed` scores the ALL FILES aggregate, so its exit code passes while a single
  file sits under 90. `render-thread.ts` has now gone 91.13 → 88.60 → 90.08 → 89.92 → 88.24 → 90.03
  across four changes, each time pulled back by tests written against the survivors. Read the
  per-file row and treat that file's number as the gate; the aggregate only says the others are
  carrying it.
  Archived 2026-10-01: merge, into the mutation-aggregate entry (2026-08-30).

- [gotcha] `scripts/check-commit-size.sh` allows `--no-verify` for a mass-move, and a file split is
  one: moving 690 lines counts as some 750 changed however the commits are cut, so splitting the
  commit does not help. Run lint, typecheck, the suite, coverage and mutation by hand first, and say
  in the body that you did.
  Archived 2026-10-01: merge, into the commit-size entry (2026-08-30).

- [gotcha] Never read a bare `bunx stryker run`. `stryker.conf.json` sets `incremental: true`, and
  the repo's own `mutate:changed` and `mutate:staged` delete `reports/stryker-incremental.json`
  first for exactly that reason. Running stryker directly does not, so it reports cached verdicts
  for mutants your new tests were written to kill: this file read five survivors that were already
  dead, and the real count was one. Use the scripts, or remove the incremental file yourself.
  Archived 2026-10-01: archive, Stryker runs without incremental mode now (stryker.conf.json
  `_incremental_comment`).

- [lesson] A stamp nothing reads is a stamp nothing can get wrong. `render-thread.ts` sat at 90.27
  and four of its eleven survivors were the `site`, `library` and `source` of the DocumentStamp: a
  card is written over every top-level document the converter produced, so the stamp was replaced
  before any test could see it. The exception is a saved email, which unpacks into a FOLDER whose
  documents sit below the card's path and keep the stamp. Asserting one of those killed all four.
  The pattern generalises: when a field appears untestable, find the one path where it survives to
  disk, and if there is none, the field is dead rather than untested.
  Archived 2026-10-01: merge, into the dead-code entry (2026-09-09).

- [gotcha] A markdown link destination ends at the first space unless it is wrapped in `<>`. Every
  path this vault writes goes into one, and mail attachments are named by people, so
  `[Fw- DC Data -- Fabrikam.eml](_attachments/Fw- DC Data -- Fabrikam.eml.md)` rendered as literal text
  with a stray link to `Fabrikam.eml.md` in the middle of it. Nothing caught it for weeks because the
  tests pinned the string that was written, not what a renderer does with it, and the paths in the
  fixtures had no spaces. `linkDestination` in `markdown-link.ts` is now the only way a path becomes
  a destination; unbalanced parentheses end one the same way, so `Budget (final).xlsx` is wrapped too.
  Archived 2026-10-01: graduate, now stated at src/domain/markdown-link.ts:1-6.

- [lesson] Do not file a picture by whether its placeholder survived. An inline image whose
  `[inline image: …]` marker the converter dropped was landing under **Attachments:**, which tells a
  reader to go and open a signature logo. It is part of the message however the pairing turned out,
  so it is shown after the text and counted under `inline_images`. The rule matters because the
  pairing fails for a reason outside our control: when `convert-mail-to-markdown` misreads a
  structured mail as a quoted chain it takes the placeholders with the body, and every picture in
  that message then arrives looking like an attachment.
  Archived 2026-10-01: graduate, now stated at src/domain/mail-body.ts:87-90.

- [gotcha] OCR text needs to say it is OCR, in words. A `>` block means quoted correspondence
  everywhere else in a mail vault, so a signature read off a logo reads as something a person wrote.
  It is not a theoretical risk: this vault has `LDER` for a logo saying ALDER and `AOOWE` for
  another. Every picture with readable text now carries one line saying the words were read
  by a machine and pointing at the image above it.
  Archived 2026-10-01: graduate, now stated at src/domain/inline-image.ts:53 (`READ_BY_MACHINE`).

- [gotcha] Check `my-quick-context` before diagnosing a slow or surprising run. A sync that had
  taken ninety seconds ran past an hour and wrote threads nobody recognised: the signed-in account
  had changed to another tenant whose mail is full of pasted screenshots, 113 of them against 5,
  each costing an OCR pass at some twenty seconds on a cold cache. Nothing in the code had changed
  that path's cost. One call would have said so in a second.
  Archived 2026-10-01: merge, into the `my-quick-context` entry (2026-08-30).

- [lesson] Measure before choosing a threshold. Asked to skip OCR on small pictures, the vault
  answered what small meant: everything OCR found real text in was 64 KB or more, a table screenshot
  at 104 KB and a signature block at 64 KB, and everything under ten kilobytes was a logo that came
  back as `pe` from one logo and `AOOWE` from another. Ten kilobytes put the larger of the two
  logo thirty-seven bytes on the right side of the line. A reading like that is worse than none,
  since it reads as text somebody wrote.
  Archived 2026-10-01: graduate, now stated at src/domain/conversion-plan.ts:117-122
  (`WORTH_READING` carries the measurement).

- [gotcha] `convert-local-file-to-markdown` refuses an image outright: "png is an image, read the
  file directly with a vision-capable model". Anything wanting words off a picture has to go to OCR
  itself, and the two places that decide what OCR actually said, a photo attachment and a picture
  inside a forward, have to agree that a page of whitespace is nothing. They share `wordsIn` now.
  Archived 2026-10-01: graduate, now stated at src/use-cases/convert-attachment.ts:192-193, with
  `wordsIn` at :165.

- [gotcha] Stryker's incremental mode writes its file by pretty-printing the entire report through
  `JSON.stringify`, in `reportAll`, after every mutant has already run. On a full sweep of 4,413
  mutants under Node that string throws `RangeError: Invalid string length`, so the gate burned
  twenty-five minutes and reported nothing. There is no flag to turn the mode off: `--incremental
  false` makes Stryker read `false` as a config filename, and `=false` is rejected outright. Only the
  config file can, and it should, since `mutate-changed.sh` and `mutate-staged.sh` delete the file
  before every run anyway and CI discards it with the checkout. The same path wrote 75 MB locally
  and succeeded, and that difference was never explained; the write was removed rather than
  understood, which is worth knowing if it ever comes back.
  Archived 2026-10-01: graduate, now stated at stryker.conf.json `_incremental_comment`.

- [gotcha] `gitleaks/gitleaks-action` asks an organisation repository for a paid licence key and
  fails without one. Install the pinned binary from the release instead; the asset URL was checked
  with a HEAD request before it went in, since a guessed version 404s in exactly the same way.
  Archived 2026-10-01: graduate, now stated at .github/workflows/ci.yml:30-36.

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

- [gotcha] The mutation gate scores the aggregate of the staged files, so a new module can sit well
  under 90 inside a passing run, and a big weak file can fail a run where everything else is fine. It
  took five rounds to get this one over the line: exact assertions instead of `toContain`, then the
  input shapes the fixtures never used (LF endings, unquoted parameters, a space-folded header), then
  simplifying the code so there were fewer defensive branches to kill in the first place. Read the
  per-file column, not just the total.
  Archived 2026-10-01: merge, into the mutation-aggregate entry (2026-08-30).

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

- [gotcha] A suite built entirely from `toContain` leaves a renderer's layout untested, and mutation
  is what says so. `global-report.ts` had eight passing tests and scored 67.74%: every survivor was a
  blank-line separator turned into a string, `join('\n')` turned into `join('')`, or `trimEnd` turned
  into `trimStart`. Each one changes the document a reader opens, and no fragment assertion could see
  any of them. One `toBe` against a whole small rendering killed all ten and took the file to 100%.
  Where the output IS a document, pin at least one complete example; keep the fragment tests for the
  scenarios they name, but never let them be the only thing holding the shape.
  Archived 2026-10-01: merge, into the whole-document entry (2026-08-30).

## 2026-08-27

- [gotcha] A PP-OCR recognizer can only emit characters its own dictionary holds, so the wrong
  `--ocr-lang` yields confident line noise rather than a failure. `en_PP-OCRv4` holds 95 characters,
  ASCII only, with no CJK and not one accented letter, which is why a Chinese announcement came back
  as `STARZE / 1. / 2.i / 3.A` while its front matter still claimed `ocr: rapidocr (en)`. Never
  assume a model covers a script: the dictionary is inside the ONNX file and takes one line to read,
  `ort.InferenceSession(path).get_modelmeta().custom_metadata_map["character"].splitlines()`.
  Sizes on this machine: `en` v4 95, `latin` v3 185, `latin` v5 502, `ch` v4 6623, `ch` v5 18383.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-27 (the rule is stated at
  src/domain/ocr-language.ts:1-5, the dictionary one-liner and the sizes are not).

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

- [mistake] A guard no mutant can kill is usually dead code, not a hole in the tests. Stryker put
  `ocr-language.ts` at 83.33% and one survivor was `if (written.length === 0) return false` sitting
  in front of a division that already yields `NaN` for that input, and `NaN` compares false. The
  guard changed nothing. Reformulating the comparison to multiply instead of divide
  (`ideographs > written.length * SHARE`) removed the guard AND made a second survivor, `>` mutated
  to `>=`, killable by the existing empty-text case, since `0 >= 0` is true where `0 > 0` is not.
  Two survivors and a line of code gone for one rewrite; only the third needed a new test.
  Archived 2026-10-01: merge, into the dead-code entry (2026-09-09).

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

- [mistake] A test whose subject has a fallback path can pass without ever exercising its subject.
  Every inline-image identity test used one candidate picture, so the one-to-one last resort produced
  the right pair whatever the matching returned: green tests, 28 surviving mutants, 65% on a new
  module. Two candidates in the fixture is what makes an identity match the only explanation for the
  result. Mutation testing found this; coverage was already 100%.
  Archived 2026-10-01: merge, into the only-explanation entry (2026-08-30).

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

- [gotcha] The mutation gate compares the AGGREGATE against the break threshold, not each file. A new
  module can sit under 90 while the run passes. Worth checking the per-file column after adding one:
  `icalendar.ts` first landed at 73.6% inside a passing run.
  Archived 2026-10-01: merge, into the mutation-aggregate entry (2026-08-30).

- [gotcha] The commit-size gate is 10 files AND 300 lines, and a step that touches a domain module
  plus its wiring will breach one of them. Splitting by file works when the new module has no caller
  yet: commit the pure part first, the wiring second. Three of the eight steps here needed it.
  Archived 2026-10-01: merge, into the commit-size entry (2026-08-30).

- [gotcha] `expect([undefined]).toEqual([])` PASSES in Bun. Verified in isolation, not inferred: an
  array holding one `undefined` satisfies an assertion that it is empty. Three assertions in
  `shared-site.test.ts` read as "nothing came back" while a stray `undefined` would have satisfied
  them, which is why a guard clause (`if (site === undefined) continue`) survived mutation with the
  whole condition replaced by `false`: the mutant pushed `undefined` into the result and every test
  still agreed. `toHaveLength(0)` beside the `toEqual` is what kills it. Anywhere a function can
  return `undefined` into a collection, pin the count as well as the contents.
  Archived 2026-10-01: merge, into the `toEqual` entry (2026-09-26).

- [mistake] Estimated a parallelisation win from timings taken by shelling out to the CLI, and was
  wrong by an order of magnitude. `bunx ask-marcel-office list-accessible-drives` measured 39s and
  `search-all-accessible-sites` 10s, so running them together looked like it would take a minute
  down to forty seconds. In-process, through the library with a warm token and connection, the whole
  listing was already 33s and became 30s: about 10%, not 50%. A process-spawn measurement carries
  cold auth and module loading that the real call path does not pay. Time the code as it actually
  runs before promising a number, or promise no number.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-27 (635 bytes).

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

- [gotcha] `disambiguateSegment(name, id)` takes the first 8 characters of the id, which
  disambiguates nothing when ids share a prefix, and Graph ids do. Every item in one drive starts
  `01W25LGY...`, and a site id is `<tenant>.sharepoint.com,<guid>,<guid>`, so two sites in the same
  tenant agree for the first 20-odd characters. Two same-named sites would have landed in the same
  folder either way, which is the bug the suffix was added to fix. `siteIdHash` (sha256, in
  `src/domain/site-state.ts`) is what makes the suffix distinguishing. Hash before slicing whenever
  a shared-prefix identifier is the source of a short suffix.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-14 (the site case is stated at
  src/domain/site-state.ts:107-110, the general rule is not, and one call site breaks it).

- [gotcha] Deleting well-tested code can fail the mutation gate even when nothing newly written is
  weak. Moving the day-folder logic out of `thread.ts` dropped the aggregate to 89.67% against a
  break threshold of 90, though every line written that day was mutation-clean: the removed block was
  the well-covered share of that file, so what remained (subject trimming, the header-line anchor,
  participant sorting) became a much larger fraction of a smaller file and its PRE-EXISTING debt
  surfaced. The fix is tests for the debt the deletion exposed, not for the change itself: 4 tests in
  `output-paths.test.ts` (88.10 -> 97.62%) and 4 in `thread.test.ts` (85.86 -> 88.89%) brought the
  aggregate to 90.59%. Expect this on any commit that removes a tested block from a mixed-coverage
  file, and read the per-file table before assuming the new code is at fault.
  Archived 2026-10-01: merge, into the mutation-aggregate entry (2026-08-30).

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

- [gotcha] RapidOCR's dotted-path params take enum members, never strings.
  `RapidOCR(params={"Rec.lang_type": "en"})` raises `TypeError: The value of Rec.lang_type must be
  Enum Type.`; it needs `LangRec("en")` from `rapidocr.utils.typings`, which is what
  `src/infra/rapidocr-run.py` does. `Cls.lang_type` has to be left at its default: RapidOCR's own
  `default_models.yaml` ships only a `ch` classifier, so overriding it fails at construction. `Det`
  has both, but the shared detector locates Latin-script text fine, so only `Rec` is set. Simplifying
  that file back to a plain string breaks OCR at engine construction, before an image is ever read.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-14 (the classifier half is stated
  at src/infra/rapidocr-run.py:7-9, the enum half is not).

- [gotcha] Slide or PDF markdown that arrives as one run-on wall of text with no spaces between words
  comes from upstream's PDF text extraction (`unpdf`, inside ask-marcel-office-cli), not from
  anything here. Checked against a real synced file: line 12 was 34,252 characters on a single line.
  The only whitespace folding in this repo is `front-matter.ts` `/\s+/g -> ' '` applied to front
  matter *values*; a document body goes through `withFrontMatter` untouched. Do not look for the
  cause in `convert-file.ts` or `kb-document.ts`. A fix belongs in the library, or in a
  post-extraction word-splitter this repo does not have and has not been asked for.
  Archived 2026-10-01: tighten, rewritten in place under 2026-08-14 (650 bytes).

## 2026-07-26

- [gotcha] A batch rename across test fixtures can collide with a real identifier that happens to
  share the same substring. Renaming the "Espace Northwind" site-name fixture to "Espace Contoso" across
  21 test files, `build-deps.test.ts` also held `KB_LOG_LEVEL`/`KB_ROOT`, the actual env
  var names read by `config.ts` and documented in `README.md`. A blind find-and-replace would have
  renamed those too, breaking the test without touching the production contract to match. Before a
  batch string rename, grep the substring together with its neighbours (here `KB_`) to separate
  fixture text from something that is actually a contract, then handle the contract as its own
  confirmed change.
  Archived 2026-10-01: tighten, rewritten in place under 2026-07-26 (686 bytes).

- [decision] Landing a branch whose commits already fit the pre-commit size gate (10 files / 300
  lines) onto a `main` that has diverged, with files touched on both sides: rebase onto the new
  `main` tip rather than making one merge commit. A single merge commit carries the whole branch's
  cumulative diff and re-trips the same size gate every original commit already respected; rebasing
  replays the original commits one at a time, so only the commit(s) that actually touch a conflicting
  file need conflict resolution, and every replayed commit still lands under the gate. `git merge
  --no-ff --no-commit` first is a cheap way to see the true conflict set before choosing rebase, then
  `git merge --abort` and rebase for real.
  Archived 2026-10-01: merge, into the commit-size entry (2026-08-30).

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

- [gotcha] The big use-case files carry pre-existing sub-90% mutation debt (run-sync ~81%, sync-site
  ~86%, convert-file/convert-attachment/render-thread ~85-88% before cleanup). The scaffold's
  "90.77%" is the all-files aggregate, lifted by many 100% domain files; `mutate:changed` gates on
  the aggregate of the *changed* files only, so touching a single large use-case file often trips the
  90 break threshold even when the change itself is mutation-clean. Budget for either cleaning the
  file to 90 or tracking the debt; the survivors are mostly unkilled guard clauses (`if (!x.ok)`
  mutated to `if (false)`), logger-payload object literals mutated to `{}`, and `?.` optional chains.
  Archived 2026-10-01: merge, into the mutation-aggregate entry (2026-08-30).

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
  Archived 2026-10-01: tighten, rewritten in place under 2026-07-24 (six long sentences; the
  percentages are history).

- [gotcha] Splitting a one-line `if (!saved.ok) return saved` into a multi-line block (here to add a
  `deps.progress.done()` before the return) drops line coverage even though behaviour is unchanged:
  Bun counts a one-line `if` as covered the moment it executes, condition false every time, but once
  the body is on its own lines those lines are tracked separately and read as uncovered because the
  true branch was never taken. A mechanical refactor can therefore fail the 100% use-case gate. To
  cover the window-save failure in `sync-mailbox` `drainQueue` (and `sync-site` `processQueue`), load
  a resumed state with `pending` already set: `queueWork` returns early without its own save, so the
  window save is the first write and `files-fake` `failWriteWith` makes it fail, reaching the branch.
  Archived 2026-10-01: tighten, rewritten in place under 2026-07-24 (791 bytes).

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
