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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
