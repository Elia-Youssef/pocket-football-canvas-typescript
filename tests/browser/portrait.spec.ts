import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, startMatch, turnText } from './support/game';

/**
 * Item F3, method T, evidence `playwright/portrait`:
 *
 *   "The game is fully playable in portrait on a compact viewport via a
 *    letterboxed landscape pitch, with the HUD stacked above and below. No
 *    orientation is blocked, no function requires rotating the device, and a
 *    portrait viewport never pauses the match. The rotate hint is dismissible
 *    and covers no control."
 *
 * THE TRAP IS THE WHOLE ITEM. SPEC section 2.1 rejects the rotate prompt that
 * pauses the match as an SC 1.3.4 failure, so the tests below are written to
 * catch exactly that: a match that keeps its state through the rotation, a
 * launch taken IN portrait, and a hint that is a bar rather than an overlay.
 * "The alternative layout is more work" is a cost argument and not an
 * essentiality one, and none of these would pass a build that took it.
 *
 * COVERS NO CONTROL IS MEASURED, NOT ASSUMED. The hint's own box is compared
 * against the box of every visible control on the screen, so a hint that grew,
 * moved or became an overlay fails here rather than at a player.
 *
 * A DISCLOSED READING OF "WITH THE HUD STACKED ABOVE AND BELOW". SPEC section
 * 12 defines the HUD as the scores, the clock, the turn indicator, the ladder
 * line and the pause control, and all of it is in the bar ABOVE the pitch. What
 * is below is SPEC section 5.0's aim-controls row, which is chrome but is not
 * the HUD. The clause is therefore closed by the reading "the chrome is stacked
 * above and below", which is what the test beneath asserts and what DESIGN
 * section 6's portrait paragraph describes; no HUD readout was moved. The
 * alternative, moving the turn indicator into the bottom bar at this
 * breakpoint, is a one-element change and is offered rather than taken.
 */

/** A compact portrait viewport: a phone held the way phones are held. */
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function breakpointOf(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.dataset['pfBreakpoint'] ?? '');
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(page: Page, marker: string): Promise<Box> {
  const box = await at(page, marker).boundingBox();
  if (box === null) {
    throw new Error(`no box for ${marker}`);
  }
  return box;
}

