import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import coreBoundary from './tools/eslint-plugin-core-boundary/index.js';

// Node's globals, written out rather than pulled from a dependency. Only the
// tooling files get them; nothing under src/ does, which is what leaves a
// platform reference inside core visible to the boundary rules as an
// unresolved name.
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

// Everything the two inherited configurations turn on, collapsed to a single
// record so the fixture block can switch all of it off by name. Derived rather
// than listed, because a hand-written copy of somebody else's rule set drifts
// the first time they add a rule, and the fixtures would start reporting a
// message the boundary test never asked for.
const INHERITED = Object.assign(
  {},
  ...[js.configs.recommended, ...tseslint.configs.recommended].map(
    (entry) => entry.rules ?? {},
  ),
);
const INHERITED_OFF = Object.fromEntries(
  Object.keys(INHERITED).map((name) => [name, 'off']),
);

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'blob-report/**',
      '.determinism/**',
      'artifacts/**',
      'node_modules/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Item M3. Applied to every file the project lints, in every extension a
  // module can arrive in, and NOT scoped by a glob: each rule reads the path
  // itself and stays inert outside core. A glob is one edit away from being
  // wrong, and a rule that is scoped twice is scoped in whichever place a
  // reader does not look.
  {
    // Every extension the plugin's own specifier reader knows how to strip,
    // jsx included. A gap here is not a weaker rule, it is no rule at all: an
    // unmatched file is never linted, so a core module in the missing
    // extension would call Math.random with nothing to say about it.
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { 'core-boundary': coreBoundary },
    rules: {
      'core-boundary/no-forbidden-imports': 'error',
      'core-boundary/no-dom': 'error',
      'core-boundary/no-math-random': 'error',
    },
  },

  // A violating line inside core may not switch off its own detection.
  // Without this, the whole of item M3 is worth one comment.
  {
    files: ['**/core/**'],
    linterOptions: { noInlineConfig: true },
  },

  {
    files: [
      'scripts/**',
      'tools/**',
      'tests/**',
      'eslint.config.js',
      '*.config.ts',
    ],
    languageOptions: { globals: NODE_GLOBALS },
  },

  // Ambient declarations describe what another file exports; the unused-name
  // rules have nothing to say about them.
  {
    files: ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // The lint fixtures are input to a test, not source. Every inherited rule is
  // off inside them so the only messages they can produce are the boundary
  // rules' own, which is what lets the boundary test assert in both
  // directions: every marked line reported, and nothing else reported at all.
  {
    files: ['tests/lint/fixtures/**'],
    rules: INHERITED_OFF,
  },
];
