import { defineConfig, devices } from '@playwright/test';

import { PREVIEW_PORT } from './vite.config';

// The browser gate runs against the BUILT bundle served by `vite preview`,
// never against the dev server: the dev server transforms modules on request
// and injects a client, so a suite driven from it says nothing about what
// ships. `npm run test:browser` builds first, and the server below serves the
// result of that build.
//
// One origin, one port, and strictPort. A stale preview from another project
// answering on a shared port would be reused silently and the suite would pass
// against somebody else's bundle.
const BASE_URL = `http://localhost:${String(PREVIEW_PORT)}/`;

// Three engines, which is PART of what STACK section 6 asks for. That table
// names five automated targets: Chromium, Firefox and WebKit, plus the Chrome
// and Edge stable channels. The two channels are deferred to PF-20, the browser
// matrix part, because they need an installed channel rather than a downloaded
// engine and nothing here yet exercises a difference between them. Until then
// this file covers three of five and says so.
//
// Playwright's `webkit` is a WebKit build and NOT Safari, and it cannot drive
// iOS: QUALITY-BAR section 2 puts real Safari, iOS and Android on the release
// gate, and no check here may claim otherwise.
const ENGINES = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
] as const;

/**
 * The tag a test carries when it DRIVES A MATCH rather than looking at one.
 *
 * WHY THE SPLIT EXISTS, MEASURED. A driven test installs the page's clock and
 * hands the frame driver a quarter of a second at a time, so a whole match is a
 * few thousand round trips to the browser rather than a few dozen. Run at the
 * default parallelism those tests saturate the machine and starve each other:
 * every one of them, and several tests that do nothing but click, timed out at
 * four minutes when the whole set ran together on this machine, where the same
 * test passes alone in five seconds. Round trips are the resource, so the
 * driven tests are given a phase of their own with ONE worker per engine, and
 * `dependencies` is what keeps that phase out of the way of the parallel one
 * rather than beside it.
 *
 * EVERY DRIVEN PROJECT WAITS FOR EVERY PARALLEL ONE, not merely for its own
 * engine, and that is the difference between a green run and a starved one:
 * with each waiting only on its own engine, the first engine's driven phase
 * runs BESIDE the other two engines' parallel phases, and the whole suite is
 * back to competing for the same round trips. Measured on this machine: with
 * the narrow dependency, sixteen tests that pass alone in seconds timed out at
 * four minutes; with this one, the phases do not overlap at all.
 *
 * The tag is on tests and not on files, because the same file usually holds one
 * driven test and several that only look: splitting by file would serialise
 * work that has no reason to be serial.
 */
const DRIVEN = /@drive/;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    // The parallel phase: everything that is not driving a match.
    ...ENGINES.map((engine) => ({
      name: engine.name,
      use: { ...engine.device },
      grepInvert: DRIVEN,
    })),
    // The driven phase, one worker per engine, behind every parallel project
    // for the reason the section above measures.
    ...ENGINES.map((engine) => ({
      name: `${engine.name}-driven`,
      use: { ...engine.device },
      grep: DRIVEN,
      workers: 1,
      dependencies: ENGINES.map((main) => main.name),
    })),
  ],
  webServer: {
    command: 'npm run preview',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
