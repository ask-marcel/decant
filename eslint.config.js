import pluginJs from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import securityPlugin from 'eslint-plugin-security';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import unicornPlugin from 'eslint-plugin-unicorn';
import globals from 'globals';
import tsPlugin from 'typescript-eslint';

// `mock` from `bun:test` is process-global once installed and leaks into every other test file the
// runner loads. Use dependency injection (createXFromApi or installFetchMock) instead. See
// references/testing-infra.md. A const, because every layer zone below has to repeat it: ESLint
// replaces a rule's options when a second block matches the same file, it never merges them.
const MOCK_BAN = {
  name: 'bun:test',
  importNames: ['mock'],
  message:
    '`mock` from bun:test is forbidden — it leaks across test files. Use dependency injection: refactor the production code to accept the SDK as a parameter, then pass a fake at construction.',
};

// The style rules as lint (hard rules 1, 7, 10, 18). ESLint replaces a rule's options when a second
// block matches the same file, it never merges them, so every scoped `no-restricted-syntax` block
// below spreads this list before its own selector.
const STYLE_BANS = [
  { selector: 'ClassDeclaration', message: 'No class keyword (hard rule 1; rule 10 for error classes): a module of arrow functions and typed records.' },
  { selector: 'ClassExpression', message: 'No class keyword (hard rule 1): a module of arrow functions and typed records.' },
  { selector: 'ImportSpecifier[importKind="type"]', message: 'Type-only imports on their own line: `import type { Foo } from ...` (hard rule 7).' },
  {
    selector: 'VariableDeclarator[id.name!=/^create[A-Z]/] > ArrowFunctionExpression > ArrowFunctionExpression.body',
    message: 'No curried arrow chains: one arrow with all its parameters, wrapped at the call site; the DI factory `createX = (deps) => (input) => ...` is the one exemption (hard rule 18).',
  },
];
// Hard rule 17: a use case pattern-matches the Result a port returns; a catch there means the port lied.
const TRY_BAN = {
  selector: 'TryStatement',
  message: 'try/catch is quarantined to src/infra/**, the pure-domain fallback and src/main.ts; a use case pattern-matches the Result (hard rule 17).',
};
// Hard rule 20: file IO is Bun.file and Bun.write; node:fs only in tests, src/test-helpers/** and
// the one commented directory helper in src/infra/**.
const FS_BAN = {
  selector: 'ImportDeclaration[source.value=/^(node:)?fs(\\/promises)?$/]',
  message: 'File IO goes through Bun.file and Bun.write; node:fs only in tests, src/test-helpers/** and the one commented directory helper in src/infra/** (hard rule 20).',
};

// Bun's `toEqual` ignores an `undefined` array item, so `toEqual([])` passes on `[undefined]`, and
// mutants that left one in a result survived three times for it (lessons.archive.md, 2026-09-26).
// An empty array is asserted with a matcher that can fail. An empty array inside an object is left
// alone: the report notes hold one in nearly every scenario, and the trap there is rarer.
const EMPTY_EQUAL_BAN = {
  selector: "CallExpression[callee.property.name='toEqual'] > ArrayExpression[elements.length=0]",
  message: '`toEqual([])` passes on `[undefined]`: assert an empty array with `toStrictEqual([])` or `toHaveLength(0)`.',
};

// The dependency rule as lint (hard rule 37). Dependencies point inward, so each layer names the
// layers it may never import, and a layer left out of a list is one it may reach. Production files
// only: a test reaches for the fakes in src/test-helpers/ by design.
const layerZone = (layer, forbidden, files = [`src/${layer}/**/*.ts`]) => ({
  files,
  ignores: ['**/*.test.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [MOCK_BAN],
        patterns: [
          {
            group: forbidden.flatMap((name) => [`**/${name}`, `**/${name}/**`]),
            message: `src/${layer} must not import ${forbidden.join(', ')}: dependencies point inward (hard rule 37).`,
          },
        ],
      },
    ],
  },
});

