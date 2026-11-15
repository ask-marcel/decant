# Request: three changes to the Teams chat commands of the library

**Package:** `ask-marcel-office-cli` 2.8.0
**Category:** chats
**Kind:** two missing options and one description. Nothing is broken.

## Context

`decant` mirrors Teams chats into markdown, one note for each chat and day. It reads the chats with
`list-teams-chats-with-messages`, the messages with `list-teams-chat-history`, and the pasted
pictures with `extract-teams-chat-message-images`.

`decant` converts the HTML of the messages with `convert-local-file-to-markdown`, which converts an
`.html` file with no call to the network. Thus a markdown command for a chat message is not
necessary.

## 1. The size of a pasted picture

`extract-teams-chat-message-images` downloads the address in the `src` of each picture tag. That
address is the `views/imgo` view, which Teams makes smaller. In a real run of `decant`, no picture
of 82 was larger than 800 pixels on its long side. The text in a screenshot is then hard to read,
for a person and for OCR.

An option that gets the full size of the picture would help.

## 2. `since` and the time of a message

The description of `--since` on `list-teams-chat-history` says that only the messages at or after
the instant come back. In a real run with `since: '2026-11-10T00:00:00Z'`, one message with a
`composetime` on 2026-11-08 came back. The cause is not known. A later edit or a later reaction
is a possible cause.

It would help if the description said which time the bound applies to. `decant` removes such a
message itself, because it cannot write a day from one message of that day.

## 3. No limit on the content of a message

`list-teams-chat-history` cuts each message at 4096 characters if the caller gives no
`maxContentChars`. `decant` sends `maxContentChars: '1000000'`. A value that means "no limit" for
the default projection would be clearer than a large number.
