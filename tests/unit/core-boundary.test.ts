import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  DOM_LIB_NAMES,
  DOM_LIB_ORIGIN,
  importClosure,
  importSpecifiers,
  isCorePath,
  matchesEngineRenderer,
  matchesSurfaceSegment,
  modulesUnder,
  readSpecifier,
  topLevelDeclarations,
  withoutComments,
} from '../../tools/eslint-plugin-core-boundary/index.js';

/**
 * Item M3, Critical: "The core import boundary is lint-enforced and the lint
 * fails the build ... A deliberately violating fixture is rejected by the same
 * rule."
 *
 * "The same rule" is the load-bearing phrase, so ESLint is constructed here
 * with a cwd and nothing else. No inline configuration, no rule objects passed
 * in, no severity overrides: what runs below is the file the build runs,
 * eslint.config.js, resolved the way the command line resolves it. A test that
 * hands ESLint its own copy of the rules proves the rules work and says nothing
 * about whether the project has them switched on.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const FIXTURES = path.join(PROJECT_ROOT, 'tests', 'lint', 'fixtures');
const VIOLATIONS = path.join(FIXTURES, 'core', 'violations.ts');
const CLEAN = path.join(FIXTURES, 'core', 'clean.ts');
const OUTSIDE = path.join(FIXTURES, 'outside', 'uses-dom.ts');
const CORE = path.join(PROJECT_ROOT, 'src', 'core');
const LEAKY_CORE = path.join(FIXTURES, 'reach', 'core');

const RULES = [
  'core-boundary/no-forbidden-imports',
  'core-boundary/no-dom',
  'core-boundary/no-math-random',
] as const;

const MARKER = /@expect\s+([\w-]+\/[\w-]+)(?::([\w]+))?/;

interface Expectation {
  ruleId: string;
  messageId: string | undefined;
}

function markers(file: string): Map<number, Expectation> {
  const found = new Map<number, Expectation>();
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = MARKER.exec(line);
    const ruleId = match?.[1];
    if (ruleId === undefined) {
      return;
    }
    found.set(index + 1, { ruleId, messageId: match?.[2] });
  });
  return found;
}

function eslint(): ESLint {
  return new ESLint({ cwd: PROJECT_ROOT });
}

async function lint(file: string): Promise<ESLint.LintResult> {
  const results = await eslint().lintFiles([file]);
  expect(results).toHaveLength(1);
  const only = results[0];
  if (only === undefined) {
    throw new Error(`no lint result for ${file}`);
  }
  return only;
}

function severityOf(entry: unknown): number {
  const value = Array.isArray(entry) ? entry[0] : entry;
  if (value === 'error') {
    return 2;
  }
  if (value === 'warn') {
    return 1;
  }
  if (value === 'off') {
    return 0;
  }
  return typeof value === 'number' ? value : -1;
}

/**
 * The budget the ESLint-loading tests carry, in milliseconds.
 *
 * A LITERAL, AND A MEASUREMENT RATHER THAN A TASTE. Constructing ESLint and
 * resolving the flat config pulls in typescript-eslint, @eslint/js and both
 * local plugins. Warm that is 1007 ms here and 1213 ms in the pointer file, the
 * two slowest tests in the suite. On a cold module graph, which is exactly what
 * `npm ci` followed immediately by `npm run test` produces in CI, the same work
 * measures 7.62 to 8.65 s across six fresh installs, exceeds Vitest's 5000 ms
 * default, and the unit gate goes red for a reason that has nothing to do with
 * the code. Reproduced three times out of three on fresh installs before this
 * budget existed, once more independently, and six times over at review.
 *
 * The two tests that shell out to a real `vite build` already carry their own
 * budgets for the same reason; these were the asymmetry. The default stays at
 * 5000 ms for everything else, so this is a named exception rather than a
 * suite-wide loosening: 30 seconds is about 3.5 times the slowest cold
 * measurement, which leaves room for a slower runner and still fails loudly on
 * anything genuinely hung.
 */
const COLD_ESLINT_LOAD_MS = 30_000;

