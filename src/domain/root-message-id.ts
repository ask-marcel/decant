// Graph hands the RFC headers back as a list rather than a map, because a name can repeat and its
// casing is whatever the sending server chose. Verified against this tenant: `References`,
// `Message-ID` and `In-Reply-To` all arrive spelled that way, but nothing promises they will.
export type MessageHeader = { readonly name: string; readonly value: string };

// A message id inside its angle brackets. The brackets are what an id is read by rather than the
// space around them: a long `References` arrives folded across lines, so the separator between two
// ids can be a space, a CRLF, or both.
const MESSAGE_ID = /<[^<>]+>/;

const valueOf = (headers: ReadonlyArray<MessageHeader>, name: string): string | undefined => headers.find((header) => header.name.toLowerCase() === name)?.value;

const firstId = (value: string | undefined): string | undefined => MESSAGE_ID.exec(value ?? '')?.[0];

// Which message a thread began with, as far as this one can say.
//
// `References` carries the chain a reply travelled, oldest first, so its first entry names the root
// even when the root itself never reached this mailbox: that is the case this exists for, a thread
// joined at reply five where the oldest message held is not the one it started from. A message that
// began its own thread carries no `References` and stands as its own root. Graph's own id is the
// last resort, so an answer is always a string and a run never stops for a malformed header.
//
// Read this from the OLDEST message of a conversation, never the newest. `list-conversation-messages`
// filters across every folder, so an unsent draft reply has a newer `receivedDateTime` than any real
// message and no `References` at all, and sampling it would name the thread after the draft.
export const rootMessageId = (headers: ReadonlyArray<MessageHeader>, ownMessageId: string): string =>
  firstId(valueOf(headers, 'references')) ?? firstId(valueOf(headers, 'message-id')) ?? ownMessageId;
