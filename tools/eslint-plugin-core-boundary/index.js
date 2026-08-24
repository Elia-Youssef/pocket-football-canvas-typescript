import noDom from './rules/no-dom.js';
import noForbiddenImports from './rules/no-forbidden-imports.js';
import noMathRandom from './rules/no-math-random.js';

export { isCorePath } from './lib/core-path.js';
export {
  ENGINE_RENDERER,
  matchesEngineRenderer,
  matchesSurfaceSegment,
  readSpecifier,
  specifierSegments,
  SURFACE_SEGMENTS,
} from './lib/specifiers.js';
export {
  isPlatformGlobalName,
  PLATFORM_GLOBALS,
  PLATFORM_PREFIXES,
} from './lib/platform-globals.js';

/**
 * The three halves of item M3, as one plugin. Each rule scopes itself to a
 * `core/` path, so the shipping configuration can apply all three everywhere
 * and a file that moves into or out of core changes what it is subject to
 * without anybody editing a glob.
 */
export default {
  meta: {
    name: 'eslint-plugin-core-boundary',
    version: '1.0.0',
  },
  rules: {
    'no-forbidden-imports': noForbiddenImports,
    'no-dom': noDom,
    'no-math-random': noMathRandom,
  },
};
