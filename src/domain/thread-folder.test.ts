import { describe, expect, it } from 'bun:test';
import type { ThreadId } from './thread-id.ts';
import { findThreadFolder, threadFolderName, threadIdInFolder } from './thread-folder.ts';

// Unbrands a value so it can be compared with a plain literal, as `kb-path.test.ts` does.
const text = (value: string): string => value;

const ID = 'd9f4e0a3c1' as ThreadId;
const OTHER = '5461bae9fa' as ThreadId;

describe('naming the folder a thread lives in', () => {
  it('a folder carries the day a thread began, its id, and what it is about', () => {
    expect(text(threadFolderName('2026-06-11', ID, 'rimowa-tw-store-opening'))).toBe('2026-06-11-d9f4e0a3c1-rimowa-tw-store-opening');
  });

  it('a name a filesystem could not hold is made safe before it becomes a path', () => {
    expect(text(threadFolderName('2026-06-11', ID, 'a/b'))).toBe('2026-06-11-d9f4e0a3c1-a_b');
  });
});

describe('finding the folder a thread already has', () => {
  // Matched on the id alone, which is what makes the rest of the name free to be wrong. Timezone
  // drift, clock skew and a slug someone later wants to improve all leave the id untouched, so none
  // of them can produce a second folder for a thread already held.
  it('a folder already holding a thread is found by its id, whatever date or subject it was named with', () => {
    const held = ['2024-01-02-d9f4e0a3c1-an-older-name-entirely', '2026-06-11-5461bae9fa-something-else'];

    expect(findThreadFolder(held, ID)).toBe('2024-01-02-d9f4e0a3c1-an-older-name-entirely');
  });

  it('a folder belonging to another thread is not mistaken for this one', () => {
    expect(findThreadFolder(['2026-06-11-5461bae9fa-something-else'], ID)).toBeUndefined();
  });

  it('a thread with no folder yet is reported as having none, rather than borrowing one', () => {
    expect(findThreadFolder([], ID)).toBeUndefined();
  });

  it('an id is read out of a folder name by where it sits, after the day', () => {
    expect(threadIdInFolder('2026-06-11-d9f4e0a3c1-rimowa-tw-store-opening')).toBe(ID);
    expect(threadIdInFolder(threadFolderName('0000-00-00', OTHER, 'no-subject'))).toBe(OTHER);
  });

  it('a folder that is not a thread folder at all is passed over rather than half read', () => {
    expect(threadIdInFolder('_images')).toBeUndefined();
    expect(threadIdInFolder('2026-06-11-NOTHEXAAA-something')).toBeUndefined();
    expect(threadIdInFolder('2026-06-11-d9f4e0a3-too-short')).toBeUndefined();
    // A tail that reads as hex while the head does not, and a name too short to hold an id at all.
    // Both would pass a check that looked anywhere in the segment, or that only checked its shape.
    expect(threadIdInFolder('2026-06-11-ZZZZ123456-something')).toBeUndefined();
    expect(threadIdInFolder('2026-06-11-abc')).toBeUndefined();
  });
});
