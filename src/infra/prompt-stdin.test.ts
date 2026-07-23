import { afterEach, describe, expect, it } from 'bun:test';
import { createStdinPrompt } from './prompt-stdin.ts';

const originalWrite = process.stdout.write.bind(process.stdout);
const written: string[] = [];

const capture = (): void => {
  written.length = 0;
  process.stdout.write = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
};

const linesOf = (...answers: ReadonlyArray<string>): (() => AsyncIterable<string>) =>
  async function* generate() {
    yield* answers;
  };

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe('asking the operator a question on the terminal', () => {
  it('the answer typed back is taken, without the newline', async () => {
    capture();

    expect(await createStdinPrompt(linesOf('  2  ', '3')).ask('Source:')).toBe('2');
  });

  it('the question is printed before the answer is waited for', async () => {
    capture();
    await createStdinPrompt(linesOf('1')).ask('Libraries:');

    expect(written).toContain('Libraries: ');
  });

  it('a closed terminal answers nothing rather than hanging the run', async () => {
    capture();

    expect(await createStdinPrompt(linesOf()).ask('Source:')).toBe('');
  });

  it('what the operator is shown goes to stdout', () => {
    capture();
    createStdinPrompt(linesOf()).show('SharePoint sites you can read:');

    expect(written).toContain('SharePoint sites you can read:\n');
  });
});
