import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  LEGACY_EVENT,
  LEGACY_HANDLER,
  LISTENER_METHODS,
} from '../../tools/eslint-plugin-pointer-events/index.js';

/**
 * Item C9, Critical, method T, evidence `lint/pointer-events`:
 *
 *   "Input is handled through Pointer Events only; no mouse or touch listener
 *    exists in the source. Aiming drags call setPointerCapture on pointerdown
 *    so a pointer leaving the canvas still updates the aim, and the canvas
 *    carries touch-action pinch-zoom outside an active capture."
 *
 * THIS FILE OWNS THE FIRST SENTENCE. The two clauses after it are behaviour
 * and are graded where behaviour can be driven: tests/browser/input-parity.
 * spec.ts takes a real drag off the edge of the canvas and asserts the aim
 * keeps tracking, and reads `touch-action` back from the computed style at
 * rest and during a capture. A source scan cannot decide either one, and a
 * test that claimed to would be asserting the presence of a call rather than
 * the property the call is supposed to buy.
 *
 * "THE SAME RULE" IS THE LOAD-BEARING PHRASE, so ESLint is constructed here
 * with a cwd and nothing else. No inline configuration, no rule object passed
 * in, no severity override: what runs below is the file the build runs,
 * eslint.config.js, resolved the way the command line resolves it.
 *
 * THREE ASSERTIONS, AND THE THIRD IS THE ONE THE CRITERION ACTUALLY MAKES.
 * The rule rejects a file written to be rejected; it stays silent on a file of
 * near misses; and the whole of `src/` is swept with it and comes back clean.
 * Only the third says anything about the shipped game, and it is only worth
 * anything because the first two prove the sweep can fail.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const FIXTURES = path.join(PROJECT_ROOT, 'tests', 'lint', 'fixtures', 'pointer');
const VIOLATIONS = path.join(FIXTURES, 'legacy-listeners.ts');
const CLEAN = path.join(FIXTURES, 'pointer-only.ts');
const SOURCE = path.join(PROJECT_ROOT, 'src');

const RULE = 'pointer-events/no-mouse-or-touch-listeners';
const MARKER = /@expect\s+([\w-]+\/[\w-]+)(?::([\w]+))?/;

interface Expectation {
  readonly ruleId: string;
  readonly messageId: string | undefined;
}

function markers(file: string): Map<number, Expectation> {
  const found = new Map<number, Expectation>();
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
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

async function lint(target: string): Promise<ESLint.LintResult[]> {
  return eslint().lintFiles([target]);
}

async function only(file: string): Promise<ESLint.LintResult> {
  const results = await lint(file);
  expect(results).toHaveLength(1);
  const first = results[0];
  if (first === undefined) {
    throw new Error(`no lint result for ${file}`);
  }
  return first;
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

describe('PF-6 pointer events only, item C9', () => {
  it('puts the rule at error in the shipping config, everywhere it lints', async () => {
    // Every file the project lints, not just the play surface: the criterion
    // says the SOURCE has no mouse or touch listener, and a second input path
    // written first as a test helper would be the same defect arriving by a
    // side door.
    for (const relative of [
      'src/render/input.ts',
      'src/ui/components/aim-controls.ts',
      'src/core/aiming.ts',
      'tests/unit/pointer-events.test.ts',
      'scripts/mutation-check.mjs',
    ]) {
      const config = await eslint().calculateConfigForFile(
        path.join(PROJECT_ROOT, relative),
      );
      const rules = (config.rules ?? {}) as Record<string, unknown>;
      expect(severityOf(rules[RULE]), `${RULE} in ${relative}`).toBe(2);
    }
  });

  it('reports every marked line of the fixture, and reports nothing else', async () => {
    const expected = markers(VIOLATIONS);
    // Twenty-seven shapes, so a fixture quietly emptied cannot pass this.
    expect(expected.size).toBe(27);

    const result = await only(VIOLATIONS);
    const errors = result.messages.filter((message) => message.severity === 2);

    // Direction one: every marker is backed by a real error of that rule.
    for (const [line, expectation] of expected) {
      const onLine = errors.filter((message) => message.line === line);
      expect(onLine.length, `line ${String(line)} reported nothing`).toBe(1);
      for (const message of onLine) {
        expect(message.ruleId, `line ${String(line)} rule`).toBe(expectation.ruleId);
        expect(message.messageId, `line ${String(line)} message id`).toBe(
          expectation.messageId,
        );
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

  it('fires both of its arms, and both of the listener methods', async () => {
    const result = await only(VIOLATIONS);
    const fired = result.messages
      .filter((message) => message.severity === 2)
      .map((message) => message.messageId);
    expect(fired.filter((id) => id === 'legacyListener').length).toBe(18);
    expect(fired.filter((id) => id === 'legacyHandler').length).toBe(9);
  });

  it('stays silent on the near misses', async () => {
    const result = await only(CLEAN);
    expect(
      result.messages.map((message) => `${String(message.line)}: ${message.message}`),
    ).toEqual([]);
  });

  it('finds no mouse or touch listener anywhere under src/', async () => {
    const results = await lint(path.join(SOURCE, '**', '*.ts'));
    const offences = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === RULE)
        .map(
          (message) =>
            `${path.relative(PROJECT_ROOT, result.filePath)}:${String(message.line)}`,
        ),
    );
    expect(offences).toEqual([]);
    // A sweep over nothing passes. This is the part of it that cannot: the
    // walk reached the whole surface layer and the whole chrome.
    const swept = results.map((result) =>
      path.relative(PROJECT_ROOT, result.filePath).split(path.sep).join('/'),
    );
    expect(swept).toContain('src/render/input.ts');
    expect(swept).toContain('src/ui/components/aim-controls.ts');
    expect(swept.length).toBeGreaterThan(15);
  });

  it('matches the event names and handler properties it claims to', () => {
    // The matchers, on their own, so a rule that has stopped matching is
    // caught by something cheaper than a whole lint run.
    for (const name of [
      'mousedown',
      'mouseup',
      'mousemove',
      'mouseenter',
      'mouseleave',
      'mouseover',
      'mouseout',
      'mousewheel',
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
      'dblclick',
      // The HTML drag family, plus the two names that are nobody's prefix.
      'dragstart',
      'drag',
      'dragenter',
      'dragover',
      'dragleave',
      'dragend',
      'drop',
      'auxclick',
    ]) {
      expect(LEGACY_EVENT.test(name), name).toBe(true);
    }
    for (const name of [
      'onmousedown',
      'ontouchstart',
      'ondblclick',
      'onmouseup',
      'ondragstart',
      'ondrop',
      'onauxclick',
    ]) {
      expect(LEGACY_HANDLER.test(name), name).toBe(true);
    }
    // The near misses, by name. `click` is deliberately allowed: it is fired
    // for a pointer, for a touch and for Enter or Space on a focused control,
    // so banning it would ban the one event that makes a button reachable by
    // all three input methods, which is what item C11 grades.
    for (const name of [
      'click',
      'pointerdown',
      'pointermove',
      'lostpointercapture',
      'keydown',
      'change',
      'input',
      'focus',
      'wheel',
      'contextmenu',
    ]) {
      expect(LEGACY_EVENT.test(name), name).toBe(false);
    }
    for (const name of ['onclick', 'onkeydown', 'onMouseWheelPolicy', 'onpointerdown']) {
      expect(LEGACY_HANDLER.test(name), name).toBe(false);
    }
    expect([...LISTENER_METHODS].sort()).toEqual([
      'addEventListener',
      'removeEventListener',
    ]);
  });
});
