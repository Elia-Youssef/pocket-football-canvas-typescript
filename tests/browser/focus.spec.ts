import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  pauseClock,
  startMatch,
} from './support/game';

/**
 * Item G9, method T, evidence `playwright/focus`:
 *
 *   "Every overlay traps focus while open and restores focus to its invoking
 *    control on close, and Escape dismisses every dismissible overlay."
 *
 * REAL TAB PRESSES, NEVER element.focus(). `focus()` succeeds on anything a
 * script points it at, including an element the platform would never have
 * reached, so a trap proved with it is a statement about the test rather than
 * about a player. Every walk below is `page.keyboard.press('Tab')` and reads
 * back what the platform actually focused.
 *
 * THE WALK RUNS PAST THE END ON PURPOSE. A trap is a claim about the BOUNDARY:
 * what happens at the last control when Tab is pressed again, and at the first
 * when Shift+Tab is. Walking exactly as many times as a panel has controls
 * proves nothing, so each walk takes the panel's own count plus two, in both
 * directions, and every stop has to still be inside the panel.
 *
 * THE MECHANISM IS NATIVE `inert` AND THE ASSERTION IS NOT ABOUT IT. What is
 * asserted is where focus lands; `tests/unit/focus-trap.test.ts` is what holds
 * the wiring to inerting the right set in the right order, which is the half a
 * Tab walk cannot see.
 *
 * THE THREE DISMISSIBLE OVERLAYS ARE PAUSE, SETTINGS AND HOW TO PLAY. The mode
 * menu has nothing to go back to and SPEC section 13's game-over panel offers
 * four ways back in, so neither is dismissible and neither carries an Escape
 * listener; the criterion's "every dismissible overlay" is exactly those three,
 * and the last test states the other two rather than leaving them unmentioned.
 */

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** Whether focus is inside the named panel right now, and what it is on. */
async function focusInside(page: Page, marker: string): Promise<{ inside: boolean; on: string }> {
  return page.evaluate((name) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return { inside: false, on: 'none' };
    }
    const on =
      active.getAttribute('data-pf') ??
      (active.textContent ?? '').trim() ??
      active.tagName.toLowerCase();
    return {
      inside: active.closest(`[data-pf="${name}"]`) !== null,
      on: on === '' ? active.tagName.toLowerCase() : on,
    };
  }, marker);
}

/** The focusable controls the panel holds, which decides how far to walk. */
async function controlCount(page: Page, marker: string): Promise<number> {
  return page.locator(`[data-pf="${marker}"] button, [data-pf="${marker}"] input`).count();
}

/**
 * Walk `steps` stops in one direction and answer every stop that escaped.
 * Reported rather than asserted, so a failure names where focus went.
 */
async function escapes(page: Page, marker: string, steps: number, back = false): Promise<string[]> {
  const out: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const where = await focusInside(page, marker);
    if (!where.inside) {
      out.push(`${back ? 'Shift+Tab' : 'Tab'} ${String(step + 1)} landed on ${where.on}`);
    }
  }
  return out;
}

/** Both directions, each walked two stops past the panel's own control count. */
async function walkBothWays(page: Page, marker: string): Promise<string[]> {
  const stops = (await controlCount(page, marker)) + 2;
  expect(stops, marker).toBeGreaterThan(2);
  return [...(await escapes(page, marker, stops)), ...(await escapes(page, marker, stops, true))];
}

/** The marker of the control that currently has focus, or what it is instead. */
async function activeMarker(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return 'body';
    }
    return active.getAttribute('data-pf') ?? active.tagName.toLowerCase();
  });
}

