/**
 * Scope analysis, shared by `no-dom` and `no-math-random`.
 *
 * Both rules ask the same question: does this name reach a real declaration, or
 * does it reach the ambient platform? Answering it by text would fail in both
 * directions. A parameter named `window`, a locally declared type named like a
 * DOM interface, and an imported `Node` are all legitimate and all would be
 * reported by a grep; a `Math` reached through an alias would be missed by one.
 * The clean fixture exists to pin the first three.
 */

/**
 * True when `name`, seen at `node`, resolves to something the source declares.
 *
 * A variable found with no definitions can only have come from the ambient
 * global scope, whether it was written into the configuration as a known global
 * or synthesised by the parser, so that case is deliberately NOT a declaration.
 */
export function isDeclaredInScope(sourceCode, name, node) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(name);
    if (variable) {
      return variable.defs.length > 0;
    }
    scope = scope.upper;
  }
  return false;
}

/**
 * Every identifier in the file that reaches the ambient global scope.
 *
 * Two sources, and both are needed. `through` holds references that resolved to
 * nothing at all, which is the shape when the configuration declares no globals
 * for the file. The second loop holds references that resolved to a global the
 * configuration did declare, which is the shape as soon as one does: without
 * it, adding a `globals` block to the shipping configuration would silently
 * switch this plugin off.
 */
export function globalReferences(sourceCode) {
  const globalScope = sourceCode.scopeManager.globalScope;
  if (!globalScope) {
    return [];
  }
  const references = [...globalScope.through];
  for (const variable of globalScope.variables) {
    if (variable.defs.length === 0) {
      references.push(...variable.references);
    }
  }
  return references;
}
