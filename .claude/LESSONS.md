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

- [gotcha] A file too big to score is a file too big to trust: `render-thread.ts` reached 692 lines
  doing five jobs and crossed under 90 on three of four changes in one session, each time pulled
  back by tests written against whatever survived. Splitting it into its jobs put every piece over
  90 on its own, made each survivor attributable to one module, and turned up three pieces of dead
  code.

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

- [decision] The four thread modules got their own test files but kept ONE harness, because what
  each does is only visible in the documents a whole run writes: a card names a file the placement
  chose, and a body links a card the writing made. Narrower fakes per module would test the seams
  between them rather than the vault they produce; mutation is scored per source file whatever
  drives it, so readability was the reason to split the tests.

- [gotcha] An untested error path looks exactly like a covered one. `convert-file.ts` sat at 89.07
  with line coverage at 100: every `if (!x.ok) return failure(x.error)` could be deleted outright
  and the suite still passed, because no test ever made `x` fail. Two seeds, a workbook and an
  invitation the source refuses, put it over 90. Coverage says the line ran; only mutation says the
  line mattered.

- [mistake] Blamed the library for bold markers stranded around inline pictures, and the break was
  ours: the placeholder arrives inside the HTML's emphasis (`**\[inline image: logo.png\]**`), which
  was harmless while its replacement was one line and broke once the OCR reading made it three
  blocks (now handled in `inline-image.ts:75`). Before writing a bug report upstream, check whether
  the input was fine until our own output changed shape.

- [decision] A message a person reads says which and why, not just that: "a kind of file this tool
  does not read" appeared fourteen times in one seven-day report and covered a kind we decline to
  convert and a name with no extension at all, which want different answers, so the reason names the
  extension or says there is none. Describe the file at the SOURCE, not by the words a message
  linked it under, which can call a recording `Rapport.docx`. Front matter follows the same rule: a
  card links the file beside it rather than naming a path to retype.

- [decision] A report earns attention only if everything in it deserves attention. One run's report
  was fourteen lines, thirteen notification icons and a shared folder, all false positives, because
  an icon dropped from the thread as decoration was still reported as not reaching the knowledge
  base. Whatever is deliberately ignored is ignored everywhere, or the report is noise on the day
  something real lands in it: ask of every line whether a reader would do anything about it.

- [gotcha] The reach day decides which threads are written, not where they are filed: a thread whose
  first message is from April but which had activity inside the reach is filed under April, because
  the folder is named from the first message and frozen there. That is correct and looks wrong in a
  directory listing.

- [gotcha] Check `my-quick-context` before diagnosing a slow or surprising run, since the signed-in
  account can change: a sync that took ninety seconds ran past an hour because the account had moved
  to another tenant whose mail held 113 pasted screenshots against 5, each an OCR pass. The account
  also sets the day: a thread's folder is dated in the `--timezone` zone (default: this machine's)
  and frozen at creation, and `my-quick-context` reports the tenant zone in Windows spelling, which
  `--timezone` refuses, so the mapping is a human step (Romance Standard Time is `Europe/Paris`).
  Ask per run rather than carrying an answer forward.
  Merges: 2026-08-30, 2026-08-30.

- [gotcha] A unit test proves the function, never the call: `withoutPlaceholders` was written and
  tested but never called, because the edit meant to wire it into `rewriteMessageBody` missed its
  anchor after prettier had collapsed the array onto one line. The suite and the mutation gate
  stayed green, and only counting the vault after a re-sync showed the ten markers still there.
  Wiring a transformation in needs one test at the level of the thing that uses it, and the proof is
  that removing the call turns a test red.

- [mistake] A capability wired into one route and not its mirror is the shape this codebase keeps
  producing: safelink unwrapping went into thread bodies and not card bodies, and OCR into inline
  images and not the parts of a saved email. Both times the rule belonged to "text that came out of
  mail" and was applied to one of the places such text lands. When adding one, list every route the
  same content can arrive by before calling it done.

