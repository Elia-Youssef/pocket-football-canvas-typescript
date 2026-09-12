import { defineConfig } from 'vitest/config';

// The unit suite is headless and framework-free by construction: nothing it
// covers needs a browser, and anything that does belongs in tests/browser/.
// QUALITY-BAR section 13 splits the two harnesses on exactly that line.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // No global test API. Every helper is imported where it is used, so a file
    // that drifts out of the suite fails to resolve rather than failing to run.
    globals: false,
    // The lint fixtures are linted by a test, never collected as tests.
    exclude: ['node_modules/**', 'dist/**', 'tests/lint/**', '.determinism/**'],
    // NO SUITE-WIDE BUDGET HERE, DELIBERATELY. Five tests need more than the
    // default: two shell out to a real build, and three construct ESLint and
    // resolve the flat config, which measured 7.62 to 8.65 s on the cold module
    // graph a fresh install leaves and reddened the gate for a reason unrelated
    // to the code. Each of the five carries its own budget beside its own
    // measurement instead. Raising the default here would buy the same green at
    // the price of a suite that no longer notices anything hanging, and
    // core-boundary.test.ts asserts both halves: that this file has not grown a
    // default, and that the FIRST linter test of each file that loads one still
    // carries the budget, since that is the test which pays the cold graph.
  },
});
