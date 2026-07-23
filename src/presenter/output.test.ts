import { afterEach, describe, expect, it } from 'bun:test';
import { printLine } from './output.ts';

const originalWrite = process.stdout.write.bind(process.stdout);

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe('printing what the operator asked to see', () => {
  it('a rendered line reaches stdout with its newline', () => {
    const written: string[] = [];
    process.stdout.write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };

    printLine('Already synced:');

    expect(written).toEqual(['Already synced:\n']);
  });
});
