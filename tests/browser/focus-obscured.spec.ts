import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, startMatch } from './support/game';
import {
  DEFAULT_ROOT_FONT_SIZE,
  DOUBLED_ROOT_FONT_SIZE,
  TIGHT_VIEWPORTS,
  VIEWPORTS,
  useRootFontSize,
  viewportLabel,
} from './support/viewports';
import { STICKY_MIN_REM } from '../../src/ui/breakpoints';

/**
 * Item G11, method T, evidence `playwright/focus-obscured`:
 *
 *   "No focused control is wholly obscured by a sticky HUD bar, overlay or the
 *    rotate hint at any breakpoint, satisfying WCAG 2.2 SC 2.4.11 Focus Not
 *    Obscured, which with SC 2.5.7 is one of only two criteria 2.2 adds at AA
 *    that apply to this game."
 *
 * THE ASSERTION IS THE VISIBLE INTERSECTION, NEVER THE MECHANISM. The chrome
 * declares scroll padding the height of each stuck bar and the composition root
 * asks the platform to honour it on a focus move, but a criterion about what a
 * player can see is graded on what is on top of the pixels: every focused
 * control is sampled over its own box and at least one sample has to come back
 * as the control itself. A test that asserted the padding existed would pass on
 * a padding the browser ignored.
 *
 * THE PREMISE IS ASSERTED FIRST, AND IT IS NOT THE PREMISE THIS FILE WAS
 * EXPECTED TO HAVE. "A control scrolled beneath a stuck bar" is only a case
 * where the page scrolls AND the bars are stuck, so the first test measures
 * that rather than assuming it, and the measurement says the page does not
 * scroll at any viewport where the bars stick: PF-14 built the column so the
 * stage absorbs whatever the two bars leave, and QUALITY-BAR section 5 unsticks
 * them below a 400 px viewport height, so the two states are exclusive. Measured
 * at six viewports from 1280 by 900 down to 320 by 400. The criterion therefore
 * holds at the size the game ships at, and that is asserted as an invariant
 * rather than left as a lucky outcome. It is an EMPIRICAL invariant and not a
 * construction: six viewports were measured and every one of them answered the
 * same way, which is a different and weaker thing than a proof.
 *
 * THE OTHER ARRANGEMENT IS WALKED TOO. Below QUALITY-BAR section 5's 400 px
 * height the bars go static and the page scrolls, so the reasoning above does
 * not cover it; the walk includes that viewport, where the two scroll extremes
 * are genuinely two different pages.
 *
 * WHAT IS OUTSIDE IT, AND DISCLOSED RATHER THAN AVOIDED. Raise the BROWSER'S own
 * text size to 200 percent on a narrow, short screen and the two bars no longer
 * fit: at 360 by 500 they measure 205 and 403 CSS pixels against a 500 pixel
 * viewport, so the bottom bar covers the top one and the pause control goes
 * behind it. That is a sticky-bar arrangement with no rule for "they do not both
 * fit", which is PF-14's to decide and carries the same hysteresis question its
 * own 400 px threshold does; it is in the PF-15 report as a park with the
 * measurement, and nothing in this file claims it away.
 *
 * SC 2.4.11 IS ABOUT THE MOMENT FOCUS ARRIVES. A player who then scrolls the
 * page away from the focused control has not been failed by the author, so the
 * measurement is taken after a real Tab press, on a page deliberately scrolled
 * to both extremes first.
 */

/** The narrow, short viewport where the HUD wraps and the aim row wraps most. */
const SCROLLING = { name: 'scrolling', width: 360, height: 500 };

/** The smallest viewport at which the bars still stick: QUALITY-BAR section 5's
 * floor of 320 CSS pixels wide, at the 400 px height its own rule stops at. */
const SMALLEST_STICKY = { name: 'smallest sticky', width: 320, height: 400 };

/**
 * The other arrangement entirely: below 400 px of height QUALITY-BAR section 5
 * unsticks both bars, the stage takes a viewport of its own and the PAGE
 * scrolls. Nothing is stuck there, so nothing can stand over a focused control,
 * but that is a claim about a layout and the walk below measures it instead of
 * trusting it. It is also the only viewport where the walk's two scroll extremes
 * are two different pages rather than the same one twice.
 */
const STATIC_BARS = { name: 'static bars', width: 360, height: 380 };

/** How far off a control's own box the samples are spread, per side. */
const SAMPLE_STEPS = 5;

interface Visibility {
  /** Samples of the control's box that fall inside the viewport at all. */
  readonly inside: number;
  /** Samples where the top-most element at that point IS the control. */
  readonly visible: number;
  readonly top: number;
  readonly height: number;
}