test.describe('PF-15 overlays trap and restore focus, item G9', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('traps focus inside the first-launch overlay and the menu beneath it', async ({
    page,
  }) => {
    // SPEC section 19's How to Play opens OVER the menu on a first launch, so
    // the two of them are the one case where an overlay's background is another
    // overlay. The trap has to be around the top one and not merely around
    // something.
    await page.goto('/');
    await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
    expect(await walkBothWays(page, 'panel-how-to-play')).toEqual([]);

    await page
      .locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' })
      .click();
    await expect(at(page, 'panel-how-to-play')).toBeHidden(SETTLE);
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    expect(await walkBothWays(page, 'panel-mode')).toEqual([]);
  });

  test('traps focus inside the pause overlay and inside each panel above it', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3 });
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    expect(await walkBothWays(page, 'panel-pause')).toEqual([]);

    // Settings opens ABOVE the pause overlay, so the panel underneath becomes
    // background: a trap left around the bottom of the stack would let a walk
    // wander into a pause panel nobody is looking at.
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    expect(await walkBothWays(page, 'panel-settings')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(at(page, 'panel-settings')).toBeHidden(SETTLE);

    await page.locator('[data-pf="panel-pause"] button', { hasText: 'How to play' }).click();
    await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
    expect(await walkBothWays(page, 'panel-how-to-play')).toEqual([]);
  });

  test('reaches the whole page when no overlay is open, which is the control', async ({
    page,
  }) => {
    // THE NEGATIVE CONTROL FOR EVERY WALK ABOVE. Each of them asserts that a
    // list of escapes is empty, and a page where Tab moved nothing at all would
    // satisfy all of them. With no overlay open the same walk has to LEAVE the
    // panels: it reaches the HUD, the play surface and the aim row in turn.
    await startMatch(page, { mode: 'first-to', target: 3 });
    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      seen.push(await activeMarker(page));
    }
    expect(seen).toEqual(['pause', 'play-frame', 'aim-left', 'aim-angle']);
    // And with the pause overlay open, the same four presses reach none of
    // them, which is the same walk answering differently.
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    const trapped: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      trapped.push(await activeMarker(page));
    }
    for (const marker of seen) {
      expect(trapped, marker).not.toContain(marker);
    }
    expect(trapped).not.toContain('body');
  });

  test('restores focus to the control that opened each overlay', async ({ page }) => {
    await startMatch(page, { mode: 'first-to', target: 3 });
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);

    // Settings, closed by its own Close button.
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Settings' }).click();
    await expect(at(page, 'panel-settings')).toBeVisible(SETTLE);
    await page.locator('[data-pf="panel-settings"] button', { hasText: 'Close' }).click();
    await expect(at(page, 'panel-settings')).toBeHidden(SETTLE);
    expect(await activeMarker(page)).toBe('pause-settings');

    // How to Play, closed by Escape. The invoker is its own button, which is
    // what keeps Escape reaching the pause overlay still open beneath it.
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'How to play' }).click();
    await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
    await page.keyboard.press('Escape');
    await expect(at(page, 'panel-how-to-play')).toBeHidden(SETTLE);
    expect(await activeMarker(page)).toBe('pause-how-to');

    // And the pause overlay itself hands focus back to the HUD control that
    // raised it, rather than dropping it on the document body.
    await page.keyboard.press('Escape');
    await expect(at(page, 'panel-pause')).toBeHidden(SETTLE);
    expect(await activeMarker(page)).toBe('pause');
  });

  test('dismisses the three dismissible overlays with Escape, and neither of the other two', async ({
    page,
  }) => {
    await startMatch(page, { mode: 'first-to', target: 3 });
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);

    for (const [open, marker] of [
      ['Settings', 'panel-settings'],
      ['How to play', 'panel-how-to-play'],
    ] as const) {
      await page.locator('[data-pf="panel-pause"] button', { hasText: open }).click();
      await expect(at(page, marker)).toBeVisible(SETTLE);
      await page.keyboard.press('Escape');
      await expect(at(page, marker)).toBeHidden(SETTLE);
      // The pause overlay is still there underneath, which is what makes the
      // dismissal a dismissal of the top panel rather than of the stack.
      await expect(at(page, 'panel-pause')).toBeVisible();
    }

    // The third: Escape on the pause overlay resumes the match, because the
    // panel IS the pause and dismissing it and letting the match run on are
    // the same act.
    await page.keyboard.press('Escape');
    await expect(at(page, 'panel-pause')).toBeHidden(SETTLE);
    await expect(at(page, 'turn')).not.toHaveText('PAUSED');

    // AND THE MENU IS NOT DISMISSIBLE. There is nothing behind it to go back
    // to: Escape leaves it exactly where it was.
    await at(page, 'pause').click();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Quit' }).click();
    await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
    await page.keyboard.press('Escape');
    await expect(at(page, 'panel-mode')).toBeVisible();
  });

  test(
    'traps and restores around the game-over panel, which is not dismissible',
    { tag: '@drive' },
    async ({ page }) => {
      // A Quick Match nobody launches in reaches full time level, which is the
      // cheapest honest route to the panel: sixty seconds of match is 240
      // driven frames rather than sixty seconds of waiting.
      await page.clock.install({ time: 0 });
      await startMatch(page, { mode: 'quick', duration: 60 });
      // AND STOPPED: the drive below is made of the frames it charges.
      await pauseClock(page);
      await advance(page, 260);
      await expect(at(page, 'turn')).toHaveText('FULL TIME', SETTLE);
      await expect(at(page, 'panel-game-over')).toBeVisible(SETTLE);

      expect(await walkBothWays(page, 'panel-game-over')).toEqual([]);

      // Not dismissible: SPEC section 13's four actions are the ways back in,
      // so Escape has nothing honest to restore and leaves the panel open.
      await page.keyboard.press('Escape');
      await expect(at(page, 'panel-game-over')).toBeVisible();

      // And Play Again hands focus back to the stable anchor the panel was
      // opened against, because it opened without an invoking control at all.
      await at(page, 'play-again').click();
      await expect(at(page, 'panel-game-over')).toBeHidden(SETTLE);
      expect(await activeMarker(page)).toBe('pause');
    },
  );
});
