import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * An assertion inventory over the browser gate, which is the measured half of
 * item A2.
 *
 * WHY THIS EXISTS. Every other gate here is graded by breaking it and watching
 * something go red. That method does not work on a test suite, because gutting
 * a test makes it PASS: emptying the forbidden-token list, or reducing the
 * off-origin comparison to something that can never be true, leaves all twelve
 * browser tests green and the checklist still cross-referencing them by name.
 * A suite that asserts nothing is the exact failure QUALITY-BAR section 13 was
 * written about, and there is no run of that suite that can detect it.
 *
 * WHY IT IS BRITTLE, STATED PLAINLY. This reads the spec file as text. It
 * cannot tell a real assertion from one that happens to contain the same
 * characters, and a legitimate refactor that renames `offOrigin` or reflows the
 * forbidden list will fail it. That is the price of grading a suite that passes
 * when it stops asserting, and the failure mode is loud and one line to fix
 * rather than silent. It is a second line of defence and not the first: the
 * Inspection-layer backstop is the build checklist, which tells the reviewer to
 * read these four test bodies rather than the run summary.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const SPEC = path.join(PROJECT_ROOT, 'tests', 'browser', 'scaffold.spec.ts');
const source = readFileSync(SPEC, 'utf8');

function titles(): string[] {
  return [...source.matchAll(/\btest\('([^']+)'/g)].map((match) => match[1] ?? '');
}

function requires(fragment: string, why: string): void {
  expect(source.includes(fragment), `${why}: ${fragment}`).toBe(true);
}

describe('PF-0 browser gate inventory, item A2', () => {
  it('declares exactly the four checks the build checklist cross-references', () => {
    expect(titles()).toEqual([
      'serves the built bundle and runs the compiled entry, with a clean console',
      'requests nothing beyond the host it was served from',
      'emits only relative references',
      'leaves no environment value or configuration hook in the built files',
    ]);
  });

  it('keeps the served-and-ran check asserting a status, the marker and a clean console', () => {
    requires('response?.status()).toBe(200)', 'the response status is asserted');
    requires("'data-game'", 'the marker attribute is named');
    requires("'pocket-football'", 'the marker value is asserted');
    requires('expect(consoleErrors).toEqual([])', 'console errors are asserted empty');
    requires('expect(pageErrors).toEqual([])', 'page errors are asserted empty');
  });

  it('keeps the off-origin check comparing origins for real', () => {
    // The neutering to beat here is a condition that can never be true, which
    // leaves offOrigin empty and the assertion below trivially satisfied.
    requires(
      'new URL(url).origin !== origin',
      'the request origin is compared against the page origin',
    );
    requires('expect(offOrigin).toEqual([])', 'off-origin requests are asserted empty');
  });

  it('keeps the relative-reference check rejecting both absolute forms', () => {
    requires("reference.startsWith('/')", 'a host-absolute reference is rejected');
    requires('/^[a-z][a-z0-9+.-]*:/i.test(reference)', 'a scheme is rejected');
  });

  it('keeps the configuration check naming every token and a floor on emitted files', () => {
    requires("'process.env'", 'process.env is forbidden in the output');
    requires("'import.meta.env'", 'import.meta.env is forbidden in the output');
    requires("'VITE_'", 'a VITE_ prefixed value is forbidden in the output');
    requires(
      'files.length).toBeGreaterThan(1)',
      'an empty or single-file dist cannot satisfy the check by accident',
    );
  });
});
