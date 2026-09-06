import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, centres, nextFrames, startMatch } from './support/game';

/**
 * Item F6, method T, evidence `playwright/surface-scale`:
 *
 *   "The play-surface size setting offers 100, 125, 150 and 200 percent,
 *    raises the logical-to-CSS scale by that factor, persists, and leaves the
 *    logical space unchanged so the 30 px and 180 px drag constants still mean
 *    the same thing. Browser zoom alone does not magnify canvas content, so
 *    this is the only magnification path the pitch has."
 *
 * THE SECOND HALF IS THE ONE A SCALE IMPLEMENTATION GETS WRONG. Raising the
 * scale is easy; leaving the logical space alone while doing it is the part
 * that fails silently, because everything still LOOKS right and every drag has
 * quietly changed what it is worth. So the test below drags the same DESIGN
 * distance at two settings and requires the same strength, and drags the same
 * CSS distance at two settings and requires a different one. The first is the
 * criterion; the second is the control that proves the first was measuring
 * anything at all.
 *
 * THE CONSTANTS ARE PINNED BY LITERAL. SPEC section 6.1 puts the minimum drag
 * at 30 design units and the maximum at 180, and the strengths those two
 * produce are 0 and 100 percent. Those numbers are written out here rather
 * than imported, because a test driven by the symbol that defines the bound
 * passes for whatever value the symbol takes.
 */

/** SPEC section 3's design space, which is what the setting does NOT change. */
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

/** SPEC section 6.1's two drag bounds, in design units, and their strengths. */
const MIN_DRAG = 30;
const MAX_DRAG = 180;
const HALF_DRAG = 105;

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

async function surfaceRect(page: Page): Promise<Rect> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
}

/** Open Settings from the pause overlay, choose a size, and go back to play. */
async function chooseSize(page: Page, percent: number): Promise<void> {
  await at(page, 'pause').click();
  await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
  await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
  await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
  await at(page, `surface-scale-${String(percent)}`).check();
  await at(page, 'settings-close').click();
  await expect(at(page, 'panel-settings')).toBeHidden(SETTLE);
  await page.locator('[data-pf="panel-pause"] button', { hasText: 'Resume' }).click();
  await expect(at(page, 'panel-pause')).toBeHidden(SETTLE);
}

/** The strength the aim controls are showing, which is SPEC section 6.1's scale. */
async function power(page: Page): Promise<number> {
  return Number(await at(page, 'power').inputValue());
}

/**
 * Drag from the player's circle by `cssAcross` css pixels and answer the
 * strength that produced, then take the drag back to nothing and release, so
 * the turn is exactly where it was before.
 */
async function dragBy(page: Page, cssAcross: number): Promise<number> {
  const scene = await centres(page);
  const rect = await surfaceRect(page);
  const fromX = rect.left + (scene.player.x * rect.width) / LOGICAL_WIDTH;
  const fromY = rect.top + ((LOGICAL_HEIGHT - scene.player.y) * rect.height) / LOGICAL_HEIGHT;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + cssAcross, fromY, { steps: 4 });
  // The controls are a VIEW of the aim, written once a frame from the preview,
  // so the reading is taken after the frame that carries it.
  await nextFrames(page, 2);
  const reading = await power(page);
  // Back to no drag at all, which is below the minimum and therefore a
  // cancelled aim rather than a launch.
  await page.mouse.move(fromX, fromY, { steps: 2 });
  await page.mouse.up();
  return reading;
}

