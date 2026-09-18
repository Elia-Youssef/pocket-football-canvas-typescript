import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, startMatch } from './support/game';
import {
  DEFAULT_ROOT_FONT_SIZE,
  DOUBLED_ROOT_FONT_SIZE,
  VIEWPORTS,
  controlBoxes,
  overlaps,
  rootFontSize,
  TIGHT_VIEWPORTS,
  scrollsSideways,
  setRootFontSize,
  useRootFontSize,
  useViewport,
  viewportLabel,
} from './support/viewports';
import { STICKY_MIN_REM } from '../../src/ui/breakpoints';

/**
 * Item G6, method T, evidence `playwright/text-scale`:
 *
 *   "Chrome text resizes to 200 percent with no clipping, no overlap and no
 *    loss of function."
 *
 * A FONT SIZE AND NEVER A TRANSFORM. QUALITY-BAR section 4 asks that chrome TEXT
 * resize, which is what a browser's own text-size setting does and what every
 * rem in `src/ui/tokens.css` exists for. A CSS transform would scale a picture
 * of the chrome: every line break would stay where it was, nothing would reflow,
 * and a clipping assertion against it would be measuring the same layout twice.
 * The root font size is raised instead, and the first assertion below is that
 * the raise actually reached the text.
 *
 * THE SWEEP IS ITEM F1'S, SHARED RATHER THAN COPIED. `support/viewports.ts`
 * holds `VIEWPORTS`, `controlBoxes` and `overlaps`, and `breakpoints.spec.ts`
 * consumes the same three. Two sweeps agreeing about four viewports would prove
 * nothing about each other; one sweep run at two text sizes is the comparison
 * the criterion asks for.
 *
 * NO CLIPPING IS A MEASUREMENT AND NOT AN EYE. An element clips when its own
 * overflow is not visible and its content is bigger than its box, so that is
 * what is measured, over every element of the app column, with the two boxes
 * that scroll BY DESIGN named as exceptions and a planted control proving the
 * measurement can fail at all.
 */

/** The boxes that scroll on purpose, and the reason each of them does. */
const SCROLLS_BY_DESIGN: readonly string[] = [
  // QUALITY-BAR section 4's size setting is the one thing that can make the
  // pitch larger than the box it is drawn in; the frame is where it overflows.
  'play-frame',
  // A card taller than the viewport scrolls inside itself rather than pushing
  // its last control past the bottom edge, which is how every control stays
  // reachable at 200 percent rather than in spite of it.
  'panel-card',
  // The accessible mirror is clipped away on purpose: it is a visually hidden
  // subtree with real semantics, and it is not chrome text anybody reads.
  'play-mirror',
];

interface Clip {
  readonly where: string;
  readonly axis: string;
  readonly content: number;
  readonly box: number;
}

/**
 * Every element of the app column whose own box cuts its content off.
 *
 * The exceptions are passed in rather than written in the page, so the list
 * above is the one a reader checks and the page task cannot quietly grow one.
 */
async function clipped(page: Page, allowed: readonly string[]): Promise<Clip[]> {
  return page.evaluate((exceptions) => {
    const found: { where: string; axis: string; content: number; box: number }[] = [];
    const column = document.querySelector('.pf-app');
    if (!(column instanceof HTMLElement)) {
      throw new Error('the app column is not in the document');
    }
    for (const element of [column, ...column.querySelectorAll('*')]) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const marker = element.dataset['pf'] ?? '';
      const named = marker === '' ? element.className : marker;
      if (exceptions.some((name) => named.includes(name))) {
        continue;
      }
      if (element.closest('.pf-visually-hidden') !== null) {
        continue;
      }
      const style = window.getComputedStyle(element);
      // A visible overflow is not a clip: the content spills out and is still
      // read. Only a box that hides or scrolls its own content can cut it off.
      if (style.overflowX !== 'visible' && element.scrollWidth > element.clientWidth + 1) {
        found.push({
          where: named,
          axis: 'x',
          content: element.scrollWidth,
          box: element.clientWidth,
        });
      }
      if (style.overflowY !== 'visible' && element.scrollHeight > element.clientHeight + 1) {
        found.push({
          where: named,
          axis: 'y',
          content: element.scrollHeight,
          box: element.clientHeight,
        });
      }
    }
    return found;
  }, allowed);
}

