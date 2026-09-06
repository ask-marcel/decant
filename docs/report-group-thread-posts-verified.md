# Report: the group-posts request is answered, and what is left is a release

**Package:** `ask-marcel-office-cli` 2.5.0, built locally, not on npm
**Category:** mail
**Kind:** verification, not a request. Everything asked for in `request-group-thread-posts.md` exists
and works against a second tenant. Nothing further is needed from the library.

## What was asked, and what shipped

The request asked for `list-group-thread-posts`, and said a `get-group-post` sibling and a markdown
converter would match how the mail commands are shaped. 2.5.0 ships six commands, not three:

| Command | Verified live |
|---------|---------------|
| `list-group-thread-posts` | yes |
| `get-group-post` | yes, including `--select` |
| `convert-group-post-to-markdown` | yes |
| `list-group-post-attachments` | no, see below |
| `get-group-post-attachment` | no, see below |
| `convert-group-post-attachment-to-markdown` | no, see below |

## Verified live, 2026-09-06

A second tenant, unrelated to the one the commands were built against: 3 unified groups, 13 threads,
14 posts. Read-only, through the CLI binary and again through the library entry point
(`commands['list-group-thread-posts'].execute(graph, params)`), which is the route `decant` uses.

`list-group-thread-posts` returns the full HTML `body.content` where `list-group-threads` returns a
truncated `preview`. The `from` / `sender` split the summary documents is exactly what arrives:
`from` is the group's own SMTP address, `sender` is the person who wrote the post. A thread holding
two posts returned both in one call, with no page cursor.

`convert-group-post-to-markdown` renders the `**From:** … on behalf of …` author line, the date line,
and the body. No subject line, which is correct: the thread's `topic` is the subject.

`convert-mail-to-markdown` on an ordinary Outlook message returns output byte-identical to 2.4.0,
2226 bytes both. The refactor that parameterised the resource path and the header renderer did not
disturb the mail path.

## What the thread collection does and does not support

Probed on the same tenant, because a consumer syncing a group needs to know how to go back for what
changed:

- `--top` is honoured. Asking for 3 of 10 threads returned 3.
- `--orderby lastDeliveredDateTime desc` is honoured, and the order was correct.
- Paging works. A truncated listing emits a `next-page` cursor, `$skip`-based.
- `--filter` is refused by Graph: `ConversationFilterOther: The 'Threads' collection only supports
  the filter '$filter=IsLocked eq true' or '$filter=IsLocked ne false'`.
- There is no delta endpoint for group threads or posts.

The consequence is not a gap in the library, it is the shape of the API. An incremental sync cannot
ask "what changed since", it orders newest-first and stops at the first thread older than its
watermark. `--orderby` plus `--top` make that one cheap call per group per run, so the refused
`--filter` costs nothing in practice.

The posts collection is narrower still, and 2.5.0 already documents it: `$top`, `$skip` and
`$orderby` are silently ignored and `$filter` is rejected, so only `--select` and `--expand` are
exposed and no cursor is ever emitted. Confirmed here: a two-post thread came back whole.

## What could not be verified

Not one post in any of the three groups carries an attachment, so the three attachment commands went
untested. They are covered by the library's own suite; this tenant simply cannot exercise them. The
same applies to a post whose only images are inline, which is the case the changelog's
`hasAttachments: false` fix exists for.

## The one thing outstanding

npm serves 2.4.0. A consumer pinning `^2.4.0`, which is what `decant` does today, resolves the
registry copy and cannot call any of the six commands, whatever is linked globally on the machine.
Publishing 2.5.0 is the whole of what is left.

Gates were run against the local tree at that point: 4899 tests passing, `lint:strict` and
`typecheck` clean, coverage at tier on every layer, and the doc-numbers gate matching the registry at
192 commands. The packed tarball carries no tenant data and no tokens.

## Not a gap, recorded so it is not re-asked

The secondary item in the original request, `Mail.Read.Shared`, is still absent. `scopes-check` on
this tenant confirms it: the token carries `Mail.Read` and `Mail.ReadWrite` and not the `.Shared`
variant. Since `login` captures the token the Teams web client already uses, the scope set is not the
maintainer's to extend, and a shared Exchange mailbox stays out of reach. 2.5.0 rewrote the five
`list-shared-mailbox-*` summaries to say so and to point at the group route instead, which is the
right answer: the group route was tested here and it works.

## Where the ball is now

For `decant` the remaining work is entirely local. The library gives it posts, bodies, authors,
dates and a markdown renderer; what does not exist yet is a group source: a reader port over these
commands, a picker entry beside `m) My mailbox`, and a per-group state file. Thread identity is free
here, since Graph hands out a stable thread id and none of the RFC `References` reconstruction the
mailbox sync needs applies.

Worth knowing before that work is scheduled: on this tenant the three groups hold 14 posts in total,
and most of them are the welcome message Microsoft posts when a group is created.
