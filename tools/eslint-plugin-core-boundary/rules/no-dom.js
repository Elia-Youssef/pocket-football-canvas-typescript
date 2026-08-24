import { isCorePath } from '../lib/core-path.js';
import {
  DOM_LIB_REFERENCE,
  isPlatformGlobalName,
} from '../lib/platform-globals.js';
import { globalReferences, isDeclaredInScope } from '../lib/scope.js';

/**
 * Item M3, second clause: no module under core touches a DOM or canvas type.
 *
 * Detection is by scope analysis and never by raw text. The clean fixture holds
 * the near misses that a text scan gets wrong: a parameter named `window`, a
 * locally declared interface whose name starts with `HTML`, a `document`
 * declared as an ordinary local object. All three are legitimate and all three
 * stay silent, because they resolve to a declaration in this file.
 *
 * Type positions are visited explicitly rather than left to the reference
 * graph. A type annotation is where a DOM dependency reaches core most quietly,
 * since it compiles away and leaves no runtime trace to notice later.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'forbid DOM, canvas and other platform globals inside core (item M3)',
    },
    schema: [],
    messages: {
      platformGlobal:
        "core must not reference '{{name}}': core has to run headlessly, with " +
        'no document, no canvas and no frame clock (item M3).',
      domLib:
        'core must not pull in the DOM library: this reference puts the whole ' +
        'platform surface back into scope (item M3).',
    },
  },

  create(context) {
    if (!isCorePath(context.filename)) {
      return {};
    }
    const sourceCode = context.sourceCode;
    const reported = new Set();

    function check(identifier) {
      if (!identifier || identifier.type !== 'Identifier') {
        return;
      }
      if (!isPlatformGlobalName(identifier.name)) {
        return;
      }
      if (isDeclaredInScope(sourceCode, identifier.name, identifier)) {
        return;
      }
      if (reported.has(identifier)) {
        return;
      }
      reported.add(identifier);
      context.report({
        node: identifier,
        messageId: 'platformGlobal',
        data: { name: identifier.name },
      });
    }

    function checkEntityName(entity) {
      let name = entity;
      while (name && name.type === 'TSQualifiedName') {
        name = name.left;
      }
      check(name);
    }

    return {
      TSTypeReference: (node) => checkEntityName(node.typeName),
      TSTypeQuery: (node) => checkEntityName(node.exprName),
      TSClassImplements: (node) => checkEntityName(node.expression),
      TSInterfaceHeritage: (node) => checkEntityName(node.expression),

      'Program:exit': () => {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type === 'Line' && DOM_LIB_REFERENCE.test(comment.value)) {
            context.report({ loc: comment.loc, messageId: 'domLib' });
          }
        }
        for (const reference of globalReferences(sourceCode)) {
          check(reference.identifier);
        }
      },
    };
  },
};
