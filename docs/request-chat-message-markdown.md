# Request: give a chat message the markdown conversion that a channel post has

**Package:** `ask-marcel-office-cli` 2.8.0
**Category:** chats
**Kind:** missing command. Nothing is broken. The text of a chat message arrives in full as Teams
HTML. A consumer must convert it.

## Context

`decant` mirrors Teams chats into markdown, one note for each chat and day. It reads the chats with
`list-teams-chats-with-messages` and the messages with `list-teams-chat-history`.

A channel post has `convert-team-channel-message-to-markdown`. The library converts the Teams HTML,
resolves the mentions and the attachment links, and quotes the replies. A chat message has no
command of this type.

## What is missing

| Channel command | Chat equivalent in 2.8.0 | What is lost |
|---|---|---|
| `convert-team-channel-message-to-markdown` | none | Bold text, tables, code blocks and the quote of a reply. |

## What the consumer does meanwhile

`decant` converts the HTML with its own small converter (`src/domain/html-text.ts`). This converter
keeps the words, the links, the list items and the line breaks. It removes all other markup. Thus:

- A table becomes one line for each row, with ` | ` between the cells.
- Bold, italic and code formats are lost.
- A reply that quotes a message shows the name and the quoted text as plain lines before the reply.
  The reader cannot see where the quote stops.

## What would help

One of these two commands:

1. `convert-teams-chat-message-to-markdown --chat-id <id> --message-id <id>`, with the same output
   shape as the channel command (`{ text }`).
2. A local command that converts a string of Teams HTML to markdown, with no call to the network.
   `decant` reads many messages in one call to `list-teams-chat-history`. Thus a local conversion
   adds no call for each message.

The second command is better for `decant`. A chat of 200 messages then needs one read, not 201.

For the two commands, these parts of the Teams HTML are important:

- `<img itemtype="http://schema.skype.com/AMSImage">`: keep a placeholder with the position of the
  picture, in the same order as `extract-teams-chat-message-images` gives the pictures.
- `<img itemtype="http://schema.skype.com/Emoji">`: give the `alt` character.
- `<span itemtype="http://schema.skype.com/Mention">`: give the name.
- `<blockquote itemtype="http://schema.skype.com/Reply">`: give a markdown quote.

## A second, smaller point

`list-teams-chat-history` cuts each message at 4096 characters if the caller gives no
`maxContentChars`. `decant` sends `maxContentChars: '1000000'`. A value that means "no limit" for
the default projection would be clearer than a large number.

## A third point: the size of a pasted picture

`extract-teams-chat-message-images` downloads the address in the `src` of each picture tag. That
address is the `views/imgo` view, which Teams makes smaller. In a real run of `decant`, no picture
of 82 was larger than 800 pixels on its long side. The text in a screenshot is then hard to read,
for a person and for OCR.

An option that gets the full size of the picture would help.

## A fourth point: `since` and the time of a message

The description of `--since` on `list-teams-chat-history` says that only the messages at or after
the instant come back. In a real run with `since: '2026-11-10T00:00:00Z'`, one message with a
`composetime` on 2026-11-08 came back. The cause is not known. A later edit or a later reaction
is a possible cause.

It would help if the description said which time the bound applies to. `decant` must remove such
a message itself, because it cannot write a day from one message of that day.