test.describe('PF-14 the play-surface size setting, item F6', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('offers exactly 100, 125, 150 and 200 percent', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    const group = page.locator('[data-pf="panel-settings"] input[name="pf-surface-scale"]');
    await expect(group).toHaveCount(4);
    expect(await group.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))))
      .toEqual(['100%', '125%', '150%', '200%']);
    // A new player is at 100, which is the value the stored settings default to.
    await expect(at(page, 'surface-scale-100')).toBeChecked();
  });

  test('raises the css box by exactly the factor it names', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const base = await surfaceRect(page);
    // The reference layout fits the pitch across the whole width here, so the
    // base is a real measurement and not a floor.
    expect(base.width).toBeGreaterThan(600);
    for (const percent of [125, 150, 200]) {
      await chooseSize(page, percent);
      const grown = await surfaceRect(page);
      const label = `${String(percent)} percent`;
      expect(grown.width, label).toBeCloseTo((base.width * percent) / 100, 1);
      expect(grown.height, label).toBeCloseTo((base.height * percent) / 100, 1);
      // The shape is untouched: this is a magnification and never a stretch.
      expect(grown.width / grown.height, label).toBeCloseTo(LOGICAL_WIDTH / LOGICAL_HEIGHT, 2);
    }
    // And back down again, exactly.
    await chooseSize(page, 100);
    expect((await surfaceRect(page)).width).toBeCloseTo(base.width, 1);
  });

  test('leaves the logical space alone, so the drag constants mean what they meant', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);

    const design = async (units: number): Promise<number> => {
      const rect = await surfaceRect(page);
      return dragBy(page, (units * rect.width) / LOGICAL_WIDTH);
    };

    // At 100 percent: SPEC section 6.1's two bounds and the midpoint between
    // them, pinned by literal.
    expect(await design(MIN_DRAG)).toBe(0);
    expect(await design(MAX_DRAG)).toBe(100);
    const halfAtOne = await design(HALF_DRAG);
    expect(halfAtOne).toBeGreaterThanOrEqual(49);
    expect(halfAtOne).toBeLessThanOrEqual(51);

    // The same drags in DESIGN units at 200 percent are worth exactly the
    // same, which is the criterion: the logical space did not change.
    const cssForHalfAtOne = await surfaceRect(page).then(
      (rect) => (HALF_DRAG * rect.width) / LOGICAL_WIDTH,
    );
    await chooseSize(page, 200);
    expect(await design(MIN_DRAG)).toBe(0);
    expect(await design(MAX_DRAG)).toBe(100);
    expect(await design(HALF_DRAG)).toBe(halfAtOne);

    // THE CONTROL. The same CSS distance is worth LESS at 200 percent,
    // because one design unit is now two css pixels. Without this the test
    // above would pass against a build that changed nothing at all.
    const halfInCssAtTwo = await dragBy(page, cssForHalfAtOne);
    expect(halfInCssAtTwo).toBeLessThan(halfAtOne);
    // And it is the magnification that did it: half the design distance.
    expect(halfInCssAtTwo).toBeCloseTo(
      Math.round(((HALF_DRAG / 2 - MIN_DRAG) / (MAX_DRAG - MIN_DRAG)) * 100),
      0,
    );
  });

  test('persists across a reload and comes back at the size it was left', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const base = await surfaceRect(page);
    await chooseSize(page, 150);
    expect((await surfaceRect(page)).width).toBeCloseTo((base.width * 150) / 100, 1);

    await page.reload();
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
    expect((await surfaceRect(page)).width).toBeCloseTo((base.width * 150) / 100, 1);
    // And the control opens on the stored value rather than on the default.
    await at(page, 'pause').click();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    await expect(at(page, 'surface-scale-150')).toBeChecked();
    await expect(at(page, 'surface-scale-100')).not.toBeChecked();
  });

  test('goes back to 100 percent when the data is reset', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const base = await surfaceRect(page);
    await chooseSize(page, 200);
    expect((await surfaceRect(page)).width).toBeCloseTo(base.width * 2, 1);

    await at(page, 'pause').click();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    await at(page, 'reset-data').click();
    await at(page, 'reset-confirm').click();
    // The pitch is back at its fitted size before the panel is even closed:
    // SPEC section 17's reset is what the size goes back to, not a reload.
    expect((await surfaceRect(page)).width).toBeCloseTo(base.width, 1);
    await expect(at(page, 'surface-scale-100')).toBeChecked();
  });
});
