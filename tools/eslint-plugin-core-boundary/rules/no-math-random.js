import { isCorePath } from '../lib/core-path.js';
import { globalReferences, isDeclaredInScope } from '../lib/scope.js';

/**
 * Item M3, third clause: nothing under core calls Math.random.
 *
 * STACK section 3 and QUALITY-BAR section 1 put every draw on the seeded stream
 * with one `split()` per consumer, so that changing one consumer's draw count
 * cannot shift another's. A single unseeded call anywhere in core destroys the
 * property for the whole game and fails nothing else, which is why this is
 * lint-enforced rather than reviewed.
 *
 * The rule therefore refuses every route to the function, not just the obvious
 * call. Every capture of the bare `Math` object is reported, because once the
 * object is held under another name nothing here can follow it. What stays
 * permitted is exactly what can be read statically and shown to be safe: a
 * named member that is not `random`, and a destructure whose keys are all known
 * and none of them `random`.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'forbid Math.random and every capture of Math inside core (item M3)',
    },
    schema: [],
    messages: {
      mathRandom:
        'core must not call Math.random: all randomness comes from the seeded ' +
        'stream, one split per consumer (item M3).',
      mathDestructure:
        'core must not destructure random out of Math: it is the same call ' +
        'under another name (item M3).',
      mathAlias:
        'core must not hold Math under another name: an alias carries random ' +
        'with it and nothing can follow it from here (item M3).',
      mathComputed:
        'core must not reach into Math with a computed key: the key cannot be ' +
        'read statically, so random cannot be ruled out (item M3).',
      mathCapture:
        'core must not pass Math out of the module: whatever receives it can ' +
        'call random (item M3).',
    },
  },

  create(context) {
    if (!isCorePath(context.filename)) {
      return {};
    }
    const sourceCode = context.sourceCode;

    /** The string behind a property key, or null when it is not static. */
    function staticKey(node) {
      if (!node) {
        return null;
      }
      if (node.type === 'Literal') {
        return typeof node.value === 'string' || typeof node.value === 'number'
          ? String(node.value)
          : null;
      }
      if (
        node.type === 'TemplateLiteral' &&
        node.expressions.length === 0 &&
        node.quasis.length === 1
      ) {
        const cooked = node.quasis[0].value.cooked;
        return typeof cooked === 'string' ? cooked : null;
      }
      return null;
    }

    function checkPattern(pattern) {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          context.report({ node: property, messageId: 'mathDestructure' });
          continue;
        }
        const name =
          !property.computed && property.key.type === 'Identifier'
            ? property.key.name
            : staticKey(property.key);
        if (name === null) {
          context.report({ node: property, messageId: 'mathComputed' });
          continue;
        }
        if (name === 'random') {
          context.report({ node: property, messageId: 'mathDestructure' });
        }
      }
    }

    function inspect(node) {
      const parent = node.parent;
      if (!parent) {
        return;
      }

      if (parent.type === 'MemberExpression' && parent.object === node) {
        if (!parent.computed) {
          if (
            parent.property.type === 'Identifier' &&
            parent.property.name === 'random'
          ) {
            context.report({ node: parent, messageId: 'mathRandom' });
          }
          return;
        }
        const key = staticKey(parent.property);
        if (key === null) {
          context.report({ node: parent, messageId: 'mathComputed' });
          return;
        }
        if (key === 'random') {
          context.report({ node: parent, messageId: 'mathRandom' });
        }
        return;
      }

      if (parent.type === 'VariableDeclarator' && parent.init === node) {
        const id = parent.id;
        if (id.type === 'ObjectPattern') {
          checkPattern(id);
          return;
        }
        context.report({ node: parent.id, messageId: 'mathAlias' });
        return;
      }

      if (parent.type === 'AssignmentExpression' && parent.right === node) {
        if (parent.left.type === 'ObjectPattern') {
          checkPattern(parent.left);
          return;
        }
        context.report({ node: parent.left, messageId: 'mathAlias' });
        return;
      }

      context.report({ node, messageId: 'mathCapture' });
    }

    return {
      'Program:exit': () => {
        for (const reference of globalReferences(sourceCode)) {
          const identifier = reference.identifier;
          if (identifier.name !== 'Math') {
            continue;
          }
          if (isDeclaredInScope(sourceCode, 'Math', identifier)) {
            continue;
          }
          inspect(identifier);
        }
      },
    };
  },
};
