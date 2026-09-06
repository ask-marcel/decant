# Request: read the posts of a Microsoft 365 group conversation

**Package:** `ask-marcel-office-cli` 2.4.0
**Category:** mail
**Kind:** missing command. Nothing is broken; a group's mail is reachable up to its titles and no further.

## What exists today

Two commands read a unified group's inbox, both on `/groups/{group-id}`:

- `list-group-conversations` on `GET /groups/{id}/conversations`
- `list-group-threads` on `GET /groups/{id}/threads`

Both return `id`, `topic`, `hasAttachments`, `lastDeliveredDateTime`, `uniqueSenders` and a `preview`.
The preview is Graph's own truncation of the latest post, a few hundred characters cut mid-line,
and it is the only body text either command yields. Verified live on 2.4.0 against a group the
signed-in user belongs to: both calls succeed on `Group.Read.All`, and neither reaches a full post.

There is no reader for posts. The mail and teams categories were both checked.

## What is missing

Graph keeps the full text one level down:

```
GET /groups/{group-id}/threads/{thread-id}/posts
GET /groups/{group-id}/conversations/{conversation-id}/threads/{thread-id}/posts
```

Each `post` carries `body.content` and `body.contentType` (HTML), `from`, `sender`,
`receivedDateTime`, `hasAttachments`, and its attachments under `/posts/{post-id}/attachments`.
Delegated scope is `Group.Read.All`, which the current app registration already consents to, so no
new permission is involved.

Reference: https://learn.microsoft.com/en-us/graph/api/conversationthread-list-posts

## Why the shared-mailbox commands cannot stand in

A group has an SMTP address, so the obvious workaround is to read it as a shared mailbox through
`list-shared-mailbox-folders` and friends on `/users/{address}/mailFolders`. Graph refuses:

```
ErrorGroupIsUsedInNonGroupURI: Group Shard is used in non-Groups URI
```

That is a hard rule of the API, not a scope or a bug: a group's mail is only addressable under
`/groups/`. The posts endpoint is the only way to the text.

## The ask

A `list-group-thread-posts` command, `--group-id` and `--thread-id`, returning the `post`
collection with the usual paging envelope. A `get-group-post` sibling for one post by id would match
how the mail commands are shaped but is not needed for the first use.

`convert-mail-to-markdown` takes a message id; a post has the same HTML body and would want the same
rendering, so either that command accepting a group post or a `convert-group-post-to-markdown`
sibling would let a caller treat a group thread exactly like a mail conversation.

## What it unlocks

`decant` mirrors a mailbox into markdown, one document per conversation. With a posts reader, a
group inbox is the same job with one call swapped: threads instead of conversations, posts instead
of messages, the rest unchanged. Without it, a synced group would be one truncated line per thread,
which is not worth writing down.

## Secondary, same registration

`scopes-check` on 2.4.0 shows the consented delegated scopes include `Mail.Read`, `Mail.ReadWrite`,
`Calendars.Read.Shared` and `Place.Read.Shared`, but not `Mail.Read.Shared`. The four
`list-shared-mailbox-*` commands and `get-shared-mailbox-message` document that scope as required,
so against a mailbox that is not the signed-in user's own they will 403 until it is added to the
app registration. Unconfirmed live for want of a delegated mailbox to try, but the docs and the
scope list agree.
