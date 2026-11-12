import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands, createBunFileSystem } from 'ask-marcel-office-cli';
import type { ChildProcess, SpawnChild } from './convert-in-child.ts';
import { createBunSpawn, createChildConversion } from './convert-in-child.ts';

const scratch = mkdtempSync(join(tmpdir(), 'decant-convert-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// A child that answers at once with what it is told, and keeps what it was asked and whether it was
// stopped, so a test can read both after the conversion.
type Seen = { input?: string; copy?: string; killed: boolean };

const answering = (stdout: string, seen: Seen = { killed: false }, exitCode = 0, stderr = ''): SpawnChild => {
  const spawn: SpawnChild = (_command, input) => {
    seen.input = input;
    const params: unknown = JSON.parse(input);
    const path = typeof params === 'object' && params !== null && 'path' in params ? String(params.path) : '';
    seen.copy = readFileSync(path, 'utf8');
    return { stdout: Promise.resolve(stdout), stderr: Promise.resolve(stderr), exited: Promise.resolve(exitCode), kill: () => undefined };
  };
  return spawn;
};

// A child that never finishes on its own, the way SheetJS does on a workbook of millions of cells,
// and ends only when it is stopped.
const stalled = (seen: Seen): SpawnChild => {
  const spawn: SpawnChild = () => stalledChild(seen);
  return spawn;
};

const stalledChild = (seen: Seen): ChildProcess => {
  let end: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    end = resolve;
  });
  const child: ChildProcess = {
    stdout: exited.then(() => ''),
    stderr: exited.then(() => ''),
    exited,
    kill: () => {
      seen.killed = true;
      end?.(137);
    },
  };
  return child;
};

const TABLE = '| Poste | Montant |\n| --- | --- |\n| Loyer | 1200 |';
const CSV = new TextEncoder().encode('Poste,Montant\nLoyer,1200\n');

describe('converting a file in a child process with a time limit', () => {
  it('a workbook that converts in time gives its text, from a copy that keeps its extension', async () => {
    const seen: Seen = { killed: false };
    const convert = createChildConversion({ spawn: answering(JSON.stringify({ ok: true, value: { text: TABLE } }), seen), timeoutMs: 1_000, scratch });

    const converted = await convert.bytes(CSV, 'Budget 2026.csv', { includeMetadata: 'true' });

    expect(converted).toEqual({ ok: true, value: { text: TABLE } });
    expect(seen.copy).toBe('Poste,Montant\nLoyer,1200\n');
    expect(JSON.parse(seen.input ?? '{}')).toMatchObject({ includeMetadata: 'true' });
    expect(String(JSON.parse(seen.input ?? '{}').path).endsWith('.csv')).toBe(true);
  });

  it('a conversion that passes the time limit is stopped and fails with the limit as its reason', async () => {
    const seen: Seen = { killed: false };
    const convert = createChildConversion({ spawn: stalled(seen), timeoutMs: 20, scratch });

    const converted = await convert.path({ path: 'kb/Finance/Raw Data.xlsx' });

    expect(seen.killed).toBe(true);
    expect(converted).toEqual({ ok: false, error: { type: 'api_error', message: 'the conversion took longer than 0.02 s and was stopped' } });
  });

  it('a conversion that crashes, out of memory, fails with its exit code and the last line it wrote', async () => {
    const convert = createChildConversion({ spawn: answering('', { killed: false }, 3, 'loading workbook\nRangeError: Out of memory\n'), timeoutMs: 1_000, scratch });

    const converted = await convert.bytes(CSV, 'Raw Data.csv', {});

    expect(converted).toEqual({ ok: false, error: { type: 'api_error', message: 'the conversion stopped with exit code 3: RangeError: Out of memory' } });
  });

  it('the copy written for a conversion is removed afterwards, also when the conversion was stopped', async () => {
    await createChildConversion({ spawn: answering(JSON.stringify({ ok: true, value: { text: TABLE } })), timeoutMs: 1_000, scratch }).bytes(CSV, 'Budget.csv', {});
    await createChildConversion({ spawn: stalled({ killed: false }), timeoutMs: 20, scratch }).bytes(CSV, 'Raw Data.csv', {});

    expect(readdirSync(scratch)).toHaveLength(0);
  });

  it('the real child converts a spreadsheet to the same table the library gives in this process', async () => {
    const own = mkdtempSync(join(tmpdir(), 'decant-convert-real-'));
    const convert = createChildConversion({ spawn: createBunSpawn(), timeoutMs: 30_000, scratch: own });

    const converted = await convert.bytes(CSV, 'Budget.csv', { includeMetadata: 'true' });
    const path = join(own, 'Budget.csv');
    await Bun.write(path, CSV);
    const inProcess = await commands['convert-local-file-to-markdown']?.executeLocal?.(createBunFileSystem(), { path, includeMetadata: 'true' });
    rmSync(own, { recursive: true, force: true });

    expect(converted).toEqual(JSON.parse(JSON.stringify(inProcess)));
  }, 30_000);
});
