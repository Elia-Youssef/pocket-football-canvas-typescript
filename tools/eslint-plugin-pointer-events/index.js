/**
 * Item C9's first clause, as a lint rule: input is handled through Pointer
 * Events only, and no mouse or touch listener exists in the source.
 *
 * WHY A RULE AND NOT A REVIEW. QUALITY-BAR section 3 asks for one pointer path
 * rather than a mouse path and a touch path, because two paths are two sets of
 * coordinates, two sets of capture rules and two bugs. The rule is what makes
 * the absence of the second path a property of the build instead of a habit,
 * and the shipping lint run over `src/` is what turns "this file has none" into
 * "the source has none".
 *
 * WHAT IT REPORTS.
 *
 *   addEventListener('mousedown', ...)   a legacy event name, read statically
 *   element.onmousedown = ...            the same listener as a property
 *
 * A legacy name is any event whose name begins `mouse`, `touch` or `drag`,
 * plus `drop`, `dblclick` and `auxclick`. The last three are named
 * individually because none of them is a prefix of the others, and the HTML
 * drag family is here for the reason the criterion exists at all: an input
 * path built on `dragstart` and `drop` is a SECOND input path, it is not
 * Pointer Events, and it is the one shape a rule that only looked for `mouse`
 * and `touch` would have let through. `auxclick` is a mouse-button event with
 * no touch and no keyboard equivalent, like `dblclick`.
 *
 * Both arms match lowercase only, because DOM event types and handler
 * properties are lowercase: a name in any other case is not one of them, and a
 * rule that guessed otherwise would report `onMouseWheelPolicy`.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE, and each of these is a decision rather
 * than a gap:
 *
 *   `click`, which is fired for a pointer, for a touch AND for Enter or Space
 *   on a focused control. Banning it would ban the one activation event that
 *   makes a button work for all three input methods, which is the parity item
 *   C11 grades.
 *
 *   `MouseEvent` and `TouchEvent` as type names. A `PointerEvent` IS a
 *   `MouseEvent` by inheritance, so the type name is not the offence; the
 *   listener is, and the listener is what is reported.
 *
 *   An event name this rule cannot read: a variable, or a template with an
 *   expression in it. Nothing static is there to judge, and a rule that
 *   guessed would report the name of every event in the project.
 *
 * THREE STATED LIMITS, each carried in the clean fixture so that it is tested
 * rather than merely admitted, and each of them a deliberate refusal to guess:
 *
 *   An ALIASED registration, `const add = element.addEventListener.bind(...)`
 *   and then `add('mousedown', h)`. The callee's property name is `add`, and
 *   following it would mean tracking every value in the module through every
 *   assignment. What closes this is not a longer rule: it is the shipping lint
 *   running over the whole of `src/`, where a module that aliased a listener
 *   in order to register a mouse one is a module a reader would ask about.
 *
 *   `element.setAttribute('onmousedown', ...)`. The handler name is a string
 *   argument and not a property, and a rule that read the first argument of
 *   every `setAttribute` would report `aria-label` on the day somebody named a
 *   control "onmousedown-toggle". Item M1's own scan is the backstop: nothing
 *   under `src/ui/` may hand-roll input at all.
 *
 *   A HANDLER PROPERTY ASSIGNED THROUGH A VARIABLE KEY,
 *   `const PROP = 'onmousedown'; element[PROP] = handler`. The property node is
 *   an identifier naming a variable, not the handler, and resolving it would
 *   mean constant-folding every string in the module; guessing from the
 *   identifier's own spelling would report `element[onmousedown]` while
 *   missing every variable named anything else, which is the worst of the three
 *   available answers. This is the limit that was neither caught nor named
 *   until now, and the same two backstops close it: the shipping lint reads the
 *   whole of `src/`, where a module computing a handler property name is a
 *   module a reader would ask about, and item M1's scan covers the chrome.
 *
 * None of the three evasions has ever appeared in this project, and each would
 * read as deliberate to a reviewer, which is the standard the boundary plugin
 * beside this one is held to as well.
 */

const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;
const LEGACY_HANDLER =
  /^on(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;
const LISTENER_METHODS = new Set(['addEventListener', 'removeEventListener']);

/** A property or method name, whether written plainly or in brackets. */
function nameOf(node) {
  if (!node) {
    return null;
  }
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return null;
}

/**
 * A statically known event name, or null. A template literal counts only when
 * it has no expressions in it, which is the same reading the core boundary's
 * specifier reader takes of an import path.
 */
function readEventName(node) {
  if (!node) {
    return null;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

const noMouseOrTouchListeners = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'forbid mouse and touch listeners, so input is Pointer Events only (item C9)',
    },
    schema: [],
    messages: {
      legacyListener:
        "input is Pointer Events only: '{{name}}' is a mouse or touch listener. " +
        'A separate mouse path and touch path is two sets of coordinates and two ' +
        'sets of capture rules, which is what item C9 exists to prevent.',
      legacyHandler:
        "input is Pointer Events only: '{{name}}' is a mouse or touch handler " +
        'property, which is the same listener written another way (item C9).',
    },
  },

  create(context) {
    function reportHandler(node, name) {
      if (typeof name === 'string' && LEGACY_HANDLER.test(name)) {
        context.report({ node, messageId: 'legacyHandler', data: { name } });
      }
    }

    return {
      CallExpression: (node) => {
        if (node.callee.type !== 'MemberExpression') {
          return;
        }
        const method = nameOf(node.callee.property);
        if (method === null || !LISTENER_METHODS.has(method)) {
          return;
        }
        const event = readEventName(node.arguments[0]);
        if (event !== null && LEGACY_EVENT.test(event)) {
          context.report({
            node: node.arguments[0] ?? node,
            messageId: 'legacyListener',
            data: { name: event },
          });
        }
      },

      MemberExpression: (node) => {
        reportHandler(node.property, nameOf(node.property));
      },

      Property: (node) => {
        reportHandler(node.key, nameOf(node.key));
      },
    };
  },
};

export default {
  meta: {
    name: 'eslint-plugin-pointer-events',
    version: '1.0.0',
  },
  rules: {
    'no-mouse-or-touch-listeners': noMouseOrTouchListeners,
  },
};

export { LEGACY_EVENT, LEGACY_HANDLER, LISTENER_METHODS, noMouseOrTouchListeners };
