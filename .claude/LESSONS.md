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
