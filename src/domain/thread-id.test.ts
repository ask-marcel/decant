import { describe, expect, it } from 'bun:test';
import { THREAD_ID_LENGTH, threadIdOf } from './thread-id.ts';

// Unbrands a value so it can be compared with a plain literal, as `kb-path.test.ts` does.
const text = (value: string): string => value;

const ROOT = '<FRRPR05MB13141@outlook.com>';

describe('identifying the thread a message belongs to', () => {
  it('two mails pointing at the same root belong to one thread', () => {
    expect(threadIdOf(ROOT)).toBe(threadIdOf(ROOT));
  });

  it('two different roots never share a thread', () => {
    expect(threadIdOf(ROOT)).not.toBe(threadIdOf('<other@outlook.com>'));
  });

  it('an id is ten hex characters, however long the root it came from', () => {
    expect(threadIdOf('x')).toMatch(/^[0-9a-f]{10}$/);
    expect(threadIdOf(ROOT)).toHaveLength(THREAD_ID_LENGTH);
  });

  // Pinned to a literal rather than recomputed: the id is a folder name that is written once and
  // never rebuilt, so an algorithm that quietly changed would file every thread already held a
  // second time. This is the assertion that would catch it.
  it('the same root gives the same id, run after run and version after version', () => {
    expect(text(threadIdOf(ROOT))).toBe('5461bae9fa');
    expect(text(threadIdOf('<other@outlook.com>'))).toBe('38f4e5adb0');
  });
});
