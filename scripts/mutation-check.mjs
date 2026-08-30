#!/usr/bin/env node
/**
 * Validation by mutation: break every gate this part adds, one break at a time,
 * and require each break to be caught.
 *
 * BUILD-PLAN's per-part rule is that every automated gate a part adds gets an
 * entry here and that `npm run verify:mutations` reports every entry detected
 * before the part is done. It is a phase gate rather than a per-part gate
 * because it is slow, and it exists because a gate that has quietly stopped
 * failing is the defect class this document set was written to kill: it looks
 * exactly like a gate that is passing.
 *
 * Two detectors, both run as their own node binary rather than through npm, so
 * that a mutated package.json cannot change what the harness runs:
 *
 *   unit   the whole Vitest suite
 *   lint   ESLint over the tree, with the fixtures excluded the way the
 *          shipping script excludes them
 *
 * Every entry names the property it attacks, not the line it edits. If an entry
 * is ever reported as NOT DETECTED, the gate it names is decorative.
 *
 * The item column names whatever owns the property. Usually that is an
 * acceptance item; where the gate is a repository rule rather than a sheet
 * item, it is the GITHUB section that states it, so that `GH7` reads as
 * "section 7, the authorship of the repository record".
 *
 * Three safety properties, because a harness that edits live source files has
 * to be trustworthy before it is useful:
 *
 *   Staleness guard.  Each `find` must match its file EXACTLY once. A mutation
 *                     whose target has been refactored away would otherwise be
 *                     applied to nothing and reported as undetected, or worse,
 *                     applied twice.
 *   Restore always.   Originals are restored in a finally, and an added file is
 *                     refused if the path already exists and removed afterwards.
 *   Baseline first.   Both detectors must be green before anything is mutated.
 *                     Against a red tree every mutation looks detected.
 *
 * Import-inert: main() runs only when this file is the entry point, so a test
 * may import the entry lists without editing anybody's source.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const require = createRequire(import.meta.url);

function binaryFor(packageName, fallback) {
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry =
      typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[packageName];
    if (typeof entry === 'string') {
      return path.join(path.dirname(manifestPath), entry);
    }
  } catch (error) {
    console.log(`  note  falling back for ${packageName}: ${String(error)}`);
  }
  return path.join(PROJECT_ROOT, fallback);
}

const DETECTORS = {
  unit: {
    label: 'unit suite',
    argv: () => [binaryFor('vitest', 'node_modules/vitest/vitest.mjs'), 'run'],
  },
  lint: {
    label: 'lint',
    argv: () => [
      binaryFor('eslint', 'node_modules/eslint/bin/eslint.js'),
      '.',
      '--ignore-pattern',
      'tests/lint/fixtures/',
    ],
  },
};

const PLUGIN = 'tools/eslint-plugin-core-boundary';

/**
 * One entry per protected property. Named after the property, so that a FAIL
 * line below reads as a statement about the project rather than about a diff.
 */