test.describe('PF-14 portrait is letterboxed, not blocked, item F3', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize(PORTRAIT);
  });

  test('draws the same landscape pitch, scaled to fit and letterboxed', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    expect(await breakpointOf(page)).toBe('portrait');
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
      };
    });
    // THE SAME LANDSCAPE PITCH. Not a vertical one, not a cropped one: the
    // logical space is 1280 by 720 and the drawn box keeps that shape.
    expect(measured.surface.width / measured.surface.height).toBeCloseTo(1280 / 720, 2);
    expect(measured.surface.width).toBeGreaterThan(measured.surface.height);
    // Scaled to FIT: it spans the width it was given and leaves bands in the
    // axis that did not bind, which is what letterboxed means.
    expect(measured.surface.width).toBeLessThanOrEqual(measured.stage.width + 0.5);
    expect(measured.surface.height).toBeLessThan(measured.stage.height);
    expect(measured.surface.width).toBeGreaterThan(measured.stage.width - 2);
  });

  test('stacks the HUD above the pitch and the aim controls below it', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const hud = await boxOf(page, 'hud');
    const surface = await boxOf(page, 'play-surface');
    const aim = await boxOf(page, 'aim-controls');
    expect(hud.y + hud.height).toBeLessThanOrEqual(surface.y + 0.5);
    expect(surface.y + surface.height).toBeLessThanOrEqual(aim.y + 0.5);
    // And both bars are in view without scrolling, because this viewport is
    // well above the height at which they unstick.
    await expect(at(page, 'hud')).toBeInViewport({ ratio: 1 });
    await expect(at(page, 'aim-controls')).toBeInViewport({ ratio: 1 });
  });

  test('never pauses the match for being in portrait, at load or on rotation', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    // Loaded in portrait: a running turn, not a paused match and not a prompt.
    expect(await turnText(page)).not.toBe('PAUSED');
    expect(await turnText(page)).not.toBe('MENU');
    await expect(at(page, 'panel-pause')).toBeHidden();
    // And rotated INTO portrait from landscape, which is the moment a rotate
    // prompt would fire.
    await page.setViewportSize(LANDSCAPE);
    await expect.poll(async () => breakpointOf(page), SETTLE).toBe('medium');
    const beforeRotation = await turnText(page);
    await page.setViewportSize(PORTRAIT);
    await expect.poll(async () => breakpointOf(page), SETTLE).toBe('portrait');
    await expect(at(page, 'panel-pause')).toBeHidden();
    expect(await turnText(page)).toBe(beforeRotation);
  });

  test('takes a launch in portrait, so no function requires rotating', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    expect(await breakpointOf(page)).toBe('portrait');
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    // SPEC section 5.0's no-drag path, driven in portrait: every control is
    // reachable and the launch it produces reaches the match.
    await at(page, 'aim-angle').fill('20');
    await at(page, 'power').fill('80');
    await at(page, 'aim-launch').click();
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
  });

  test('shows a dismissible hint in portrait and nowhere else', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const hint = at(page, 'portrait-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Rotate');
    // It suggests rather than instructs: SPEC section 2.1 refuses to gate play
    // on orientation and the line has to say so.
    await expect(hint).toContainText('plays fully in portrait');
    // Landscape has nothing to suggest, so the hint is not there at all.
    await page.setViewportSize(LANDSCAPE);
    await expect.poll(async () => breakpointOf(page), SETTLE).toBe('medium');
    await expect(hint).toBeHidden();
    await page.setViewportSize(PORTRAIT);
    await expect(hint).toBeVisible();
  });

  test('covers no control, measured against every control on the screen', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const hint = await boxOf(page, 'portrait-hint');
    expect(hint.width).toBeGreaterThan(0);
    expect(hint.height).toBeGreaterThan(0);
    let counted = 0;
    for (const locator of await page.locator('button:visible, input:visible').all()) {
      const box = await locator.boundingBox();
      if (box === null) {
        continue;
      }
      const marker = (await locator.getAttribute('data-pf')) ?? '';
      if (marker === 'hint-dismiss') {
        // The hint's own control is inside it by construction.
        continue;
      }
      counted += 1;
      const shares =
        hint.x + hint.width - 0.5 > box.x &&
        box.x + box.width - 0.5 > hint.x &&
        hint.y + hint.height - 0.5 > box.y &&
        box.y + box.height - 0.5 > hint.y;
      expect(shares, `the hint covers ${marker}`).toBe(false);
    }
    // The sweep is not vacuous: the pause control and the eight aim controls
    // are all on the screen while it runs.
    expect(counted).toBeGreaterThanOrEqual(9);
  });

  test('remembers the dismissal across a reload, and a reset brings it back', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    const hint = at(page, 'portrait-hint');
    await expect(hint).toBeVisible();
    await at(page, 'hint-dismiss').click();
    await expect(hint).toBeHidden();

    // The dismissal outlives the session, which is what SPEC section 2.1 asks
    // of it and what the stored document is for.
    await page.reload();
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await expect(hint).toBeHidden();
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
    await expect(hint).toBeHidden();

    // SPEC section 17's Reset all data clears every persisted value, and the
    // hint is one of them: a player who has erased their data has not
    // dismissed anything.
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    await at(page, 'reset-data').click();
    await at(page, 'reset-confirm').click();
    await at(page, 'settings-close').click();
    await expect(at(page, 'panel-settings')).toBeHidden(SETTLE);
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Resume' }).click();
    await expect(hint).toBeVisible();
  });
});
