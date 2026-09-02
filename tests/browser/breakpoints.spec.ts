import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, startMatch } from './support/game';

/**
 * Item F1, method T, evidence `playwright/breakpoints`:
 *
 *   "All supported breakpoints render with no clipping, no overlap and no
 *    unreachable control, and the HUD remains fully visible at every one."
 *
 * Item F4's ARMOUR lives at the end of this file. F4 is a demonstration item
 * and closes by the scripted capture at the demonstration session, on a device
 * that HAS a notch; a desktop engine reports every safe-area inset as zero, so
 * nothing here can close it. What is armoured is the machinery that capture
 * will exercise: the four inset reads, and the chrome moving by exactly what
 * they are set to. Armour, not closure.
 *
 * INVARIANTS RATHER THAN PIXELS. Nothing below asserts where a control is; it
 * asserts that no control is off the screen sideways, that no two of them
 * cover each other, that the pitch is inside the box it was fitted into, and
 * that the HUD is wholly in view. Those outlive a layout change, and a pixel
 * assertion at four viewports would not survive the next part that adds a
 * control.
 *
 * ONE LOAD, FOUR VIEWPORTS. The four breakpoints are asserted by resizing a
 * running match rather than by loading four times, because a viewport change
 * with a match in progress is what a player actually does and it exercises the
 * resize path as well as the initial one. The initial path is asserted on its
 * own beneath, at the two extremes.
 */

/** Every viewport that resolves to each name, with a height that keeps the bars stuck. */
const VIEWPORTS = [
  { name: 'wide', width: 1280, height: 900 },
  { name: 'medium', width: 900, height: 700 },
  { name: 'compact', width: 700, height: 420 },
  { name: 'portrait', width: 420, height: 800 },
] as const;

interface Box {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function resolved(page: Page): Promise<{ breakpoint: string; bars: string }> {
  return page.evaluate(() => ({
    breakpoint: document.documentElement.dataset['pfBreakpoint'] ?? '',
    bars: document.documentElement.dataset['pfBars'] ?? '',
  }));
}

/** Whether the PAGE can be scrolled sideways, which item F2 forbids outright. */
async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

/** Every visible control, with the box the platform gives it. */
async function controlBoxes(page: Page): Promise<Box[]> {
  const found: Box[] = [];
  for (const locator of await page.locator('button:visible, input:visible').all()) {
    const box = await locator.boundingBox();
    if (box === null) {
      continue;
    }
    const marker = (await locator.getAttribute('data-pf')) ?? '';
    const label = (await locator.getAttribute('aria-label')) ?? (await locator.innerText());
    found.push({
      label: `${marker}|${label}`,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }
  return found;
}

/** True where two boxes share area. A shared edge is not an overlap. */
function overlaps(one: Box, other: Box): boolean {
  const slack = 0.5;
  return (
    one.x + one.width - slack > other.x &&
    other.x + other.width - slack > one.x &&
    one.y + one.height - slack > other.y &&
    other.y + other.height - slack > one.y
  );
}

test.describe('PF-14 every supported breakpoint, item F1', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('resolves each supported breakpoint and keeps the HUD wholly in view', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect
        .poll(async () => (await resolved(page)).breakpoint, SETTLE)
        .toBe(viewport.name);
      const state = await resolved(page);
      // Every one of these heights is at or above the sticky threshold, so
      // both bars are stuck and the HUD is in view without scrolling.
      expect(state.bars, viewport.name).toBe('sticky');
      await expect(at(page, 'hud'), viewport.name).toBeInViewport({ ratio: 1 });
      await expect(at(page, 'aim-controls'), viewport.name).toBeInViewport({ ratio: 1 });
      expect(await scrollsSideways(page), viewport.name).toBe(false);
    }
  });

  test('resolves the same names on a fresh load as on a resize', async ({ page }) => {
    // The resize path and the mount path are two code paths to the same
    // answer, and a layout that only settled after a resize would pass the
    // test above and fail a player who arrived at that size.
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
      expect((await resolved(page)).breakpoint, viewport.name).toBe(viewport.name);
      expect(await scrollsSideways(page), viewport.name).toBe(false);
    }
  });

