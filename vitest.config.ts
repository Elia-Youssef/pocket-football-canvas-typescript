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
  },
});
