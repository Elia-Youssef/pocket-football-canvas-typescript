import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * An assertion inventory over the accessibility scan, which is the measured
 * half of item G1.
 *
 * WHY THIS EXISTS, and it is the same reason `browser-gate.test.ts` exists for
 * item A2: every other gate here is graded by breaking it and watching something
 * go red, and that method does not work on a scan. Narrowing the tag set, losing
 * a screen from the frozen list, or turning the exclusion check into one that
 * runs no rules at all all leave the suite GREEN, because a scan that looks at
 * less finds less. There is no run of that spec which can detect it.
 *
 * WHY IT IS BRITTLE, STATED PLAINLY. It reads the spec file as text. A
 * legitimate refactor that renames a helper or reflows the tag list will fail
 * it, and the failure is loud and one line to fix. That is the price of grading
 * a scan that passes when it stops scanning.
 *
 * THE TAXONOMY IS THE PART THAT MATTERS. The criterion excludes four families
 * "graded by G2 and G7", and on this page those exclusions are vacuous as a tag
 * filter: every landmark and heading rule in axe-core 4.13.0 is best-practice
 * tagged and never runs under the WCAG tags at all. An exclusion that removes
 * nothing is a hole that reports as a pass, so the spec runs each family BY RULE
 * ID and requires it to pass, and this file is what holds it to that.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const SPEC = path.join(PROJECT_ROOT, 'tests', 'browser', 'axe.spec.ts');
const source = readFileSync(SPEC, 'utf8');

