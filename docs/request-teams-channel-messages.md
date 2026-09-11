# Request: let a consumer read a Teams channel's messages

> **Resolved in `ask-marcel-office-cli` 2.7.0**, the day after it was written. The four commands
> below all landed on Graph and the basic token: `list-team-channel-messages`,
> `list-team-channel-messages-delta` (with `--since` and a `deltaLink` to ask later with),
> `list-team-channel-message-replies` and `get-team-channel-message`, plus two the request did not
> ask for, `convert-team-channel-message-to-markdown` and `convert-team-channel-messages-to-markdown`,
> which render a post with its replies the way `convert-mail-to-markdown` renders a message.
> `decant` took the dependency on 2026-09-11 and syncs the channels of every Team the user belongs
> to, one adapter and one category entry as predicted, plus a use-case of its own because a channel
> keeps a delta cursor where a group inbox keeps none. Kept as the record of what was asked for.

**Package:** `ask-marcel-office-cli` 2.6.0
**Category:** teams
**Kind:** missing commands. Nothing is broken. A team's channels can be listed and named; what was
said in one cannot be read at all.

## Context

`decant` mirrors Microsoft 365 into markdown for local agents. It already covers SharePoint
libraries, Loop workspaces, OneDrive, the Outlook mailbox, Microsoft 365 group inboxes and
Microsoft To Do. The conversations people actually have during a working day are the gap, and they
are in two places: Teams chats and Teams channels.

Teams chats are covered, through `list-teams-chats-with-messages` and `list-teams-chat-history`.
Both were verified live on 2026-09-10 against a real tenant with the token the ordinary login
captures.

Teams channels are not covered, and that is the request.

## What exists in 2.6.0

| Command | Graph path |
|---|---|
| `list-joined-teams` | `/me/joinedTeams` |
| `get-team` | `/teams/{team-id}` |
| `list-team-channels` | `/teams/{team-id}/channels` |
| `get-team-channel` | `/teams/{team-id}/channels/{channel-id}` |
| `get-team-primary-channel` | `/teams/{team-id}/primaryChannel` |
| `get-channel-files-folder` | `/teams/{team-id}/channels/{channel-id}/filesFolder` |

So a consumer can walk every team the user has joined, name every channel in it, and reach the
files behind the Files tab. The messages in those channels, which is what a channel is for, are
reachable by nothing.

## What is missing

| Wanted | Graph path | Nearest thing that exists |
|---|---|---|
| list a channel's messages | `/teams/{team-id}/channels/{channel-id}/messages` | none |
| a message's replies | `/teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies` | none |
| one message | `/teams/{team-id}/channels/{channel-id}/messages/{message-id}` | none |
| incremental read | `/teams/{team-id}/channels/{channel-id}/messages/delta` | none |

A channel post and its replies are one conversation, the way a group inbox thread and its posts
are, so the listing plus the replies is the pair a consumer needs. The delta is what would make a
re-sync cheap, and its absence is survivable: `lastModifiedDateTime` on the listing supports the
same newest-first watermark a group inbox already uses.

## Why it may have been left out, and what to say if so

Graph gates channel messages behind `ChannelMessage.Read.All`, which is admin-consent only, and the
protected-API programme with per-seat licensing applies to some tenants. That is very likely why
these are absent where the chat substrate commands are present, and it is a real obstacle rather
than an oversight.

Two things would still help a consumer, in descending order of usefulness:

1. **The commands, gated.** Ship them, and let the call fail with the `auth_failed` or `api_error`
   Graph already returns when the scope is missing. A consumer that gets a clear refusal can report
   "your tenant has not consented to channel messages" and carry on with every other source. Today
   a consumer cannot tell that case apart from "this package does not do Teams channels".
2. **A documented answer either way.** If the commands will not ship, saying so in `COMMANDS.md`
   under the teams category is worth as much as the commands to anyone deciding what to build.

## What the consumer does meanwhile

`decant` syncs Teams chats and does not offer Teams channels at all, rather than offering them and
failing per channel. The picker shows what can be read; a category that could never work would be a
row that always errors.

When the commands land, the work is confined to one new adapter over them plus a category entry,
because the rendering path a conversation takes is already shared by the mailbox, the group inboxes
and the Teams chats. The same prediction was made in `request-group-post-parity.md` and held: when
2.6.0 landed those three commands, wiring them was three method bodies and one test.
