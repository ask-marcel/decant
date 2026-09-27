import { beforeAll, describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

// Every gate proves it can fail. Each fixture below is a violation the config must reject, linted
// through the real `eslint.config.js` under a path the rule governs, so a change to the config or a
// toolchain upgrade that quietly switches a gate off turns this suite red rather than leaving the
// gate seen only ever green.
const eslint = new ESLint({ cwd: import.meta.dir });

// Loading the config and its plugins takes seconds, near the default time a test is allowed, so it is
// paid once here, with room to spare, before any fixture is linted.
const LOADING_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await eslint.lintText('', { filePath: 'src/domain/warm-up.ts' });
}, LOADING_TIMEOUT_MS);

const rulesBrokenBy = async (code: string, filePath: string): Promise<ReadonlyArray<string>> => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'parse');
};

// A function holding `branches` decisions, one `if` each, so its complexity is one more than that.
const branchy = (branches: number): string =>
  [
    'export const pick = (value: number): number => {',
    ...Array.from({ length: branches }, (_, index) => `  if (value === ${index}) return ${index};`),
    '  return -1;',
    '};',
    '',
  ].join('\n');

const importing = (specifier: string): string => `import { thing } from '${specifier}';\n\nexport const used = thing;\n`;

describe('holding every function to ten branches', () => {
  it('a function with eleven paths through it is refused, and one with ten is not', async () => {
    expect(await rulesBrokenBy(branchy(10), 'src/domain/fixture.ts')).toContain('complexity');
    expect(await rulesBrokenBy(branchy(9), 'src/domain/fixture.ts')).not.toContain('complexity');
  });
});

describe('keeping every layer to what it may import', () => {
  it('each layer is refused the layers outside it', async () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ['src/domain/fixture.ts', '../use-cases/ports/drive-reader.ts'],
      ['src/use-cases/fixture.ts', '../presenter/render-picker.ts'],
      ['src/use-cases/fixture.ts', '../infra/output.ts'],
      ['src/presenter/fixture.ts', '../use-cases/sync-site.ts'],
      ['src/infra/fixture.ts', '../presenter/render-picker.ts'],
      ['src/composition/fixture.ts', '../test-helpers/files-fake.ts'],
      ['src/test-helpers/fixture.ts', '../infra/output.ts'],
      ['src/main.ts', './test-helpers/files-fake.ts'],
    ];

    for (const [file, specifier] of refused) {
      expect({ file, specifier, rules: await rulesBrokenBy(importing(specifier), file) }).toMatchObject({ rules: expect.arrayContaining(['no-restricted-imports']) });
    }
  });

  it('what points inward is let through, and a test may still reach for the fakes', async () => {
    expect(await rulesBrokenBy(importing('../domain/result.ts'), 'src/use-cases/fixture.ts')).not.toContain('no-restricted-imports');
    expect(await rulesBrokenBy(importing('../use-cases/ports/files.ts'), 'src/infra/fixture.ts')).not.toContain('no-restricted-imports');
    expect(await rulesBrokenBy(importing('../test-helpers/files-fake.ts'), 'src/use-cases/fixture.test.ts')).not.toContain('no-restricted-imports');
  });

  it('inside a layer, `mock` from bun:test is refused all the same', async () => {
    expect(await rulesBrokenBy("import { mock } from 'bun:test';\n\nexport const used = mock;\n", 'src/use-cases/fixture.ts')).toContain('no-restricted-imports');
  });
});

describe('holding the style rules as lint', () => {
  it('a class, an inline type import and a curried chain are refused, and a createX factory is the one chain allowed', async () => {
    expect(await rulesBrokenBy('export class Thing {}\n', 'src/domain/fixture.ts')).toContain('no-restricted-syntax');
    expect(
      await rulesBrokenBy("import { type Result } from './result.ts';\n\nexport const none: Result<number, string> | undefined = undefined;\n", 'src/domain/fixture.ts')
    ).toContain('no-restricted-syntax');
    expect(await rulesBrokenBy('export const add = (a: number) => (b: number): number => a + b;\n', 'src/domain/fixture.ts')).toContain('no-restricted-syntax');
    expect(await rulesBrokenBy('export const createAdd = (a: number) => (b: number): number => a + b;\n', 'src/domain/fixture.ts')).not.toContain('no-restricted-syntax');
  });

  it('a try in a use case, and node:fs outside infra, are refused, and infra may use both', async () => {
    const guarded = 'export const safely = (run: () => void): boolean => {\n  try {\n    run();\n    return true;\n  } catch {\n    return false;\n  }\n};\n';
    const readsDisk = "import { readFileSync } from 'node:fs';\n\nexport const read = (path: string): string => readFileSync(path, 'utf8');\n";

    expect(await rulesBrokenBy(guarded, 'src/use-cases/fixture.ts')).toContain('no-restricted-syntax');
    expect(await rulesBrokenBy(guarded, 'src/infra/fixture.ts')).not.toContain('no-restricted-syntax');
    expect(await rulesBrokenBy(readsDisk, 'src/domain/fixture.ts')).toContain('no-restricted-syntax');
    expect(await rulesBrokenBy(readsDisk, 'src/use-cases/fixture.ts')).toContain('no-restricted-syntax');
    expect(await rulesBrokenBy(readsDisk, 'src/infra/fixture.ts')).not.toContain('no-restricted-syntax');
  });
});

describe('leaving no way to silence a gate', () => {
  it('a comment disabling a rule does nothing, so the violation it hid is still reported', async () => {
    expect(await rulesBrokenBy(`// eslint-disable-next-line complexity\n${branchy(10)}`, 'src/domain/fixture.ts')).toContain('complexity');
  });

  it("a @ts- comment, and another tool's ignore marker, are refused", async () => {
    expect(await rulesBrokenBy('// @ts-expect-error: nothing to expect\nexport const one: number = 1;\n', 'src/domain/fixture.ts')).toContain('@typescript-eslint/ban-ts-comment');
    expect(await rulesBrokenBy('// istanbul ignore next\nexport const one = 1;\n', 'src/domain/fixture.ts')).toContain('no-warning-comments');
  });
});
