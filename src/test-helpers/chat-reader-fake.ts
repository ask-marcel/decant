import type { Chat } from '../domain/chat.ts';
import type { ChatMessage } from '../domain/chat-message.ts';
import { err, ok } from '../domain/result.ts';
import type { ChatReader, ChatReaderError } from '../use-cases/ports/chat-reader.ts';
import type { EmbeddedImage } from '../use-cases/ports/drive-reader.ts';
import type { LinkedFile } from '../use-cases/ports/mail-reader.ts';

export type ChatReaderSeed = {
  readonly chats?: ReadonlyArray<Chat>;
  // The messages of each chat, by chat id. A read from a day answers only the ones written on or after
  // it, counted in UTC, as the source does.
  readonly messages?: Readonly<Record<string, ReadonlyArray<ChatMessage>>>;
  // The pictures pasted in each message, by message id.
  readonly pictures?: Readonly<Record<string, ReadonlyArray<EmbeddedImage>>>;
  // The drive item each shared file is, by the address the message gave for it. One with no entry
  // here does not resolve.
  readonly links?: Readonly<Record<string, LinkedFile>>;
  readonly failChats?: ChatReaderError;
  // Only the chats named here fail to read, so one can fail while the rest land beside it.
  readonly failMessagesOf?: Readonly<Record<string, ChatReaderError>>;
  // Only the messages named here fail to give their pictures.
  readonly failPicturesOf?: ReadonlyArray<string>;
  // A read of the chat named here answers only once its promise settles, so a test can hold one chat
  // open while the others end.
  readonly holdMessagesOf?: Readonly<Record<string, Promise<void>>>;
};

// `days` is the day each chat was read from, `all` when none: kept beside the calls, so a test about
// the day reads it here and every other test reads the calls.
export type ChatReaderFake = ChatReader & { readonly calls: Array<string>; readonly days: Array<string> };

export const createChatReaderFake = (seed: ChatReaderSeed = {}): ChatReaderFake => {
  const calls: string[] = [];
  const days: string[] = [];
  return {
    calls,
    days,
    listChats: async () => {
      calls.push('listChats');
      return seed.failChats === undefined ? ok(seed.chats ?? []) : err(seed.failChats);
    },
    messages: async (chatId, since) => {
      calls.push(`messages:${chatId}`);
      days.push(`${chatId}:${since ?? 'all'}`);
      await seed.holdMessagesOf?.[chatId];
      const failure = seed.failMessagesOf?.[chatId];
      if (failure !== undefined) return err(failure);
      return ok((seed.messages?.[chatId] ?? []).filter((message) => since === undefined || message.sent >= since));
    },
    pictures: async (chatId, messageId) => {
      calls.push(`pictures:${messageId}`);
      if ((seed.failPicturesOf ?? []).includes(messageId)) return err({ kind: 'transient', message: `cannot fetch the pictures of ${messageId}` });
      return ok(seed.pictures?.[messageId] ?? []);
    },
    fileLink: async (file) => {
      calls.push(`fileLink:${file.name}`);
      const link = seed.links?.[file.url];
      return link === undefined ? err({ kind: 'permanent', message: `${file.name} is not a file in a library` }) : ok(link);
    },
  };
};
