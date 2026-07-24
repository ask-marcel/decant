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