- [gotcha] The OCR cache is keyed by content hash alone, so it is shared by every mailbox synced on
  this machine and cannot be cleaned per account. What can be identified is what the current vault
  does not reference: 115 of 123 entries after a run against another tenant. That also drops
  readings for mail outside the current `--since` window, which costs one pass each if that mail
  comes back into range. It survives `rm -rf kb/Mailbox`, which is why a killed sync loses no OCR.

- [gotcha] The local gates are not the CI gates: `bun run lint` is the cached ordinary pass where CI
  runs `lint:strict`, and `mutate:changed` scores a file or two where `mutate` on main scores
  ninety. CI's first run failed four ways no local gate could show: `gitleaks` absent from the
  runner, one error only the strict type-aware lint sees, thirteen fixable CVEs, and a mutation
  sweep that died writing its report. Run the CI variant before the first push, not the local one.

- [mistake] Changed things before reading the stack trace: the first fix for the mutation sweep
  crash dropped the html reporter on a theory, while the trace had said
  `MutationTestReportHelper.reportAll` and `JSON.stringify` all along, and the second fix invented a
  flag that does not exist. Two extra twenty-five-minute runs were the price of a guess and a habit.

- [gotcha] A source can report one condition two ways, as an empty answer or as a refusal, and code
  that handles one will not handle the other. `convertPdf` fell back to OCR when a PDF's text came
  back empty, but the library answers a genuinely scanned PDF with a 415 and a message, so the
  fallback was unreachable for the only file type it was written for, and the failure read as an
  unlucky file rather than a dead branch. When adding a fallback, check what the source actually
  does in the case the fallback is for.

- [gotcha] A fake that answers whatever it is handed keeps a dead feature green: the OCR fallback
  for scanned PDFs passed its tests from 24 July to 6 September without ever reading one, because
  `pdfText` handed RapidOCR the PDF's own path, which PIL refuses with `UnidentifiedImageError`,
  while the OCR fake returned text for any path. Wherever a fake is keyed by a path or an id it
  never validates, its tests prove the wiring, not that the adapter can do what it was asked; the
  fix read the pages as images through `extract-drive-item-images`.

## 2026-09-08

- [gotcha] A checkpoint that advances past work it has not confirmed loses that work in silence.
  `sync-site` saved `deltaLink` and `sync-mailbox` every folder cursor before the conversions they
  covered, then sliced windows off `pending` whether each item succeeded or not, so a failed item
  became unreachable while the report promised a retry and the next run said `0 failed`. Wherever a
  cursor moves past work, the record of what the work left unfinished moves with it in the same
  write, as the retry ledger now does (`retry-policy.ts:3`).

- [decision] Every failed conversion is retried, capped at three attempts, rather than routed by
  error kind. `ConvertOutcome.failed` flattens `DriveReaderError`'s `transient`, `throttled`,
  `permanent` and `unrenderable` into a `"kind: message"` string, so a kind-aware policy means
  threading a new field through `convertFile`, `convertAttachment` and `renderThread`, and the kind
  of the failure that prompted the work was never established. A flat cap costs at most two
  pointless calls over two later runs and needs no new information.

- [gotcha] A record that brings lost work back has to live at the level the queue is keyed on, not
  at the level of the thing that failed. A per-attachment record could not get its thread re-queued,
  because the folder cursors had advanced when the thread's messages were swept and the thread
  ledger is the only thing that reaches a thread afterwards. Before designing a partial retry, check
  what re-queues the work: that sets the smallest unit that can be retried, and everything below it
  re-runs.

- [gotcha] Code written for a case nothing can yet reach is untested by construction, and it was
  wrong here: `drainQueue` dropped per-run given-up notes in two places, written in 8f38b2c when no
  render could produce one. Coverage was 100% and mutation 92% over those lines, because dropping an
  always-empty list changes nothing observable, and only the first test producing a note through
  that path found it. When adding a field that nothing fills yet, fill it from something or leave it
  out until a caller exists.

