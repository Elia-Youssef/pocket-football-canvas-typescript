/**
 * Reading and classifying module specifiers for the import half of item M3.
 *
 * Only statically known specifiers are classified. A computed specifier is
 * reported by nothing here on purpose: guessing at a runtime string would
 * produce a rule that is wrong in both directions, and the honest answer is
 * that the boundary is enforced on what can be read.
 */

/** The two presentation directories named in DESIGN section 1. */
export const SURFACE_SEGMENTS = new Set(['render', 'ui']);

/** The shared engine's renderer, as an exact package path. STACK section 3. */
export const ENGINE_RENDERER = '@js-games/engine/render';

const CODE_EXTENSION = /\.(?:m|c)?[jt]sx?$/i;

/**
 * The specifier split into path segments, with a leading package scope marker
 * and any code extension removed, so that comparison is per segment.
 *
 *   '../render/pitch'          -> ['..', 'render', 'pitch']
 *   '../render-cache/store'    -> ['..', 'render-cache', 'store']
 *   '@js-games/engine/render'  -> ['js-games', 'engine', 'render']
 *   './ui.ts'                  -> ['.', 'ui']
 */
export function specifierSegments(specifier) {
  return specifier
    .split('/')
    .map((segment) => segment.replace(/^@/, '').replace(CODE_EXTENSION, ''));
}

/**
 * True when the specifier names the render or ui layer as a whole segment.
 * `../render-cache/store`, `../guidance/ui-copy` and `../rendering-order` all
 * contain the letters and none of them names the layer, so all three stay
 * silent; the clean fixture pins that.
 */
export function matchesSurfaceSegment(specifier) {
  return specifierSegments(specifier).some((segment) =>
    SURFACE_SEGMENTS.has(segment.toLowerCase()),
  );
}

/**
 * True for the shared engine's renderer entry point and for anything beneath
 * it. Matched as an exact package path prefix, so a sibling export such as
 * `@js-games/engine/render-utils` is not caught here.
 */
export function matchesEngineRenderer(specifier) {
  return (
    specifier === ENGINE_RENDERER || specifier.startsWith(`${ENGINE_RENDERER}/`)
  );
}

/**
 * The string behind a specifier node, or null when it is not statically known.
 * Covers a plain string, a template literal with no expressions, and the
 * literal type position TypeScript uses for `import('...')` in a type.
 */
export function readSpecifier(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length !== 0 || node.quasis.length !== 1) {
      return null;
    }
    const cooked = node.quasis[0].value.cooked;
    return typeof cooked === 'string' ? cooked : null;
  }
  if (node.type === 'TSLiteralType') {
    return readSpecifier(node.literal);
  }
  return null;
}
