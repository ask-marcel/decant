import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesUnder } from './check-mutation-files.ts';

const mutants = (counts: Readonly<Record<string, number>>): ReadonlyArray<{ readonly status: string }> =>
  Object.entries(counts).flatMap(([status, count]) => Array.from({ length: count }, () => ({ status })));

describe('holding each mutated file to the break, not only their total', () => {
  it('a file under the break is named even when the run as a whole passes', () => {
    const report = { files: { 'src/domain/strong.ts': { mutants: mutants({ Killed: 30 }) }, 'src/use-cases/weak.ts': { mutants: mutants({ Killed: 8, Survived: 2 }) } } };

    expect(filesUnder(report, 90)).toStrictEqual([{ file: 'src/use-cases/weak.ts', score: 80, detected: 8, valid: 10 }]);
  });

  it('a timeout counts as caught and a mutant no test reached as missed, the way Stryker scores them', () => {
    const atTheLine = { files: { 'src/domain/a.ts': { mutants: mutants({ Killed: 8, Timeout: 1, NoCoverage: 1 }) } } };
    const under = { files: { 'src/domain/a.ts': { mutants: mutants({ Killed: 8, Timeout: 1, NoCoverage: 2 }) } } };

    expect(filesUnder(atTheLine, 90)).toStrictEqual([]);
    expect(filesUnder(under, 90)).toStrictEqual([{ file: 'src/domain/a.ts', score: (9 / 11) * 100, detected: 9, valid: 11 }]);
  });

  it('mutants that never ran count for nothing', () => {
    const report = {
      files: {
        'src/domain/a.ts': { mutants: mutants({ Killed: 9, Survived: 1, CompileError: 5, RuntimeError: 1, Ignored: 4 }) },
        'src/domain/b.ts': { mutants: mutants({ CompileError: 2 }) },
      },
    };

    expect(filesUnder(report, 90)).toStrictEqual([]);
  });

  it('run on a report, the check exits non-zero and names the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutation-report-'));
    const run = (files: Readonly<Record<string, Readonly<Record<string, number>>>>): { readonly code: number; readonly out: string } => {
      const path = join(dir, 'mutation.json');
      writeFileSync(path, JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([file, counts]) => [file, { mutants: mutants(counts) }])) }));
      const ran = Bun.spawnSync(['bun', 'run', 'scripts/check-mutation-files.ts', path], { cwd: join(import.meta.dir, '..') });
      return { code: ran.exitCode, out: ran.stdout.toString() };
    };

    try {
      const failing = run({ 'src/domain/strong.ts': { Killed: 30 }, 'src/use-cases/weak.ts': { Killed: 8, Survived: 2 } });
      const passing = run({ 'src/domain/strong.ts': { Killed: 30 } });

      expect(failing.code).toBe(1);
      expect(failing.out).toContain('src/use-cases/weak.ts');
      expect(failing.out).not.toContain('src/domain/strong.ts');
      expect(passing.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