- [decision] Where a source cannot do what its sibling does, the adapter answers honestly and the
  gap goes upstream, rather than a local workaround. Group posts lacked the PDF, picture and link
  commands mail has, so the adapter returned `unrenderable` or an empty list with the reason beside
  it and `docs/request-group-post-parity.md` asked for them; when 2.6.0 landed all three, wiring
  them took three method bodies in `group-reader-marcel.ts` plus one test, because the honest
  answers had kept the shape of the real ones. Return the shape the real answer will have, say why
  in the error, and file the request.
  Merges: 2026-09-08, 2026-09-08.

## 2026-09-09

- [decision] A delta endpoint is not automatically the incremental answer: a delta tells you WHAT
  changed, not what the thing now IS. To Do's `list-todo-tasks-delta` takes no `expand`, so a task's
  steps and links would have cost one `get-todo-task` per changed task, while the plain listing
  takes `expand`, needs no cursor and shows a deletion by absence on every run (`todo-state.ts:80`).
  Before designing a state around a delta, check what its response can actually carry.

- [gotcha] A survivor no test can kill usually marks dead code, not a missing test. A guard in front
  of a division that already yields `NaN` (`ocr-language.ts`), a stamp every card overwrote
  (`render-thread.ts`), the fields and guards a deleted store left behind, and a `?? ''` behind a
  lookup over the very items that built the map (`syncTodo`) all survived for that reason. Remove
  the code, or reshape it so the question cannot be asked (hand back `{ task, file }` pairs rather
  than an index to look up), instead of writing tests for a path nothing reaches; a field that seems
  untestable either reaches disk on some path or is dead.
  Merges: 2026-08-27, 2026-08-30, 2026-08-30, 2026-09-09.

## 2026-09-11

- [decision] A source reachable only through an endpoint whose token lapses without a browser
  sign-in is not a source `update` can own. Teams chats were built on the library's
  Microsoft-internal substrate commands, which answered on the day; by the next morning the
  substrate token had lapsed while the Graph token beside it was still good, so every scheduled
  `update` would have failed there until a person signed in. Teams channels, on Graph since 2.7.0,
  took its place, and the parked `teams-chats-wip` branch has since gone. Before building a
  category, check that a read will still work tomorrow with nobody at the keyboard.

## 2026-09-12

- [gotcha] A new source kind that borrows another kind's id collides wherever ids are held together,
  and nothing fails loudly: a site's lists share the site's id with its libraries, so the picker's
  synced marks and the global report's untouched tail would each have taken one for the other. Every
  such map now keys by `sourceKey` (`sync-state.ts:33`). When a new kind shares an id with an
  existing one, grep every `source.id` lookup before wiring it in.

- [gotcha] Graph's `hidden` and `readOnly` column flags miss columns nobody fills in: a live run
  over one real list showed `Content Type`, filed under the `_Hidden` group instead
  (`sharepoint-list.ts:49`), and `Attachments`, a plain editable flag the list keeps for itself. For
  a category whose output is a projection of what Graph flags, render one real item and read it
  before trusting the flags.

## 2026-09-19

- [mistake] A mutation run opened the browser to sign in, over and over: the wired tests in
  `build-deps.test.ts` left the mail reader real and said `interactive: true`, and a mutant turning
  `if (known.value.some(kind === 'mailbox'))` into `if (true)` walked the `update` test into it.
  Mutation is what walks the line from an unfaked reader to the network. A test that wires the real
  composition is never interactive (`build-deps.test.ts:20`) and fakes every port that touches the
  network, not only the ones its scenario reaches.

## 2026-09-26

- [gotcha] Format with `bunx eslint --fix`, never `bunx prettier --write`. The Prettier options
  (single quotes, 180 columns) live in `eslint.config.js` as the `prettier/prettier` rule, and the
  repo has no `.prettierrc`, so bare Prettier formats with its defaults: double quotes, 80
  columns. Re-running ESLint puts the quotes back but not the layout, because Prettier keeps an
  object literal multi-line once it breaks after the opening brace; one stray run turned a
  250-line test diff into 1,200 lines and the file had to be restored and re-patched.

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
