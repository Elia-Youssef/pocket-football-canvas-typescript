/**
 * Path scoping for every rule in this plugin.
 *
 * QUALITY-BAR section 1 and item M3 draw the boundary at a `core/` directory,
 * so the rules decide their own scope from the filename rather than relying on
 * a `files` glob in the shipping configuration. A rule that is only scoped by
 * configuration is one edited config away from being inert, and the same rule
 * would then be silent on a fixture that exists to prove it is not.
 *
 * Two properties this comparison is required to have:
 *
 *   Segment equality, not substring. `src/render-cache/core-notes.ts` is not a
 *   core module and `tools/eslint-plugin-core-boundary/` is not one either.
 *
 *   Case insensitivity. A case-insensitive filesystem resolves `src/Core/` and
 *   `src/core/` to the same directory, so a case-sensitive comparison would
 *   enforce the boundary on one contributor's machine and skip it on another's,
 *   which is the worst of the three possible outcomes.
 */
export function isCorePath(filename) {
  if (typeof filename !== 'string' || filename === '') {
    return false;
  }
  return filename
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase() === 'core');
}
