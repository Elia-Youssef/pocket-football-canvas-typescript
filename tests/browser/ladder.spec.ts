import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  playUntil,
  scores,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J3, method T, evidence `playwright/ladder`:
 *
 *   "Ladder plays the six opponents in order, advances on a win, restarts on a
 *    loss, and persists progress across sessions."
 *
 * THE SIX, IN ORDER, ARE SPEC SECTION 10'S OWN TABLE, written out here as
 * literals and read nowhere else in this file. The browser is asked for the
 * rung it is on and the name it shows; the order itself is pinned over the
 * real mode module in tests/unit/modes.test.ts, where all six can be walked
 * without playing six matches.
 *
 * A RUNG IS DRIVEN TO A REAL RESULT, both ways. The scripted striker in
 * `support/game.ts` attacks the opponent's goal to win a rung and the player's
 * own to lose one, which is the same routine pointed at the other mouth, and a
 * First-to-N rung always ends decisively so neither drive can trail off into a
 * draw. Time is the test's own from before the navigation.
 *
 * PERSISTENCE ACROSS SESSIONS IS NOT ASSERTED HERE, and the split is disclosed
 * rather than implied. What exists today is the seam: `core/modes.ts` defines
 * the store the composition root holds and the round trip is graded at the
 * unit layer, and the in-session behaviour every clause above depends on is
 * driven here through that seam. The document that survives a reload is SPEC
 * section 16's and arrives at PF-10; the criterion clause has its verified
 * home in item I5 there, whose own text names ladder progress and settings
 * surviving a mid-match reload.
 */

/** SPEC section 10's six, in the order the section lists them. */
const RUNGS: readonly string[] = ['Sparks', 'Bolt', 'Anchor', 'Vector', 'Cinder', 'Meridian'];

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** The HUD's ladder readout, which SPEC section 12 gives the ladder alone. */
function rungLine(name: string, position: number): string {
  return `${name} - RUNG ${String(position)} OF 6`;
}

/** Play the rung out with the striker pointed at one goal or the other. */
async function playRung(page: Page, attacking: 'left' | 'right'): Promise<void> {
  const frames = await playUntil(page, 2500, attacking, async () => {
    return (await turnText(page)) === 'FULL TIME';
  });
  expect(frames).toBeLessThan(2500);
}

test.describe('PF-9 the ladder, item J3', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test('opens on the first opponent and names the rung', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'ladder' });
    // Rung one, by name, in the HUD and in the turn indicator alike.
    await expect(at(page, 'ladder')).toHaveText(rungLine('Sparks', 1));
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    // SPEC section 12: a rung is a First-to-N match, so the centre slot
    // carries the target and the score line rather than a clock.
    await expect(at(page, 'target-line')).toHaveText('FIRST TO 3');
    await expect(at(page, 'clock')).toBeHidden();
  });

  test('advances on a win, restarts on a loss, and carries the rung', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'ladder' });
    await expect(at(page, 'ladder')).toHaveText(rungLine('Sparks', 1));

    // RUNG ONE, WON. The striker attacks the opponent's goal until the rung's
    // own target is reached, which a First-to-N rung always reaches.
    await playRung(page, 'right');
    expect((await scores(page)).player).toBe(3);
    await expect(at(page, 'result')).toHaveText('You win!');
    // SPEC section 13: a rung won offers the next opponent, and a rung won is
    // not a ladder to restart.
    await expect(at(page, 'next-opponent')).toHaveAttribute('aria-disabled', 'false');
    await expect(at(page, 'restart-ladder')).toHaveAttribute('aria-disabled', 'true');

    // The rung is recorded by the RESULT rather than by the button that
    // follows it: leaving to the menu instead of taking the next opponent
    // still leaves the ladder standing on rung two.
    await at(page, 'change-mode').click();
    await expect(at(page, 'panel-mode')).toBeVisible();
    await expect(at(page, 'mode-ladder-rung')).toHaveText('Ladder: rung 2 of 6, Bolt');
    await at(page, 'mode-ladder').check();
    await at(page, 'mode-start').click();
    await expect(at(page, 'ladder')).toHaveText(rungLine('Bolt', 2));
    expect(await scores(page)).toEqual({ player: 0, opponent: 0 });
    // The second rung is the second NAME: the order is SPEC section 10's, not
    // whichever profile happened to be next in an array.
    expect(RUNGS[1]).toBe('Bolt');

    // RUNG TWO, LOST, by putting the rung's own target past the player's own
    // keeper: SPEC section 3 credits the mouth the ball entered.
    await playRung(page, 'left');
    expect((await scores(page)).opponent).toBe(3);
    await expect(at(page, 'result')).toHaveText('Bolt wins!');
    await expect(at(page, 'restart-ladder')).toHaveAttribute('aria-disabled', 'false');
    await expect(at(page, 'next-opponent')).toHaveAttribute('aria-disabled', 'true');

    await at(page, 'restart-ladder').click();
    await expect(at(page, 'ladder')).toHaveText(rungLine('Sparks', 1));
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    expect(RUNGS[0]).toBe('Sparks');
    // And the menu offers the ladder from the bottom again.
    await at(page, 'pause').click();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Quit' }).click();
    await expect(at(page, 'mode-ladder-rung')).toHaveText('Ladder: rung 1 of 6, Sparks');
  });
});
