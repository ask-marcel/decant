# LESSONS

Append-only session memory. Three kinds of entry: `[mistake]`, `[decision]`, `[gotcha]`.
Never edit or delete a past entry; supersede it with a new `[decision]`.
A compaction pass retires entries into `lessons.archive.md`, verbatim and with the reason.

## 2026-07-23

- [decision] A conversation records no folder in its front matter. A thread spans folders by nature
  (the question sits in Inbox, the answer in Sent Items), so naming one of them would mislead.

- [mistake] `--site-id` filed a site under its raw id instead of its display name, quietly building
  a second knowledge base for a site already synced. Anything used as a folder name must be
  resolved to the name the source itself uses before it reaches the filesystem.

## 2026-07-24

- [gotcha] ask-marcel-office-cli 2.3.0 is breaking under a minor version bump. It removed all 77
  flag aliases and 4 deprecated command names, and every command now hard-refuses a parameter it
  does not declare, returning `validation_error` with code `unknown_parameter` where the library
  surface used to silently strip the key and return data that looked like it had obeyed. Calls that
  already used one canonical command name and one specific id flag each were untouched; anything on
  an `--id`-style alias would have broken. Pin-read the CHANGELOG on any future bump of this package.

- [gotcha] `crypto.subtle.digest('SHA-256', bytes)` fails typecheck under this repo's TS: a plain
  `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which is not assignable to `BufferSource` (the
  SharedArrayBuffer case), and it is async besides. `new Bun.CryptoHasher('sha256').update(bytes)
  .digest('hex')` is synchronous, allocation-free, and typechecks. Prefer it for hashing in this Bun
  repo (`src/domain/content-hash.ts`).

- [gotcha] A per-iteration save-guard in a loop that also saves at the end survives mutation to
  `if (false)` when the fake fails every write, since the run fails either way. In `sync-site`
  `processQueue` and `sync-mailbox` `drainQueue` the observable is how much work was attempted: seed
  two pending items at `concurrency: 1` under `files-fake` `failWriteWith` and assert exactly one
  `convert.failed` was logged. The six `add` `+`->`-` survivors there are equivalent (`add` is
  applied to `EMPTY` twice, so `0 - (0 - n) === n`); leave them unless `add` is refactored.

- [gotcha] Splitting a one-line `if (!saved.ok) return saved` into a block drops line coverage with
  behaviour unchanged: Bun counts a one-line `if` as covered once it runs, but a body on lines of
  its own reads as uncovered until the true branch is taken, which can fail the 100% use-case gate.
  To reach the window-save failure in `sync-mailbox` `drainQueue` or `sync-site` `processQueue`,
  load a resumed state with `pending` set, so `queueWork` returns early without its own save and
  `files-fake` `failWriteWith` fails the window save.

## 2026-07-26

- [gotcha] A batch rename across test fixtures can hit a real identifier that shares the substring:
  renaming a site-name fixture across 21 test files would also have renamed `KB_LOG_LEVEL` and
  `KB_ROOT` in `build-deps.test.ts`, the env vars `config.ts` reads and `README.md` documents. Grep
  the substring with its neighbours (here `KB_`) before a batch rename, and change anything that is
  a contract as its own confirmed step.

## 2026-08-14

- [gotcha] `disambiguateSegment(name, id)` suffixes the first 8 characters of the id, which tells
  nothing apart when ids share a prefix, and Graph ids do: every item in one drive starts
  `01W25LGY...`, and two sites in one tenant agree for the first 20-odd characters. Hash before
  slicing whenever a shared-prefix identifier feeds a short suffix, as `siteIdHash` in
  `src/domain/site-state.ts` does for sites and notebooks.

- [gotcha] RapidOCR's dotted-path params take enum members, never strings:
  `RapidOCR(params={"Rec.lang_type": "en"})` raises
  `TypeError: The value of Rec.lang_type must be Enum Type.` at engine construction, before an image
  is ever read. `src/infra/rapidocr-run.py` passes `LangRec(...)` and `OCRVersion(...)` from
  `rapidocr.utils.typings`; simplifying either back to a plain string breaks OCR.

- [gotcha] Slide or PDF markdown that arrives as one run-on wall of text with no spaces between
  words comes from the PDF text extraction inside ask-marcel-office-cli (`unpdf`), not from here: a
  real synced file held a 34,252-character line 12. The only whitespace folding in this repo is
  `front-matter.ts` `/\s+/g -> ' '` on front matter values, and a body goes through
  `withFrontMatter` untouched, so the fix belongs in the library.

## 2026-08-27

- [gotcha] A PP-OCR recognizer can only emit characters its own dictionary holds, so a model without
  the script yields confident noise rather than a failure: `en_PP-OCRv4` holds 95 ASCII characters
  and read a Chinese announcement as `STARZE / 1. / 2.i / 3.A`. The dictionary is inside the ONNX
  file and takes one line to read:
  `ort.InferenceSession(path).get_modelmeta().custom_metadata_map["character"].splitlines()`. Sizes
  on this machine: `en` v4 95, `latin` v3 185, `latin` v5 502, `ch` v4 6623, `ch` v5 18383.

- [decision] `ThreadRecord.attachments` records what the messages carried, not every file the run
  wrote for them. Pictures taken out of a document, and a raw file written beside its markdown, are
  in the shared store record instead, which is what dedupe reads. The rule is that the record mirrors
  what a reader sees in the front matter; the store holds the whole production.

- [mistake] Estimated a parallelisation win from CLI timings and was wrong by an order of magnitude:
  `bunx ask-marcel-office list-accessible-drives` took 39s and `search-all-accessible-sites` 10s,
  which promised about half, but in-process through the library, with a warm token and connection,
  the listing went from 33s to 30s. A spawned process pays cold auth and module loading that the
  real call path never does, so time the code as it actually runs before promising a number, or
  promise none.

## 2026-08-28

- [mistake] A parser tested with fixtures I wrote myself is tested against my idea of the format, not
  the format. The MIME boundary was escaped into a pattern and the escaping was wrong; every fixture
  used `BOUND` or `B`, so the tests passed for a parser that would have broken on the first real
  Outlook message, whose boundaries carry `.` and `+`. When a value comes from somewhere else, put
  what that somewhere else actually sends in the fixture.

## 2026-08-30

- [gotcha] Fragment assertions leave a document's shape untested. A `global-report.ts` suite built
  from `toContain` scored 67.74% with every survivor a blank-line separator turned into a string,
  `join('\n')` turned into `join('')`, or `trimEnd` into `trimStart`, and `toContain('- name')`
  cannot tell a bare list entry from one with a suffix appended (five survivors in
  `zip-manifest.ts`, two in `thread-card.ts`). Where the output IS a document, pin at least one
  complete rendering with `toBe`, and keep the fragment tests for the scenarios they name.
  Merges: 2026-08-28, 2026-08-30.

- [mistake] A test passes without testing its subject when something else explains the result. Every
  inline-image identity test used one candidate picture, so the one-to-one fallback paired them
  whatever the matching returned (green tests, 28 surviving mutants, 65%). The first `mail-meta`
  sort test used `'1234567890'` and `'ffff000000'`, and JavaScript hoists an integer-like key to the
  front of an object whatever order it was built in, so the test passed with no sort at all. Build
  the fixture so the subject is the only explanation: two candidates, keys that are not integer-like
  inserted in reverse.
  Merges: 2026-08-27, 2026-08-30.

- [gotcha] `eslint --cache` reports findings against paths that no longer hold them. Several rounds
  went into a `prettier/prettier` warning attributed to `mail-meta.test.ts` that actually lived in
  `mail-meta.ts`, and `--fix` on the named file changed nothing because nothing there was wrong.
  When a warning points at a file you have already corrected, re-run with `--no-cache` before
  believing the location.

- [decision] `internetMessageHeaders` IS honored on `list-conversation-messages --select` (verified
  live), and the per-conversation `get-mail-message` call stays anyway: the header read happens in
  the sweep, off delta data, before any conversation has been fetched, so there is no call to fold
  it into. Both cost one call per conversation, and `get-mail-message` returns one message's headers
  (~4 KB) where the conversation call returns every message's (~120 KB on a 30-message thread).
  Check which call is actually made at that point in the run before folding anything into it.

- [decision] Shared mailboxes are not reachable through this CLI and the sync will not chase them.
  The `/users/{id}/...` commands exist but need the delegated `Mail.Read.Shared` scope, which
  neither token the CLI can obtain carries, across two tenants: the ceiling is Microsoft's app
  registration, not something a tenant admin can grant. Outlook on the Web is not a way round it
  either, since the token holding the shared-mail scope is bound to an Exchange audience the CLI
  cannot call. Treat those commands as present but inert; they answer `ErrorAccessDenied`.

- [gotcha] `list-groups` returns every group in the TENANT, not the ones the signed-in user belongs
  to, so the obvious first call hands back groups that then answer `ErrorAccessDenied` on any read.
  That reads like a permissions bug and is not one. `list-joined-teams` gives the groups the user is
  actually in: three here, against a tenant list still paging after ten.

- [gotcha] Concurrency 4 is proven clean against real mail (169 threads, 169 documents, no thread id
  in two folders), and only a run that CREATES threads could have shown it, since a re-run over
  threads already written writes nothing. Run a test like that into a scratch `KB_ROOT` with the OCR
  cache symlinked in, which keeps it off the real vault and off a cold cache.

- [decision] A state record written before a field existed is treated as unseen rather than
  migrated: a picture's `AttachmentRecord` from before `text` holds no reading, so it costs one
  extra fetch and repairs itself (`thread-files.ts:141`). Prefer that shape to a state version bump
  whenever the repair is cheap, since a bump makes every user rebuild for a field most of them could
  refill in a second.

- [gotcha] The same note can be right in one place and wrong in another. `_No text could be read
  from this file_` is what a document holding nothing has to say; quoted under a picture in a thread
  it tells the reader to open a file that no longer exists, once per signature down a long thread.
  A converter that returns text rather than a document has to drop it.

- [gotcha] The mutation gate breaks on the aggregate of the files it mutates, never per file. A new
  module can sit well under 90 inside a passing run (`icalendar.ts` landed at 73.6%), and one large
  use-case file carrying old debt can fail a run whose own change is mutation-clean. Deleting
  well-tested code does it too, since the removed block was the covered share and the rest of the
  file surfaces its debt: moving the day-folder logic out of `thread.ts` took the aggregate to
  89.67%. Read the per-file row and treat that file's number as the gate; the aggregate only says
  the others are carrying it.
  Merges: 2026-07-24, 2026-08-14, 2026-08-27, 2026-08-28, 2026-08-30.

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

- [gotcha] The commit-size gate is 10 files AND 300 lines. A step touching a domain module and its
  wiring splits as the pure module first, while it has no caller, and the wiring second; a branch
  lands by rebase rather than one merge commit, which carries the whole cumulative diff and trips
  the gate every original commit respected (`git merge --no-ff --no-commit`, then
  `git merge --abort`, shows the real conflict set first). A mass move cannot be split under it,
  since 690 moved lines count some 750 however the commits are cut, so it takes `--no-verify` after
  lint, typecheck, the suite, coverage and mutation have run by hand, said in the body.
  Merges: 2026-07-26, 2026-08-27, 2026-08-30.

- [lesson] Splitting a test file is not the same as splitting the code. The four thread modules got
  their own test files but kept ONE harness, because what each of them does is only visible in the
  documents a whole run writes: a card names a file the placement chose, and a body links a card the
  writing made. Narrower fakes per module would test the seams between them rather than the vault
  they produce. Mutation is scored per source file whatever drives it, so the measurement was never
  the reason to split the tests; readability was.

- [gotcha] An untested error path looks exactly like a covered one. `convert-file.ts` sat at 89.07
  with line coverage at 100: every `if (!x.ok) return failure(x.error)` could be deleted outright
  and the suite still passed, because no test ever made `x` fail. Two seeds, a workbook and an
  invitation the source refuses, put it over 90. Coverage says the line ran; only mutation says the
  line mattered.

- [gotcha] Substituting a multi-line block for an inline placeholder breaks whatever span held it.
  `convert-mail-to-markdown` carries the surrounding HTML's emphasis onto its placeholder, so a
  picture in a bold signature arrives as `**\[inline image: logo.png\]**`. That was harmless while
  the replacement was one line; once the OCR reading went under the picture it was three blocks, and
  the opening marker stranded itself on the image line while the closer landed after the quote.
  Seven of them in one seven-day vault, all one sender's signature. Worth checking the next time a
  replacement grows from a line to a block: the question is not whether the new text is right, but
  what was wrapped around the old.
  Attributed upstream first and it was ours. Before writing a bug report, check whether the input
  was fine until our own output changed shape.

- [lesson] A message a person reads has to say which and why, not just that. "a kind of file this
  tool does not read" appeared fourteen times in one seven-day report and covered two situations
  wanting different answers: a kind we know and decline to convert, worth revisiting, and a name
  with no extension at all, where nothing could have been done. Naming the extension, or saying
  there is none, turned a wall of identical lines into something a reader can act on. The same
  applies to the front matter: `original:` named the file beside a card and a reader still had to
  retype the path, so the card links it.
  Describe the file at the SOURCE, not the words a message linked it under: a message can point at
  a recording calling it `Rapport.docx`, and the reason would then name a kind that was never there.

- [lesson] A report earns attention only if everything in it deserves attention. Two decisions had
  drifted apart: a notification icon was dropped from the thread as decoration, then reported as
  something that did not reach the knowledge base. One run's report was fourteen lines, all false
  positives, thirteen icons and a shared folder, with nothing lost in any of them. Whatever is
  deliberately ignored has to be ignored everywhere, or the report is noise on the day something
  real lands in it. Ask of every line: would a reader do anything about this?

- [gotcha] `--since` bounds the sweep, not the folder date. A thread whose first message is from
  April but which had activity inside the window is filed under April, because the folder is named
  from the first message and frozen there. That is correct and looks wrong in a directory listing.

- [gotcha] Check `my-quick-context` before diagnosing a slow or surprising run, since the signed-in
  account can change: a sync that took ninety seconds ran past an hour because the account had moved
  to another tenant whose mail held 113 pasted screenshots against 5, each an OCR pass. The account
  also sets the day: a thread's folder is dated in the `--timezone` zone (default: this machine's)
  and frozen at creation, and `my-quick-context` reports the tenant zone in Windows spelling, which
  `--timezone` refuses, so the mapping is a human step (Romance Standard Time is `Europe/Paris`).
  Ask per run rather than carrying an answer forward.
  Merges: 2026-08-30, 2026-08-30.

- [gotcha] A unit test proves the function, never the call. `withoutPlaceholders` was written, tested
  and never called: the edit meant to wire it into `rewriteMessageBody` missed its anchor because
  prettier had collapsed the array onto one line, and the function's own tests passed regardless. The
  suite stayed green, the mutation gate stayed green, and a re-sync left the ten markers exactly
  where they were. Counting the vault afterwards is what caught it. Wiring a new transformation in
  needs one test at the level of the thing that should USE it, and the proof it works is that
  removing the call turns a test red. Two of the tests it turned red were asserting the old
  behaviour, which is how you know the call was doing something.

- [lesson] A capability wired in one place and not its mirror is the shape this codebase keeps
  producing. The safelink unwrapping went into thread bodies and not card bodies, so a signature sat
  in a card at six hundred characters a line beside a thread that read cleanly. OCR went into the
  inline-image path and not into the parts of a saved email, so a signature block was read when its
  owner mailed you and silent when somebody forwarded them. Both times the rule belonged to "text
  that came out of mail" and was applied to one of the places such text lands. When adding one, list
  every route the same content can arrive by before calling it done.

- [gotcha] The OCR cache is keyed by content hash alone, so it is shared by every mailbox synced on
  this machine and cannot be cleaned per account. What can be identified is what the current vault
  does not reference: 115 of 123 entries after a run against another tenant. That also drops
  readings for mail outside the current `--since` window, which costs one pass each if that mail
  comes back into range. It survives `rm -rf kb/Mailbox`, which is why a killed sync loses no OCR.

- [gotcha] CI had never run on this code before the day it went public, and its first four failures
  were all first contact rather than regressions: `gitleaks` absent from the runner, one error that
  only the strict type-aware lint sees, thirteen fixable CVEs, and a mutation sweep that ran every
  mutant and then died writing its report. None of them showed locally because none of the local
  gates are the CI gates. `bun run lint` is the cached ordinary pass and `lint:strict` is what CI
  runs; `mutate:changed` scores a file or two and `mutate` on main scores ninety. Run the CI
  variant before the first push, not the local one.

- [lesson] Read the stack trace before changing anything. The first fix for the sweep crash dropped
  the html reporter on the theory that serialising a report is a reporter's job; the trace had said
  `MutationTestReportHelper.reportAll` and `JSON.stringify` all along, and a second twenty-five
  minute run was the price of not reading it. The second fix invented a flag that does not exist and
  cost a third run. Two runs and fifty minutes bought by a guess and a habit.

- [gotcha] A source can report one condition two ways, as an empty answer or as a refusal, and code
  that handles one will not handle the other. `convertPdf` fell back to OCR when a PDF's text came
  back empty, which is the entire reason the OCR-PDF work exists, and still reported a genuinely
  scanned PDF as failed: the library answers that case with a 415 and a message, never with an empty
  body, so the fallback was unreachable for the only file type it was written for. Nothing looked
  wrong from inside, since a failed file reads as an unlucky file rather than as a dead branch, and
  it took a real library and one appendix sitting beside its converted siblings to show it. When
  adding a fallback, check what the source actually does in the case the fallback is for, rather
  than what an absence of data would look like.

- [gotcha] A fake that answers whatever it is handed will keep a dead feature green. The OCR fallback
  for scanned PDFs passed its tests from 24 July to 6 September and had never read one: `pdfText`
  gave the reader the PDF's own path, and RapidOCR loads through PIL, which refuses a PDF outright
  with `UnidentifiedImageError`. The OCR fake returns text for any path at all, so every test agreed
  the feature worked, and the one thing the fake could not say is that its real counterpart takes
  pictures and nothing else. It surfaced only because a real library held a scanned appendix and the
  file came out holding the note instead of its own text. The trap is open wherever a fake is keyed
  by a path or an id it never validates: those tests prove the wiring, not that the adapter can do
  what it was asked. The fix was to read the pages, one image per page out of
  `extract-drive-item-images`, which is what OCR can actually open.

## 2026-09-08

- [gotcha] A checkpoint that advances past work it has not confirmed loses that work in silence. Both
  halves of this sync saved a Graph cursor before the conversion or the render it covered: `sync-site`
  wrote `deltaLink` when the sweep returned, `sync-mailbox` wrote every folder cursor in `finishQueue`,
  and both then sliced a window off `pending` whether each item had succeeded or not. A delta only
  reports what changed, so the failed item was unreachable from that moment on, and the only way back
  was deleting `deltaLink` by hand to force a full re-sweep. The report meanwhile said "will be tried
  again on the next run" and the next run said `0 failed`, which is the worst pairing available: a
  promise, and a clean bill of health covering the thing it promised about. Wherever a cursor moves
  past work, the record of what that work left unfinished has to move with it, in the same write.

- [decision] Every failed conversion is retried, capped at three attempts, rather than routed by
  error kind. `DriveReaderError` does distinguish `transient`, `throttled`, `permanent` and
  `unrenderable`, but `ConvertOutcome.failed` flattens whichever one it was into a `"kind: message"`
  string, so a kind-aware policy means threading a new field through `convertFile`,
  `convertAttachment` and `renderThread`. Against that: the kind of the failure that prompted this
  work was never established, so a policy that gives up on `permanent` might not have brought back
  the one file it was written for. A flat cap costs at most two pointless calls spread over two later
  runs and needs no new information anywhere.

- [gotcha] A record that brings lost work back has to live at the level the queue is keyed on, not at
  the level of the thing that failed. The plan for a failed attachment inside a thread that otherwise
  rendered named two shapes, and the finer one turned out not to exist: a per-attachment record could
  not get its thread re-queued, because the folder cursors had advanced when the thread's messages
  were swept and the thread-level ledger is the only thing that reaches a thread afterwards. The
  document had to be rewritten to carry the recovered file's card in any case, so the finer shape
  would have saved the other attachments' conversions and nothing besides. Worth checking before
  designing a partial-retry: whatever re-queues the work sets the smallest unit that can be retried,
  and everything below it re-runs whether or not it needs to.

- [gotcha] Code written for a case nothing can yet reach is untested by construction, and it was
  wrong here. `drainQueue` dropped a per-run given-up note in two places, `givenUp: notes.givenUp` in
  the window fold and a final line that replaced the list rather than adding to it, both written in
  8f38b2c when only the ledger produced such notes and no render could. Coverage was 100% and
  mutation 92% over those very lines, because a mutant that drops an always-empty list changes
  nothing observable. What found it was the first test that produced a note through that path, which
  is the only thing that could have. When adding a field that nothing fills yet, either fill it from
  something or leave it out until a caller exists.

- [decision] Where a source cannot do what its sibling does, the adapter answers honestly and the
  gap goes upstream, rather than a local workaround. Group posts lacked the PDF, picture and link
  commands mail has, so the adapter returned `unrenderable` or an empty list with the reason beside
  it and `docs/request-group-post-parity.md` asked for them; when 2.6.0 landed all three, wiring
  them took three method bodies in `group-reader-marcel.ts` plus one test, because the honest
  answers had kept the shape of the real ones. Return the shape the real answer will have, say why
  in the error, and file the request.
  Merges: 2026-09-08, 2026-09-08.

## 2026-09-09

- [decision] A delta endpoint is not automatically the incremental answer, and the thing to check
  before designing a state around one is what its response can actually carry. Microsoft To Do has
  `list-todo-tasks-delta`, and the first shape for this sync was built on it, the way the mailbox is.
  Its zod schema turned out to be `{ todoTaskListId }` and nothing else, so it takes no `expand`,
  and a task's steps and linked resources are navigation properties Graph omits unless expanded. The
  delta would therefore have discovered which tasks changed and then cost one `get-todo-task` per
  task to learn what each one holds. The plain listing takes `expand` and pages normally, so reading
  the list whole is fewer requests than a delta plus a fetch per changed task, needs no cursor in the
  state at all, and reports a deletion by absence on every run rather than on the single run a delta
  reports its removal. Cheaper, smaller, and more robust, by not using the endpoint built for the
  job. The general form: a delta tells you WHAT changed, not what the thing now IS, and when those
  differ the listing usually wins.

- [gotcha] A survivor no test can kill usually marks dead code, not a missing test. A guard in front
  of a division that already yields `NaN` (`ocr-language.ts`), a stamp every card overwrote
  (`render-thread.ts`), the fields and guards a deleted store left behind, and a `?? ''` behind a
  lookup over the very items that built the map (`syncTodo`) all survived for that reason. Remove
  the code, or reshape it so the question cannot be asked (hand back `{ task, file }` pairs rather
  than an index to look up), instead of writing tests for a path nothing reaches; a field that seems
  untestable either reaches disk on some path or is dead.
  Merges: 2026-08-27, 2026-08-30, 2026-08-30, 2026-09-09.

## 2026-09-11

- [mistake] Proved the tree and landed something else, twice. After `git merge --no-commit` the
  reconciliation edits stayed unstaged, so the gates passed on disk while `main` got a
  `sync-group.ts` that did not typecheck for four commits; and a landing split into "the consumer
  gains a dependency" then "the composition supplies it" passed the hook twice, since the hook
  typechecks the working tree, and left a commit that does not compile. Run `git add -A` before the
  gates, and before pushing build every commit of the landing in a detached worktree
  (`git worktree add --detach <dir> <sha>`, a symlinked `node_modules`, `tsc` and `bun test` per
  sha). A split that cannot compile alone is folded into one commit, with the size-gate bypass
  explained in the body.
  Merges: 2026-09-08, 2026-09-11.

- [decision] A source reachable only through an endpoint whose token expires without a browser
  sign-in is not a source `update` can own. Teams chats were built to the use-case test on the
  library's Microsoft-internal substrate commands, both of which answered on the day; the next
  morning the substrate token had lapsed while the Graph token beside it was still good, and the
  library refreshes the one and not the other. Every scheduled `update` would have failed on that
  one category, forever, until a person logged in again. The work is parked on `teams-chats-wip`
  and Teams channels, which 2.7.0 landed on Graph the same day, took the place. The general form:
  before building a category, check not only that a read works but that it will still work
  tomorrow without anyone at the keyboard, since `update` is the run that matters.

## 2026-09-12

- [gotcha] A new source kind that borrows another kind's id collides everywhere ids are held
  together, and nothing fails loudly. A site's lists are keyed by the site's own id, the same id
  its libraries are keyed by, and two maps in the tree key by id alone: the picker's synced marks
  (`syncedMarks`) and the global report's untouched tail (`touched.has(source.id)`). With the
  lists wired in, a site synced for its libraries would have shown as synced for its lists, and a
  lists run would have struck the site's libraries off the tail as if they had run. Neither is a
  crash; both are a lie in the output. `sourceKey` in `sync-state.ts` (`lists:<siteId>` for the
  lists, the id alone for everything else) is what every such map now keys by, and `sourceLabel`
  names the run `<Site> (lists)` beside `<Group> (group inbox)`. When a kind shares an id with
  another, grep for every `source.id` lookup before wiring it in.

- [gotcha] Graph's `hidden` and `readOnly` column flags do not catch every column nobody filled
  in. A live run over one real list showed `Content Type` and `Attachments` in the table beside
  the project columns: `ContentType` is flagged neither hidden nor read-only and is filed under
  the `_Hidden` column group instead, and `Attachments` is a plain editable flag the list keeps
  for itself. The rule now hides the group and names the column. The general form: for a category
  whose output is a projection of what Graph flags, render one real item and read the header
  before trusting the flags, since the probe showed the flags and not what they missed.

## 2026-09-19

- [mistake] A mutation run opened the browser to sign in, over and over. The wired tests in
  `build-deps.test.ts` faked every reader but the mail reader, which nothing in those tests
  reached, and their config said `interactive: true`, which nothing in those tests needed. Under
  Stryker every mutant of `run-sync.ts` runs the whole suite, and a mutant that flips `if
  (known.value.some(kind === 'mailbox'))` to `if (true)` sends the `update` test into the real
  mail reader, whose first Graph call opens a sign-in browser. One unfaked reader is one line
  away from being reached, and mutation is what walks that line. Two fixes, both kept: every
  `buildDeps` override site now fakes all ten readers (the earlier lesson on auditing every call
  site, applied to readers this time), and the test config is `interactive: false`, so a reader
  left real by a future test fails fast instead of asking a person to sign in. Rule: a test
  that wires the real composition is interactive never, and fakes every port that touches the
  network, not only the ones the scenario reaches.

## 2026-09-26

- [gotcha] Format with `bunx eslint --fix`, never `bunx prettier --write`. The Prettier options
  (single quotes, 180 columns) live in `eslint.config.js` as the `prettier/prettier` rule, and the
  repo has no `.prettierrc`, so bare Prettier formats with its defaults: double quotes, 80
  columns. Re-running ESLint puts the quotes back but not the layout, because Prettier keeps an
  object literal multi-line once it breaks after the opening brace; one stray run turned a
  250-line test diff into 1,200 lines and the file had to be restored and re-patched.

- [gotcha] Bun's `toEqual` ignores `undefined` array items and properties, so
  `expect([undefined]).toEqual([])` passes, and so does `toEqual({ ok: true, value: [] })` on a list
  holding a hole. Guard clauses and filters that keep `undefined` out of a result survived mutation
  three times for this (`shared-site.test.ts`, `listSyncedSources`, and a value remembered as
  `undefined`). Where a test asserts that nothing came back or that something was filtered out, pin
  the count with `toHaveLength(0)`, use `toStrictEqual`, or assert a mapped projection where a hole
  shows up as `undefined`.
  Merges: 2026-08-27, 2026-09-08, 2026-09-26.

## 2026-09-29

- [gotcha] Outlook keeps only the last few generations of a mail folder's sync state, and every
  delta read of the folder most likely moves it on, whether or not decant saves the new cursor.
  After two dry-run `update`s and a few read-only page-size probes on 2026-09-28, the next real run
  got a 410 `SyncStateNotFound` (`generation=74; [highest=77]`) and the whole mailbox failed. A dry
  run or a probe against the real mailbox is therefore not free: it ages the cursor the next real
  run depends on. `firstPage` in `sync-mailbox.ts` now reads the folder afresh on that 410 (any
  other refusal still ends the mailbox run), so an aged cursor costs one folder re-read, not the
  mailbox.

- [decision] `update` carries on past a source that fails: it prints the source and the step it
  failed at, lists it as failed in `kb/_sync-report.md`, moves on to the next source, and still
  exits 1 at the end. Before, the first failure ended the run, so one broken source (a Loop
  workspace that resolved to no library) left every source after it stale. Two cases still stop
  the run: a lapsed sign-in (`SIGNED_OUT`, an `auth` error), since every later source would fail on
  the same token, and the picker's runs (`runMany`, `runInTurn`), which were kept stopping at the
  first failure when this scope was chosen. Applies to any new error kind: decide whether it breaks
  one source (carry on) or all of them (stop, like `auth`).
