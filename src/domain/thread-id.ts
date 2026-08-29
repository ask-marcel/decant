import { contentHash } from './content-hash.ts';

// Ten hex characters, chosen against the birthday bound rather than by eye: six collide at about
// 4,000 threads and eight at about 65,000, where ten holds to roughly a million. A working mailbox
// passes four thousand threads in a couple of years, so the shorter widths are not headroom.
export const THREAD_ID_LENGTH = 10;

// What a thread IS, and the one part of its folder name that is never recomputed. Taken from the
// root message id rather than from Graph's `conversationId`, which is scoped to a single mailbox,
// so a shared mailbox and a personal one see different values for the same message, and which
// Graph reassigns when an external party replies from outside Exchange, splitting a vendor exchange
// into two folders mid-conversation.
export type ThreadId = string & { readonly __brand: 'ThreadId' };

export const threadIdOf = (rootMessageId: string): ThreadId => contentHash(new TextEncoder().encode(rootMessageId)).slice(0, THREAD_ID_LENGTH) as ThreadId;
