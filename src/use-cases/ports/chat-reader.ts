import type { Chat } from '../../domain/chat.ts';
import type { ChatFile, ChatMessage } from '../../domain/chat-message.ts';
import type { Result } from '../../domain/result.ts';
import type { DriveReaderError, EmbeddedImage } from './drive-reader.ts';
import type { LinkedFile } from './mail-reader.ts';

// A chat fails in the terms the rest does. One difference: the messages come from the Teams substrate,
// on a token of its own, so a sign-in the substrate refuses is not `auth`, which would end the run for
// every source after this one. It is `permanent`, and costs the chats alone.
export type ChatReaderError = DriveReaderError;

// Finding the chats of the signed-in person, reading the messages of one, and fetching what a message
// carried: the pictures pasted in it, and where a file it shared sits at the source.
export type ChatReader = {
  readonly listChats: () => Promise<Result<ReadonlyArray<Chat>, ChatReaderError>>;
  // With a day, the source is asked only for the messages written on or after it, counted in UTC.
  // Followed to its end before anything is handed back.
  readonly messages: (chatId: string, since?: string) => Promise<Result<ReadonlyArray<ChatMessage>, ChatReaderError>>;
  // The pictures pasted in one message, in the order its markers are numbered.
  readonly pictures: (chatId: string, messageId: string) => Promise<Result<ReadonlyArray<EmbeddedImage>, ChatReaderError>>;
  // The drive item a shared file is, so it is pulled the way a file linked from a mail is.
  readonly fileLink: (file: ChatFile) => Promise<Result<LinkedFile, ChatReaderError>>;
};
