import { isCorePath } from '../lib/core-path.js';
import {
  matchesEngineRenderer,
  matchesSurfaceSegment,
  readSpecifier,
} from '../lib/specifiers.js';

/**
 * Item M3, first clause: no module under core imports render, ui or the shared
 * engine renderer.
 *
 * Every way a module can name another module is covered, because the boundary
 * is only worth what its weakest entry point is: static import, re-export,
 * `export *`, dynamic `import()`, `require`, `import x = require(...)`, a
 * type-only import, and the `import('...')` type position.
 *
 * The two matchers are kept apart and report different messages. The engine
 * renderer is asked about first, so its own matcher is what answers for it; if
 * that matcher were broken the specifier would still be caught by the segment
 * matcher, and a single shared message would hide the breakage.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'forbid imports of the presentation layers from inside core (item M3)',
    },
    schema: [],
    messages: {
      surfaceSegment:
        "core must not import '{{specifier}}': render and ui are presentation " +
        'layers, and core has to be playable with neither (item M3).',
      engineRenderer:
        "core must not import '{{specifier}}': the shared engine renderer is a " +
        'presentation module (item M3).',
    },
  },

  create(context) {
    if (!isCorePath(context.filename)) {
      return {};
    }

    function check(sourceNode) {
      const specifier = readSpecifier(sourceNode);
      if (specifier === null) {
        return;
      }
      if (matchesEngineRenderer(specifier)) {
        context.report({
          node: sourceNode,
          messageId: 'engineRenderer',
          data: { specifier },
        });
        return;
      }
      if (matchesSurfaceSegment(specifier)) {
        context.report({
          node: sourceNode,
          messageId: 'surfaceSegment',
          data: { specifier },
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source) {
          check(node.source);
        }
      },
      ExportAllDeclaration: (node) => check(node.source),
      // `source` on current parser versions, `argument` on older ones. Both
      // are read so the rule does not depend on which one is present.
      TSImportType: (node) => check(node.source ?? node.argument),
      TSImportEqualsDeclaration: (node) => {
        const reference = node.moduleReference;
        if (reference && reference.type === 'TSExternalModuleReference') {
          check(reference.expression);
        }
      },
      CallExpression: (node) => {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1
        ) {
          check(node.arguments[0]);
        }
      },
    };
  },
};
