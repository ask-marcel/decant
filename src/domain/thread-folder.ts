import { safeSegment } from './kb-path.ts';
import type { SafeSegment } from './kb-path.ts';
import { THREAD_ID_LENGTH } from './thread-id.ts';
import type { ThreadId } from './thread-id.ts';

// `2026-06-11-d9f4e0a3c1-rimowa-tw-store-opening`: the day sorts, the id identifies, the slug reads.
// All three are settled once, from the root message, and none is ever recomputed. A reply arriving
// two years later moves nothing, so anything already pointing at the folder keeps working.
export const threadFolderName = (day: string, threadId: ThreadId, slug: string): SafeSegment => safeSegment(`${day}-${threadId}-${slug}`);

// Every day is written to this width, `0000-00-00` included, so the id sits at a fixed offset.
const DAY_WIDTH = 10;

const ID_AT = DAY_WIDTH + 1;

const HEX = /^[0-9a-f]+$/;

export const threadIdInFolder = (name: string): ThreadId | undefined => {
  const id = name.slice(ID_AT, ID_AT + THREAD_ID_LENGTH);
  return id.length === THREAD_ID_LENGTH && HEX.test(id) ? (id as ThreadId) : undefined;
};

// Resolve before you create: never build a path and assume it is new. Matching on the id alone is
// what makes every other part of the name safe to be wrong. Timezone drift, clock skew, and a slug
// someone later decides to improve all leave the id untouched, so none of them can produce a second
// folder for a thread that is already held.
export const findThreadFolder = (names: ReadonlyArray<string>, threadId: ThreadId): string | undefined => names.find((name) => threadIdInFolder(name) === threadId);
