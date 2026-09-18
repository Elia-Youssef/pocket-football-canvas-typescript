import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  pauseClock,
  playUntil,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item G1, method T, evidence `playwright/axe`:
 *
 *   "An automated accessibility scan with all WCAG 2.2 A and AA rules enabled
 *    reports no violations on every screen and overlay, excluding the
 *    colour-contrast, lang, landmark and heading rules graded by G2 and G7.
 *    Passing is a precondition for the manual items, never a substitute."
 *
 * THE EXCLUSIONS ARE ASSERTED NON-VACUOUS, which on this page took measuring
 * rather than reasoning. Under the four WCAG tags the criterion names, every
 * landmark and heading rule in axe-core 4.13.0 is best-practice tagged and does
 * not run at all, so excluding them removes nothing and an exclusion that
 * removes nothing is a hole that reports as a pass. This file therefore does
 * three things instead of one: it scans with the tag set and no exclusions at
 * all, it scans again with the criterion's exclusions applied and requires the
 * two to agree, and it runs each excluded family BY RULE ID and requires it to
 * pass for real.
 *
 * THE SPELLING IS AXE'S. The criterion says "colour-contrast"; the rule is
 * `color-contrast`, and an unknown id is an error rather than a silent skip,
 * which is what makes naming them safe.
 *
 * `region` IS THE RULE THAT USED TO FIRE. Before the `main` landmark item G7
 * added, it reported twenty-six nodes on the menu alone, and it is
 * best-practice tagged, so G1's own tag-filtered scan could never have seen it.
 * It is named by id below and given a planted control: content appended OUTSIDE
 * the landmark has to bring it back, or the check has stopped checking.
 *
 * PAGES COME FROM `browser.newContext()`. `finishRun` opens a sibling blank page
 * in the same context to compute its results, which a page from
 * `browser.newPage()` cannot do; measured on 1.63.0, where it fails outright.
 */

/**
 * Every tag that means "level A or AA" to this scanner, in one place.
 *
 * WCAG 2.2 IS A SUPERSET OF 2.1 AND 2.0, and axe tags a rule with the version
 * that INTRODUCED its criterion rather than with every version that carries it.
 * The four-tag list this began as (`wcag2a`, `wcag2aa`, `wcag22a`, `wcag22aa`)
 * therefore dropped every rule whose criterion arrived in 2.1: measured on
 * axe-core 4.13.0, `autocomplete-valid` (SC 1.3.5), `avoid-inline-spacing`
 * (SC 1.4.12), `css-orientation-lock` (SC 1.3.4) and `label-content-name-
 * mismatch` (SC 2.5.3), two of which QUALITY-BAR names by number for this game.
 * A criterion that says "all WCAG 2.2 A and AA rules enabled" is not satisfied
 * by a list that quietly runs four fewer.
 *
 * `wcag22a` MATCHES NOTHING TODAY and is kept deliberately: axe has no rule for
 * either criterion 2.2 adds at level A, and a tag that gains one later belongs
 * in the scan the day it does. It is why the list is checked against the
 * scanner's own tag vocabulary below rather than trusted as prose.
 *
 * WHAT A TAG RUN REACHES, MEASURED: 63 of the 70. A rule's own `enabled: false`
 * is bypassed once a tag matches it, so `target-size` runs here without being
 * asked for; what a tag run cannot reach is the seven rules axe's `tagExclude`
 * default holds back, and those are listed below.
 */
const WCAG_TAGS: readonly string[] = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
];

/**
 * A level A or AA WCAG tag as axe spells them: `wcag` then the version digits
 * then one or two `a`s. It is what excludes `wcag2aaa`, and it is what makes
 * the list above checkable against the scanner instead of against the criterion.
 */
const LEVEL_TAG = /^wcag2\d*a{1,2}$/;

/** The rules the 2.1 tags bring in, named so a shorter tag list reddens. */
const WCAG_21_RULES: readonly string[] = [
  'autocomplete-valid',
  'avoid-inline-spacing',
  'css-orientation-lock',
  'label-content-name-mismatch',
];

