// The child process `convert-in-child.ts` starts for each conversion: it reads the parameters of
// `convert-local-file-to-markdown` as JSON on its standard input, runs the command through the
// library, and writes the result as JSON on its standard output. A conversion that throws is written
// as a failed result, so the parent always reads a result from a child that ended on its own.
import { commands, createBunFileSystem } from 'ask-marcel-office-cli';
import { formatError } from '../domain/utilities/format-error.ts';

const failed = (message: string): string => JSON.stringify({ ok: false, error: { type: 'api_error', message } });

export const answerConversion = async (input: string): Promise<string> => {
  try {
    const params: unknown = JSON.parse(input);
    const command = commands['convert-local-file-to-markdown'];
    if (command?.executeLocal === undefined) return failed('the library has no convert-local-file-to-markdown');
    return JSON.stringify(await command.executeLocal(createBunFileSystem(), params as Record<string, string>));
  } catch (error) {
    return failed(formatError(error));
  }
};

// Run only when started as the child, so a module that imports this file converts nothing.
if (import.meta.main) await Bun.write(Bun.stdout, await answerConversion(await Bun.stdin.text()));
