/**
 * The boundary decided by what a core module REACHES, not by what it names.
 *
 * Item M3 is a statement about a set of modules: "no module under core imports
 * render, ui, the shared engine renderer, or any DOM or canvas type, and none
 * calls Math.random". Every rule in this plugin answers that one file at a
 * time, because that is all a lint rule can see, and one file at a time is
 * exactly one hop short. A core module that imports a non-core module, which
 * imports the render layer or calls `Math.random`, satisfies every rule in this
 * directory and breaks the item. So does a core module in a subdirectory that a
 * top-level directory listing never reads.
 *
 * Neither hole is a shipped defect today: `src/core` has no subdirectory and no
 * core module imports anything outside it. Both bite at the shared-engine
 * extraction, where a package between core and everything else becomes a
 * legitimate one-hop indirection, which is the point at which a rule that
 * cannot see past one file stops being enough.
 *
 * So the walk lives here, beside the rules, rather than in a test file: it is
 * the same boundary, asked as a question about a graph. It is not loaded by any
 * rule, because a rule is handed one file and no filesystem; it is used by the
 * boundary test, which can read the tree the shipping build compiles.
 *
 * WHAT COUNTS AS LEAVING. Any specifier that does not resolve to a file inside
 * the root, and any specifier that resolves to nothing at all. A bare specifier
 * is included in that: a package, a node builtin and a typo are all things a
 * core module may not depend on, and none of them is a file under the root.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every extension a module can arrive in, in the order a resolver tries them.
 * The same list the shipping configuration's `files` glob carries, because a
 * gap here is not a weaker walk, it is a module the walk never reads.
 */
export const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

/** Directories no source walk has any business descending into. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage']);

/**
 * Source with comments removed and string literals preserved.
 *
 * A commented-out import is not an import, and a walk that read one would
 * report an escape that does not exist; a scan that also erased string literals
 * would miss `import('../render/effects')`, which is an import written as one.
 *
 * THREE BRANCHES, AND EACH ONE DECIDES A CASE THE OTHERS CANNOT. The line
 * comment and the block comment remove text a pattern would otherwise read as
 * code, which is the false-escape half. The quote state is what keeps them
 * honest in the other direction: without it a string that merely contains `/*`
 * opens a comment that swallows every import after it, and the walk then
 * reports a module with dependencies as a module with none. All three are
 * graded in tests/unit/core-boundary.test.ts on sources that no other part of
 * this file can decide.
 *
 * WHAT IT IS NOT. This is a scanner and not a parser: a regular expression
 * literal containing a quote enters the quote state, so the text after it is
 * copied verbatim rather than stripped. Copied verbatim is the safe direction
 * (an import after such a literal is still read, which the same test pins);
 * the unsafe direction would be dropping it.
 */
export function withoutComments(source) {
  let out = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const here = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      out += here;
      if (here === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (here === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (here === "'" || here === '"' || here === '`') {
      quote = here;
      out += here;
      index += 1;
      continue;
    }
    if (here === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (here === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += here;
    index += 1;
  }
  return out;
}

/**
 * Every module specifier the source depends on, in every route the boundary
 * rules already know about: static import and export, `import type`, a dynamic
 * `import()`, a type-position `import('...')`, and `require()`.
 */
export function importSpecifiers(source) {
  const text = withoutComments(source);
  const patterns = [
    // The static forms, anchored at the start of a line because that is where
    // a statement begins. Unanchored, the same pattern reads an import out of
    // a string that merely quotes one, which the mutation harness's own entry
    // list is full of.
    //
    // THE CLASS EXCLUDES `;`, `'` AND `"` AND NOTHING ELSE, so the clause
    // crosses newlines and a WRAPPED import list is read the way the compiler
    // reads it. Excluding the newline as well cost this walk five of the
    // thirteen modules under src/core, whose import lists wrap; every edge
    // those five carried was invisible, so a dependency leaving the boundary
    // through one of them passed lint, passed this walk and passed the suite.
    // The three excluded characters are what still bounds the clause to one
    // statement: no import statement holds a semicolon or a quote in front of
    // its own specifier.
    /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    // The call forms, which are expressions and can appear anywhere: a dynamic
    // `import()`, a type-position `import('...')`, and `require()`.
    /(?:^|[^\w$.])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const at = new Map();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (typeof specifier === 'string' && !at.has(specifier)) {
        at.set(specifier, match.index ?? 0);
      }
    }
  }
  // Source order, so a failure names the escapes in the order a reader meets
  // them rather than in the order the patterns happened to run.
  return [...at.entries()]
    .sort((left, right) => left[1] - right[1])
    .map((entry) => entry[0]);
}

/** Every module file under `root`, recursively, as absolute paths, sorted. */
export function modulesUnder(root, extensions = MODULE_EXTENSIONS) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          // THE RECURSION IS THE POINT. A listing of the top level alone reads
          // a directory rather than a layer, and a module one directory down is
          // then subject to nothing at all.
          stack.push(path.join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        found.push(path.join(directory, entry.name));
      }
    }
  }
  found.sort();
  return found;
}

/** True when `file` is inside `root`, by path segment and not by prefix. */
export function isInside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

/**
 * The file a relative specifier names, or null. Extensionless first, then the
 * directory index, which is the order a bundler resolves them in.
 */
export function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (existsSync(base) && statSync(base).isFile()) {
    return base;
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The transitive import closure of every module under `root`.
 *
 * `modules` is every file the closure reached, `root`'s own included.
 * `escapes` is every dependency that left it, each one naming the module it was
 * written in and the specifier that did the leaving, so a failure says which
 * line to read rather than that a set is not empty.
 */
export function importClosure(root, read = readFileSync) {
  const entries = modulesUnder(root);
  const seen = new Set(entries);
  const queue = [...entries];
  const escapes = [];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const specifier of importSpecifiers(read(file, 'utf8'))) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null || !isInside(root, resolved)) {
        escapes.push({
          from: path.relative(root, file).split(path.sep).join('/'),
          specifier,
          resolved:
            resolved === null
              ? null
              : path.relative(root, resolved).split(path.sep).join('/'),
        });
        continue;
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  const modules = [...seen].sort();
  escapes.sort((left, right) =>
    `${left.from} ${left.specifier}`.localeCompare(`${right.from} ${right.specifier}`),
  );
  return { modules, escapes };
}