/**
 * Every level A or AA rule a TAG RUN does not reach, asked for by id.
 *
 * MEASURED ON axe-core 4.13.0, twice and two ways, because the first reading of
 * this was wrong. Seventy rules carry a level tag and a tag run reaches 63 of
 * them. What holds the other seven back is NOT a rule's own `enabled: false`:
 * once a tag matches, `matchTags` returns true and the flag is bypassed, which
 * is why `target-size` (SC 2.5.8 Target Size, a criterion WCAG 2.2 adds at AA
 * and disabled by default) runs under `wcag22aa` with no help at all. What holds
 * them back is `tagExclude`, which defaults to `['experimental', 'deprecated']`:
 * five level rules are tagged experimental (`css-orientation-lock` SC 1.3.4,
 * `label-content-name-mismatch` SC 2.5.3, `p-as-heading`, `table-fake-caption`
 * and `td-has-header`, all SC 1.3.1) and two are tagged deprecated
 * (`aria-roledescription`, `audio-caption`).
 *
 * THE LIST IS DERIVED AND NOT TRUSTED. The coverage test below computes the same
 * set from the scanner's own metadata and requires this list to equal it, so a
 * later version that moves a rule between those states reddens the test rather
 * than leaving this comment quietly stale.
 */
const ASKED_BY_ID: readonly string[] = [
  'aria-roledescription',
  'audio-caption',
  'css-orientation-lock',
  'label-content-name-mismatch',
  'p-as-heading',
  'table-fake-caption',
  'td-has-header',
];

/** What axe holds back from a tag run: its own `tagExclude` default. */
const TAG_EXCLUDED: readonly string[] = ['experimental', 'deprecated'];

/**
 * One options object, because the second one silently replaces the first.
 *
 * MEASURED: `AxeBuilder.withTags(...).options({ preload: true })` runs the WHOLE
 * default rule set rather than the tag set, because `options` replaces the run
 * options `withTags` had written. A tag list that quietly stops filtering is the
 * same class of defect as a tag list that quietly stops covering, so the builder
 * is given `runOnly`, the rules asked for by id and the excluded ones together,
 * and never in two calls.
 */
function scanOptions(exclusions: readonly string[]): {
  runOnly: { type: 'tag'; values: string[] };
  rules: Record<string, { enabled: boolean }>;
} {
  const rules: Record<string, { enabled: boolean }> = {};
  for (const rule of ASKED_BY_ID) {
    rules[rule] = { enabled: true };
  }
  for (const rule of exclusions) {
    rules[rule] = { enabled: false };
  }
  return { runOnly: { type: 'tag', values: [...WCAG_TAGS] }, rules };
}

/**
 * The rules G2 and G7 grade, by family and by axe's own id.
 *
 * The four families are the criterion's own words. Each id is asserted to have
 * RUN, so a rule renamed in a later axe-core reddens here rather than quietly
 * dropping out of the exclusion list and out of the scan together.
 */
const EXCLUDED: Readonly<Record<string, readonly string[]>> = {
  'colour-contrast': ['color-contrast'],
  lang: ['html-has-lang', 'html-lang-valid', 'valid-lang'],
  landmark: [
    'landmark-one-main',
    'landmark-unique',
    'landmark-no-duplicate-main',
    'landmark-no-duplicate-banner',
    'region',
  ],
  heading: ['page-has-heading-one', 'heading-order', 'empty-heading'],
};

function allExcluded(): string[] {
  return Object.values(EXCLUDED).flat();
}

/** The two viewports the ten frozen states are scanned at. */
const LANDSCAPE = { width: 1280, height: 900 };
const PORTRAIT = { width: 420, height: 800 };

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** A violation, flattened to something a failure message can be read from. */
interface Finding {
  readonly screen: string;
  readonly rule: string;
  readonly impact: string;
  readonly nodes: number;
  readonly first: string;
}