/** @type {import('eslint').Linter.Config[]} */
export default [
  pluginJs.configs.recommended,
  ...tsPlugin.configs.recommended,
  securityPlugin.configs.recommended,
  {
    // Hard rule 15: no inline ignore, ever. Directive comments are inert AND each one is reported, so
    // the violation a comment tried to hide surfaces beside it. A finding is a refactor, or a
    // project-level severity change with a reason, never a suppression.
    linterOptions: { noInlineConfig: true },
  },
  {
    files: ['**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'func-style': ['error', 'expression'],
      // Rule 35: cyclomatic complexity at most 10 per function. The branches a function holds are
      // counted, a one-line chain of `&&`, `??` and ternaries included; the fix is never a bigger
      // number but a split, or a table to dispatch on.
      complexity: ['error', 10],
      'no-console': ['error'],
      'prefer-template': 'error',
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-restricted-imports': ['error', { paths: [MOCK_BAN] }],
      // Hard rules 1, 7, 10, 18 (STYLE_BANS above); the scoped blocks below add 17 and 20.
      'no-restricted-syntax': ['error', ...STYLE_BANS],
      // Hard rule 15, the other tools' escape hatches: every @ts- form (the recommended preset allows
      // a described @ts-expect-error) and the markers other tools read, anywhere in a comment.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }],
      'no-warning-comments': [
        'error',
        {
          terms: ['prettier-ignore', 'stryker disable', 'nosonar', 'sonar-ignore', 'snyk-ignore', 'deepcode ignore', 'biome-ignore', 'oxlint-disable', 'c8 ignore', 'v8 ignore', 'istanbul ignore'],
          location: 'anywhere',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
  },
  {
    // Hard rule 17 for the one layer where the count is zero; the domain fallback, the adapter catch
    // and the single catch in main.ts stay with review.
    files: ['src/use-cases/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...STYLE_BANS, TRY_BAN, FS_BAN] },
  },
  {
    // Hard rule 20 over the rest of src/**; the carve-outs are paths, never inline ignores.
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/test-helpers/**', 'src/infra/**', 'src/use-cases/**'],
    rules: { 'no-restricted-syntax': ['error', ...STYLE_BANS, FS_BAN] },
  },
  {
    // The one assertion that cannot fail where it matters (EMPTY_EQUAL_BAN above), in every test.
    files: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...STYLE_BANS, EMPTY_EQUAL_BAN] },
  },
  layerZone('domain', ['use-cases', 'infra', 'presenter', 'composition', 'test-helpers']),
  layerZone('use-cases', ['infra', 'presenter', 'composition', 'test-helpers']),
  layerZone('presenter', ['use-cases', 'infra', 'composition', 'test-helpers']),
  layerZone('infra', ['presenter', 'composition', 'test-helpers']),
  layerZone('composition', ['test-helpers']),
  // The fakes may reach the ports they stand for; an adapter is the one thing they may never wrap,
  // or the fake stops being a fake.
  layerZone('test-helpers', ['infra']),
  // The entry point sees the composition root and infra; it is still production code, so the fakes
  // stay out of it.
  layerZone('main.ts', ['test-helpers'], ['src/main.ts']),
  {
    // Gate scripts (scripts/check-coverage.ts, scripts/regenerate-coverage-preload.ts)
    // are terminal tools, not production code: their whole job is printing to the
    // console that invoked them. The Logger port (rule 4) governs src/**; injecting
    // Winston into a pre-commit gate would be ceremony without observability value.
    // Project-level severity change with a comment — never an inline ignore (rule 15).
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // Type-aware rules — slow (~25s on full repo), enabled only by
  // `bun run lint:strict` (which sets LINT_STRICT=1) and the pre-commit hook.
  // Inner-loop `bun run lint` does NOT run them.
  ...(process.env['LINT_STRICT']
    ? [
        {
          files: ['src/**/*.ts'],
          languageOptions: {
            parserOptions: {
              projectService: true,
              tsconfigRootDir: import.meta.dirname,
            },
          },
          rules: {
            // Lint-time equivalents of Sonar S4325 (no `!`/`as` non-narrowing assertions)
            // and S6671 (Promise.reject must be an Error).
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/prefer-promise-reject-errors': 'error',
          },
        },
      ]
    : []),
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': [
        1,
        {
          endOfLine: 'lf',
          printWidth: 180,
          semi: true,
          singleQuote: true,
          tabWidth: 2,
          trailingComma: 'es5',
        },
      ],
    },
  },
  {
    plugins: { unicorn: unicornPlugin },
    rules: {
      'unicorn/empty-brace-spaces': 'off',
      'unicorn/no-null': 'off',
    },
  },
  {
    rules: {
      // false-positive-heavy rules in this codebase's idioms; disabled at project level.
      // Never inline-ignore — change severity here or refactor the code.
      'security/detect-object-injection': 'off',
      'security/detect-unsafe-regex': 'off',
      // detect-non-literal-fs-filename flags `chmodSync(mkdtempSync(...))` in FS-adapter
      // tests. Production code uses Bun.file (not flagged by this rule), so disabling
      // globally loses nothing on the real attack surface.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  sonarjsPlugin.configs.recommended,
  {
    // SonarJS rule overrides — always-on, justified per rule. See LESSONS.md.
    rules: {
      'sonarjs/no-unused-vars': 'off', // duplicates @typescript-eslint/no-unused-vars
      'sonarjs/no-empty-test-file': 'off', // false positives on `describe` test layout
      'sonarjs/cognitive-complexity': 'off', // we already cap function size; this is noise
    },
  },
  {
    // A test asserting URL-formatting behaviour (e.g. kb-document.test.ts's plain-http case)
    // needs a literal http:// as inert fixture data, never a real outbound call. Scoped to
    // *.test.ts only, so the rule still catches a real hardcoded insecure endpoint in src/**.
    // Project-level severity change with a comment — never an inline ignore (rule 15).
    files: ['**/*.test.ts'],
    rules: { 'sonarjs/no-clear-text-protocols': 'off' },
  },
  // Non-source paths must not be linted: Stryker copies the tree into .stryker-tmp/
  // during a run, reports/ is output, and the config file itself would trip no-undef
  // on `process` (it runs under Node semantics, not the **/*.ts globals block).
  // scripts/ IS linted — the gate scripts stay under the full rule set, with only
  // no-console turned off for them above.
  {
    ignores: ['eslint.config.js', '.stryker-tmp/**', 'reports/**', 'docs/**', '.claude/**', '.agents/**', 'kb/**'],
  },
];
