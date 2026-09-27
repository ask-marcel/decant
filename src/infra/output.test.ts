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

  it('a control character in a message cannot move the terminal cursor, so an error is never hidden by its own text', () => {
    const written: string[] = [];
    process.stdout.write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };

    printLine('no such choice: \u001b[Au');

    expect(written).toEqual(['no such choice: [Au\n']);
  });

  it('a rendered block keeps its own newlines, so a picker still prints as lines', () => {
    const written: string[] = [];
    process.stdout.write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };

    printLine('Sites:\n\n  1) Espace Contoso');

    expect(written).toEqual(['Sites:\n\n  1) Espace Contoso\n']);
  });

  it('a name in another script is printed as it is, since only control characters are stripped', () => {
    const written: string[] = [];
    process.stdout.write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };

    printLine('  2) 工作组网站');

    expect(written).toEqual(['  2) 工作组网站\n']);
  });
});