export const EDITS = [
  {
    item: 'M3',
    name: 'the import rule is switched on in the shipping config',
    file: 'eslint.config.js',
    find: "'core-boundary/no-forbidden-imports': 'error',",
    replace: "'core-boundary/no-forbidden-imports': 'off',",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the DOM rule is an error and not a warning',
    file: 'eslint.config.js',
    find: "'core-boundary/no-dom': 'error',",
    replace: "'core-boundary/no-dom': 'warn',",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the Math.random rule is switched on in the shipping config',
    file: 'eslint.config.js',
    find: "'core-boundary/no-math-random': 'error',",
    replace: "'core-boundary/no-math-random': 'off',",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the shipping lint excludes the fixtures and nothing else',
    file: 'package.json',
    find: '"eslint . --ignore-pattern tests/lint/fixtures/"',
    replace: '"eslint ."',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a violating line inside core cannot silence its own detection',
    file: 'eslint.config.js',
    find: 'linterOptions: { noInlineConfig: true },',
    replace: 'linterOptions: { noInlineConfig: false },',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the render segment is a forbidden import',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: "export const SURFACE_SEGMENTS = new Set(['render', 'ui']);",
    replace: "export const SURFACE_SEGMENTS = new Set(['ui']);",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the ui segment is a forbidden import',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: "export const SURFACE_SEGMENTS = new Set(['render', 'ui']);",
    replace: "export const SURFACE_SEGMENTS = new Set(['render']);",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the shared engine renderer has its own matcher',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: "export const ENGINE_RENDERER = '@js-games/engine/render';",
    replace: "export const ENGINE_RENDERER = '@js-games/engine/renderer';",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a specifier is matched per segment and not as a substring',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: `  return specifierSegments(specifier).some((segment) =>
    SURFACE_SEGMENTS.has(segment.toLowerCase()),
  );`,
    replace: '  return /render|ui/i.test(specifier);',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'an undeclared name is not treated as a declaration',
    file: `${PLUGIN}/lib/scope.js`,
    find: `    scope = scope.upper;
  }
  return false;`,
    replace: `    scope = scope.upper;
  }
  return true;`,
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a name declared by configuration is still a platform reference',
    file: `${PLUGIN}/lib/scope.js`,
    find: 'if (variable.defs.length === 0) {',
    replace: 'if (variable.defs.length === -1) {',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the platform denylist is consulted by exact name',
    file: `${PLUGIN}/lib/platform-globals.js`,
    find: '  if (PLATFORM_GLOBALS.has(name)) {',
    replace: "  if (PLATFORM_GLOBALS.has(`${name}-never`)) {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'whole platform families are caught by prefix',
    file: `${PLUGIN}/lib/platform-globals.js`,
    find: '  /^HTML[A-Z]/,',
    replace: '  /^HTMLNEVER[A-Z]/,',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a DOM library reference is detected',
    file: `${PLUGIN}/lib/platform-globals.js`,
    find: String.raw`["']dom`,
    replace: String.raw`["']never`,
    detectedBy: 'unit',
  },
  {
    // There is deliberately no entry attacking the explicit type-position
    // visitor in no-dom, and the absence is a finding rather than an omission.
    // The parser in use resolves type references into the scope graph, so the
    // sweep below covers type positions as well and removing the visitor alone
    // changes no verdict. The visitor is kept as redundancy against a parser
    // that does not, and no single edit can isolate it. See the plugin README.
    item: 'M3',
    name: 'a platform name in a value position is refused',
    file: `${PLUGIN}/rules/no-dom.js`,
    find: `        for (const reference of globalReferences(sourceCode)) {
          check(reference.identifier);
        }`,
    replace: '        void globalReferences;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a named Math.random member is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "            parent.property.name === 'random'",
    replace: "            parent.property.name === 'randomise'",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a bracketed Math random member is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        if (key === 'random') {",
    replace: "        if (key === 'randomise') {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'destructuring random out of Math is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        if (id.type === 'ObjectPattern') {",
    replace: "        if (id.type === 'ArrayPattern') {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a destructured key named random is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        if (name === 'random') {",
    replace: "        if (name === 'randomise') {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'holding Math under another name is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        context.report({ node: parent.id, messageId: 'mathAlias' });",
    replace: '        void parent;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'handing Math out of the module is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "      context.report({ node, messageId: 'mathCapture' });",
    replace: '      void node;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the core path scope is case-insensitive',
    file: `${PLUGIN}/lib/core-path.js`,
    find: "    .some((segment) => segment.toLowerCase() === 'core');",
    replace: "    .some((segment) => segment === 'core');",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'two builds are compared by their bytes',
    file: 'scripts/output-fingerprint.mjs',
    find: '    if (other.hash !== entry.hash || other.bytes !== entry.bytes) {',
    replace: '    if (other.absent !== entry.absent) {',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'a file missing from the second build is a difference',
    file: 'scripts/output-fingerprint.mjs',
    find: '      onlyInLeft.push(key);',
    replace: '      void key;',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'a file added by the second build is a difference',
    file: 'scripts/output-fingerprint.mjs',
    find: '      onlyInRight.push(key);',
    replace: '      void key;',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the identical verdict depends on the differences found',
    file: 'scripts/output-fingerprint.mjs',
    find: `  const identical =
    onlyInLeft.length === 0 && onlyInRight.length === 0 && differing.length === 0;`,
    replace: '  const identical = true;',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'every emitted file is hashed, with no extension filter',
    file: 'scripts/output-fingerprint.mjs',
    find: '      if (entry.isFile()) {',
    replace: "      if (entry.isFile() && !entry.name.endsWith('.html')) {",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the tree fingerprint covers every entry in the tree',
    file: 'scripts/output-fingerprint.mjs',
    find: '  for (const key of [...tree.keys()].sort()) {',
    replace: '  for (const key of [...tree.keys()].sort().slice(0, 0)) {',
    detectedBy: 'unit',
  },

  // The driver around the comparison. Two builds under identical conditions
  // would report the strongest possible PASS having tested nothing, and a
  // verdict that dropped a condition would do the same.
  {
    item: 'A6',
    name: 'the two builds run in different time zones',
    file: 'scripts/check-determinism.mjs',
    find: "    zone: 'Pacific/Kiritimati',",
    replace: "    zone: 'UTC',",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the two builds set a different VITE_ probe value',
    file: 'scripts/check-determinism.mjs',
    find: "    probe: 'second-probe-value',",
    replace: "    probe: 'first-probe-value',",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the two builds stamp different mtimes onto the inputs',
    file: 'scripts/check-determinism.mjs',
    find: "    stamp: new Date('2023-11-14T22:13:20Z'),",
    replace: "    stamp: new Date('2001-09-09T01:46:40Z'),",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the verdict requires the input tree to have stayed still',
    file: 'scripts/check-determinism.mjs',
    find: '    inputStable &&',
    replace: '    emittedCount >= 0 &&',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the verdict requires at least one emitted file',
    file: 'scripts/check-determinism.mjs',
    find: '    emittedCount > 0',
    replace: '    emittedCount >= 0',
    detectedBy: 'unit',
  },

  // The browser gate cannot be graded by running it: gutting a test makes it
  // pass. These three attack the assertions themselves, and the detector is
  // the inventory in tests/unit/browser-gate.test.ts.
  {
    item: 'A2',
    name: 'the off-origin check really compares two origins',
    file: 'tests/browser/scaffold.spec.ts',
    find: '      if (new URL(url).origin !== origin) {',
    replace: '      if (offOrigin.length < 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'A2',
    name: 'every configuration token is still forbidden in the output',
    file: 'tests/browser/scaffold.spec.ts',
    find: "    const forbidden = ['process.env', 'import.meta.env', 'VITE_'];",
    replace: '    const forbidden = [];',
    detectedBy: 'unit',
  },
  {
    item: 'A2',
    name: 'the compiled entry marker is still asserted',
    file: 'tests/browser/scaffold.spec.ts',
    find: "      'pocket-football',",
    replace: "      '',",
    detectedBy: 'unit',
  },
  {
    item: 'A2',
    name: 'an empty or single-file dist cannot satisfy the output check',
    file: 'tests/browser/scaffold.spec.ts',
    find: '    expect(files.length).toBeGreaterThan(1);',
    replace: '    expect(files.length).toBeGreaterThan(-1);',
    detectedBy: 'unit',
  },

  // The repository record gate. GITHUB section 7 rather than a sheet item.
  {
    item: 'GH7',
    name: 'the delivery record takes no gameplay carve-out',
    file: 'scripts/check-repository-record.mjs',
    find: '  return scanLines(text, () => false);',
    replace: '  return scanLines(text, isGameContextLine);',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the carve-out covers this game vocabulary and no delivery vocabulary',
    file: 'scripts/check-repository-record.mjs',
    find: String.raw`/\b(?:opponents?|difficulty|`,
    replace: String.raw`/\b(?:refactor|assisted|generated|opponents?|difficulty|`,
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the Closes waiver belongs to the commit and not to a branch',
    file: 'scripts/check-repository-record.mjs',
    find: "  return !subject.startsWith('deps:');",
    replace: '  return false;',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the dependency trailer waiver names the bot, not anybody signing off',
    file: 'scripts/check-repository-record.mjs',
    find: String.raw`const DEPENDENCY_TRAILER = /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/;`,
    replace: String.raw`const DEPENDENCY_TRAILER = /^Signed-off-by: /;`,
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the dependency trailer waiver belongs to dependency updates only',
    file: 'scripts/check-repository-record.mjs',
    find: '    if (dependencyUpdate && DEPENDENCY_TRAILER.test(line)) {',
    replace: '    if (DEPENDENCY_TRAILER.test(line)) {',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'a control byte in a record value is flagged, not passed as ASCII',
    file: 'scripts/check-repository-record.mjs',
    find: '    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {',
    replace: '    if (code === 0x7f) {',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'a message keeps its text after an embedded field separator',
    file: 'scripts/check-repository-record.mjs',
    find: '      message: parts.slice(5).join(UNIT_SEPARATOR),',
    replace: '      message: parts[5],',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'an unparseable record fragment is reported, never skipped',
    file: 'scripts/check-repository-record.mjs',
    find: '      fragments.push(commit);',
    replace: '      void commit;',
    detectedBy: 'unit',
  },

  // The token layer, item E1. Three sources have to agree, every quoted ratio
  // has to re-derive from the hexes, and the literal sweep has to be able to
  // see a literal. The last four attack the machinery the sweep is built from
  // rather than an assertion: gutting an assertion makes a suite PASS, so an
  // entry that did that would be reported as undetected and would be right.
  {
    item: 'E1',
    name: 'a stylesheet value must match the design contract',
    file: 'src/ui/tokens.css',
    find: '  --space-5: 24px;',
    replace: '  --space-5: 25px;',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the renderer record must match the design contract',
    file: 'src/render/tokens.ts',
    find: "    rail: '#C8CFCB',",
    replace: "    rail: '#C8CFCC',",
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a quoted ratio is re-derived and not trusted',
    file: 'tests/reference/design-contract.md',
    find: '| 16.43 |',
    replace: '| 16.53 |',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a measured pair is checked against its own threshold',
    file: 'tests/reference/design-contract.md',
    find: '| Entity ring on player fill | `--pf-line` | `--team-player` | 3.09 | 3.09 | 3 |',
    replace: '| Entity ring on player fill | `--pf-line` | `--team-player` | 3.09 | 3.09 | 5 |',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the corrected rail cell is re-derived and not trusted',
    file: 'tests/reference/design-contract.md',
    find: '| Rail on ground | Daylight | 1.15 | 3 | Rail on pitch, both variants |',
    replace: '| Rail on ground | Daylight | 1.16 | 3 | Rail on pitch, both variants |',
    detectedBy: 'unit',
  },

  // The two scoped cells, corrected 2026-08-29 from the two disclosures this
  // harness protected since PF-1: measured, quoted in section 5, and
  // deliberately below the threshold their named carrier meets. The pins are
  // on the derived value, on the ceiling, and on the rows being there at all.
  {
    item: 'E1',
    name: 'a filled arrow cell is re-derived and not trusted',
    file: 'tests/reference/design-contract.md',
    find: '| Aim arrow weak end on pitch | `--pf-line` | `--pitch-stripe-a` | 5.38 | 3.71 | 3 |',
    replace: '| Aim arrow weak end on pitch | `--pf-line` | `--pitch-stripe-a` | 5.38 | 3.81 | 3 |',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a quiet cell is measured against the real ceiling',
    file: 'tests/reference/design-contract.md',
    find:
      "| Aim arrow strong end on pitch | Daylight | 1.59 | 3 | The arrow's own `--pf-line` " +
      'outline, both variants |',
    replace:
      "| Aim arrow strong end on pitch | Daylight | 1.59 | 1.5 | The arrow's own `--pf-line` " +
      'outline, both variants |',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a scoped cell cannot be deleted',
    file: 'tests/reference/design-contract.md',
    find: '| Rail on ground | Daylight | 1.15 | 3 | Rail on pitch, both variants |\n',
    replace: '',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a stated threshold cannot be quietly lowered',
    file: 'tests/reference/design-contract.md',
    find: '| Rail on pitch | `--pf-rail` | `--pitch-stripe-a` | 3.67 | 3.09 | 3 |',
    replace: '| Rail on pitch | `--pf-rail` | `--pitch-stripe-a` | 3.67 | 3.09 | 1 |',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the pitch is redefined per theme',
    file: 'src/ui/tokens.css',
    find: `  --pitch-stripe-a: var(--pitch-stripe-a-floodlit);
  --pitch-stripe-b: var(--pitch-stripe-b-floodlit);
  --pf-rail: var(--pf-rail-floodlit);
}`,
    replace: `  --pitch-stripe-a: var(--pitch-stripe-a-daylight);
  --pitch-stripe-b: var(--pitch-stripe-b-daylight);
  --pf-rail: var(--pf-rail-daylight);
}`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'reduced motion resolves every duration to zero',
    file: 'src/ui/tokens.css',
    find: '    --dur-2: var(--dur-0);',
    replace: '    --dur-2: 140ms;',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep matches a colour literal',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`  /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(|(?<![\w-])color\s*\(/gi;`,
    replace: String.raw`  /#never[0-9A-Fa-f]{3,8}\b/gi;`,
    detectedBy: 'unit',
  },
  {
    // A CSS function name is case-insensitive. Without the flag, RGB() is a
    // colour to every browser and not a colour to the sweep.
    item: 'E1',
    name: 'the colour sweep is case-insensitive, as CSS is',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`color\s*\(/gi;`,
    replace: String.raw`color\s*\(/g;`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the bare colour function form is matched too',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`|(?<![\w-])color\s*\(/gi;`,
    replace: String.raw`/gi;`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep reads stylesheets as well as modules',
    file: 'tests/unit/tokens.test.ts',
    find: "  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css',",
    replace: "  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',",
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep matches a stylesheet dimension literal',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`const DIMENSION_LITERAL = /(?<![\w#-])\d*\.?\d+(?:px|rem|em|ms|s)\b/g;`,
    replace: String.raw`const DIMENSION_LITERAL = /(?<![\w#-])\d*\.?\d+(?:never)\b/g;`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep descends into every directory under src',
    file: 'tests/unit/tokens.test.ts',
    find: `      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }`,
    replace: `      if (entry.isDirectory()) {
        continue;
      }`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the token layer is the only thing the sweep excludes',
    file: 'tests/unit/tokens.test.ts',
    find: "const TOKEN_LAYER = ['src/ui/tokens.css', 'src/render/tokens.ts'];",
    replace: "const TOKEN_LAYER = ['src/ui/tokens.css', 'src/render/tokens.ts', 'src/main.ts'];",
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-2. The three time layers, damping, the stop threshold, containment,
  // the speed cap, the finiteness guard and the seeded stream.
  //
  // Every entry here attacks the property rather than the assertion. The
  // three time layers get one entry per layer plus one per constant,
  // because a layer that has been deleted and a layer whose constant has
  // drifted fail in different places and one of them is silent.
  // ---------------------------------------------------------------------

  {
    item: 'B1',
    name: 'a frame delta past the ceiling is clamped and the rest discarded',
    file: 'src/core/physics.ts',
    find: '        applied = DELTA_CEILING;',
    replace: '        applied = delta;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'a negative delta is no time at all',
    file: 'src/core/physics.ts',
    find: '      if (!Number.isFinite(delta) || delta <= 0) {',
    replace: '      if (!Number.isFinite(delta)) {',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'a delta that is not a number is no time at all',
    file: 'src/core/physics.ts',
    find: '      if (!Number.isFinite(delta) || delta <= 0) {',
    replace: '      if (delta <= 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'a gap past the resume threshold is dropped and never simulated',
    file: 'src/core/physics.ts',
    find: `        leftover = 0;
        resumed = true;`,
    replace: `        applied = delta;
        resumed = true;`,
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'time is consumed in slices no larger than the catch-up ceiling',
    file: 'src/core/physics.ts',
    find: '        let take = Math.min(pending, CATCH_UP_SLICE);',
    replace: '        let take = pending;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the accumulator carries its remainder into the next frame',
    file: 'src/core/physics.ts',
    find: '        leftover += take;',
    replace: '        leftover = take;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the fixed step is the one the whole time model is derived from',
    file: 'src/core/config.ts',
    find: 'export const FIXED_STEP = 1 / 120;',
    replace: 'export const FIXED_STEP = 1 / 90;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the delta ceiling is the value the standard states',
    file: 'src/core/config.ts',
    find: 'export const DELTA_CEILING = 0.25;',
    replace: 'export const DELTA_CEILING = 0.5;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the catch-up slice is the value the standard states',
    file: 'src/core/config.ts',
    find: 'export const CATCH_UP_SLICE = 1 / 60;',
    replace: 'export const CATCH_UP_SLICE = 1 / 30;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the resume threshold is the value the standard states',
    file: 'src/core/config.ts',
    find: 'export const RESUME_GAP = 5;',
    replace: 'export const RESUME_GAP = 50;',
    detectedBy: 'unit',
  },

  {
    item: 'B2',
    name: 'damping is per second rather than once per step',
    file: 'src/core/physics.ts',
    find: '  const perStepDecay = decayFactor(FIXED_STEP);',
    replace: '  const perStepDecay = DAMPING;',
    detectedBy: 'unit',
  },
  {
    item: 'B2',
    name: 'a step damps at all',
    file: 'src/core/physics.ts',
    find: '      scale(body.velocity, perStepDecay);',
    replace: '      scale(body.velocity, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'B2',
    name: 'the damping constant is the one SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const DAMPING = 0.32;',
    replace: 'export const DAMPING = 0.33;',
    detectedBy: 'unit',
  },

  {
    item: 'B3',
    name: 'a body at or below the stop threshold is zeroed',
    file: 'src/core/physics.ts',
    find: `      if (atRest(body.velocity)) {
        zero(body.velocity);
      }`,
    replace: '      void atRest;',
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'the threshold reads at or below rather than below',
    file: 'src/core/physics.ts',
    find: '  return Math.hypot(velocity.x, velocity.y) <= STOP_SPEED;',
    replace: '  return Math.hypot(velocity.x, velocity.y) < STOP_SPEED;',
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'the stop threshold is the value SPEC section 6.2 states',
    file: 'src/core/config.ts',
    find: 'export const STOP_SPEED = 6;',
    replace: 'export const STOP_SPEED = 7;',
    detectedBy: 'unit',
  },

  {
    // RE-POINTED AT PF-3. The statement grew a second call, because item B6's
    // reflection reads the mask `contain` returns rather than reading the four
    // bounds a second time. The property this entry attacks is unchanged:
    // remove the statement and no body is contained by anything.
    item: 'B9',
    name: 'every body is contained by the field bound, every step',
    file: 'src/core/physics.ts',
    find: `    for (const body of bodies) {
      reflect(body, contain(body));
    }`,
    replace: '    void contain;',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'containment is measured at the body edge and not at its centre',
    file: 'src/core/physics.ts',
    find: '    at.x = FIELD_LEFT + body.radius;',
    replace: '    at.x = FIELD_LEFT;',
    detectedBy: 'unit',
  },
  {
    // RE-POINTED AT PF-4. The statement grew the goal-opening exemption in
    // front of it, item B7, and the property this entry attacks is unchanged:
    // read the bound against the centre rather than against the edge and every
    // body is half of itself outside the field.
    item: 'B9',
    name: 'the containment test reads the body edge against the bound',
    file: 'src/core/physics.ts',
    find: '  if (!throughTheOpening && at.x - body.radius < FIELD_LEFT) {',
    replace: '  if (!throughTheOpening && at.x < FIELD_LEFT) {',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'the field bound is where SPEC section 3 puts it',
    file: 'src/core/config.ts',
    find: 'export const FIELD_RIGHT = 1190;',
    replace: 'export const FIELD_RIGHT = 1195;',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'the contact disc is measured from both radii',
    file: 'src/core/config.ts',
    find: 'export const CIRCLE_RADIUS = 34;',
    replace: 'export const CIRCLE_RADIUS = 35;',
    detectedBy: 'unit',
  },

  {
    // The SECOND application of the cap, at DESIGN section 3's position 5, has
    // its own entry in the PF-3 block below. PF-2 recorded a deliberate absence
    // here, because nothing between the two applications could raise a speed
    // until item B4's elastic transfer existed; PF-3 built the transfer and the
    // absence became a live entry.
    item: 'B10',
    name: 'nothing is integrated over the global speed cap',
    file: 'src/core/physics.ts',
    find: `    for (const body of bodies) {
      limit(body.velocity, SPEED_CAP);
    }`,
    replace: '    void limit;',
    detectedBy: 'unit',
  },
  {
    item: 'B10',
    name: 'the speed cap is the value SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const SPEED_CAP = 1200;',
    replace: 'export const SPEED_CAP = 2400;',
    detectedBy: 'unit',
  },
  {
    item: 'B10',
    name: 'a velocity set from outside is capped on the way in',
    file: 'src/core/bodies.ts',
    find: `  set(body.velocity, x, y);
  limit(body.velocity, SPEED_CAP);`,
    replace: '  set(body.velocity, x, y);',
    detectedBy: 'unit',
  },
  {
    item: 'B10',
    name: 'a launch is capped on the way in',
    file: 'src/core/bodies.ts',
    find: `  fromAngle(body.velocity, radians, speed);
  limit(body.velocity, SPEED_CAP);`,
    replace: '  fromAngle(body.velocity, radians, speed);',
    detectedBy: 'unit',
  },

  {
    item: 'B11',
    name: 'a non-finite position is repaired rather than propagated',
    file: 'src/core/physics.ts',
    find: `    if (!isFiniteVec2(body.position)) {
      copy(body.position, safe);
      record(body.kind, 'position');
    }`,
    replace: '    void safe;',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'a non-finite velocity is repaired rather than propagated',
    file: 'src/core/physics.ts',
    find: `    if (!isFiniteVec2(body.velocity)) {
      zero(body.velocity);
      record(body.kind, 'velocity');
    }`,
    replace: '    void body;',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'the repair source is only ever a position that was finite',
    file: 'src/core/physics.ts',
    find: '      if (body !== undefined && safe !== undefined && isFiniteVec2(body.position)) {',
    replace: '      if (body !== undefined && safe !== undefined) {',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'the development policy raises after the repair',
    file: 'src/core/physics.ts',
    find: "    if (policy === 'throw') {",
    replace: "    if (policy === 'repair') {",
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'containment leaves a non-finite position for the guard to catch',
    file: 'src/core/physics.ts',
    find: `  if (!isFiniteVec2(at)) {
    return 0;
  }
`,
    replace: '',
    detectedBy: 'unit',
  },

  {
    // There is deliberately no entry attacking the generator's warm-up draws.
    // Nothing pins an absolute value out of the stream, on purpose: a test
    // that did would be a test of this generator rather than of the property
    // item B12 states, and it would have to be rewritten the day the
    // generator is replaced. Removing the warm-up changes every sequence and
    // no assertion, which is the correct outcome for a detail nobody depends
    // on rather than a gap.
    item: 'B12',
    name: 'a stream is derived from the seed and not from its path alone',
    file: 'src/core/rng.ts',
    find: 'const words = expand(`${seed}#${path}`);',
    replace: 'const words = expand(path);',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a split stream is a new stream and not the one it came from',
    file: 'src/core/rng.ts',
    find: "    split: (name) => createStream(seed, path === '' ? name : `${path}/${name}`),",
    replace: '    split: () => stream,',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a split stream is named by its whole path from the root',
    file: 'src/core/rng.ts',
    find: "path === '' ? name : `${path}/${name}`",
    replace: 'name',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-2, second pass. Gates the part added without an entry behind them,
  // and the exported surfaces PF-3 will build on before it can.
  // ---------------------------------------------------------------------

  {
    item: 'B3',
    name: 'a zeroed vector is positive zero in both components',
    file: 'src/core/vec2.ts',
    find: `  out.x = 0;
  out.y = 0;
  return out;`,
    replace: `  out.x = out.x * 0;
  out.y = out.y * 0;
  return out;`,
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'a stopped body is an equality and not an epsilon',
    file: 'src/core/bodies.ts',
    find: '  return body.velocity.x === 0 && body.velocity.y === 0;',
    replace: '  return Math.hypot(body.velocity.x, body.velocity.y) < 1e-9;',
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'a kickoff clears every velocity',
    file: 'src/core/bodies.ts',
    find: '    zero(body.velocity);',
    replace: '    void body;',
    detectedBy: 'unit',
  },

  {
    item: 'B9',
    name: 'the wall mask sets a bit for every wall that clamped',
    file: 'src/core/physics.ts',
    find: '    walls |= WALL_TOP;',
    replace: '    walls |= 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'no two walls share a bit in the mask',
    file: 'src/core/physics.ts',
    find: 'export const WALL_RIGHT = 2;',
    replace: 'export const WALL_RIGHT = 1;',
    detectedBy: 'unit',
  },

  {
    item: 'B1',
    name: 'a reset drops the accumulator',
    file: 'src/core/physics.ts',
    find: `      leftover = 0;
    },`,
    replace: '    },',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the readout counts what it says it counts',
    file: 'src/core/physics.ts',
    find: '      return { steps, frames, leftover, repairs: repaired, clamps, resumes };',
    replace: '      return { steps, frames, leftover, repairs: repaired, clamps: 0, resumes: 0 };',
    detectedBy: 'unit',
  },

  {
    item: 'B11',
    name: 'the repair list handed out is a copy of the one kept',
    file: 'src/core/physics.ts',
    find: '    const reported = found.slice();',
    replace: '    const reported = found;',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'a reset re-arms the repair source',
    file: 'src/core/physics.ts',
    find: '          set(safe, body.position.x, body.position.y);',
    replace: '          void safe;',
    detectedBy: 'unit',
  },

  {
    item: 'B12',
    name: 'splitting a stream does not advance the stream it came from',
    file: 'src/core/rng.ts',
    find: "    split: (name) => createStream(seed, path === '' ? name : `${path}/${name}`),",
    replace: `    split: (name) => {
      nextUint32();
      return createStream(seed, path === '' ? name : \`\${path}/\${name}\`);
    },`,
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'an integer draw rejects the biased tail rather than folding it',
    file: 'src/core/rng.ts',
    find: `      const ceiling = WORD - (WORD % span);
      for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt += 1) {
        const drawn = nextUint32();
        if (drawn < ceiling) {
          return low + (drawn % span);
        }
      }`,
    replace: '      return low + (nextUint32() % span);',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a span wider than one draw is refused',
    file: 'src/core/rng.ts',
    find: '        span > WORD',
    replace: '        span > WORD * 2',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a float draw is divided by the whole draw space',
    file: 'src/core/rng.ts',
    find: '    nextFloat: () => nextUint32() / WORD,',
    replace: '    nextFloat: () => nextUint32() / (WORD - 1),',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'the seed expansion reads every character it is given',
    file: 'src/core/rng.ts',
    find: '  for (let at = 0; at < seed.length; at += 1) {',
    replace: '  for (let at = 0; at < seed.length - 1; at += 1) {',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-3. Elastic collisions, positional separation and wall reflection.
  //
  // SPEC section 6.3 is three rules that have to be applied in one order
  // and one number of times, so the entries below attack each rule, the
  // order and the count separately: a resolver missing its gate and a
  // resolver running one pass instead of four are different defects and
  // they fail in different places.
  // ---------------------------------------------------------------------

  {
    item: 'B4',
    name: 'a step resolves body pairs at all',
    file: 'src/core/physics.ts',
    find: '    resolveContacts(world);',
    replace: '    void resolveContacts;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the impulse is gated on the pair actually approaching',
    file: 'src/core/collisions.ts',
    find: `  if (!(approach < 0)) {
    return true;
  }`,
    replace: '  void approach;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the restitution in the impulse is the one SPEC section 6.1 states',
    file: 'src/core/collisions.ts',
    find: '  const impulse = (-(1 + CIRCLE_RESTITUTION) * approach) / (1 / a.mass + 1 / b.mass);',
    replace: '  const impulse = -approach / (1 / a.mass + 1 / b.mass);',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the circle restitution is the value SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const CIRCLE_RESTITUTION = 1;',
    replace: 'export const CIRCLE_RESTITUTION = 0.5;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the impulse is divided by the reduced mass and not by two',
    file: 'src/core/collisions.ts',
    find: '(1 / a.mass + 1 / b.mass);',
    replace: '2;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the impulse is applied along the contact normal alone',
    file: 'src/core/collisions.ts',
    find: '  addScaled(a.velocity, contactNormal, -(impulse / a.mass));',
    replace: '  addScaled(a.velocity, closingVelocity, -(impulse / a.mass));',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the two bodies are pushed in opposite directions',
    file: 'src/core/collisions.ts',
    find: '  addScaled(b.velocity, contactNormal, impulse / b.mass);',
    replace: '  addScaled(b.velocity, contactNormal, -(impulse / b.mass));',
    detectedBy: 'unit',
  },
  {
    // The two totality guards, which are the reason both readings in
    // `resolvePair` are written as refusals of a proven fact rather than as the
    // comparison SPEC section 6.3 states. Flipped to the plain form, a body
    // whose position is not a number reads as a contact against a healthy one
    // and four passes shove the healthy body 104 px, which the sanitiser does
    // not undo because it repairs only the body that was poisoned. That is item
    // B11's "caught rather than propagated" clause, so both entries live under
    // B11 rather than under the collision items.
    item: 'B11',
    name: 'a position that is not a number is not a contact',
    file: 'src/core/collisions.ts',
    find: '  if (!(distanceSquared(a.position, b.position) <= reach * reach)) {',
    replace: '  if (distanceSquared(a.position, b.position) > reach * reach) {',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'a relative velocity that is not a number is not an approach',
    file: 'src/core/collisions.ts',
    find: '  if (!(approach < 0)) {',
    replace: '  if (approach >= 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'a pair that is not touching answers that it is not',
    file: 'src/core/collisions.ts',
    find: '    return false;',
    replace: '    return true;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the touching test measures both radii',
    file: 'src/core/collisions.ts',
    find: '  const reach = a.radius + b.radius;',
    replace: '  const reach = a.radius;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the touching test measures both axes',
    file: 'src/core/vec2.ts',
    find: '  return dx * dx + dy * dy;',
    replace: '  return dx * dx;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'a difference of two vectors is a difference',
    file: 'src/core/vec2.ts',
    find: `  out.x -= other.x;
  out.y -= other.y;`,
    replace: `  out.x += other.x;
  out.y += other.y;`,
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the approach reading projects both components',
    file: 'src/core/vec2.ts',
    find: '  return one.x * other.x + one.y * other.y;',
    replace: '  return one.x * other.x;',
    detectedBy: 'unit',
  },
  {
    // The site item B10's criterion names, "a ball accelerated by an elastic
    // transfer", and the entry PF-2 recorded as a deliberate absence because
    // nothing could yet raise a speed between the two applications of the cap.
    item: 'B10',
    name: 'the cap is applied again after the elastic transfer',
    file: 'src/core/physics.ts',
    find: `      scale(body.velocity, perStepDecay);
      limit(body.velocity, SPEED_CAP);`,
    replace: '      scale(body.velocity, perStepDecay);',
    detectedBy: 'unit',
  },

  {
    item: 'B5',
    name: 'an overlapping pair is separated positionally',
    file: 'src/core/collisions.ts',
    find: `  if (penetration > 0) {
    const half = penetration / 2;
    addScaled(a.position, contactNormal, -half);
    addScaled(b.position, contactNormal, half);
  }`,
    replace: '  void penetration;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'each body moves half the penetration and not all of it',
    file: 'src/core/collisions.ts',
    find: '    const half = penetration / 2;',
    replace: '    const half = penetration;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the two bodies are separated in opposite directions',
    file: 'src/core/collisions.ts',
    find: '    addScaled(a.position, contactNormal, -half);',
    replace: '    addScaled(a.position, contactNormal, half);',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the penetration is measured from the reach and the distance',
    file: 'src/core/collisions.ts',
    find: '  const penetration = reach - between;',
    replace: '  const penetration = reach;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'coincident centres take the fixed normal SPEC section 6.3 names',
    file: 'src/core/collisions.ts',
    find: '  const between = normalise(contactNormal, 1, 0);',
    replace: '  const between = normalise(contactNormal, 0, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the fallback normal is the one the caller asked for',
    file: 'src/core/vec2.ts',
    find: `    out.x = fallbackX;
    out.y = fallbackY;`,
    replace: `    out.x = fallbackY;
    out.y = fallbackX;`,
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'a distance under the coincidence epsilon takes the fallback',
    file: 'src/core/vec2.ts',
    find: 'measured < COINCIDENT_EPSILON',
    replace: 'measured < 0',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the pairs are resolved four times per step',
    file: 'src/core/collisions.ts',
    find: '  for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {',
    replace: '  for (let pass = 0; pass < 1; pass += 1) {',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the pass count is the one SPEC section 6.3 states',
    file: 'src/core/config.ts',
    find: 'export const SOLVER_ITERATIONS = 4;',
    replace: 'export const SOLVER_ITERATIONS = 6;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the pairs are resolved in the fixed order the section states',
    file: 'src/core/collisions.ts',
    find: `    resolvePair(world.player, world.opponent);
    resolvePair(world.player, world.ball);`,
    replace: `    resolvePair(world.player, world.ball);
    resolvePair(world.player, world.opponent);`,
    detectedBy: 'unit',
  },

  {
    item: 'B6',
    name: 'a clamped body has its velocity reflected at all',
    file: 'src/core/physics.ts',
    find: '      reflect(body, contain(body));',
    replace: '      contain(body);',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the left wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_LEFT) !== 0 && moving.x < 0) {
    moving.x = -moving.x * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_LEFT;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the right wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_RIGHT) !== 0 && moving.x > 0) {
    moving.x = -moving.x * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_RIGHT;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the bottom wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_BOTTOM;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the top wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_TOP) !== 0 && moving.y > 0) {
    moving.y = -moving.y * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_TOP;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the reflection reads the mask rather than the velocity alone',
    file: 'src/core/physics.ts',
    find: '  if ((walls & WALL_LEFT) !== 0 && moving.x < 0) {',
    replace: '  if (walls >= 0 && moving.x < 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'a body already leaving a wall is not turned back into it',
    file: 'src/core/physics.ts',
    find: '  if ((walls & WALL_RIGHT) !== 0 && moving.x > 0) {',
    replace: '  if ((walls & WALL_RIGHT) !== 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the reflection is scaled by the restitution',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y * WALL_RESTITUTION;`,
    replace: `  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y;`,
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the wall restitution is the value SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const WALL_RESTITUTION = 0.92;',
    replace: 'export const WALL_RESTITUTION = 0.9;',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-4. The goal opening, the goal test and the GOAL state.
  //
  // SPEC section 6.4 is one predicate doing two jobs and a two-part goal
  // condition on top of it, so the entries below attack each job, each
  // condition and each bound separately: a transparency that stopped
  // exempting the ball and a detection that started scoring half-in balls
  // are different defects, and only one of them is visible on the pitch.
  //
  // The GOAL state entries carry item B8's label because PF-4 is where the
  // machinery was built. The criteria that grade it are item D7 and item D6
  // at PF-7 and item J2 at PF-9, and the suites named there will inherit
  // these entries rather than write them again.
  // ---------------------------------------------------------------------

  {
    item: 'B7',
    name: 'the goal opening is a rule about which body it is',
    file: 'src/core/goals.ts',
    find: `  if (body.kind !== 'ball') {
    return false;
  }`,
    replace: '  void body;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the opening test measures the whole ball at the low post',
    file: 'src/core/goals.ts',
    find: '    at.y - body.radius >= GOAL_OPENING_LOW - slack &&',
    replace: '    at.y >= GOAL_OPENING_LOW - slack &&',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the opening test measures the whole ball at the high post',
    file: 'src/core/goals.ts',
    find: '    at.y + body.radius <= GOAL_OPENING_HIGH + slack',
    replace: '    at.y <= GOAL_OPENING_HIGH + slack',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the opening is where SPEC section 3 puts it',
    file: 'src/core/config.ts',
    find: 'export const GOAL_OPENING_LOW = 265;',
    replace: 'export const GOAL_OPENING_LOW = 255;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the hysteresis is applied to a ball that is already through',
    file: 'src/core/goals.ts',
    find: '  const slack = centrePastAGoalLine(body) ? GOAL_OPENING_HYSTERESIS : 0;',
    replace: '  const slack = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the hysteresis widens the opening rather than narrowing it',
    file: 'src/core/goals.ts',
    find: '  const slack = centrePastAGoalLine(body) ? GOAL_OPENING_HYSTERESIS : 0;',
    replace: '  const slack = centrePastAGoalLine(body) ? -GOAL_OPENING_HYSTERESIS : 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the hysteresis is the value SPEC section 6.4 states',
    file: 'src/core/config.ts',
    find: 'export const GOAL_OPENING_HYSTERESIS = 0.5;',
    replace: 'export const GOAL_OPENING_HYSTERESIS = 5;',
    detectedBy: 'unit',
  },
  {
    // The documented reading in `centrePastAGoalLine`. Read as the leading
    // edge touching the line, the widened bound applies on the way in too and
    // SPEC section 6.4's condition 2 stops being the binding one.
    item: 'B7',
    name: 'a ball on its way in is judged at the exact bound',
    file: 'src/core/goals.ts',
    find: '  return body.position.x < LEFT_GOAL_LINE || body.position.x > RIGHT_GOAL_LINE;',
    replace: `  return (
    body.position.x - body.radius < LEFT_GOAL_LINE ||
    body.position.x + body.radius > RIGHT_GOAL_LINE
  );`,
    detectedBy: 'unit',
  },
  {
    // The comparison the documented reading of "already through" turns on. At
    // or past the line rather than past it, and the slack meant for a ball that
    // has gone through arrives at the position where it is deciding whether to.
    item: 'B7',
    name: 'a centre exactly on the goal line is not through yet',
    file: 'src/core/goals.ts',
    find: '  return body.position.x < LEFT_GOAL_LINE || body.position.x > RIGHT_GOAL_LINE;',
    replace: '  return body.position.x <= LEFT_GOAL_LINE || body.position.x >= RIGHT_GOAL_LINE;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the left goal end is transparent to a ball that fits',
    file: 'src/core/physics.ts',
    find: '  if (!throughTheOpening && at.x - body.radius < FIELD_LEFT) {',
    replace: '  if (at.x - body.radius < FIELD_LEFT) {',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the right goal end is transparent to a ball that fits',
    file: 'src/core/physics.ts',
    find: '  if (!throughTheOpening && at.x + body.radius > FIELD_RIGHT) {',
    replace: '  if (at.x + body.radius > FIELD_RIGHT) {',
    detectedBy: 'unit',
  },
  {
    // The other half of transparency, which is the half that comes free: no
    // clamp means no wall bit means no reflection. This entry puts the bit
    // back while leaving the position alone, which is a ball that passes
    // through the mouth and is turned around inside the goal.
    item: 'B7',
    name: 'a ball passing through a goal end is not turned by it',
    file: 'src/core/physics.ts',
    find: `  if (!throughTheOpening && at.x + body.radius > FIELD_RIGHT) {
    at.x = FIELD_RIGHT - body.radius;
    walls |= WALL_RIGHT;
  }`,
    replace: `  if (at.x + body.radius > FIELD_RIGHT) {
    if (!throughTheOpening) {
      at.x = FIELD_RIGHT - body.radius;
    }
    walls |= WALL_RIGHT;
  }`,
    detectedBy: 'unit',
  },

  {
    item: 'B8',
    name: 'the right goal is measured at the trailing edge, not the centre',
    file: 'src/core/goals.ts',
    find: '  if (at.x - body.radius >= RIGHT_GOAL_LINE) {',
    replace: '  if (at.x >= RIGHT_GOAL_LINE) {',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the left goal is measured at the trailing edge, not the centre',
    file: 'src/core/goals.ts',
    find: '  if (at.x + body.radius <= LEFT_GOAL_LINE) {',
    replace: '  if (at.x <= LEFT_GOAL_LINE) {',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal needs the opening test as well as the line',
    file: 'src/core/goals.ts',
    find: `  if (!ballFitsOpening(body)) {
    return undefined;
  }
  return trailingEdgePast(body);`,
    replace: '  return trailingEdgePast(body);',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the step tests for a goal at all',
    file: 'src/core/physics.ts',
    find: '    scoring.observe(world, steps);',
    replace: '    void steps;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal awards exactly one point',
    file: 'src/core/goals.ts',
    find: '      scores[scorer] += 1;',
    replace: '      scores[scorer] += 2;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the mouth the ball entered names the side that attacks it',
    file: 'src/core/goals.ts',
    find: "const SCORER: Readonly<Record<GoalMouth, Side>> = { left: 'opponent', right: 'player' };",
    replace: "const SCORER: Readonly<Record<GoalMouth, Side>> = { left: 'player', right: 'opponent' };",
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal freezes the simulation where the ball lies',
    file: 'src/core/physics.ts',
    find: `    if (scoring.frozen()) {
      scoring.holdOneStep(world);
      steps += 1;
      return;
    }`,
    replace: '    void scoring;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal starts the hold, which is what keeps the award to one',
    file: 'src/core/goals.ts',
    find: '      hold = GOAL_HOLD_STEPS;',
    replace: '      hold = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the hold counts down rather than running forever',
    file: 'src/core/goals.ts',
    find: '      hold -= 1;',
    replace: '      hold -= 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the celebration hold is the duration SPEC section 6.4 states',
    file: 'src/core/config.ts',
    find: 'export const GOAL_HOLD = 1.2;',
    replace: 'export const GOAL_HOLD = 1.5;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the hold is that duration counted in fixed steps',
    file: 'src/core/goals.ts',
    find: 'export const GOAL_HOLD_STEPS = Math.round(GOAL_HOLD / FIXED_STEP);',
    replace: 'export const GOAL_HOLD_STEPS = Math.round(GOAL_HOLD);',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the hold ends by putting the world back to kickoff',
    file: 'src/core/goals.ts',
    find: '      kickoff(world);',
    replace: '      void world;',
    detectedBy: 'unit',
  },
  {
    // The reset's other half, every velocity cleared, is attacked by the entry
    // above under item B3, "a kickoff clears every velocity": PF-2 built that
    // reading and PF-4 gave it a second detector in unit/goal-detection.
    item: 'B8',
    name: 'the reset puts every body back where it starts',
    file: 'src/core/bodies.ts',
    find: '    set(body.position, start.x, start.y);',
    replace: '    void start;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the goal test answers with the goal it awarded',
    file: 'src/core/goals.ts',
    find: '      return goal;',
    replace: '      return undefined;',
    detectedBy: 'unit',
  },
  {
    // The two ways a caller ends a celebration early, which PF-7 and PF-9 both
    // need: putting the world back, and starting a new match. A hold that
    // outlived either would freeze the state that replaced it.
    item: 'B8',
    name: 'putting the world back to kickoff drops a running celebration',
    file: 'src/core/physics.ts',
    find: '      scoring.clearHold();',
    replace: '      void 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a new match drops a running celebration with the scores',
    file: 'src/core/goals.ts',
    find: `      goals = 0;
      hold = 0;`,
    replace: '      goals = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the next turn belongs to the side that conceded',
    file: 'src/core/goals.ts',
    find: '      nextTurn = last === undefined ? nextTurn : last.conceded;',
    replace: '      nextTurn = last === undefined ? nextTurn : last.scorer;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a target reached ends the match instead of kicking off',
    file: 'src/core/goals.ts',
    find: `      if (target !== undefined && scores[scorer] >= target) {
        over = true;
      }`,
    replace: '      void target;',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-7. The match around the simulation: the turn-end conjunction, the
  // opponent's pre-launch wait, the goal hold routing and the restart.
  //
  // The conjunction gets one entry per half, because the halves prevent
  // different defects: a turn handed back while a body still moves, and a
  // turn handed back while the celebration is still running. The restart
  // order gets one entry for the protection the order provides rather than
  // for the textual order itself: within one synchronous restart, swapping
  // the two calls is state-identical and would be an undetectable entry, so
  // the entry drops the world reset entirely, which is the defect the order
  // exists to prevent and which tests/unit/goal-reset.test.ts watches for.
  // ---------------------------------------------------------------------

  {
    item: 'D1',
    name: 'a turn ends only when every body has stopped',
    file: 'src/core/match.ts',
    find: '      const turnOver = everyBodyStopped(sim.world) && !scoringNow.frozen;',
    replace: '      const turnOver = !scoringNow.frozen;',
    detectedBy: 'unit',
  },
  {
    item: 'D1',
    name: 'a turn at rest still waits for a running celebration to lift',
    file: 'src/core/match.ts',
    find: '      const turnOver = everyBodyStopped(sim.world) && !scoringNow.frozen;',
    replace: '      const turnOver = everyBodyStopped(sim.world);',
    detectedBy: 'unit',
  },
  {
    item: 'D1',
    name: 'a launch routes through MOVING with no special case',
    file: 'src/core/match.ts',
    find: "        state = { kind: 'MOVING', launchedBy: 'player' };",
    replace: "        state = { kind: 'PLAYER_TURN' };",
    detectedBy: 'unit',
  },
  {
    item: 'D2',
    name: 'the seam reads the whole delay from the config',
    file: 'src/core/match.ts',
    find: '      if (!opponentReady && opponentDelay >= OPPONENT_PRELAUNCH_DELAY) {',
    replace: '      if (!opponentReady && opponentDelay >= OPPONENT_PRELAUNCH_DELAY / 2) {',
    detectedBy: 'unit',
  },
  {
    item: 'D2',
    name: 'the wait accumulates the deltas it is driven with',
    file: 'src/core/match.ts',
    find: '      opponentDelay += elapsedOf(dt);',
    replace: '      opponentDelay = elapsedOf(dt);',
    detectedBy: 'unit',
  },
  {
    item: 'D6',
    name: 'the kickoff after a goal belongs to the side that conceded',
    file: 'src/core/match.ts',
    find: '        enterKickoff(state.goal.conceded);',
    replace: '        enterKickoff(state.goal.scorer);',
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'the match leaves GOAL when the freeze lifts, not while it runs',
    file: 'src/core/match.ts',
    find: '      } else if (!scoringNow.frozen) {',
    replace: '      } else {',
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'the goal reset preserves both scores',
    file: 'src/core/goals.ts',
    find: `      nextTurn = last === undefined ? nextTurn : last.conceded;
      kickoff(world);`,
    replace: `      nextTurn = last === undefined ? nextTurn : last.conceded;
      kickoff(world);
      scores.player = 0;
      scores.opponent = 0;`,
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'a goal does not restore the match clock',
    file: 'src/core/match.ts',
    find: '        enterKickoff(state.goal.conceded);',
    replace: '        remaining = options.duration;\n        enterKickoff(state.goal.conceded);',
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'the clock ticks through the celebration as well',
    file: 'src/core/match.ts',
    find:
      "    kind === 'PLAYER_TURN' || kind === 'OPPONENT_TURN' || kind === 'MOVING' || kind === 'GOAL'",
    replace: "    kind === 'PLAYER_TURN' || kind === 'OPPONENT_TURN' || kind === 'MOVING'",
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'a new match puts the world back before the scoreboard is cleared',
    file: 'src/core/match.ts',
    find: `    sim.reset();
    scoring.reset();`,
    replace: '    scoring.reset();',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-8. The opponent routine: the reachable cone, the difficulty
  // parameters and the power band, and the seam that answers them.
  //
  // The clamp gets one entry per stated property - the cone itself, the
  // solidity floor, the exact contact point - because a clamp that reads
  // the whole plane, a clamp without its floor and an aim with a safety
  // margin are three different defects that fail in different places. The
  // backwards discipline gets the entry that separates a bounded own-goal
  // soak from an unbounded one, and the difficulty entries attack the
  // draws the table states rather than the profile constants anybody can
  // check by eye.
  // ---------------------------------------------------------------------

  {
    item: 'D3',
    name: 'the clamp reads the reachable cone and not the whole plane',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  if (along >= floor) {',
    replace: '  if (true) {',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the floor holds the clamped side above a graze',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const floor = Math.max(TOUCHING / gap, MIN_STRIKE_SOLIDITY);',
    replace: '  const floor = TOUCHING / gap;',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the launch aims at the contact point and not past it',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  return { x: ball.x + side.x * BALL_RADIUS, y: ball.y + side.y * BALL_RADIUS };',
    replace:
      '  return { x: ball.x + side.x * (BALL_RADIUS + 2), y: ball.y + side.y * (BALL_RADIUS + 2) };',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the routine declines the strike that drives the ball backwards',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const backwards = towardX * targetX + towardY * targetY < 0;',
    replace: '  const backwards = false;',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the seam answers with the planned strength and not a stub',
    file: 'src/core/ai.ts', // the opponent routine
    find: "  match.dispatch({ kind: 'launch', angle: plan.angle, power: plan.power });",
    replace: "  match.dispatch({ kind: 'launch', angle: plan.angle, power: 0 });",
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the angular error spans the range the table states',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const errorRad = (2 * rng.nextFloat() - 1) * spanRad;',
    replace: '  const errorRad = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the whiff roll is a real possibility and not a vestige',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const whiffed = rng.nextFloat() < profile.whiffChance;',
    replace: '  const whiffed = false;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'a whiff lays the aim off the ball by the stated offset',
    file: 'src/core/ai.ts', // the opponent routine
    find: '    const offset = WHIFF_OFFSET * TOUCHING;',
    replace: '    const offset = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'D5',
    name: 'the power draw follows the stated aggression transform',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const drawnPower = low + (high - low) * rng.nextFloat() ** (1 - profile.aggression);',
    replace: '  const drawnPower = low + (high - low) * rng.nextFloat();',
    detectedBy: 'unit',
  },
  {
    item: 'D5',
    name: 'a derived shot asks for the trip margin the routine promises',
    file: 'src/core/ai.ts', // the opponent routine
    find: 'const POWER_MARGIN = 1.4;',
    replace: 'const POWER_MARGIN = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'D5',
    name: 'the band of the profile bounds the drawn power',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const [low, high] = profile.powerBand;',
    replace: '  const [low, high] = [0, 1];',
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the ladder rung that always overhits keeps doing so',
    file: 'src/core/ai.ts', // the opponent routine
    find: "  { name: 'Sparks', profile: { ...CASUAL, aggression: 1 } },",
    replace: "  { name: 'Sparks', profile: { ...CASUAL, aggression: 0.2 } },",
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the wild rung stays wilder than its base difficulty',
    file: 'src/core/ai.ts', // the opponent routine
    find:
      "  { name: 'Bolt', profile: { ...CASUAL, angularErrorDeg: 16, aggression: 0.75 } },",
    replace:
      "  { name: 'Bolt', profile: { ...CASUAL, angularErrorDeg: 12, aggression: 0.75 } },",
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the blocking rung actually aims to block',
    file: 'src/core/ai.ts', // the opponent routine
    find: "  { name: 'Anchor', profile: { ...PRO, defensiveBias: 0.85 } },",
    replace: "  { name: 'Anchor', profile: { ...PRO, defensiveBias: 0 } },",
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'wall candidates reach the routine that scores them',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  if (profile.useWallShots) {',
    replace: '  if (false) {',
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the best candidate is the one the physics favours',
    file: 'src/core/ai.ts', // the opponent routine
    find: '      if (score > bestScore) {',
    replace: '      if (false) {',
    detectedBy: 'unit',
  },

  // PF-11, pitch and entity rendering. The armour behind these entries is
  // tests/unit/render-*.test.ts: a recorder context censuses the draw calls,
  // so every entry here either changes what is drawn, what it is drawn with,
  // or how often it is drawn, and the census pins all three.

  {
    item: 'E3',
    name: 'the one transform maps design space y up, flipped',
    file: 'src/render/surface.ts',
    find: 'context.setTransform(scale, 0, 0, -scale, 0, LOGICAL_HEIGHT * scale);',
    replace: 'context.setTransform(scale, 0, 0, scale, 0, LOGICAL_HEIGHT * scale);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'a collapsed host still gets a one-pixel backing store',
    file: 'src/render/surface.ts',
    find: 'const width = Math.max(1, Math.round(cssWidth * deviceRatio));',
    replace: 'const width = Math.round(cssWidth * deviceRatio);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the surface is hidden from the accessibility tree',
    file: 'src/render/surface.ts',
    find: "canvas.setAttribute('aria-hidden', 'true');",
    replace: "canvas.setAttribute('aria-hidden', 'false');",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the surface carries the stable selection marker',
    file: 'src/render/surface.ts',
    find: "canvas.dataset['pf'] = 'play-surface';",
    replace: "canvas.dataset['pf'] = 'surface';",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the stripe count comes from the spacing scale, and stays even',
    file: 'src/render/pitch.ts',
    find: 'const count = Math.ceil(FIELD_WIDTH / STRIPE_WIDTH);',
    replace: 'const count = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the vignette fades the stripes and then hands the alpha back',
    file: 'src/render/pitch.ts',
    find: 'context.globalAlpha = VIGNETTE_EDGE_ALPHA;',
    replace: 'context.globalAlpha = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the rail boundary is a hairline, the one the section measures',
    file: 'src/render/pitch.ts',
    find: 'context.lineWidth = BORDER.hair;',
    replace: 'context.lineWidth = BORDER.thick;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the end walls sit outside the field bounds',
    file: 'src/render/pitch.ts',
    find: 'const left = FIELD_LEFT - WALL_THICKNESS;',
    replace: 'const left = FIELD_LEFT;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the centre spot stays the small radius step',
    file: 'src/render/pitch.ts',
    find: 'context.arc(BALL_START_X, BALL_START_Y, RADIUS.sm, 0, TAU);',
    replace: 'context.arc(BALL_START_X, BALL_START_Y, CENTRE_CIRCLE_RADIUS, 0, TAU);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'each goal frame is tinted to the side that defends it',
    file: 'src/render/pitch.ts',
    find: 'context.fillStyle = index === 0 ? palette.teamPlayer : palette.teamOpponent;',
    replace: 'context.fillStyle = index === 0 ? palette.teamOpponent : palette.teamPlayer;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the static pitch is cached, not rebuilt every frame',
    file: 'src/render/pitch.ts',
    find: 'if (layer === null || !pitchLayerIsCurrent(layer, surface, palette)) {',
    replace: 'if (true) {',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the blit returns the surface to design space',
    file: 'src/render/pitch.ts',
    find: 'applySurfaceTransform(surface.context, surface.scale);',
    replace: 'surface.context.setTransform(1, 0, 0, 1, 0, 0);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'every circle carries its facing marker',
    file: 'src/render/entities.ts',
    find: '  drawMarker(context, body, facing, glyphColour);',
    replace: '  ;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the ball boundary ring draws at the border step, like the circles',
    file: 'src/render/entities.ts',
    find:
      '  context.strokeStyle = palette.line;\n' +
      '  context.lineWidth = BORDER.thick;\n' +
      '  context.beginPath();\n' +
      '  context.arc(x, y, body.radius, 0, TAU);\n' +
      '  context.stroke();\n' +
      '}',
    replace:
      '  context.strokeStyle = palette.line;\n' +
      '  context.lineWidth = BORDER.hair;\n' +
      '  context.beginPath();\n' +
      '  context.arc(x, y, body.radius, 0, TAU);\n' +
      '  context.stroke();\n' +
      '}',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the kickoff glyphs are the ones SPEC section 4 names',
    file: 'src/render/entities.ts',
    find: "export const DEFAULT_GLYPHS: Glyphs = { player: 'P', opponent: 'O' };",
    replace: "export const DEFAULT_GLYPHS: Glyphs = { player: 'X', opponent: 'X' };",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the glyph counter-flip is a real flip',
    file: 'src/render/entities.ts',
    find: 'context.scale(1, -1);',
    replace: 'context.scale(1, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the central panel of the ball is a real pentagon',
    file: 'src/render/entities.ts',
    find: 'const PANEL_RADIUS = 0.42;',
    replace: 'const PANEL_RADIUS = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the rim patches reach into the clip',
    file: 'src/render/entities.ts',
    find: 'const PATCH_RADIUS = 0.3;',
    replace: 'const PATCH_RADIUS = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the ball draws, and draws last in the entity pass',
    file: 'src/render/entities.ts',
    find: '  drawBall(context, palette, world.ball);',
    replace: '  ;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the shipping entry never imports the capture hooks',
    file: 'src/main.ts',
    find: "import { drawFrame } from './render/pitch';",
    replace: "import { drawFrame } from './render/pitch';\nimport '../render/capture';",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the capture module never joins the emitted bytes by chunk either',
    file: 'src/main.ts',
    find: 'mount(host);',
    replace: "mount(host);\nimport('./render/capture');",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the hooks register under the key the capture script reads',
    file: 'src/render/capture.ts',
    find: "export const CAPTURE_KEY = '__pfCapture';",
    replace: "export const CAPTURE_KEY = '__pfSomethingElse';",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the density watch arms a live query and re-arms on every fire',
    file: 'src/render/surface.ts',
    find: 'query = win.matchMedia(`(resolution: ${String(ratio)}dppx)`);',
    replace: 'query = null;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'a layer is stale when the backing-store height moves too',
    file: 'src/render/pitch.ts',
    find: 'layer.canvas.height === surface.canvas.height',
    replace: 'layer.canvas.height === layer.canvas.height',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the capture hooks re-derive the scale on every redraw',
    file: 'src/render/capture.ts',
    find: '      surface.scale = scaleOf(seams.canvas);',
    replace: '      ;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the composition root asks the theme the stylesheet answers',
    file: 'src/main.ts',
    find: "const THEME_QUERY = '(prefers-color-scheme: dark)';",
    replace: "const THEME_QUERY = '(prefers-color-scheme: light)';",
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-13. The HUD and the panels as real DOM, and the gates the part
  // added: the MM:SS ceiling, the per-phase presence and reachability of
  // the pause control, the census of focusable controls per screen, the
  // derivation of every panel from the readout, and the scan that keeps a
  // pointer coordinate away from a chrome rectangle. The scan's own
  // entries are detected by the inventory that pins the matchers, the
  // positive controls and the empty exemption lists as source, because a
  // weakened scan over a clean tree still passes it.
  // ---------------------------------------------------------------------

  {
    item: 'M1',
    name: 'the clock face is the ceiling of the exact seconds',
    file: 'src/ui/components/clock.ts',
    find: '  return Math.ceil(remaining);',
    replace: '  return Math.round(remaining);',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the clock reads 00:00 only at exactly zero',
    file: 'src/ui/components/clock.ts',
    find: `  if (!(remaining > 0)) {
    return 0;
  }`,
    replace: `  if (remaining < 1) {
    return 0;
  }`,
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the turn indicator names the side and the state',
    file: 'src/ui/components/hud.ts',
    find: "      return 'YOUR TURN';",
    replace: "      return 'YOUR GO';",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the pause control is reachable in exactly the four in-play states',
    file: 'src/ui/components/hud.ts',
    find: `  'MOVING',
  'GOAL',
];`,
    replace: `  'MOVING',
];`,
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'a refused pause is refused without needing a pointer',
    file: 'src/ui/components/hud.ts',
    find: "    if (pause.getAttribute('aria-disabled') === 'true') {",
    replace: "    if (pause.getAttribute('aria-disabled') === 'never') {",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'a panel opens when its wiring shows it',
    file: 'src/ui/components/panel.ts',
    find: '      root.hidden = false;',
    replace: '      root.hidden = true;',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the census freezes the named controls per screen',
    file: 'src/ui/components/pause-panel.ts',
    find: "  panel.addControl(button('Resume', options.onResume));",
    replace: "  panel.addControl(button('Continue', options.onResume));",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'panel visibility is derived from the readout on every sync',
    file: 'src/ui/layout.ts',
    find: "    if (readout.state.kind !== 'PAUSED') {",
    replace: "    if (readout.state.kind === 'PAUSED') {",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the game-over panel words the result as the spec states it',
    file: 'src/ui/components/game-over-panel.ts',
    find: "    return 'You win!';",
    replace: "    return 'You lose!';",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the pause stack closes with the pause, whatever dismissed it',
    file: 'src/ui/layout.ts',
    find: `      if (settings.isOpen()) {
        settings.hide();
      }`,
    replace: '      void settings;',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the game-over panel hands focus to a stable anchor on the way out',
    file: 'src/ui/layout.ts',
    find: '        game.show(hud.pause);',
    replace: '        game.show();',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the coordinate matcher reads every way a pointer coordinate arrives',
    file: 'tests/unit/chrome-dom.test.ts',
    find: String.raw`const POINTER_COORDINATE = /\.(?:clientX|clientY|pageX|pageY|screenX|screenY|offsetX|offsetY)\b/;`,
    replace: String.raw`const POINTER_COORDINATE = /\.(?:clientY|pageX|pageY|screenX|screenY|offsetX|offsetY)\b/;`,
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the scan is proved live by its positive controls',
    file: 'tests/unit/chrome-dom.test.ts',
    find: "  'const x = pointer.pageY;',\n",
    replace: '',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'an exemption from the scan can only be added by name, here',
    file: 'tests/unit/chrome-dom.test.ts',
    find: `/** Checked exemptions: a path may hold a pattern only by name, here. */