/**
 * The tests that construct the linter, in the order the runner takes them.
 *
 * WHY IN ORDER. The cold module graph is paid once per test FILE, by whichever
 * test in it first resolves the flat config; every test after that one answers
 * warm. So the property is not "some test somewhere carries a budget", which is
 * what a search for one string asserts and what let a future linter test slide
 * in ahead of the budgeted one unnoticed. It is "the first test in this file
 * that touches the linter carries the budget", and that is what the census
 * below reads.
 *
 * The three helpers are the only routes to a linter in either file:
 * `eslint()` constructs one, and `lint()`, `only()` and `boundaryErrors()` all
 * call it. A fourth route would be a fourth name here.
 */
const LOADS_ESLINT = /\b(?:eslint|lint|only|boundaryErrors)\(/;

export function testBlocks(source: string): { title: string; body: string }[] {
  const found: { title: string; body: string }[] = [];
  const starts = [...source.matchAll(/\n[ \t]*it\(/g)];
  starts.forEach((start, index) => {
    const from = start.index ?? 0;
    const to = index + 1 < starts.length ? starts[index + 1]?.index : source.length;
    const body = source.slice(from, to ?? source.length);
    found.push({ title: /'([^']*)'/.exec(body)?.[1] ?? '', body });
  });
  return found;
}

/**
 * A file shaped like the two the census reads, whose first linter test has no
 * budget: the control, so a census that had stopped finding anything is caught
 * here rather than by a cold runner in six months.
 *
 * The opening token is composed rather than written, because this constant is
 * inside one of the files the census reads and a literal one here would be
 * found as a test of this file.
 */
const TEST = 'it';
const CENSUS_CONTROL = [
  "describe('a file shaped like the two the census reads', () => {",
  `  ${TEST}('answers without the linter', () => {`,
  '    expect(1).toBe(1);',
  '  });',
  '',
  `  ${TEST}('loads the linter without a budget', async () => {`,
  '    const result = await lint(VIOLATIONS);',
  '    expect(result).toBeDefined();',
  '  });',
  '',
  `  ${TEST}(`,
  "    'loads it again, with one',",
  '    { timeout: COLD_ESLINT_LOAD_MS },',
  '    async () => {',
  '      await eslint().calculateConfigForFile(CLEAN);',
  '    },',
  '  );',
  '});',
].join('\n');

describe('PF-0 core boundary, item M3', () => {
  it(
    'puts all three rules at error for a core module, in the shipping config',
    { timeout: COLD_ESLINT_LOAD_MS },
    async () => {
      const config = await eslint().calculateConfigForFile(
        path.join(PROJECT_ROOT, 'src', 'core', 'physics.ts'),
      );
      const rules = (config.rules ?? {}) as Record<string, unknown>;
      for (const rule of RULES) {
        expect(severityOf(rules[rule]), `${rule} severity`).toBe(2);
      }
    },
  );

  it(
    'puts the non-null assertion rule at error over the shipped source',
    { timeout: COLD_ESLINT_LOAD_MS },
    async () => {
      const RULE = '@typescript-eslint/no-non-null-assertion';
      const shipped = await eslint().calculateConfigForFile(
        path.join(PROJECT_ROOT, 'src', 'core', 'physics.ts'),
      );
      expect(
        severityOf((shipped.rules ?? {} as Record<string, unknown>)[RULE]),
        `${RULE} over src/`,
      ).toBe(2);

      // The scope, asserted rather than assumed, because it is deliberate and
      // narrow: three assertions live in the suite today, so the rule covers
      // the shipped source alone until they are written another way. A test
      // that only checked the first half would pass a rule applied everywhere
      // and a rule applied nowhere in particular.
      const suite = await eslint().calculateConfigForFile(
        path.join(PROJECT_ROOT, 'tests', 'unit', 'core-boundary.test.ts'),
      );
      expect(
        severityOf((suite.rules ?? {} as Record<string, unknown>)[RULE]),
        `${RULE} over tests/`,
      ).not.toBe(2);
    },
  );

  it('carries the cold budget on the first linter test of each file', () => {
    // READ AS SOURCE, BECAUSE THE DEFECT IS NOT REPRODUCIBLE ON A WARM TREE.
    // Every one of these tests answers in about a second here whether or not
    // the budget is written, and the only machine where it decides anything is
    // a runner that has just installed, which is every machine CI has. So the
    // presence of the option is the property, and it is asserted where it can
    // be: by census, in declaration order, rather than by looking for one
    // string anywhere in the file.
    const BUDGET = '{ timeout: COLD_ESLINT_LOAD_MS },';
    for (const [relative, atLeast] of [
      ['tests/unit/core-boundary.test.ts', 6],
      ['tests/unit/pointer-events.test.ts', 4],
    ] as const) {
      const source = readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
      expect(source, relative).toContain('const COLD_ESLINT_LOAD_MS = 30_000;');

      const loaders = testBlocks(source).filter((block) =>
        LOADS_ESLINT.test(block.body),
      );
      // Non-vacuous: the census found the tests rather than an empty list, and
      // the floor is open ended so a new linter test needs no edit here.
      expect(loaders.length, `${relative} linter tests`).toBeGreaterThanOrEqual(
        atLeast,
      );
      expect(
        loaders[0]?.body,
        `${relative}, first linter test: ${loaders[0]?.title ?? 'none found'}`,
      ).toContain(BUDGET);
    }

    // The control. A census that had stopped recognising a linter test would
    // report an empty list above and pass the floor by accident; this one has a
    // first test with no budget and the census has to say so.
    const censused = testBlocks(CENSUS_CONTROL).filter((block) =>
      LOADS_ESLINT.test(block.body),
    );
    expect(censused.map((block) => block.title)).toEqual([
      'loads the linter without a budget',
      'loads it again, with one',
    ]);
    expect(censused[0]?.body).not.toContain(BUDGET);
    expect(censused[1]?.body).toContain(BUDGET);

    // And the other half of the same decision: the suite-wide default is NOT
    // loosened. Five named exceptions are a measurement; a raised default is a
    // suite that no longer notices anything hanging.
    const config = readFileSync(
      path.join(PROJECT_ROOT, 'vitest.config.ts'),
      'utf8',
    );
    expect(/^\s*testTimeout\s*:/m.test(config), 'no suite-wide testTimeout').toBe(
      false,
    );
    expect(/^\s*testTimeout\s*:/m.test('  testTimeout: 30_000,\n')).toBe(true);
  });

  it('refuses to let a violating line switch off its own detection', async () => {
    const result = await lint(VIOLATIONS);
    const inert = result.messages.filter(
      (message) =>
        message.ruleId === null && /noInlineConfig/.test(message.message),
    );
    expect(inert.length).toBeGreaterThan(0);

    // The disable comment is inert, so the line beneath it is still an error.
    const suppressed = inert[0]?.line ?? 0;
    const stillReported = result.messages.filter(
      (message) =>
        message.severity === 2 &&
        message.line === suppressed + 1 &&
        message.ruleId === 'core-boundary/no-math-random',
    );
    expect(stillReported).toHaveLength(1);
  });

  it('reports every marked line, and reports nothing else', async () => {
    const expected = markers(VIOLATIONS);
    expect(expected.size).toBeGreaterThan(30);

    const result = await lint(VIOLATIONS);
    const errors = result.messages.filter((message) => message.severity === 2);

    // Direction one: every marker is backed by a real error of that rule.
    for (const [line, expectation] of expected) {
      const onLine = errors.filter((message) => message.line === line);
      expect(onLine.length, `line ${String(line)} reported nothing`).toBe(1);
      for (const message of onLine) {
        expect(message.ruleId, `line ${String(line)} rule`).toBe(
          expectation.ruleId,
        );
        if (expectation.messageId !== undefined) {
          expect(message.messageId, `line ${String(line)} message id`).toBe(
            expectation.messageId,
          );
        }
      }
    }

    // Direction two: nothing is reported that no marker asked for. Without
    // this half, a rule that reported every line would pass the half above.
    for (const message of errors) {
      expect(
        expected.has(message.line),
        `unmarked error at line ${String(message.line)}: ${message.message}`,
      ).toBe(true);
    }
    expect(errors).toHaveLength(expected.size);
  });

  it('fires all three rules at least once', async () => {
    const result = await lint(VIOLATIONS);
    const fired = new Set(
      result.messages
        .filter((message) => message.severity === 2)
        .map((message) => message.ruleId),
    );
    for (const rule of RULES) {
      expect(fired.has(rule), `${rule} never fired`).toBe(true);
    }
  });

  it('stays silent on the near misses inside core', async () => {
    const result = await lint(CLEAN);
    expect(
      result.messages.map((message) => `${String(message.line)}: ${message.message}`),
    ).toEqual([]);
  });

  it('stays silent on the same offences outside core', async () => {
    const result = await lint(OUTSIDE);
    expect(
      result.messages.map((message) => `${String(message.line)}: ${message.message}`),
    ).toEqual([]);
  });

  it('scopes itself to a core path segment, case-insensitively', async () => {
    const snippet = [
      "import { drawPitch } from '../render/pitch';",
      'export const width = window.innerWidth;',
      'export const roll = Math.random();',
      'export const used = [drawPitch, width, roll];',
      '',
    ].join('\n');

    async function boundaryErrors(relative: string): Promise<string[]> {
      const results = await eslint().lintText(snippet, {
        filePath: path.join(PROJECT_ROOT, relative),
      });
      return (results[0]?.messages ?? [])
        .filter(
          (message) =>
            message.severity === 2 &&
            (message.ruleId ?? '').startsWith('core-boundary/'),
        )
        .map((message) => message.ruleId ?? '');
    }

    expect(await boundaryErrors('src/core/probe.ts')).toHaveLength(3);
    // A case-insensitive filesystem serves this path for the one above, so a
    // case-sensitive scope would enforce the boundary on one machine only.
    expect(await boundaryErrors('src/Core/probe.ts')).toHaveLength(3);
    expect(await boundaryErrors('src/CORE/probe.ts')).toHaveLength(3);
    // A substring is not a segment.
    expect(await boundaryErrors('src/render/core-notes.ts')).toHaveLength(0);
    expect(await boundaryErrors('src/rendering-core-utils/probe.ts')).toHaveLength(0);
  });

  it('keeps the shipping lint command excluding exactly the fixtures', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const script = manifest.scripts?.['lint'];
    expect(script).toBeDefined();
    expect(script).toMatch(/^eslint \./);

    const ignored = [...(script ?? '').matchAll(/--ignore-pattern\s+(\S+)/g)].map(
      (match) => match[1],
    );
    // Exactly one, and exactly the fixtures. The fixtures are input to this
    // test and must never be linted by the build; anything else being excluded
    // would be a hole in the gate that nothing else would notice.
    expect(ignored).toEqual(['tests/lint/fixtures/']);
  });

  describe('the matchers, at the boundaries they are easiest to get wrong', () => {
    it('matches a path segment and not a substring', () => {
      for (const specifier of [
        '../render/pitch',
        './ui/hud',
        './ui.ts',
        'render',
        '@js-games/engine/render',
      ]) {
        expect(matchesSurfaceSegment(specifier), specifier).toBe(true);
      }
      for (const specifier of [
        '../render-cache/store',
        '../guidance/ui-copy',
        '../rendering-order',
        '../guide/uicopy',
        '@js-games/engine/render-utils',
      ]) {
        expect(matchesSurfaceSegment(specifier), specifier).toBe(false);
      }
    });

    it('matches the engine renderer as an exact package path prefix', () => {
      expect(matchesEngineRenderer('@js-games/engine/render')).toBe(true);
      expect(matchesEngineRenderer('@js-games/engine/render/passes')).toBe(true);
      expect(matchesEngineRenderer('@js-games/engine/render-utils')).toBe(false);
      expect(matchesEngineRenderer('@js-games/engine')).toBe(false);
    });

    it('reads only statically known specifiers', () => {
      expect(readSpecifier({ type: 'Literal', value: '../render/pitch' })).toBe(
        '../render/pitch',
      );
      expect(
        readSpecifier({
          type: 'TemplateLiteral',
          expressions: [],
          quasis: [{ value: { cooked: '../ui/hud' } }],
        }),
      ).toBe('../ui/hud');
      expect(
        readSpecifier({
          type: 'TemplateLiteral',
          expressions: [{ type: 'Identifier' }],
          quasis: [{ value: { cooked: '../' } }, { value: { cooked: '' } }],
        }),
      ).toBeNull();
      expect(readSpecifier({ type: 'Identifier', name: 'target' })).toBeNull();
    });

    it('scopes on segments, not on substrings', () => {
      expect(isCorePath('src/core/physics.ts')).toBe(true);
      expect(isCorePath('src\\core\\physics.ts')).toBe(true);
      expect(isCorePath('src/Core/physics.ts')).toBe(true);
      expect(isCorePath('src/render-cache/core-notes.ts')).toBe(false);
      expect(isCorePath('tools/eslint-plugin-core-boundary/index.js')).toBe(false);
      expect(isCorePath('')).toBe(false);
      expect(isCorePath(undefined)).toBe(false);
    });
  });

  /**
   * THE BOUNDARY DECIDED BY REACH.
   *
   * Everything above asks the question one file at a time, because that is all
   * a lint rule can see. One file at a time is one hop short of the item: a
   * core module that imports a non-core module which calls `Math.random`
   * satisfies every rule in the plugin and breaks item M3, and so does a core
   * module in a subdirectory that a top-level listing never reads. Both were
   * planted and both were green through lint and the whole unit suite.
   *
   * Neither is a shipped defect today, which is why the real tree can only ever
   * prove the walk found nothing. The fixture tree under tests/lint/fixtures/
   * reach/ is the half that proves it can find something.
   */
  describe('what a core module reaches, and not only what it names', () => {
    it('reads every core module recursively, not the top level of a directory', () => {
      const found = modulesUnder(CORE).map((file) =>
        path.relative(CORE, file).split(path.sep).join('/'),
      );
      // Named rather than counted, so the walk cannot quietly stop reading one
      // of them, and open ended, so the part that adds the next module does not
      // have to come back here to say so.
      for (const name of ['ai.ts', 'bodies.ts', 'match.ts', 'physics.ts', 'rng.ts']) {
        expect(found, name).toContain(name);
      }
      expect(found.length).toBeGreaterThanOrEqual(13);

      // The recursion itself, on the one tree that has a subdirectory to
      // descend. Without this the property is untestable until `src/core` grows
      // one, which is exactly when it stops being testable in time to matter.
      const leaky = modulesUnder(LEAKY_CORE).map((file) =>
        path.relative(LEAKY_CORE, file).split(path.sep).join('/'),
      );
      expect(leaky).toEqual(['entry.ts', 'sub/deep.ts']);
    });

    it('keeps the whole transitive closure of core inside core', () => {
      const closure = importClosure(CORE);
      expect(
        closure.escapes.map((escape) => `${escape.from} -> ${escape.specifier}`),
      ).toEqual([]);

      // A closure over nothing has no escapes either. This is the half that
      // cannot pass vacuously: the walk reached every module and each one is
      // inside the boundary.
      const inside = closure.modules.map((file) =>
        path.relative(CORE, file).split(path.sep).join('/'),
      );
      expect(inside).toEqual(
        modulesUnder(CORE).map((file) =>
          path.relative(CORE, file).split(path.sep).join('/'),
        ),
      );
      for (const relative of inside) {
        expect(isCorePath(path.join('src', 'core', relative)), relative).toBe(true);
      }
      expect(inside.length).toBeGreaterThanOrEqual(13);
    });

    it('reports the one hop out of a tree that has one', () => {
      // The negative control. The escape is two directories and one import away
      // from the entry point, so a walk that read the top level only, or read
      // entry points without following them, reports this tree clean.
      const closure = importClosure(LEAKY_CORE);
      expect(
        closure.escapes.map((escape) => `${escape.from} -> ${escape.specifier}`),
      ).toEqual(['sub/deep.ts -> ../../shared/unseeded']);
      // Named, not merely counted: the walk says which file it landed in, so a
      // failure is a line to read rather than a set that is not empty.
      expect(closure.escapes[0]?.resolved).toBe('../shared/unseeded.ts');
    });

    it('reads an import in every route, and reads no import out of a comment', () => {
      expect(
        importSpecifiers(
          [
            "import { a } from './one';",
            "import type { B } from './two';",
            "export { c } from './three';",
            "export * from './four';",
            "import './five';",
            "const d = await import('./six');",
            "const e = require('./seven');",
            "type F = import('./eight').Thing;",
            // THE WRAPPED FORMS, which are what five of the thirteen modules
            // under src/core are actually written in. A pattern that stopped at
            // the end of the line read none of these three and reported the
            // modules that use them as importing nothing at all.
            'import {',
            '  g,',
            "} from './nine';",
            'import type {',
            '  H,',
            "} from './ten';",
            'export {',
            '  i,',
            "} from './eleven';",
            "// import { j } from './twelve';",
            "/* import { k } from './thirteen'; */",
            "const label = \"import { l } from './fourteen';\";",
          ].join('\n'),
        ),
      ).toEqual([
        './one',
        './two',
        './three',
        './four',
        './five',
        './six',
        './seven',
        './eight',
        './nine',
        './ten',
        './eleven',
      ]);
    });

    it('grades the comment stripper on cases only the stripper can decide', () => {
      // WHY A SECOND SOURCE. Every negative case in the test above sits behind
      // a comment opener at column zero, and the static patterns are anchored
      // at the margin, so they would not have matched those lines with or
      // without a stripper: `withoutComments` could be replaced by the identity
      // function and that test would stay green. These four cases each turn on
      // one branch of the stripper and nothing else.
      const source = [
        // One: a block comment whose body starts at the margin. The anchored
        // pattern reads this as a statement unless the comment is removed.
        '/*',
        "import { hidden } from './block-hidden';",
        '*/',
        // Two: a line comment carrying a call form. The call patterns are
        // unanchored by necessity, so nothing but the stripper refuses this.
        "// const also = require('./line-hidden');",
        // Three: a string that merely contains a comment opener, followed by a
        // real import. Without the quote state the opener starts a comment that
        // never closes and every import below it disappears.
        'const opener = "/* not an opener";',
        "import { m } from './after-string';",
        // Four: a regular expression literal containing a quote, followed by a
        // real import. The scanner enters its quote state on the quote inside
        // the literal, so the rest of the file is copied verbatim rather than
        // stripped, and the import after it is still read. Copied verbatim is
        // the safe direction and this pins it.
        'const pattern = /[\'"]/;',
        "import { n } from './after-regex';",
      ].join('\n');

      expect(importSpecifiers(source)).toEqual([
        './after-string',
        './after-regex',
      ]);

      // And the stripper on its own, so a failure above says which half moved.
      const stripped = withoutComments(source);
      expect(stripped).not.toContain('./block-hidden');
      expect(stripped).not.toContain('./line-hidden');
      expect(stripped).toContain('./after-string');
      expect(stripped).toContain('/* not an opener');
    });
  });

  /**
   * The DOM name set, derived from the type definitions the build compiles
   * against rather than from a list somebody maintained.
   */
  describe('the DOM globals, derived rather than remembered', () => {
    it('derives a real set from the installed library files', () => {
      expect(DOM_LIB_ORIGIN, 'the DOM library file was found and read').not.toBeNull();
      // A derivation that silently found nothing would leave the rule at
      // whatever the hand list happens to hold, which is the state this was
      // written to leave behind.
      //
      // THE BAND IS NARROW BECAUSE THE SET IS A DEPENDENCY. Measured at 2021
      // names against the installed typescript 6.0.3, and the strictness of
      // item M3's boundary now moves with that package: a compiler release that
      // ADDS a DOM name tightens the rule loudly, because a core module that
      // used the name starts failing lint, while one that REMOVES a name
      // loosens it in silence. Dependabot ignores typescript majors only, so a
      // minor rides the weekly group. A wide floor would sit there through a
      // release that halved the set; these bounds report it.
      expect(DOM_LIB_NAMES.size).toBeGreaterThan(1900);
      expect(DOM_LIB_NAMES.size).toBeLessThan(2200);
    });

    it('holds the names a hand-written list missed', () => {
      for (const name of ['ChildNode', 'EventListener', 'Blob', 'console']) {
        expect(DOM_LIB_NAMES.has(name), name).toBe(true);
      }
    });

    it('holds none of the language s own, so core can still do arithmetic', () => {
      // The ES library files are subtracted for exactly this. Without the
      // subtraction the rule would report `Math` inside a module whose whole
      // job is arithmetic, and it would be switched off within a week.
      for (const name of ['Array', 'Map', 'Math', 'Promise']) {
        expect(DOM_LIB_NAMES.has(name), name).toBe(false);
      }
    });

    it('takes a declaration at the margin and a member never', () => {
      const declared = topLevelDeclarations(
        [
          'interface FakeElement {',
          '    interface NotThisOne: string;',
          '    declare var NorThisOne: number;',
          '}',
          'declare var fakeGlobal: FakeElement;',
          'declare function fakeCall(): void;',
          'type FakeAlias = FakeElement;',
          'declare namespace FakeSpace {}',
        ].join('\n'),
      );
      expect([...declared].sort()).toEqual([
        'FakeAlias',
        'FakeElement',
        'FakeSpace',
        'fakeCall',
        'fakeGlobal',
      ]);
    });
  });
});
