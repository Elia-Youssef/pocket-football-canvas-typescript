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

function detectorPasses(name) {
  const detector = DETECTORS[name];
  try {
    execFileSync(process.execPath, detector.argv(), {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      env: { ...process.env, CI: '1' },
      maxBuffer: 64 * 1024 * 1024,
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