const EXEMPT_COORDINATE: readonly string[] = [];`,
    replace: `/** Checked exemptions: a path may hold a pattern only by name, here. */
const EXEMPT_COORDINATE: readonly string[] = ['src/render/surface.ts'];`,
    detectedBy: 'unit',
  },
];

/**
 * Fresh violations dropped into the REAL src/core/, not into the fixtures. The
 * fixtures prove the rules reject a file that was written to be rejected; these
 * prove the shipping lint run reaches a file that was not, in more than one
 * module extension.
 */
export const ADDITIONS = [
  {
    item: 'M3',
    name: 'a new core module importing the render layer is rejected',
    file: 'src/core/mutation-render-import.ts',
    content: "import { drawPitch } from '../render/pitch';\n\nexport const used = drawPitch;\n",
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module importing the engine renderer is rejected',
    file: 'src/core/mutation-engine-renderer.mts',
    content:
      "import { createSurface } from '@js-games/engine/render';\n\nexport const used = createSurface;\n",
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module touching the DOM is rejected',
    file: 'src/core/mutation-dom-touch.ts',
    content: 'export const width = window.innerWidth;\n',
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module naming a canvas type is rejected',
    file: 'src/core/mutation-dom-type.mts',
    content: 'export const surface: HTMLCanvasElement | null = null;\n',
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module calling Math.random is rejected',
    file: 'src/core/mutation-math-random.ts',
    content: 'export const roll = Math.random();\n',
    detectedBy: 'lint',
  },
  {
    // A third extension, because an extension the configuration does not match
    // is not a weaker rule, it is no rule: the file is never linted at all.
    item: 'M3',
    name: 'a new core module in a third extension is still linted',
    file: 'src/core/mutation-third-extension.jsx',
    content: 'export const roll = Math.random();\n',
    detectedBy: 'lint',
  },

  // Item E1. Fresh literals dropped into the real src/, one per shape the
  // sweep is claimed to catch, and the last of them into a directory that has
  // no code in it at all. That is the claim that matters most: every part
  // after this one is written under the rule rather than audited against it
  // afterwards. The recursion the sweep needs to reach them is pinned by its
  // own entry above, because an addition alone cannot tell a walk that stopped
  // at the top level from one that found nothing to complain about.
  {
    item: 'E1',
    name: 'a stray colour literal in the chrome is rejected',
    file: 'src/ui/mutation-colour-literal.css',
    content: '.mutation {\n  color: #FF0000;\n}\n',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a stray dimension literal in the chrome is rejected',
    file: 'src/ui/mutation-dimension-literal.css',
    content: '.mutation {\n  padding: 12px;\n}\n',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a stray colour function in the renderer is rejected',
    file: 'src/render/mutation-colour-function.ts',
    content: "export const shadow = 'rgba(0, 0, 0, 0.5)';\n",
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a literal in a directory with no code yet is rejected',
    file: 'src/core/mutation-inherited-sweep.ts',
    content: "export const marker = '#123456';\n",
    detectedBy: 'unit',
  },
];

function occurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Ten minutes against a suite that takes seconds, and it is a fourth safety
 * property rather than a tuning number. A mutation can leave the code in a
 * state where a test loops forever rather than failing, and a synchronous loop
 * is not something a test runner's own timeout can interrupt. Without a
 * deadline here the whole gate hangs and reports nothing; with one, the
 * detector is killed, the run is not a pass, and the entry is correctly
 * reported as detected. Every loop in the suite carries its own budget for the
 * same reason; this is the backstop for the one that does not.
 */
const DETECTOR_TIMEOUT = 10 * 60 * 1000;

function detectorPasses(name) {
  const detector = DETECTORS[name];
  try {
    execFileSync(process.execPath, detector.argv(), {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      env: { ...process.env, CI: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: DETECTOR_TIMEOUT,
    });
    return { passed: true, output: '' };
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : '';
    const stderr = error && error.stderr ? String(error.stderr) : '';
    return { passed: false, output: `${stdout}${stderr}`.trim() };
  }
}

function runEdit(entry) {
  const absolute = path.join(PROJECT_ROOT, entry.file);
  const original = readFileSync(absolute, 'utf8');
  const hits = occurrences(original, entry.find);
  if (hits !== 1) {
    throw new Error(
      `mutation "${entry.name}" has gone stale: its target matches ${entry.file} ` +
        `${String(hits)} times, and a mutation must match exactly once. ` +
        'Re-point the entry at whatever replaced it, or delete the entry and ' +
        'the gate it was protecting together.',
    );
  }
  try {
    writeFileSync(absolute, original.replace(entry.find, entry.replace), 'utf8');
    return detectorPasses(entry.detectedBy).passed;
  } finally {
    writeFileSync(absolute, original, 'utf8');
  }
}

function runAddition(entry) {
  const absolute = path.join(PROJECT_ROOT, entry.file);
  if (existsSync(absolute)) {
    throw new Error(
      `mutation "${entry.name}" would overwrite ${entry.file}, which exists. ` +
        'Pick a path that does not.',
    );
  }
  try {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.content, 'utf8');
    return detectorPasses(entry.detectedBy).passed;
  } finally {
    rmSync(absolute, { force: true });
  }
}

export function main() {
  console.log('== baseline ==');
  for (const name of Object.keys(DETECTORS)) {
    const result = detectorPasses(name);
    if (!result.passed) {
      console.log(`  FAIL  ${DETECTORS[name].label} is red before any mutation`);
      console.log(result.output.split('\n').slice(-25).join('\n'));
      console.log(
        '\nrefusing to report: against a red tree every mutation looks detected.',
      );
      return 1;
    }
    console.log(`  ok    ${DETECTORS[name].label} green`);
  }

  const entries = [
    ...EDITS.map((entry) => ({ ...entry, kind: 'edit' })),
    ...ADDITIONS.map((entry) => ({ ...entry, kind: 'addition' })),
  ];

  console.log('\n== mutations ==');
  const missed = [];
  const counts = new Map();
  for (const entry of entries) {
    const stillGreen =
      entry.kind === 'edit' ? runEdit(entry) : runAddition(entry);
    const detected = !stillGreen;
    counts.set(entry.item, (counts.get(entry.item) ?? 0) + 1);
    const verdict = detected ? 'PASS' : 'FAIL';
    const by = detected
      ? `detected by ${DETECTORS[entry.detectedBy].label}`
      : 'NOT DETECTED';
    console.log(`  ${verdict}  ${entry.item}  ${entry.name.padEnd(58)} ${by}`);
    if (!detected) {
      missed.push(entry);
    }
  }

  console.log('\n== summary ==');
  for (const [item, total] of [...counts].sort()) {
    console.log(`  ${item}: ${String(total)} entries`);
  }
  const detected = entries.length - missed.length;
  console.log(
    `  ${String(entries.length)} entries, ${String(detected)} detected, ${String(missed.length)} missed`,
  );
  if (missed.length > 0) {
    console.log('\nUNDETECTED, so the gate each one names is decorative:');
    for (const entry of missed) {
      console.log(`  ${entry.item}  ${entry.name}`);
    }
    return 1;
  }
  console.log('\nmutations: PASS, every entry detected');
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
