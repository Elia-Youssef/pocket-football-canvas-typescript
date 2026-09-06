import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, centres, nextFrames, startMatch } from './support/game';

/**
 * Item F7, method T, evidence `playwright/small-viewport`:
 *
 *   "At 320 by 256 CSS pixels there is no two-dimensional scrolling and no
 *    loss of function, and both sticky HUD bars unstick below a 400 pixel
 *    viewport height rather than consuming it."
 *
 * 320 BY 256 IS WHAT 400 PERCENT ZOOM ON A 1280 BY 1024 DISPLAY PRODUCES, and
 * SC 1.4.10 is measured at the presentation a player arrives at rather than at
 * one they went on to magnify further. The whole of the criterion is asserted
 * at the default play-surface size for that reason; the largest size setting
 * is re-asserted beneath for the half that still holds there, which is that
 * the PAGE never scrolls sideways, and the report says which is which.
 *
 * THE INVARIANT PAIR. Sticky implies the page does not scroll past the bars;
 * static implies scrolling reaches everything. Both are asserted as
 * invariants: what is measured is that exactly one axis scrolls, and that
 * every control can be brought wholly into view, rather than where any of it
 * happens to be.
 *
 * THE THRESHOLD IS PINNED BY LITERAL, at 399, 400 and 401, because a bound
 * asserted against the symbol that defines it passes for whatever value the
 * symbol takes.
 */

/** SC 1.4.10's floor, which QUALITY-BAR section 5 states in these two numbers. */
const SMALLEST = { width: 320, height: 256 };

/** The one key SPEC section 16 gives the game, as the storage module names it. */
const SAVE_KEY = 'pocket-football:save';

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function positionOf(page: Page, marker: string): Promise<string> {
  return page.evaluate((name) => {
    const element = document.querySelector(`[data-pf="${name}"]`);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`no ${name} in the document`);
    }
    return window.getComputedStyle(element).position;
  }, marker);
}

interface Scrolling {
  readonly horizontal: boolean;
  readonly vertical: boolean;
  readonly movedSideways: number;
}

/**
 * Whether a design point is inside the window the play frame is showing. The
 * conversion is written from SPEC section 3 rather than borrowed from the
 * game: the canvas rectangle carries the frame's own scroll offset, so a point
 * mapped through it lands where a player would see it.
 */
async function inView(page: Page, point: { x: number; y: number }): Promise<boolean> {
  return page.evaluate((design) => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    const frame = document.querySelector('[data-pf="play-frame"]');
    if (!(canvas instanceof HTMLCanvasElement) || !(frame instanceof HTMLElement)) {
      throw new Error('the play surface is not mounted inside a frame');
    }
    const surface = canvas.getBoundingClientRect();
    const window_ = frame.getBoundingClientRect();
    const x = surface.left + (design.x * surface.width) / 1280;
    const y = surface.top + ((720 - design.y) * surface.height) / 720;
    return x >= window_.left && x <= window_.right && y >= window_.top && y <= window_.bottom;
  }, point);
}

async function scrolling(page: Page): Promise<Scrolling> {
  return page.evaluate(() => {
    const root = document.documentElement;
    window.scrollTo(4000, 0);
    const movedSideways = window.scrollX;
    window.scrollTo(0, 0);
    return {
      horizontal: root.scrollWidth > root.clientWidth,
      vertical: root.scrollHeight > root.clientHeight,
      movedSideways,
    };
  });
}

