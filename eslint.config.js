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
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
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