/** The computed font size of each named readout, in CSS pixels. */
async function textSizes(page: Page, markers: readonly string[]): Promise<number[]> {
  return page.evaluate((names) => {
    return names.map((name) => {
      const element = document.querySelector(`[data-pf="${name}"]`);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`no ${name} in the document`);
      }
      return Number.parseFloat(window.getComputedStyle(element).fontSize);
    });
  }, markers);
}

/** Readouts and controls across the chrome, one per type scale step in use. */
const MEASURED: readonly string[] = [
  'score-player',
  'clock',
  'turn',
  'ladder',
  'pause',
  'aim-readout',
];

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** Every open panel card that has to be scrolled SIDEWAYS to be read. */
async function cardsScrollingSideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const card of document.querySelectorAll('.pf-panel-card')) {
      if (!(card instanceof HTMLElement) || card.clientWidth === 0) {
        continue;
      }
      if (card.scrollWidth > card.clientWidth + 1) {
        const panel = card.closest('[data-pf]');
        found.push(panel instanceof HTMLElement ? (panel.dataset['pf'] ?? 'panel') : 'panel');
      }
    }
    return found;
  });
}

/** One open overlay at the doubled size: no clip, no overlap, nothing off screen. */
async function measureOverlay(
  page: Page,
  where: string,
  viewport: { readonly width: number },
): Promise<void> {
  const boxes = await controlBoxes(page);
  // Not vacuous: every one of these screens offers at least one control, and
  // a panel that had vanished would show up here rather than pass quietly.
  expect(boxes.length, where).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, `${where} ${box.label}`).toBeGreaterThan(0);
    expect(box.height, `${where} ${box.label}`).toBeGreaterThan(0);
    expect(box.x, `${where} ${box.label}`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${where} ${box.label}`).toBeLessThanOrEqual(viewport.width + 0.5);
  }
  for (let one = 0; one < boxes.length; one += 1) {
    for (let other = one + 1; other < boxes.length; other += 1) {
      const first = boxes[one];
      const second = boxes[other];
      if (first === undefined || second === undefined) {
        continue;
      }
      expect(overlaps(first, second), `${where}: ${first.label} over ${second.label}`).toBe(false);
    }
  }
  expect(await scrollsSideways(page), where).toBe(false);
  expect(await clipped(page, SCROLLS_BY_DESIGN), where).toEqual([]);
  expect(await cardsScrollingSideways(page), where).toEqual([]);
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

/** The whole shipped tab order, which `keyboard.spec.ts` freezes for item C12. */
const TAB_ORDER: readonly string[] = [
  'pause',
  'play-frame',
  'aim-left',
  'aim-angle',
  'aim-right',
  'power-down',
  'power',
  'power-up',
  'aim-launch',
  'aim-cancel',
];

/**
 * The order one viewport actually offers.
 *
 * SPEC section 2.1's rotate hint is shown by the stylesheet at the portrait
 * breakpoint alone, and it carries a Dismiss control, so portrait has one more
 * stop than the other three. It sits between the HUD and the stage because the
 * hint is a bar in the FLOW, which is also what makes it unable to cover
 * anything; the order below is that fact read as a tab walk.
 */
function tabOrderFor(name: string): string[] {
  if (name !== 'portrait') {
    return [...TAB_ORDER];
  }
  return ['pause', 'hint-dismiss', ...TAB_ORDER.slice(1)];
}

test.describe('PF-15 chrome text at 200 percent, item G6', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('doubles every chrome text size, at every breakpoint', async ({ page }) => {
    // THE PREMISE FIRST. A test that raised the root size and measured nothing
    // would pass on a chrome that ignored it entirely, which is exactly what a
    // chrome built in px rather than rem would do.
    await startMatch(page, { mode: 'first-to', target: 3 });
    for (const viewport of VIEWPORTS) {
      await useViewport(page, viewport);
      await setRootFontSize(page, null);
      expect(await rootFontSize(page), viewport.name).toBe(DEFAULT_ROOT_FONT_SIZE);
      const before = await textSizes(page, MEASURED);
      await setRootFontSize(page, DOUBLED_ROOT_FONT_SIZE);
      expect(await rootFontSize(page), viewport.name).toBe(DEFAULT_ROOT_FONT_SIZE * 2);
      const after = await textSizes(page, MEASURED);
      expect(before, viewport.name).toHaveLength(MEASURED.length);
      for (let at = 0; at < MEASURED.length; at += 1) {
        const where = `${viewport.name} ${MEASURED[at] ?? ''}`;
        expect(before[at], where).toBeGreaterThan(0);
        expect(after[at], where).toBeCloseTo((before[at] ?? 0) * 2, 2);
      }
    }
    await setRootFontSize(page, null);
  });

  test('clips nothing and overlaps nothing at 200 percent', async ({ page }) => {
    // THE TIGHT VIEWPORTS ARE IN THE LIST, and they are why this test exists in
    // its present form. The four breakpoints are sampled at comfortable heights,
    // so the arrangement that broke at 200 percent text (a SHORT viewport, where
    // the two bars stop fitting) was reached by no assertion anywhere: the sweep
    // ran the four, and the walk that visits 360 by 500 ran at the default size.
    // Measured on all three engines before the rule changed: the bars stayed
    // stuck at 205 and 403 CSS pixels against a 500 pixel viewport, the later
    // painted over the earlier, and this loop reported three overlapping pairs
    // at 360 by 500 and two at 320 by 400.
    await startMatch(page, { mode: 'first-to', target: 3 });
    for (const viewport of [...VIEWPORTS, ...TIGHT_VIEWPORTS]) {
      await useViewport(page, viewport);
      // The size is set per viewport rather than once, because the arrangement
      // it produces depends on the viewport: QUALITY-BAR section 5's sticky
      // floor is 25 rem, so at 200 percent text the two bars unstick below 800
      // pixels of viewport height, and the wait is for that to have landed.
      const stuck = viewport.height >= STICKY_MIN_REM * DEFAULT_ROOT_FONT_SIZE * 2;
      await useRootFontSize(page, DOUBLED_ROOT_FONT_SIZE, stuck ? 'sticky' : 'static');
      const boxes = await controlBoxes(page);
      // The sweep is not vacuous: the pause control and SPEC section 5.0's
      // eight aim controls are all present at every breakpoint, at either size.
      const at = viewportLabel(viewport);
      expect(boxes.length, at).toBeGreaterThanOrEqual(9);
      for (const box of boxes) {
        const where = `${at} ${box.label}`;
        expect(box.width, where).toBeGreaterThan(0);
        expect(box.height, where).toBeGreaterThan(0);
        expect(box.x, where).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, where).toBeLessThanOrEqual(viewport.width + 0.5);
      }
      for (let one = 0; one < boxes.length; one += 1) {
        for (let other = one + 1; other < boxes.length; other += 1) {
          const first = boxes[one];
          const second = boxes[other];
          if (first === undefined || second === undefined) {
            continue;
          }
          expect(overlaps(first, second), `${at}: ${first.label} over ${second.label}`).toBe(
            false,
          );
        }
      }
      expect(await scrollsSideways(page), at).toBe(false);
      expect(await clipped(page, SCROLLS_BY_DESIGN), at).toEqual([]);
      await useRootFontSize(page, null, 'sticky');
    }
  });

  test('clips nothing and overlaps nothing with each overlay open', async ({ page }) => {
    // THE DENSEST CHROME IN THE GAME, and the sweep above never opens it. Every
    // panel is `display: none` while it is closed, so a closed panel has a
    // scroll size of zero and contributes nothing to a clipping walk: measuring
    // a match in progress at 200 percent measures the pause control and SPEC
    // section 5.0's eight aim controls, and leaves the five overlays, which
    // carry most of the words in the chrome, unmeasured. This opens four of
    // them at every breakpoint. (The fifth, game over, costs a driven match and
    // is scanned for violations in `axe.spec.ts`; its card is the shortest of
    // the five and carries four buttons and no body text.)
    //
    // THE CARD'S OWN SIDEWAYS OVERFLOW IS MEASURED HERE RATHER THAN IN THE WALK.
    // `panel-card` is on the by-design list because it scrolls VERTICALLY on
    // purpose, and `overflow-y: auto` computes `overflow-x` to `auto` as well,
    // so the walk's exception covers an axis nothing intended to except. A card
    // that scrolls sideways at 200 percent is a clipped card.
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      // THE OVERLAY IS PUT AWAY IF IT IS THERE, which is the same real condition
      // `support/game.ts` documents: SPEC section 19 shows the first-launch
      // overlay once and PF-10 made that dismissal survive the reload, so only
      // the first pass through this loop meets it.
      const howTo = at(page, 'panel-how-to-play');
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      // AFTER the load, because the size is an inline style on the root element
      // and a navigation throws it away with the rest of the document.
      await setRootFontSize(page, DOUBLED_ROOT_FONT_SIZE);
      expect(await rootFontSize(page), viewport.name).toBe(DEFAULT_ROOT_FONT_SIZE * 2);
      await useViewport(page, viewport);
      if (await howTo.isVisible()) {
        await measureOverlay(page, `${viewport.name} first launch`, viewport);
        await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
        await expect(howTo).toBeHidden(SETTLE);
      }
      await measureOverlay(page, `${viewport.name} the menu`, viewport);

      // And How to play from the menu, which is the route that exists at every
      // launch rather than only at the first.
      await at(page, 'mode-how-to').click();
      await expect(howTo).toBeVisible(SETTLE);
      await measureOverlay(page, `${viewport.name} how to play`, viewport);
      await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
      await expect(howTo).toBeHidden(SETTLE);

      await at(page, 'mode-start').click();
      await expect(at(page, 'panel-mode')).toBeHidden(SETTLE);
      await at(page, 'pause').click();
      await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
      await measureOverlay(page, `${viewport.name} paused`, viewport);

      await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
      await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
      await measureOverlay(page, `${viewport.name} settings`, viewport);
    }
    await setRootFontSize(page, null);
  });

  test('would see a box that cut its own text off, which is the control', async ({ page }) => {
    // THE NEGATIVE CONTROL FOR THE CLIPPING MEASUREMENT. Every assertion above
    // is that a list is empty, and a reading that had stopped finding anything
    // would report the same empty list forever. A fixed-height box with more
    // text than it holds is planted in the real column, reported, and removed.
    await startMatch(page, { mode: 'first-to', target: 3 });
    await setRootFontSize(page, DOUBLED_ROOT_FONT_SIZE);
    expect(await clipped(page, SCROLLS_BY_DESIGN)).toEqual([]);

    await page.evaluate(() => {
      const column = document.querySelector('.pf-app');
      if (!(column instanceof HTMLElement)) {
        throw new Error('the app column is not in the document');
      }
      const planted = document.createElement('div');
      planted.dataset['pf'] = 'planted-clip';
      planted.style.setProperty('block-size', '10px');
      planted.style.setProperty('inline-size', '40px');
      planted.style.setProperty('overflow', 'hidden');
      planted.textContent = 'a line of chrome text far taller than the box it was given';
      column.appendChild(planted);
    });
    const found = await clipped(page, SCROLLS_BY_DESIGN);
    expect(found.map((entry) => entry.where)).toContain('planted-clip');
    for (const entry of found) {
      expect(entry.content, entry.where).toBeGreaterThan(entry.box);
    }

    await page.evaluate(() => {
      document.querySelector('[data-pf="planted-clip"]')?.remove();
    });
    expect(await clipped(page, SCROLLS_BY_DESIGN)).toEqual([]);
    // And the exception list is spent rather than decorative: each name is a
    // box that really is in the document and really does scroll itself.
    await setRootFontSize(page, null);
  });

  test('loses no function at 200 percent: every control is still reachable', async ({ page }) => {
    // "No loss of function" is the clause a layout test cannot answer. It is a
    // real Tab walk at the doubled size, on the two viewports where the chrome
    // has least room: `compact` is the shortest supported height that keeps the
    // bars stuck, and `portrait` is the narrowest and the one screen with an
    // extra stop (SPEC section 2.1's hint). Those are also the two tab-order
    // shapes the chrome has, so between them the walk covers both.
    for (const viewport of [VIEWPORTS[2], VIEWPORTS[3]]) {
      // The size is set before the load so the MOUNT path resolves it, which is
      // the path a player who arrives at this size takes; the wait afterwards is
      // the page confirming the arrangement the walk below is written for.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
      await useViewport(page, viewport);
      await setRootFontSize(page, DOUBLED_ROOT_FONT_SIZE);
      const expected = tabOrderFor(viewport.name);
      const seen: string[] = [];
      for (let step = 0; step < expected.length; step += 1) {
        await page.keyboard.press('Tab');
        seen.push(await activeMarker(page));
      }
      expect(seen, viewport.name).toEqual(expected);

      // And the controls still DO something: the pause overlay opens from the
      // keyboard and Escape puts it away, at the doubled size.
      await page.keyboard.press('Shift+Tab');
      expect(await activeMarker(page), viewport.name).toBe('aim-launch');
      await page.locator('[data-pf="pause"]').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-pf="panel-pause"]')).toBeVisible(SETTLE);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-pf="panel-pause"]')).toBeHidden(SETTLE);
      await setRootFontSize(page, null);
    }
  });
});