async function scan(page: Page, screen: string, exclusions: readonly string[]): Promise<{
  findings: Finding[];
  passed: number;
}> {
  const results = await new AxeBuilder({ page }).options(scanOptions(exclusions)).analyze();
  return {
    findings: results.violations.map((violation) => ({
      screen,
      rule: violation.id,
      impact: violation.impact ?? 'none',
      nodes: violation.nodes.length,
      first: violation.nodes[0]?.target.join(' ') ?? '',
    })),
    passed: results.passes.length,
  };
}

/** Open the game, put SPEC section 19's first-launch overlay away, choose a mode. */
async function reachMenu(page: Page): Promise<void> {
  await page.goto('/');
  await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
  const howTo = at(page, 'panel-how-to-play');
  if (await howTo.isVisible()) {
    await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
  }
  await expect(howTo).toBeHidden(SETTLE);
}

async function startQuickMatch(page: Page): Promise<void> {
  await at(page, 'mode-quick').check();
  await at(page, 'mode-guide').uncheck();
  await at(page, 'mode-start').click();
  await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
}

test.describe('PF-15 the automated accessibility scan, item G1', () => {
  test.beforeEach(() => {
    test.setTimeout(A_WHOLE_TEST);
  });

  test('reports no violation on every screen and overlay', async ({ browser }) => {
    const { context, page } = await openScanned(browser, LANDSCAPE);
    try {
      const findings: Finding[] = [];
      const excluded: Finding[] = [];
      let scanned = 0;
      let passed = 0;
      let trimmedPassed = 0;

      const take = async (screen: string): Promise<void> => {
        const whole = await scan(page, screen, []);
        const trimmed = await scan(page, screen, allExcluded());
        findings.push(...whole.findings);
        excluded.push(...trimmed.findings);
        scanned += 1;
        passed += whole.passed;
        trimmedPassed += trimmed.passed;
      };

      // THE TEN FROZEN STATES, each reached by the control that opens it. The
      // three that cost a whole match (full time, and the ladder game over won
      // and lost) are driven in their own tests.
      await page.goto('/');
      await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
      await take('first launch, how to play over the menu');

      await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
      await expect(at(page, 'panel-how-to-play')).toBeHidden(SETTLE);
      await take('the menu');

      await at(page, 'mode-how-to').click();
      await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
      await take('how to play, from the menu');
      await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
      await expect(at(page, 'panel-how-to-play')).toBeHidden(SETTLE);

      await startQuickMatch(page);
      await take('the match');

      await at(page, 'pause').click();
      await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
      await take('paused');

      await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
      await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
      await take('settings');

      await at(page, 'reset-data').click();
      await expect(at(page, 'reset-prompt')).not.toHaveText('');
      await take('the reset confirmation, armed');

      // AND ITS SECOND STEP, which is a different arrangement of the same
      // panel: the two confirmation buttons go back to refusing and the prompt
      // becomes a result line. It costs one more scan and it is the only other
      // state this panel has.
      await at(page, 'reset-confirm').click();
      await expect(at(page, 'reset-prompt')).not.toHaveText('');
      await take('the reset confirmation, taken');

      await page.setViewportSize(PORTRAIT);
      await reachMenu(page);
      await expect(at(page, 'portrait-hint')).toBeVisible(SETTLE);
      await take('the menu in portrait, with the rotate hint');

      await startQuickMatch(page);
      await expect(at(page, 'portrait-hint')).toBeVisible(SETTLE);
      await take('the match in portrait, with the rotate hint');

      expect(scanned).toBe(10);
      // The scan is not vacuous: it really examined the page, on every state.
      expect(passed).toBeGreaterThan(10 * 10);
      expect(findings).toEqual([]);
      expect(excluded).toEqual([]);
      // AND THE EXCLUSIONS TAKE A KNOWN AMOUNT AWAY. Comparing two empty lists
      // proves nothing about an exclusion, because a green page has nothing for
      // either to hold; what an exclusion can do wrong is remove more of the
      // scan than it names. The trimmed scan still passes rules in quantity, it
      // passes FEWER than the whole one (so the exclusion reached the
      // tag-filtered set at all rather than naming rules it never ran), and the
      // difference cannot exceed the named families once per screen.
      expect(trimmedPassed).toBeGreaterThan(10 * 8);
      expect(passed - trimmedPassed).toBeGreaterThan(0);
      expect(passed - trimmedPassed).toBeLessThanOrEqual(10 * allExcluded().length);
    } finally {
      await context.close();
    }
  });

  test('enables every level A and AA rule the scanner has, and no fewer', async ({
    browser,
  }) => {
    // THE CLAUSE'S FIRST WORD IS "ALL", AND IT WAS FALSE. A tag list is prose
    // until something compares it with the scanner: this asks axe which tags it
    // uses, keeps the ones that mean level A or AA, and requires the list the
    // scan runs with to be exactly those. A rule set that gains a tag gains it
    // here too, and a list that loses one reddens. The by-id list is derived the
    // same way, from the tags axe's own `tagExclude` holds back, so 63 reached
    // by tag plus 7 asked for by id is a measurement rather than a claim.
    const { context, page } = await openScanned(browser, LANDSCAPE);
    try {
      await reachMenu(page);
      const results = await new AxeBuilder({ page }).options(scanOptions([])).analyze();
      const evaluated = new Set(
        [
          ...results.passes,
          ...results.violations,
          ...results.incomplete,
          ...results.inapplicable,
        ].map((entry) => entry.id),
      );

      // axe is in the page once a scan has run, and its metadata is the
      // independent statement of what the scanner knows.
      const known = await page.evaluate(() => {
        const scanner = (
          window as unknown as {
            axe?: { getRules(): { ruleId: string; tags: string[] }[] };
          }
        ).axe;
        if (scanner === undefined) {
          throw new Error('the scan did not leave axe in the page');
        }
        return scanner.getRules().map((rule) => ({ id: rule.ruleId, tags: rule.tags }));
      });
      expect(known.length).toBeGreaterThan(90);

      // THE BY-ID LIST, DERIVED. A tag run reaches every level rule except the
      // ones axe's own `tagExclude` default holds back, so the set that needs
      // asking for by id is exactly the level rules carrying one of those tags.
      // Restating it would be prose; this is the scanner's own answer.
      const heldBack = known
        .filter(
          (rule) =>
            rule.tags.some((tag) => LEVEL_TAG.test(tag)) &&
            rule.tags.some((tag) => TAG_EXCLUDED.includes(tag)),
        )
        .map((rule) => rule.id)
        .sort();
      expect([...ASKED_BY_ID].sort()).toEqual(heldBack);
      expect(heldBack).toHaveLength(7);

      const vocabulary = new Set<string>();
      for (const rule of known) {
        for (const tag of rule.tags) {
          if (LEVEL_TAG.test(tag)) {
            vocabulary.add(tag);
          }
        }
      }
      // The scan runs with every level tag the rule set carries, plus the one
      // that carries nothing yet. Neither set is allowed to be the smaller.
      expect([...vocabulary].sort()).toEqual(
        [...WCAG_TAGS].filter((tag) => tag !== 'wcag22a').sort(),
      );
      expect([...WCAG_TAGS].sort()).toEqual([...vocabulary, 'wcag22a'].sort());

      // Every rule those tags name ran, which is what "enabled" has to mean.
      // The three that ship disabled are in the run options above, so they are
      // in this set like any other rather than quietly outside it.
      const wanted = known.filter((rule) => rule.tags.some((tag) => LEVEL_TAG.test(tag)));
      expect(wanted.length).toBeGreaterThan(60);
      // THE SET IS WHOLE, which is the assertion the criterion's first word
      // deserves: not "the list above is right" but "nothing the scanner calls
      // level A or AA went unasked". A rule that arrives disabled or
      // experimental in a later version lands here.
      const absent = wanted
        .filter((rule) => !evaluated.has(rule.id))
        .map((rule) => rule.id)
        .sort();
      expect(absent).toEqual([]);
      for (const rule of ASKED_BY_ID) {
        expect(evaluated.has(rule), `${rule} was asked for by id`).toBe(true);
      }
      // And the four the 2.1 tags bring in by name, so the exact regression
      // this test was written for cannot come back silently.
      for (const rule of WCAG_21_RULES) {
        expect(evaluated.has(rule), rule).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test('runs every excluded rule by its own id, and passes it for real', async ({ browser }) => {
    const { context, page } = await openScanned(browser, LANDSCAPE);
    try {
      await reachMenu(page);
      await startQuickMatch(page);

      const results = await new AxeBuilder({ page }).withRules(allExcluded()).analyze();
      const evaluated = new Set([
        ...results.passes,
        ...results.violations,
        ...results.incomplete,
        ...results.inapplicable,
      ].map((entry) => entry.id));

      // EVERY NAMED RULE REALLY RAN. An id axe does not know is an error rather
      // than a skip, and an id it knows but never reached would leave the
      // exclusion below excluding nothing.
      for (const [family, rules] of Object.entries(EXCLUDED)) {
        for (const rule of rules) {
          expect(evaluated.has(rule), `${family}: ${rule}`).toBe(true);
        }
      }
      // EXACTLY those and nothing else: `withRules` enables the list it is
      // given, so a set that is larger means a rule ran that nobody named and a
      // set that is smaller means one of the names never reached the page.
      expect([...evaluated].sort()).toEqual([...allExcluded()].sort());
      // And every one of them PASSES, which is what makes the exclusion a
      // deferral to items G2 and G7 rather than a hole.
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
      // The contrast rule and the lang rules are real checks on this page
      // rather than rules that found nothing to look at.
      const passing = new Set(results.passes.map((entry) => entry.id));
      for (const rule of ['color-contrast', 'html-has-lang', 'html-lang-valid', 'region']) {
        expect(passing.has(rule), rule).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test('would report page content left outside the landmark, which is the control', async ({
    browser,
  }) => {
    // THE NEGATIVE CONTROL FOR THE WHOLE FILE. `region` is the rule that fired
    // twenty-six times on this page before item G7's `main` landmark, and it is
    // best-practice tagged, so the tag-filtered scan above can never see it.
    // Content planted OUTSIDE the landmark has to bring it back.
    const { context, page } = await openScanned(browser, LANDSCAPE);
    try {
      await reachMenu(page);
      const before = await new AxeBuilder({ page }).withRules(['region']).analyze();
      expect(before.violations).toEqual([]);

      await page.evaluate(() => {
        const stray = document.createElement('p');
        stray.dataset['pf'] = 'planted-outside';
        stray.textContent = 'a line of page content that no landmark holds';
        document.body.appendChild(stray);
      });
      const after = await new AxeBuilder({ page }).withRules(['region']).analyze();
      expect(after.violations.map((violation) => violation.id)).toEqual(['region']);

      await page.evaluate(() => {
        document.querySelector('[data-pf="planted-outside"]')?.remove();
      });
      const restored = await new AxeBuilder({ page }).withRules(['region']).analyze();
      expect(restored.violations).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('reports no violation on the ladder game over, won and lost', {
    tag: '@drive',
  }, async ({ browser }) => {
    // THE ELEVENTH AND TWELFTH STATES, and the reason they are separate ones:
    // SPEC section 13's game-over panel has three arrangements, not one. A rung
    // WON offers Next opponent and refuses Restart ladder; a rung LOST offers
    // the ladder again and refuses Next opponent; the completed ladder is the
    // third and is unreachable without six rungs, so it is stated below rather
    // than driven. Scanning one of the three and calling the overlay covered is
    // how a scan reports a pass on a shape it never met.
    //
    // REACHED BY PLAYING, through the game's own routes: a rung is First to 3,
    // so the striker attacks one mouth until the rung's own target is reached,
    // and SPEC section 3 credits the mouth the ball entered, which is what lets
    // the same drive produce a loss by attacking the other way.
    const { context, page } = await openScanned(browser, LANDSCAPE);
    try {
      await page.clock.install({ time: 0 });
      await startMatch(page, { mode: 'ladder' });
      await pauseClock(page);

      await playUntil(page, 2500, 'right', async () => (await turnText(page)) === 'FULL TIME');
      await expect(at(page, 'panel-game-over')).toBeVisible(SETTLE);
      await expect(at(page, 'next-opponent')).toHaveAttribute('aria-disabled', 'false');
      await expect(at(page, 'restart-ladder')).toHaveAttribute('aria-disabled', 'true');
      await page.clock.resume();
      const won = await scan(page, 'the ladder game over, a rung won', []);
      const wonTrimmed = await scan(page, 'the ladder game over, a rung won', allExcluded());
      expect(won.passed).toBeGreaterThan(10);
      expect(won.findings).toEqual([]);
      expect(wonTrimmed.findings).toEqual([]);

      // The next rung, taken by the panel's own button, then lost.
      await page.clock.install({ time: 0 });
      await at(page, 'next-opponent').click();
      await expect(at(page, 'panel-game-over')).toBeHidden(SETTLE);
      await pauseClock(page);
      await playUntil(page, 2500, 'left', async () => (await turnText(page)) === 'FULL TIME');
      await expect(at(page, 'panel-game-over')).toBeVisible(SETTLE);
      await expect(at(page, 'restart-ladder')).toHaveAttribute('aria-disabled', 'false');
      await expect(at(page, 'next-opponent')).toHaveAttribute('aria-disabled', 'true');
      await page.clock.resume();
      const lost = await scan(page, 'the ladder game over, a rung lost', []);
      const lostTrimmed = await scan(page, 'the ladder game over, a rung lost', allExcluded());
      expect(lost.passed).toBeGreaterThan(10);
      expect(lost.findings).toEqual([]);
      expect(lostTrimmed.findings).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('reports no violation at full time', { tag: '@drive' }, async ({ browser }) => {
    // The tenth frozen state. A Quick Match nobody launches in reaches full
    // time level, and the page's own clock is driven rather than waited on:
    // sixty seconds of match is 240 frames of a quarter of a second each.
    const { context, page } = await openScanned(browser, LANDSCAPE);
    try {
      await page.clock.install({ time: 0 });
      // The shared harness, on this file's own page: it reaches a match through
      // SPEC section 9's real menu and names the duration rather than trusting
      // whatever the stored settings left the menu opened on.
      await startMatch(page, { mode: 'quick', duration: 60 });
      // AND STOPPED: the drive below is made of the frames it charges.
      await pauseClock(page);
      await advance(page, 260);
      await expect(at(page, 'turn')).toHaveText('FULL TIME', SETTLE);
      await expect(at(page, 'panel-game-over')).toBeVisible(SETTLE);

      // THE CLOCK IS LET GO BEFORE THE SCANNER RUNS, and it has to be. The
      // scanner computes its results in a sibling page of the same context, and
      // that page inherits the stopped clock: its own timers never fire and the
      // scan never returns. Measured here as a test that reached full time and
      // then sat until its budget ran out. The match is frozen at full time, so
      // letting time run again changes nothing on the pitch.
      await page.clock.resume();

      const whole = await scan(page, 'full time', []);
      const trimmed = await scan(page, 'full time', allExcluded());
      expect(whole.passed).toBeGreaterThan(10);
      expect(whole.findings).toEqual([]);
      expect(trimmed.findings).toEqual(whole.findings);
    } finally {
      await context.close();
    }
  });
});

/**
 * A context of this file's own, because the scanner needs one.
 *
 * The base URL and the viewport are passed explicitly: a context built here
 * rather than by the fixture inherits neither from the project, and a page with
 * no base URL cannot answer `goto('/')` at all.
 */
async function openScanned(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const baseURL = test.info().project.use.baseURL;
  if (baseURL === undefined) {
    throw new Error('the project states no base URL for the scanned context to use');
  }
  const context = await browser.newContext({ baseURL, viewport });
  return { context, page: await context.newPage() };
}
