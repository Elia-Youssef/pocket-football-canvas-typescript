import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  isCorePath,
  matchesEngineRenderer,
  matchesSurfaceSegment,
  readSpecifier,
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

describe('PF-0 core boundary, item M3', () => {
  it('puts all three rules at error for a core module, in the shipping config', async () => {
    const config = await eslint().calculateConfigForFile(
      path.join(PROJECT_ROOT, 'src', 'core', 'physics.ts'),
    );
    const rules = (config.rules ?? {}) as Record<string, unknown>;
    for (const rule of RULES) {
      expect(severityOf(rules[rule]), `${rule} severity`).toBe(2);
    }
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
});
