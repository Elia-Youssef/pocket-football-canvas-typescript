import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  pauseClock,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J4, method T, evidence `playwright/hotseat`:
 *
 *   "Hotseat alternates two human turns on one device with no AI acting, and
 *    the turn indicator names the side to act."
 *
 * NO ONE ACTS FOR THE SECOND HUMAN, AND THAT IS ASSERTED AS AN ABSENCE OVER
 * TIME. In every other mode the opponent's turn ends by itself after SPEC
 * section 8's pre-launch delay. Here the second turn is driven for two hundred
 * frames of the test's own clock, fifty seconds of would-be match, and it has
 * to still be that human's turn at the end of it: nothing in the shipped
 * composition is answering the seam, because SPEC section 9's Hotseat has no
 * opponent profile for anything to answer it with.
 *
 * BOTH TURNS ARE REALLY TAKEN, through SPEC section 5.0's own controls, and
 * each one is proved by the circle it MOVED. A composition that let the second
 * human aim but launched the first human's circle would pass a test that only
 * watched the turn indicator; the body that left its position is what says
 * which side actually acted.
 *
 * THE INDICATOR NAMES THE SIDE. SPEC section 13 names the winning player in
 * Hotseat, so the two sides have names, and SPEC section 12's indicator uses
 * them in place of the "YOUR TURN" that names neither of two humans.
 */

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** One turn through the no-drag controls: an exact aim, then Launch. */
async function takeTurn(page: Page, degrees: number, percent: number): Promise<void> {
  await at(page, 'aim-angle').fill(String(degrees));
  await at(page, 'power').fill(String(percent));
  await at(page, 'aim-launch').click();
}

/** Drive frames until the turn readout says `wanted`, or the budget runs out. */
async function driveToTurn(page: Page, wanted: string, budget: number): Promise<number> {
  for (let frame = 0; frame < budget; frame += 1) {
    await advance(page, 1);
    if ((await turnText(page)) === wanted) {
      return frame + 1;
    }
  }
  return budget;
}

test.describe('PF-9 Hotseat, item J4', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test('alternates two human turns, with nothing acting for either', { tag: '@drive' }, async ({
    page,
  }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'hotseat', target: 3 });
    // AND STOPPED: the two hundred frames of absence below are two hundred
    // frames this test charged, which is what makes "nobody acted" a claim
    // about the build rather than about how much match the machine ran.
    await pauseClock(page);

    // The indicator names the side to act, and it is a person's name.
    await expect(at(page, 'turn')).toHaveText('PLAYER 1 IS AIMING', SETTLE);
    await expect(at(page, 'clock')).toBeHidden();
    await expect(at(page, 'target-line')).toHaveText('FIRST TO 3');

    // Player one takes a turn: straight down the pitch at full strength.
    const kickoff = await centres(page);
    await takeTurn(page, 0, 100);
    const handedOver = await driveToTurn(page, 'PLAYER 2 IS AIMING', 200);
    expect(handedOver).toBeLessThan(200);
    const afterOne = await centres(page);
    // THE FIRST CIRCLE IS THE ONE THAT WAS LAUNCHED, which is the side whose
    // turn it was: a launch carries it most of the way down the pitch, and a
    // build that applied player one's launch to the other circle would leave
    // this one on its kickoff spot. The other circle is deliberately not
    // asserted still: the ball it was struck toward can reach it, and a body
    // moved by the ball is the simulation working rather than a turn taken.
    expect(afterOne.player.x).toBeGreaterThan(kickoff.player.x + 20);

    // NOBODY ACTS FOR PLAYER TWO. Fifty seconds of driven match, and the turn
    // is exactly where it was: no profile, so no shot.
    await advance(page, 200);
    expect(await turnText(page)).toBe('PLAYER 2 IS AIMING');
    expect(await centres(page)).toEqual(afterOne);

    // Player two takes their own turn on the same device, through the same
    // controls, and it is the SECOND circle that moves.
    await takeTurn(page, 180, 100);
    const backAgain = await driveToTurn(page, 'PLAYER 1 IS AIMING', 200);
    expect(backAgain).toBeLessThan(200);
    const afterTwo = await centres(page);
    expect(afterTwo.opponent.x).toBeLessThan(afterOne.opponent.x - 20);
    // And the turn came back to the first human, which is the alternation.
    await expect(at(page, 'turn')).toHaveText('PLAYER 1 IS AIMING', SETTLE);
  });

  test('names the second human in the result, and never an opponent', { tag: '@drive' }, async ({
    page,
  }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'hotseat', target: 3 });
    // AND STOPPED, so the drive below is made of its own frames.
    await pauseClock(page);
    // Both names are the humans', so nothing in this mode reads as a machine.
    await expect(at(page, 'turn')).toHaveText('PLAYER 1 IS AIMING', SETTLE);
    await takeTurn(page, 0, 100);
    await driveToTurn(page, 'PLAYER 2 IS AIMING', 200);
    await expect(at(page, 'turn')).toHaveText('PLAYER 2 IS AIMING');
    // The ladder readout belongs to the ladder alone, and this is not it.
    await expect(at(page, 'ladder')).toHaveText('');
  });
});
