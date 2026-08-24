import { defineConfig } from 'vite';

// QUALITY-BAR section 14: a static bundle with no server, no runtime
// configuration and no build-time secrets, and the same input tree must produce
// the same output bytes. Item A2 inspects the first, item A6 tests the second.
//
// Deliberately absent, and each absence is load-bearing:
//   define()      would inline an environment value into the bytes (A2).
//   sourcemap     would carry absolute machine paths into the output (A6).
//   modulePreload.polyfill emits an inline script, which the QUALITY-BAR
//                 section 9 policy has no hash allowance for.
export const PREVIEW_PORT = 4273;

export default defineConfig({
  // Every emitted reference is relative, so the bundle serves from a
  // subdirectory as readily as from a host root. Checklist check 4.3.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    emptyOutDir: true,
  },
  // strictPort so a stale preview on the wrong port fails loudly instead of
  // being reused. The port is this project's alone.
  server: { port: PREVIEW_PORT, strictPort: true },
  preview: { port: PREVIEW_PORT, strictPort: true },
});
