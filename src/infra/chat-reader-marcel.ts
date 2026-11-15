import { parseChat } from '../domain/chat.ts';
import type { Chat } from '../domain/chat.ts';
import { parseChatMessage } from '../domain/chat-message.ts';
import type { ChatMessage } from '../domain/chat-message.ts';
import type { Result } from '../domain/result.ts';
import { err, ok } from '../domain/result.ts';
import type { ChatReader, ChatReaderError } from '../use-cases/ports/chat-reader.ts';
import type { EmbeddedImage } from '../use-cases/ports/drive-reader.ts';
import type { MarcelCall } from './drive-reader-marcel.ts';
import { readString } from './mail-reader-marcel.ts';

// Chats read through the Teams substrate, not Graph: the token the library holds has no `Chat.Read`,
// so Graph refuses `/chats/{id}/messages`. The substrate is Microsoft's own, undocumented, and has a
// token of its own that the library renews from the sign-in it shares with Graph.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const listAt = (value: unknown, key: string): ReadonlyArray<unknown> => (isRecord(value) && Array.isArray(value[key]) ? value[key] : []);

// The page size the Teams client itself asks for.
const CHATS_PAGE = '100';

// The library cuts a message at 4096 characters unless told a limit. A million is past any message
// Teams accepts, and keeps the slim projection, which is the part of the answer it documents.
const WHOLE_MESSAGE = '1000000';

// A sign-in the substrate refuses says nothing about the sign-in every other source runs on. Named
// `auth`, it would end an update for the sources after the chats, which have nothing to do with it.
const SIGN_IN_AGAIN = 'Teams did not accept the sign-in for chats. Run `ask-marcel-office login`, then run decant again';

const chatsOnly = (error: ChatReaderError): ChatReaderError => (error.kind === 'auth' ? { kind: 'permanent', message: `${SIGN_IN_AGAIN}: ${error.message}` } : error);

// Where a paged answer goes on from, when it says there is more. A place the walk already went on
// from would page for ever, so it ends the walk.
const onwardFrom = (page: unknown, more: string, cursor: string, seen: Set<string>): string | undefined => {
  const next = isRecord(page) && page[more] === true ? readString(page, cursor) : undefined;
  if (next === undefined || seen.has(next)) return undefined;
  seen.add(next);
  return next;
};

const toPicture = (entry: unknown): ReadonlyArray<EmbeddedImage> => {
  const path = readString(entry, 'path');
  const base64 = readString(entry, 'base64');
  return path === undefined || base64 === undefined ? [] : [{ path, bytes: new Uint8Array(Buffer.from(base64, 'base64')) }];
};

export const createChatReaderFromCall = (call: MarcelCall): ChatReader => {
  const substrate = async (name: string, params: Record<string, string>): Promise<Result<unknown, ChatReaderError>> => {
    const raw = await call(name, params);
    return raw.ok ? raw : err(chatsOnly(raw.error));
  };

  return {
    // Who is signed in is asked of Graph first: it is what takes them off the members a chat is named
    // by, and a sign-in that lapsed for every source shows here as what it is.
    listChats: async () => {
      const me = await call('get-current-user', { select: 'id' });
      if (!me.ok) return me;
      const ownId = readString(me.value, 'id');
      const chats: Chat[] = [];
      const seen = new Set<string>();
      let params: Record<string, string> | undefined = { pageSize: CHATS_PAGE };
      while (params !== undefined) {
        const page = await substrate('list-teams-chats-with-messages', params);
        if (!page.ok) return page;
        chats.push(...listAt(page.value, 'chats').flatMap((entry) => parseChat(entry, ownId) ?? []));
        const next = onwardFrom(page.value, 'hasMoreData', 'continuationToken', seen);
        params = next === undefined ? undefined : { pageSize: CHATS_PAGE, continuationToken: next };
      }
      return ok(chats);
    },
    // The library walks twenty pages a call and says when there is more: the walk goes on from the
    // state it hands back, until it says there is none.
    messages: async (chatId, since) => {
      const messages: ChatMessage[] = [];
      const seen = new Set<string>();
      const always = { chatId, skipSystem: 'true', maxContentChars: WHOLE_MESSAGE };
      let params: Record<string, string> | undefined = since === undefined ? always : { ...always, since: `${since}T00:00:00Z` };
      while (params !== undefined) {
        const page = await substrate('list-teams-chat-history', params);
        if (!page.ok) return page;
        messages.push(...listAt(page.value, 'messages').flatMap((entry) => parseChatMessage(entry) ?? []));
        const next = onwardFrom(page.value, 'hasMore', 'nextSyncState', seen);
        params = next === undefined ? undefined : { ...always, syncState: next };
      }
      // Teams also hands back a message written before the day when it changed after it. One message
      // is not its day, so it is left out, as the port says.
      return ok(since === undefined ? messages : messages.filter((message) => message.sent >= since));
    },
    pictures: async (chatId, messageId) => {
      const raw = await substrate('extract-teams-chat-message-images', { chatId, messageId });
      return raw.ok ? ok(listAt(raw.value, 'media').flatMap(toPicture)) : raw;
    },
    // On Graph and the sign-in every other source uses, so its errors stay as they come.
    fileLink: async (file) => {
      const raw = await call('resolve-drive-share-link', { url: file.url });
      if (!raw.ok) return raw;
      const driveId = readString(raw.value, 'driveId');
      const itemId = readString(raw.value, 'itemId');
      if (driveId === undefined || itemId === undefined) return err({ kind: 'permanent', message: 'the link did not lead to a file in a library' });
      return ok({ url: readString(raw.value, 'webUrl') ?? file.url, driveId, itemId, name: readString(raw.value, 'name') ?? file.name });
    },
  };
};
