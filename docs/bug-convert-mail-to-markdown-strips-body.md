# `convert-mail-to-markdown` strips a whole body as a "quoted reply chain"

**Package:** `ask-marcel-office-cli` 2.3.0
**Command:** `convert-mail-to-markdown`
**Severity:** data loss. The command reports success and returns a body with the content removed.

## What happens

On a structured HTML mail with headings and numbered lists, the quoted-chain heuristic classifies
the entire body as quoted and removes it. The command returns 768 bytes: the header block, the
opening line, and the note.

```
**Subject:** Demurrage & Detention tracking — in-house build, scope for endorsement
**From:** Waldo Remijn <...>
**To:** ...
**Date:** 2026-08-12T10:54:48Z

Dear all,

_\[Quoted reply chain removed — pass --keep-quoted true to include it\]_
```

Everything after `Dear all,` is gone: a Target section, six numbered workstreams each with a
priority line, an Open Point section, a Beyond this Phase section, and the sign-off.

## What it should return

The same message with `--keep-quoted true` returns **6912 bytes, 109 lines, and zero lines
beginning with `>`**. There was no quoted reply chain in the message at all. Nothing was quoted;
the heuristic simply misread the structure.

## Reproduction

```bash
ask-marcel-office convert-mail-to-markdown --message-id '<id>'
# → 768 bytes, body replaced by the note

ask-marcel-office convert-mail-to-markdown --message-id '<id>' --keep-quoted true
# → 6912 bytes, the real body, 0 lines starting with '>'
```

The message is an Outlook-composed HTML mail containing: bold section headings, two ordered lists,
a nested ordered list with bold lead-ins, coloured inline annotation lines, and a signature block.

## Why it matters

Measured across a 7-day sync of one mailbox: **10 of 42 message sections (24%) were reduced to a
single short line.** The failure is silently biased toward the most valuable mail, because a long
structured message with headings and lists is exactly what the heuristic misreads, while a two-line
reply survives intact.

Nothing in the result distinguishes this from a message that genuinely was one line. The `note`
field says a chain was stripped, but says nothing about how much, so a caller cannot tell a correct
strip from a destroyed body without re-fetching with `--keep-quoted`.

## What a genuine quoted chain looks like

Worth stating because it suggests a more reliable rule. In a real reply fetched with
`--keep-quoted true`, the chain is **not** `>`-quoted either. It is delimited by a second Outlook
header block partway down the document:

```
Mark/Chris, are you OK with the below for me to start working on with the IT team ?

Best regards
Waldo Remijn
...
**From:** Waldo Remijn <...>          ← line 22, the chain starts here
**To:** ...
**Subject:** Demurrage & Detention tracking — in-house build, scope for endorsement
```

A structural rule (cut at the first `**From:**` block occurring after body content has begun) would
have handled both messages correctly, where the current heuristic destroys the first one.

## Suggested fixes, in order of preference

1. Use the repeated header block as the delimiter rather than inferring quotedness from structure.
2. Failing that, never strip when the result would remove most of the body: a strip that leaves one
   line out of a hundred should be treated as a failed detection, not a successful one.
3. At minimum, report what was removed, so a caller can detect the case without a second fetch.
   The current `note` is not enough: it fires identically whether one line or a hundred went.