  test('places no control off the screen and never covers one with another', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect
        .poll(async () => (await resolved(page)).breakpoint, SETTLE)
        .toBe(viewport.name);
      const boxes = await controlBoxes(page);
      // The sweep is not vacuous: the pause control and SPEC section 5.0's
      // eight aim controls are all present at every breakpoint.
      expect(boxes.length, viewport.name).toBeGreaterThanOrEqual(9);
      for (const box of boxes) {
        const where = `${viewport.name} ${box.label}`;
        expect(box.width, where).toBeGreaterThan(0);
        expect(box.height, where).toBeGreaterThan(0);
        // Inside the page sideways. A control past the right edge is one a
        // player would have to scroll sideways to reach, which item F2 also
        // forbids and which this states per control.
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
          expect(
            overlaps(first, second),
            `${viewport.name}: ${first.label} over ${second.label}`,
          ).toBe(false);
        }
      }
    }
  });

  test('keeps the whole pitch inside the box it was fitted into', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect
        .poll(async () => (await resolved(page)).breakpoint, SETTLE)
        .toBe(viewport.name);
      const measured = await page.evaluate(() => {
        const canvas = document.querySelector('[data-pf="play-surface"]');
        const stage = document.querySelector('[data-pf="stage"]');
        if (!(canvas instanceof HTMLCanvasElement) || !(stage instanceof HTMLElement)) {
          throw new Error('the play surface is not mounted inside a stage');
        }
        const surface = canvas.getBoundingClientRect();
        const box = stage.getBoundingClientRect();
        return {
          surface: { width: surface.width, height: surface.height },
          stage: { width: box.width, height: box.height },
          backing: { width: canvas.width, height: canvas.height },
        };
      });
      const where = viewport.name;
      // No clipping: the surface is inside its box in BOTH axes, which is the
      // half a width-driven fit gets wrong.
      expect(measured.surface.width, where).toBeLessThanOrEqual(measured.stage.width + 0.5);
      expect(measured.surface.height, where).toBeLessThanOrEqual(measured.stage.height + 0.5);
      expect(measured.surface.width, where).toBeGreaterThan(0);
      // And it is the SAME landscape pitch at every one of them: the logical
      // shape never changes, which is what SPEC section 2.1 promises.
      expect(measured.surface.width / measured.surface.height, where).toBeCloseTo(
        1280 / 720,
        2,
      );
      expect(measured.backing.width / measured.backing.height, where).toBeCloseTo(
        1280 / 720,
        1,
      );
    }
  });
});

test.describe('PF-14 safe-area insets, item F4 armour and not closure', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 420, height: 800 });
  });

  test('declares the viewport the insets need, and denies no magnification', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    const meta = await page.evaluate(
      () => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    );
    // QUALITY-BAR section 5: without viewport-fit=cover every safe-area inset
    // resolves to zero and the whole rule is inert.
    expect(meta).toContain('viewport-fit=cover');
    expect(meta).not.toContain('user-scalable=no');
    expect(meta).not.toContain('maximum-scale');
  });

  test('moves every bar that carries a control by exactly the inset it is given', async ({
    page,
  }) => {
    // The insets are zero on every engine this suite runs, so the armour
    // drives them: the stylesheet reads them into four custom properties, and
    // setting those is what the demonstration capture will do on a device that
    // has them for real.
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const before = await page.evaluate(() => {
      const read = (selector: string): { top: string; bottom: string; left: string } => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`no ${selector} in the document`);
        }
        const style = window.getComputedStyle(element);
        return {
          top: style.paddingTop,
          bottom: style.paddingBottom,
          left: style.paddingLeft,
        };
      };
      return { hud: read('[data-pf="hud"]'), aim: read('[data-pf="aim-controls"]') };
    });
    const grown = await page.evaluate(() => {
      const body = document.body;
      body.style.setProperty('--pf-safe-top', '40px');
      body.style.setProperty('--pf-safe-bottom', '34px');
      body.style.setProperty('--pf-safe-left', '24px');
      body.style.setProperty('--pf-safe-right', '24px');
      const read = (selector: string): { top: string; bottom: string; left: string } => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`no ${selector} in the document`);
        }
        const style = window.getComputedStyle(element);
        return {
          top: style.paddingTop,
          bottom: style.paddingBottom,
          left: style.paddingLeft,
        };
      };
      return { hud: read('[data-pf="hud"]'), aim: read('[data-pf="aim-controls"]') };
    });
    const grew = (was: string, now: string): number =>
      Number.parseFloat(now) - Number.parseFloat(was);
    // The notch is at the top and the home indicator at the bottom, and the
    // two side insets are what a landscape notch produces.
    expect(grew(before.hud.top, grown.hud.top)).toBeCloseTo(40, 1);
    expect(grew(before.hud.left, grown.hud.left)).toBeCloseTo(24, 1);
    expect(grew(before.hud.bottom, grown.hud.bottom)).toBeCloseTo(0, 1);
    expect(grew(before.aim.bottom, grown.aim.bottom)).toBeCloseTo(34, 1);
    expect(grew(before.aim.left, grown.aim.left)).toBeCloseTo(24, 1);
    expect(grew(before.aim.top, grown.aim.top)).toBeCloseTo(0, 1);
    // And a control is no longer under the notch: the whole HUD content is
    // below the inset it was given.
    const clearance = await page.evaluate(() => {
      const pause = document.querySelector('[data-pf="pause"]');
      const hud = document.querySelector('[data-pf="hud"]');
      if (!(pause instanceof HTMLElement) || !(hud instanceof HTMLElement)) {
        throw new Error('the HUD is not mounted');
      }
      return pause.getBoundingClientRect().top - hud.getBoundingClientRect().top;
    });
    expect(clearance).toBeGreaterThanOrEqual(40);
  });

  test('carries the insets into the overlays as well as the bars', async ({ page }) => {
    await page.goto('/');
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    const measured = await page.evaluate(() => {
      const panel = document.querySelector('[data-pf="panel-mode"]');
      if (!(panel instanceof HTMLElement)) {
        throw new Error('the mode menu is not mounted');
      }
      const before = window.getComputedStyle(panel).paddingTop;
      document.body.style.setProperty('--pf-safe-top', '40px');
      const after = window.getComputedStyle(panel).paddingTop;
      return { before, after };
    });
    expect(Number.parseFloat(measured.after) - Number.parseFloat(measured.before)).toBeCloseTo(
      40,
      1,
    );
  });
});