/**
 * How much of a control a player can actually see.
 *
 * `elementFromPoint` answers with what is painted on top, which is exactly the
 * question SC 2.4.11 asks; a sample counts as the control's when the element it
 * returns is the control or something inside it, because a range thumb, a label
 * span and the canvas inside the play frame all answer for their own control.
 */
async function visibility(page: Page, marker: string): Promise<Visibility> {
  return page.evaluate(
    (input) => {
      const element = document.querySelector(`[data-pf="${input.marker}"]`);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`no ${input.marker} in the document`);
      }
      const box = element.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      let inside = 0;
      let visible = 0;
      for (let across = 0; across < input.steps; across += 1) {
        for (let down = 0; down < input.steps; down += 1) {
          const x = box.left + (box.width * (across + 0.5)) / input.steps;
          const y = box.top + (box.height * (down + 0.5)) / input.steps;
          if (x < 0 || y < 0 || x >= width || y >= height) {
            continue;
          }
          inside += 1;
          const painted = document.elementFromPoint(x, y);
          if (painted !== null && (painted === element || element.contains(painted))) {
            visible += 1;
          }
        }
      }
      return { inside, visible, top: box.top, height: box.height };
    },
    { marker, steps: SAMPLE_STEPS },
  );
}

/** Whether the PAGE can be scrolled at all, which is item G11's whole premise. */
async function scrolls(page: Page): Promise<{ down: boolean; bars: string }> {
  return page.evaluate(() => ({
    down: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    bars: document.documentElement.dataset['pfBars'] ?? '',
  }));
}

async function activeMarker(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return 'body';
    }
    return active.getAttribute('data-pf') ?? active.tagName.toLowerCase();
  });
}

/** Put focus back at the top of the document, the way a fresh load leaves it. */
async function resetFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const body = document.body;
    body.setAttribute('tabindex', '-1');
    body.focus();
    body.removeAttribute('tabindex');
  });
}

/**
 * Tab through the whole document once, measuring every stop.
 *
 * The walk stops when it comes back to something it has already seen, so it
 * does not depend on how many controls a breakpoint happens to offer: the
 * portrait one has SPEC section 2.1's hint and the others do not.
 */
/** The two bars' border-box heights and the viewport they stand in. */
async function barHeights(
  page: Page,
): Promise<{ top: number; bottom: number; viewport: number }> {
  return page.evaluate(() => {
    const read = (name: string): number => {
      const element = document.querySelector(`[data-pf="${name}"]`);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`no ${name} in the document`);
      }
      return element.getBoundingClientRect().height;
    };
    return { top: read('hud'), bottom: read('aim-controls'), viewport: window.innerHeight };
  });
}

async function walkAndMeasure(
  page: Page,
  scrollTo: 'top' | 'bottom',
): Promise<{ marker: string; seen: Visibility }[]> {
  await resetFocus(page);
  const stops: { marker: string; seen: Visibility }[] = [];
  const met = new Set<string>();
  for (let step = 0; step < 20; step += 1) {
    await page.evaluate((where) => {
      window.scrollTo(0, where === 'top' ? 0 : document.documentElement.scrollHeight);
    }, scrollTo);
    await page.keyboard.press('Tab');
    const marker = await activeMarker(page);
    if (marker === 'body' || met.has(marker)) {
      break;
    }
    met.add(marker);
    stops.push({ marker, seen: await visibility(page, marker) });
  }
  return stops;
}

