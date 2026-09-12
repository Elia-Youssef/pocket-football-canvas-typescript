import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  pauseClock,
  scores,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J7, method T, evidence `playwright/visibility`:
 *
 *   "Hiding the tab pauses the match clock; restoring it shows the paused
 *    overlay, the clock has not advanced, and one activation resumes with full
 *    state intact."
 *
 * THE CLOCK IS ASSERTED ACROSS THE HIDE, not merely that play resumed. The
 * reading is taken before the tab is hidden and again after it is restored,
 * and the two have to be the same string, with two hundred driven frames of
 * would-be match time in between. A resume that quietly charged the gap would
 * pass a test that only checked the game came back.
 *
 * THE PAGE IS NOT REALLY HIDDEN, AND THAT MAKES THE TEST STRONGER. No engine
 * lets a test hide a tab, so `document.hidden` and `document.visibilityState`
 * are answered as a hidden tab answers them and the platform's own
 * `visibilitychange` event is dispatched: the wiring under test is the
 * listener, the intent it raises and the match's answer to it, and all three
 * are the real ones. A really hidden tab throttles its animation frames to
 * about one a second, so a broken implementation would be handed almost no
 * time to charge; here the frames keep arriving at full rate and the clock
 * still may not move.
 *
 * FULL STATE INTACT is asserted as the scoreboard, every body's position and
 * the state the pause interrupted, all read on both sides of the hide.
 */

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** Answer the visibility API as a hidden tab does, and raise its event. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => value,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test.describe('PF-9 the hidden tab, item J7', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    // AND STOPPED, for both tests in this file: the clause each of them
    // grades is that a hidden tab charges the match nothing, and an installed
    // clock that keeps ticking is exactly the thing that could charge it.
    await pauseClock(page);
  });

  test('pauses the clock, holds it, and resumes on one activation', { tag: '@drive' }, async ({ page }) => {
    // A shot first, so the state the pause interrupts is a real one and there
    // are positions to be intact rather than a pitch at kickoff.
    await at(page, 'aim-angle').fill('0');
    await at(page, 'power').fill('100');
    await at(page, 'aim-launch').click();
    await advance(page, 40);
    // THE POSITIVE CONTROL for the clock itself: it moved while the tab was
    // visible, so a later "it did not move" is about the hide.
    await expect(at(page, 'clock')).not.toHaveText('01:00', SETTLE);
    const turnBefore = await turnText(page);

    await setHidden(page, true);
    await expect(at(page, 'turn')).toHaveText('PAUSED', SETTLE);
    // THE BASELINE IS TAKEN THE MOMENT THE PAUSE LANDS. A reading taken just
    // before the event can be one frame older than the pause, because the page
    // is free to run a frame between the two; the clause is about the HIDDEN
    // period, which starts here.
    const before = {
      clock: await at(page, 'clock').textContent(),
      turn: turnBefore,
      board: await scores(page),
      scene: await centres(page),
    };
    // SPEC section 2.2: the overlay is up the moment the tab goes away, and
    // it is still up when the tab comes back.
    await expect(at(page, 'panel-pause')).toBeVisible();

    // Fifty seconds of would-be match, at full frame rate, while hidden.
    await advance(page, 200);
    expect(await at(page, 'clock').textContent()).toBe(before.clock);

    await setHidden(page, false);
    await expect(at(page, 'panel-pause')).toBeVisible();
    await expect(at(page, 'turn')).toHaveText('PAUSED', SETTLE);
    // THE CLAUSE: the clock has not advanced, across the whole hide.
    expect(await at(page, 'clock').textContent()).toBe(before.clock);
    // Nor has anything else: the scoreboard and every body are where they
    // were when the tab went away.
    expect(await scores(page)).toEqual(before.board);
    expect(await centres(page)).toEqual(before.scene);
    // And a paused match steps nothing, so frames after the restore change
    // nothing either.
    await advance(page, 20);
    expect(await at(page, 'clock').textContent()).toBe(before.clock);
    expect(await centres(page)).toEqual(before.scene);

    // ONE ACTIVATION. The overlay's own Resume, pressed once.
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Resume' }).click();
    await expect(at(page, 'panel-pause')).toBeHidden();
    // The state the pause interrupted came back, not a fresh turn.
    expect(await turnText(page)).toBe(before.turn);
    expect(await scores(page)).toEqual(before.board);
    // And the clock runs again from exactly where it stopped.
    await advance(page, 8);
    expect(await at(page, 'clock').textContent()).not.toBe(before.clock);
  });

  test('takes the whole match back where it left off', { tag: '@drive' }, async ({ page }) => {
    // Hidden in the player's own turn, which is the case a player meets most:
    // a notification arrives while they are lining a shot up.
    await advance(page, 12);
    const clock = await at(page, 'clock').textContent();
    await setHidden(page, true);
    await expect(at(page, 'turn')).toHaveText('PAUSED', SETTLE);
    const held = await at(page, 'clock').textContent();
    await advance(page, 100);
    await setHidden(page, false);
    expect(await at(page, 'clock').textContent()).toBe(held);
    expect(Number(clock?.slice(3))).toBeGreaterThanOrEqual(Number(held?.slice(3)));
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Resume' }).click();
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    // ONE DRIVEN FRAME BEFORE THE ROW IS TOUCHED. The panel syncs the readouts
    // in its own handler, but the aim row is brought in line with the lock once
    // a FRAME, and under a stopped clock the only frames are the ones this test
    // charges. Without it the row is still refused and the aim below would be
    // pressing a control the resume had not yet offered back.
    await advance(page, 1);
    // The turn is still the player's and still aimable, which is the whole of
    // "with full state intact" from where a player stands.
    await at(page, 'aim-angle').fill('0');
    await at(page, 'power').fill('100');
    await at(page, 'aim-launch').click();
    // One driven frame, because the readout follows the simulation and the
    // simulation runs on the frames this test charges.
    await advance(page, 1);
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
  });
});
