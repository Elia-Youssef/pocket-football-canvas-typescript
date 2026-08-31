import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * PF-0's browser gate: the measured half of item A2, "ships as a static bundle
 * requiring no server, no runtime configuration and no build-time secrets".
 *
 * A2 is an Inspection item, so the verdict is a person's, recorded against
 * docs/review-checklists/build.md. These four tests are what that person is
 * inspecting rather than re-deriving: they run on all three engines, on the
 * BUILT bundle served by `vite preview`, and the checklist cross-references
 * each one by name. Reading a green badge is not an inspection, and asserting
 * nothing is not a test.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const DIST = path.join(PROJECT_ROOT, 'dist');

/** Every emitted file, with no extension filter: an unchecked file can differ. */
function emittedFiles(): string[] {
  const found: string[] = [];
  const stack = [DIST];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        found.push(absolute);
      }
    }
  }
  return found.sort();
}

test.describe('PF-0 scaffold', () => {
  test('serves the built bundle and runs the compiled entry, with a clean console', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    // The marker only exists if the compiled module actually ran, so this is
    // the difference between serving a bundle and running one.
    await expect(page.locator('html')).toHaveAttribute(
      'data-game',
      'pocket-football',
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('requests nothing beyond the host it was served from', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const origin = new URL(baseURL ?? '').origin;
    const offOrigin: string[] = [];

    page.on('request', (request) => {
      const url = request.url();
      if (!/^https?:/i.test(url)) {
        return;
      }
      if (new URL(url).origin !== origin) {
        offOrigin.push(url);
      }
    });

    await page.goto('/');
    // A starvation budget, not a correctness one: idleness detection can be
    // starved for minutes when the whole suite runs beside a build, and the
    // listener above has been recording since before the navigation, so a
    // longer wait only ever catches MORE late requests. The suite was 12
    // tests when this wait was written and is over ten times that now.
    await page.waitForLoadState('networkidle', { timeout: 120_000 });

    // QUALITY-BAR section 9: no telemetry, no analytics, no third-party
    // request of any kind at runtime. SPEC section 21 says the same.
    expect(offOrigin).toEqual([]);
  });

  test('emits only relative references', () => {
    const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const references = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(
      (match) => match[1] ?? '',
    );
    expect(references.length).toBeGreaterThan(0);

    for (const reference of references) {
      // A host-absolute reference works from a host root and breaks from a
      // subdirectory, which passes a naive check and fails a real deployment.
      expect(
        reference.startsWith('/'),
        `${reference} is host-absolute`,
      ).toBe(false);
      expect(
        /^[a-z][a-z0-9+.-]*:/i.test(reference),
        `${reference} carries a scheme`,
      ).toBe(false);
    }
  });

  test('leaves no environment value or configuration hook in the built files', () => {
    const files = emittedFiles();
    // Two or more: an empty or single-file dist would pass every assertion
    // below for the wrong reason.
    expect(files.length).toBeGreaterThan(1);

    const forbidden = ['process.env', 'import.meta.env', 'VITE_'];
    for (const file of files) {
      if (statSync(file).size > 2_000_000) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        expect(
          text.includes(needle),
          `${path.relative(DIST, file)} contains ${needle}`,
        ).toBe(false);
      }
    }
  });
});