test.describe('PF-15 focus is never wholly obscured, item G11', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('sticks the bars over a page that does not scroll, at the size it ships at', async ({
    page,
  }) => {
    // THE STRUCTURAL HALF OF THE ANSWER, and it is why the criterion holds at
    // the default text size rather than a coincidence: PF-14 built the column
    // so that the stage absorbs whatever the bars leave, so while the bars are
    // stuck the page has nothing to scroll and nothing can go under them.
    // Measured at every breakpoint and at the narrow, short viewport the
    // criterion's worked case uses.
    for (const viewport of [...VIEWPORTS, SCROLLING, SMALLEST_STICKY]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
      const state = await scrolls(page);
      expect(state.bars, viewport.name).toBe('sticky');
      expect(state.down, viewport.name).toBe(false);
      // And the two bars really are the things that would stand over it.
      for (const marker of ['hud', 'aim-controls']) {
        const stuck = await page.evaluate((name) => {
          const element = document.querySelector(`[data-pf="${name}"]`);
          if (!(element instanceof HTMLElement)) {
            throw new Error(`no ${name} in the document`);
          }
          return window.getComputedStyle(element).position;
        }, marker);
        expect(stuck, `${viewport.name} ${marker}`).toBe('sticky');
      }
    }
  });

  test('measures what a doubled browser text size does to the two bars', async ({ page }) => {
    // THE MEASUREMENT THAT FOUND THE DEFECT, kept as the record of why the
    // threshold is stated in rem. Raise the browser's own text size on a narrow,
    // short screen and the two bars stop fitting: they wanted 205 and 403 CSS
    // pixels of a 500 pixel viewport on chromium and firefox (199 and 373 on
    // webkit). While the threshold was a 400 px literal they stayed STUCK
    // there, the later painted over the earlier, and the pause control was
    // wholly obscured. QUALITY-BAR section 5's floor is 25 rem now, so it
    // doubles with the text and this viewport is one they unstick at, which is
    // what this test asserts alongside the numbers.
    await page.setViewportSize({ width: SCROLLING.width, height: SCROLLING.height });
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    expect((await scrolls(page)).down).toBe(false);

    const doubled = DEFAULT_ROOT_FONT_SIZE * 2;
    const stuck = SCROLLING.height >= STICKY_MIN_REM * doubled;
    expect(stuck, 'the threshold at 200 percent is above this viewport').toBe(false);
    await useRootFontSize(page, DOUBLED_ROOT_FONT_SIZE, 'static');

    const state = await scrolls(page);
    // Static, so nothing stands over the page and the page scrolls instead:
    // the arrangement QUALITY-BAR section 5 puts below its own threshold.
    expect(state.bars).toBe('static');
    expect(state.down).toBe(true);
    const bars = await barHeights(page);
    // The numbers that made the rule necessary. The figures in this file's
    // header are the chromium reading, 205 and 403 against 500; the bands are
    // wide enough for the other two engines' font metrics and narrow enough
    // that either bar changing shape reddens here rather than leaving the
    // header's numbers as prose nobody checks.
    expect(bars.viewport).toBe(SCROLLING.height);
    expect(bars.top).toBeGreaterThan(150);
    expect(bars.top).toBeLessThan(260);
    expect(bars.bottom).toBeGreaterThan(340);
    expect(bars.bottom).toBeLessThan(470);
    // And the arithmetic the rule exists for: two bars that together want more
    // than the viewport has, which is why they are not stuck to it.
    expect(bars.top + bars.bottom).toBeGreaterThan(bars.viewport);

    await useRootFontSize(page, null, 'sticky');
    // Putting the size back puts the arrangement back, so the reading above is
    // about the text size and not about something this test left behind.
    expect((await scrolls(page)).down).toBe(false);
  });

  test('keeps every focused control visible, at every breakpoint', async ({ page }) => {
    // THE STATIC-BARS VIEWPORT IS IN THE LIST, and it is the only one that makes
    // the two scroll extremes below mean anything: everywhere else the page does
    // not scroll, so `scrollTo(top)` and `scrollTo(bottom)` measure the same
    // page twice. Below QUALITY-BAR section 5's sticky threshold nothing is
    // stuck and the page really does scroll, which is the arrangement where a
    // Tab press has to bring its own control into view.
    for (const viewport of [...VIEWPORTS, SCROLLING, STATIC_BARS]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
      const arrangement = await scrolls(page);
      if (viewport.name === STATIC_BARS.name) {
        expect(arrangement.bars, viewport.name).toBe('static');
        expect(arrangement.down, viewport.name).toBe(true);
      } else {
        expect(arrangement.bars, viewport.name).toBe('sticky');
      }
      for (const scrollTo of ['top', 'bottom'] as const) {
        const stops = await walkAndMeasure(page, scrollTo);
        // The walk is not vacuous: the pause control, the play surface and
        // SPEC section 5.0's eight aim controls are reached at every one.
        expect(stops.length, `${viewport.name} ${scrollTo}`).toBeGreaterThanOrEqual(10);
        for (const stop of stops) {
          const where = `${viewport.name} ${scrollTo} ${stop.marker}`;
          expect(stop.seen.inside, `${where} inside the viewport`).toBeGreaterThan(0);
          expect(stop.seen.visible, `${where} not wholly obscured`).toBeGreaterThan(0);
        }
      }
    }
  });

  test('keeps every focused control visible at 200 percent text too', async ({ page }) => {
    // THE CASE NO ASSERTION REACHED, and the one that failed. The criterion says
    // "at any breakpoint" and QUALITY-BAR section 4 requires the chrome to
    // survive a 200 percent browser text size; the walk above ran at the default
    // size and the doubled-size test above it measured the two bars without
    // asserting anything about obscuring. At 360 by 500 and 320 by 400 the bars
    // then measured 205 and 403 CSS pixels on chromium and firefox (199 and 373
    // on webkit) while still STUCK, so the later one painted over the pause
    // control and every one of its 25 samples came back covered. The rule
    // QUALITY-BAR section 5 states is a height in rem, so at 200 percent text
    // the bars unstick below 800 px and no viewport they cannot fit is one they
    // are stuck to; this walks it rather than trusting it.
    for (const viewport of [...VIEWPORTS, ...TIGHT_VIEWPORTS]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
      const at = viewportLabel(viewport);
      // The arrangement the rule gives this viewport at the doubled size, so the
      // wait is for the page to agree with the document rather than with itself.
      const stuck = viewport.height >= STICKY_MIN_REM * DEFAULT_ROOT_FONT_SIZE * 2;
      await useRootFontSize(page, DOUBLED_ROOT_FONT_SIZE, stuck ? 'sticky' : 'static');
      // Whatever the arrangement resolves to, the two bars fit inside the
      // viewport wherever they are stuck to it. That is the rule the threshold
      // now carries, and it is asserted rather than assumed.
      const bars = await barHeights(page);
      const arrangement = await scrolls(page);
      if (arrangement.bars === 'sticky') {
        expect(bars.top + bars.bottom, `${at} both bars inside the viewport`).toBeLessThan(
          bars.viewport,
        );
      }
      for (const scrollTo of ['top', 'bottom'] as const) {
        const stops = await walkAndMeasure(page, scrollTo);
        expect(stops.length, `${at} ${scrollTo}`).toBeGreaterThanOrEqual(10);
        for (const stop of stops) {
          const where = `${at} at 200 percent, ${scrollTo}, ${stop.marker}`;
          expect(stop.seen.inside, `${where} inside the viewport`).toBeGreaterThan(0);
          expect(stop.seen.visible, `${where} not wholly obscured`).toBeGreaterThan(0);
        }
      }
      await useRootFontSize(page, null, 'sticky');
    }
  });

  test('keeps the focused control visible while an overlay is open', async ({ page }) => {
    // The criterion names overlays beside the bars. An open panel is fixed over
    // the whole viewport, so every control it can obscure is one the focus trap
    // has already taken out of reach; what remains to grade is the panel's OWN
    // controls, on the viewport where its card is most likely to overflow.
    await page.setViewportSize({ width: SCROLLING.width, height: SCROLLING.height });
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await page.locator('[data-pf="pause"]').click();
    await expect(page.locator('[data-pf="panel-pause"]')).toBeVisible(SETTLE);
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(page.locator('[data-pf="panel-settings"]')).toBeVisible(SETTLE);

    const met = new Set<string>();
    for (let step = 0; step < 14; step += 1) {
      const marker = await activeMarker(page);
      if (marker !== 'body' && !met.has(marker)) {
        met.add(marker);
        const seen = await visibility(page, marker);
        expect(seen.inside, `${marker} inside the viewport`).toBeGreaterThan(0);
        expect(seen.visible, `${marker} not wholly obscured`).toBeGreaterThan(0);
      }
      await page.keyboard.press('Tab');
    }
    // THE PANEL'S SIX TAB STOPS, and six rather than eleven because a radio
    // GROUP is one stop however many radios it holds: the settings panel offers
    // the theme group, the size group and four buttons. `chrome-panels.test.ts`
    // freezes the eleven controls; this is the walk the platform gives them.
    expect([...met].sort()).toEqual([
      'reset-cancel',
      'reset-confirm',
      'reset-data',
      'settings-close',
      'surface-scale-100',
      'theme-system',
    ]);
  });

  test('would see a control that really was covered, which is the control', async ({ page }) => {
    // THE NEGATIVE CONTROL FOR THE MEASUREMENT. Every assertion above is that a
    // count is above zero, and a reading that always answered the control's own
    // element would satisfy all of them. An opaque sheet is planted over the
    // whole viewport, the same control is measured again, and it has to come
    // back wholly obscured.
    await page.setViewportSize({ width: SCROLLING.width, height: SCROLLING.height });
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await resetFocus(page);
    await page.keyboard.press('Tab');
    expect(await activeMarker(page)).toBe('pause');
    const before = await visibility(page, 'pause');
    expect(before.visible).toBeGreaterThan(0);

    await page.evaluate(() => {
      const sheet = document.createElement('div');
      sheet.dataset['pf'] = 'planted-cover';
      sheet.style.setProperty('position', 'fixed');
      sheet.style.setProperty('inset', '0');
      sheet.style.setProperty('z-index', '99');
      sheet.style.setProperty('background', 'currentColor');
      document.body.appendChild(sheet);
    });
    const covered = await visibility(page, 'pause');
    expect(covered.inside).toBe(before.inside);
    expect(covered.visible).toBe(0);

    await page.evaluate(() => {
      document.querySelector('[data-pf="planted-cover"]')?.remove();
    });
    expect((await visibility(page, 'pause')).visible).toBeGreaterThan(0);
  });
});