function titles(): string[] {
  return [...source.matchAll(/\btest\(\s*'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Every screen the scan takes a reading on, by the label it records. */
function screens(): string[] {
  return [...source.matchAll(/await take\('([^']+)'\)/g)].map((match) => match[1] ?? '');
}

function requires(fragment: string, why: string): void {
  expect(source.includes(fragment), `${why}: ${fragment}`).toBe(true);
}

describe('PF-15 the accessibility scan inventory, item G1', () => {
  it('declares exactly the six checks the criterion is graded by', () => {
    expect(titles()).toEqual([
      'reports no violation on every screen and overlay',
      'enables every level A and AA rule the scanner has, and no fewer',
      'runs every excluded rule by its own id, and passes it for real',
      'would report page content left outside the landmark, which is the control',
      'reports no violation on the ladder game over, won and lost',
      'reports no violation at full time',
    ]);
  });

  it('enables every WCAG 2.2 A and AA tag, and no fewer', () => {
    // "all WCAG 2.2 A and AA rules enabled" is the criterion's own phrase, and
    // a tag dropped from this list narrows the scan silently: fewer rules find
    // fewer violations and the suite stays green.
    //
    // THE SIX TAGS, AND THE TWO THAT WERE MISSING. WCAG 2.2 contains 2.1 and
    // 2.0, while axe tags each rule with the version its criterion ARRIVED in,
    // so a list of the 2.0 and 2.2 tags alone runs no rule introduced in 2.1.
    // Measured on axe-core 4.13.0, that dropped four rules, two of them
    // criteria QUALITY-BAR section 4 and section 5 name by number.
    for (const tag of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']) {
      requires(`  '${tag}',`, 'the tag is in the scan');
    }
    requires("runOnly: { type: 'tag', values: [...WCAG_TAGS] }", 'the scan is run with them');
    // ONE OPTIONS OBJECT, because a second `options` call replaces the first:
    // `withTags(...).options({ ... })` was measured running the whole default
    // rule set, which is a tag filter that has quietly stopped filtering.
    requires('function scanOptions(', 'the options are built in one place');
    // THE SEVEN RULES A TAG RUN DOES NOT REACH, by id. Measured on axe-core
    // 4.13.0: a tag run reaches 63 of the 70 level-tagged rules, because a
    // rule's own `enabled: false` is BYPASSED once a tag matches it (so
    // `target-size`, SC 2.5.8, runs under `wcag22aa` unasked); what holds seven
    // back is axe's `tagExclude` default, `experimental` and `deprecated`.
    for (const rule of [
      'aria-roledescription',
      'audio-caption',
      'css-orientation-lock',
      'label-content-name-mismatch',
      'p-as-heading',
      'table-fake-caption',
      'td-has-header',
    ]) {
      requires(`  '${rule}',`, 'the rule is asked for by id');
    }
    // AND THE LIST IS DERIVED RATHER THAN RESTATED: the spec computes the same
    // set from the scanner's own metadata and requires the two to be equal, so
    // a later version that moves a rule into or out of `experimental` or
    // `deprecated` reddens the spec instead of leaving this list stale.
    requires(
      "const TAG_EXCLUDED: readonly string[] = ['experimental', 'deprecated'];",
      'the held-back tags are named',
    );
    requires('expect([...ASKED_BY_ID].sort()).toEqual(heldBack);', 'the by-id list is derived');
    requires('expect(heldBack).toHaveLength(7);', 'and its size is the measured seven');
    // And the assertion that makes the list above maintainable rather than
    // merely present: nothing the scanner calls level A or AA goes unasked.
    requires('expect(absent).toEqual([]);', 'the level set is required to be whole');
    // And the four rules the 2.1 tags bring in, by id, because a tag list is
    // prose until something names what it changed.
    for (const rule of [
      'autocomplete-valid',
      'avoid-inline-spacing',
      'css-orientation-lock',
      'label-content-name-mismatch',
    ]) {
      requires(`  '${rule}',`, 'the 2.1 rule is named');
    }
    // The tag list is compared with the scanner's own vocabulary in the spec,
    // so a rule set that gains a level tag cannot leave the scan behind.
    requires('const LEVEL_TAG = /^wcag2\\d*a{1,2}$/;', 'the level tags are derived');
    requires('expect([...WCAG_TAGS].sort())', 'and the list is held against them');
  });

  it('names every excluded family, by the id axe actually uses', () => {
    // The criterion says "colour-contrast"; the rule is `color-contrast`. An id
    // axe does not know is an error rather than a silent skip, which is what
    // makes naming them safe and what makes a rename redden rather than hide.
    for (const rule of [
      "'colour-contrast': ['color-contrast']",
      "lang: ['html-has-lang', 'html-lang-valid', 'valid-lang']",
      "'landmark-one-main',",
      "'region',",
      "heading: ['page-has-heading-one', 'heading-order', 'empty-heading']",
    ]) {
      requires(rule, 'the excluded family is named');
    }
  });

  it('keeps the exclusions asserted non-vacuous, in both directions', () => {
    // Two halves. The scan is taken WITHOUT the exclusions and WITH them and the
    // two are required to agree, so an exclusion that is hiding a real violation
    // shows up as a difference; and every excluded rule is run by id and
    // required to pass, so one that never runs shows up as an absence.
    requires('const whole = await scan(page, screen, []);', 'the unexcluded scan is taken');
    requires(
      'const trimmed = await scan(page, screen, allExcluded());',
      'the excluded scan is taken',
    );
    requires('expect(excluded).toEqual([]);', 'the excluded scan is clean too');
    requires(
      'expect(passed - trimmedPassed).toBeGreaterThan(0);',
      'and the exclusion is shown to have reached the tag-filtered scan',
    );
    requires('.withRules(allExcluded())', 'every excluded rule is run by id');
    requires(
      'expect(evaluated.has(rule), `${family}: ${rule}`).toBe(true);',
      'each named rule is required to have run',
    );
    requires(
      "expect(results.violations.map((violation) => violation.id)).toEqual([]);",
      'and to have passed',
    );
  });

  it('freezes the twelve screens the baseline scanned, each by its opener', () => {
    // Ten here and two more in the driven tests, because full time and the
    // ladder game over each cost a whole match. A screen quietly dropped from
    // the list is a screen nobody scans, and the count is what says so. The
    // game-over panel has THREE arrangements and two of them are driven; the
    // third, a completed ladder, needs six rungs and is stated in the spec
    // rather than driven.
    expect(screens()).toEqual([
      'first launch, how to play over the menu',
      'the menu',
      'how to play, from the menu',
      'the match',
      'paused',
      'settings',
      'the reset confirmation, armed',
      'the reset confirmation, taken',
      'the menu in portrait, with the rotate hint',
      'the match in portrait, with the rotate hint',
    ]);
    // The count is the spec's own, read back from it: a `toHaveLength` beside
    // the list above would be the list's own length compared with itself.
    requires('expect(scanned).toBe(10);', 'the count of screens is asserted');
    requires("await expect(at(page, 'panel-game-over')).toBeVisible(SETTLE);", 'the eleventh');
    requires("const whole = await scan(page, 'full time', []);", 'is scanned too');
    // And the two ladder arrangements, each by the attribute that tells them
    // apart, so a test that reached the panel in the wrong shape reddens.
    requires("const won = await scan(page, 'the ladder game over, a rung won', []);", 'a rung won');
    requires("const lost = await scan(page, 'the ladder game over, a rung lost', []);", 'a rung lost');
    requires(
      "await expect(at(page, 'next-opponent')).toHaveAttribute('aria-disabled', 'false');",
      'the won arrangement is the one with Next opponent live',
    );
    requires(
      "await expect(at(page, 'restart-ladder')).toHaveAttribute('aria-disabled', 'false');",
      'the lost arrangement is the one with Restart ladder live',
    );
  });

  it('keeps the scan able to report anything at all', () => {
    // A scanner that examined nothing reports no violations. Two floors: the
    // passes are counted across the nine screens, and the planted control puts
    // real page content outside the landmark and requires `region` to fire.
    requires('expect(passed).toBeGreaterThan(10 * 10);', 'the scan is proven non-vacuous');
    requires("stray.dataset['pf'] = 'planted-outside';", 'the control is planted');
    // AND PLANTED WHERE THE RULE CAN SEE IT. `region` reports page content that
    // no landmark holds, so a control appended INSIDE the landmark is a control
    // that can never fire; the marker above is a name and this is the property.
    requires('document.body.appendChild(stray);', 'outside the landmark');
    requires(
      "expect(after.violations.map((violation) => violation.id)).toEqual(['region']);",
      'and the rule it breaks is required to fire',
    );
    requires('expect(restored.violations).toEqual([]);', 'and to stop firing when it is removed');
  });

  it('takes its pages from a context of its own, which the scanner needs', () => {
    // Measured on Playwright 1.63.0: the scanner computes its results in a
    // sibling page of the same context, which a page from `browser.newPage()`
    // cannot open. A refactor back to the fixture page fails outright rather
    // than quietly, and this says why before anybody has to find out again.
    requires('await browser.newContext({ baseURL, viewport });', 'a context of its own');
    requires('await context.close();', 'and it is closed');
  });
});