test.describe('PF-14 the smallest supported viewport, item F7', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize(SMALLEST);
  });

  test('scrolls in one dimension only, and never sideways', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const measured = await scrolling(page);
    // The one dimension SC 1.4.10 allows for a horizontal-language page.
    expect(measured.horizontal).toBe(false);
    expect(measured.movedSideways).toBe(0);
    // The pitch is fitted inside the width, so nothing is cut off sideways
    // either, which is the half a scroll measurement alone would not catch.
    const surface = await page.evaluate(() => {
      const canvas = document.querySelector('[data-pf="play-surface"]');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('the play surface is not in the document');
      }
      const box = canvas.getBoundingClientRect();
      return { width: box.width, height: box.height, left: box.left };
    });
    expect(surface.width).toBeLessThanOrEqual(SMALLEST.width + 0.5);
    expect(surface.left).toBeGreaterThanOrEqual(-0.5);
    expect(surface.width).toBeGreaterThan(0);
  });

  test('unsticks both bars so they do not consume the viewport', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    expect(await page.evaluate(() => document.documentElement.dataset['pfBars'] ?? '')).toBe(
      'static',
    );
    expect(await positionOf(page, 'hud')).toBe('static');
    expect(await positionOf(page, 'aim-controls')).toBe('static');
    // Unstuck means they can be scrolled away, which is what gives the pitch
    // the viewport: the page has somewhere to scroll to.
    expect((await scrolling(page)).vertical).toBe(true);
    // And the pitch really does get a viewport of its own, rather than what
    // two bars left of a 256 px screen.
    const stage = await page.evaluate(() => {
      const element = document.querySelector('[data-pf="stage"]');
      if (!(element instanceof HTMLElement)) {
        throw new Error('the stage is not in the document');
      }
      return element.getBoundingClientRect().height;
    });
    expect(stage).toBeGreaterThanOrEqual(SMALLEST.height - 0.5);
  });

  test('sticks both bars at 400 and unsticks them below it', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    for (const [height, expected] of [
      [401, 'sticky'],
      [400, 'sticky'],
      [399, 'static'],
    ] as const) {
      await page.setViewportSize({ width: 700, height });
      await expect
        .poll(
          async () => page.evaluate(() => document.documentElement.dataset['pfBars'] ?? ''),
          SETTLE,
        )
        .toBe(expected);
      const where = String(height);
      expect(await positionOf(page, 'hud'), where).toBe(
        expected === 'sticky' ? 'sticky' : 'static',
      );
      expect(await positionOf(page, 'aim-controls'), where).toBe(
        expected === 'sticky' ? 'sticky' : 'static',
      );
    }
  });

  test('loses no function: every control is reachable and a launch lands', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    // Scrolling reaches everything, which is what static bars buy: each
    // control is brought wholly into view rather than merely existing.
    for (const marker of [
      'pause',
      'aim-left',
      'aim-angle',
      'aim-right',
      'power-down',
      'power',
      'power-up',
      'aim-launch',
      'aim-cancel',
    ]) {
      const control = at(page, marker);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      if (box === null) {
        throw new Error(`no box for ${marker}`);
      }
      // Wholly on the screen once it has been scrolled to, within the pixel a
      // fractional layout can round away. A control that cannot be brought
      // into view is one that has been removed as far as a player is concerned.
      expect(box.y, marker).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height, marker).toBeLessThanOrEqual(SMALLEST.height + 1);
      expect(box.x, marker).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, marker).toBeLessThanOrEqual(SMALLEST.width + 1);
    }
    // And the function itself: an aim taken and launched at 320 by 256.
    await at(page, 'aim-angle').fill('15');
    await at(page, 'power').fill('75');
    await at(page, 'aim-launch').click();
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
  });

  test('never scrolls sideways here at 200 percent either', async ({ page }) => {
    // THE DISCLOSED READING. The criterion's no-two-dimensional-scrolling
    // clause is asserted above at the default size, which is the presentation
    // SC 1.4.10 measures. A player who then asks for 200 percent has asked for
    // a pitch larger than the screen, and panning it is the point; what still
    // holds, and is asserted here, is that the excess belongs to the play
    // frame and never to the page, so the page still scrolls in one dimension.
    await page.addInitScript(
      (seed) => {
        window.localStorage.setItem(seed.key, seed.text);
      },
      {
        key: SAVE_KEY,
        text: JSON.stringify({ version: 2, settings: { surfaceScale: 200 } }),
      },
    );
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const measured = await scrolling(page);
    expect(measured.horizontal).toBe(false);
    expect(measured.movedSideways).toBe(0);
    // The frame is what holds the excess: the page is not wider, the frame is.
    const frame = await page.evaluate(() => {
      const element = document.querySelector('[data-pf="play-frame"]');
      if (!(element instanceof HTMLElement)) {
        throw new Error('the play frame is not mounted');
      }
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrolled: element.scrollLeft + element.scrollTop,
        fitX: element.dataset['pfFitX'],
        fitY: element.dataset['pfFitY'],
      };
    });
    expect(frame.scrollWidth).toBeGreaterThan(frame.clientWidth);
    expect(frame.fitX).toBe('over');
    expect(frame.fitY).toBe('over');
    // AND IT REACHES THE PLAY WITHOUT A GESTURE. The canvas has claimed both
    // gestures that could pan a frame: a finger is an aim and never a scroll,
    // and the arrows belong to the keyboard aim model. So the frame follows
    // the play instead, and this is the assertion that says it did: the scroll
    // has moved off the origin on its own, and the circle that is about to
    // launch is inside the window it moved to.
    expect(frame.scrolled).toBeGreaterThan(0);
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    expect(await inView(page, (await centres(page)).player)).toBe(true);
  });

  test('follows the ball once it is in play, at 200 percent', async ({ page }) => {
    await page.addInitScript(
      (seed) => {
        window.localStorage.setItem(seed.key, seed.text);
      },
      {
        key: SAVE_KEY,
        text: JSON.stringify({ version: 2, settings: { surfaceScale: 200 } }),
      },
    );
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    // The launcher is what is watched while an aim can be taken, so it is in
    // view before the launch and the ball is in view after it. A window this
    // small cannot hold both at 200 percent, which is what magnification is.
    expect(await inView(page, (await centres(page)).player)).toBe(true);
    await at(page, 'aim-angle').fill('0');
    await at(page, 'power').fill('90');
    await at(page, 'aim-launch').click();
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
    await nextFrames(page, 20);
    const moving = await centres(page);
    expect(await inView(page, moving.ball)).toBe(true);
  });
});
