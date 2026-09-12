import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  chooseMode,
  leaveToMenu,
  pauseClock,
  playUntil,
  scores,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J1, method T, evidence `playwright/quick-match`:
 *
 *   "Quick Match supports 60, 90 and 120 second durations, stops all movement
 *    at zero, and resolves the higher score as the winner and equal scores as
 *    a draw."
 *
 * TIME IS THE TEST'S OWN. `page.clock.install()` before the navigation makes
 * every timestamp the page reads the test's, so a whole two minute match is a
 * few hundred driven frames rather than two minutes of waiting. Each frame is
 * exactly QUALITY-BAR section 7's quarter-second ceiling, which is the one
 * frame length at which the simulation consumes all of a delta and the match
 * clock charges all of it, so the two cannot disagree about when zero is.
 *
 * THE DRAW IS DRIVEN, NOT ARRANGED. A match where the player never launches
 * ends level by construction: the match sits in the player's turn, so the
 * opponent never gets one either and neither side can score. That is the case
 * a winner-takes-higher implementation gets wrong, and it is the one this file
 * drives first.
 *
 * THE WINNER IS DERIVED FROM THE SCOREBOARD THE PANEL ITSELF SHOWS, under SPEC
 * section 13's rule written out here from the document. A timed match against
 * a live opponent cannot be made to end at a chosen scoreline without
 * arranging its physics, so what is asserted is the implication: whatever the
 * two scores are, the result string is the one the section says they produce.
 * The two decisive strings are each driven exactly, in a mode that CAN be made
 * to end at a chosen scoreline, in tests/browser/game-over.spec.ts.
 */

/** SPEC section 12's MM:SS face, for the three durations SPEC section 9 offers. */
const CLOCK_FACES: readonly (readonly [number, string])[] = [
  [60, '01:00'],
  [90, '01:30'],
  [120, '02:00'],
];

/** SPEC section 13's rule, written from the document and from nothing else. */
function resultFor(player: number, opponent: number, name: string): string {
  if (player > opponent) {
    return 'You win!';
  }
  if (opponent > player) {
    return `${name} wins!`;
  }
  return 'Draw!';
}

async function at(page: Page, marker: string): Promise<string> {
  return (await page.locator(`[data-pf="${marker}"]`).textContent()) ?? '';
}

test.describe('PF-9 Quick Match, item J1', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test('supports 60, 90 and 120 second durations', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    // The menu offers exactly three, and each one is the clock the match
    // starts on, ceiling-rounded as SPEC section 12 states it.
    for (const [duration, face] of CLOCK_FACES) {
      await leaveToMenu(page);
      await chooseMode(page, { mode: 'quick', duration });
      await page.locator('[data-pf="mode-start"]').click();
      await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
      await expect(page.locator('[data-pf="clock"]')).toHaveText(face, SETTLE);
      await expect(page.locator('[data-pf="clock"]')).toBeVisible();
    }
    // And no fourth: the durations are a closed set.
    await leaveToMenu(page);
    for (const duration of [30, 45, 180]) {
      await expect(page.locator(`[data-pf="duration-${String(duration)}"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-pf="panel-mode"] input[name="pf-duration"]')).toHaveCount(
      CLOCK_FACES.length,
    );
  });

  test('stops all movement at zero, with a shot still in flight', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    // AND STOPPED: the clock face below is driven to a reading, and a page
    // clock that keeps ticking drives it past one.
    await pauseClock(page);

    // DOWN TO THE LAST SECOND, then a full-strength shot, so the whistle lands
    // on a moving pitch rather than a still one. The clock is driven to a
    // READING rather than to a frame count, because the page's own animation
    // frames are not a currency a test can count on.
    //
    // THE LAST SECOND AND NOT THE LAST THREE, and the difference is what a
    // stopped clock makes measurable. A launch is spent within about a second
    // and a half of driven time: launched at 00:03 the whole shot is over
    // before zero, and this test's own name would be describing a still pitch.
    // A ceiling face of 00:01 means between three quarters of a second and a
    // second of match is left, so the launched circle is still travelling when
    // the whistle goes, and the freeze below is a freeze.
    let face = '';
    for (let frame = 0; frame < 300 && face !== '00:01'; frame += 1) {
      await advance(page, 1);
      face = (await page.locator('[data-pf="clock"]').textContent()) ?? '';
    }
    expect(face).toBe('00:01');
    await page.locator('[data-pf="aim-angle"]').fill('0');
    await page.locator('[data-pf="power"]').fill('100');
    await page.locator('[data-pf="aim-launch"]').click();

    // The positive control: the launched circle really was moving in the frames
    // before the whistle, so "nothing moved" afterwards is a statement about
    // the whistle and not about a scene that was already at rest. Half a second
    // of driven time, which cannot reach zero from a face of 00:01.
    await advance(page, 1);
    const moving = await centres(page);
    await advance(page, 1);
    const later = await centres(page);
    expect(later.player.x).not.toBeCloseTo(moving.player.x, 3);

    // THE WHISTLE IS DRIVEN TO BY STATE, not by a count of frames, and with the
    // clock stopped it has to be: a ceiling clock reads 00:01 for anything from
    // three quarters of a second to a second, so a fixed count of driven frames
    // either stops short of zero or runs past the shot. Every frame here is one
    // this test charged, so the drive is exact and the bound is a starvation
    // budget.
    let toWhistle = 0;
    let whistled = false;
    for (; toWhistle < 20 && !whistled; toWhistle += 1) {
      await advance(page, 1);
      whistled = (await turnText(page)) === 'FULL TIME';
    }
    expect(whistled).toBe(true);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('FULL TIME', SETTLE);
    // AND THE SHOT WAS STILL IN FLIGHT WHEN ZERO ARRIVED, which is the clause
    // this test's name carries. It is asserted as the DISTANCE from the frame
    // the launched circle was measured moving in, not as a difference across
    // the whistle itself: the frame zero lands on steps nothing, which is what
    // "stops all movement at zero" means, so the scene at zero IS the scene of
    // the frame before it and comparing the two proves nothing either way. Half
    // a second of driven time after a measured motion, against a launch that
    // takes about a second and a half to spend, is a shot in flight.
    expect(toWhistle).toBeLessThanOrEqual(2);
    // Every body, frozen, over sixty further frames of driven time: fifteen
    // seconds of would-be match with nothing to show for it.
    const atZero = await centres(page);
    await advance(page, 60);
    expect(await centres(page)).toEqual(atZero);
    await expect(page.locator('[data-pf="clock"]')).toHaveText('00:00', SETTLE);
  });

  test('resolves equal scores as a draw', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    // AND STOPPED, so the 260 frames below are the whole of the match.
    await pauseClock(page);
    // Nobody launches, so the match sits in the player's turn and neither side
    // can score. Sixty seconds is 240 frames; twenty more prove the whistle
    // has gone rather than that the drive ran out.
    await advance(page, 260);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('FULL TIME', SETTLE);
    const board = await scores(page);
    expect(board).toEqual({ player: 0, opponent: 0 });
    await expect(page.locator('[data-pf="result"]')).toHaveText('Draw!');
    await expect(page.locator('[data-pf="final-score"]')).toHaveText('0 : 0');
  });

  test('resolves the higher score as the winner', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 120 });
    // AND STOPPED. This test read the scene between two driven frames and a
    // goal reset erased it once; with the clock stopped the only match that
    // happens between two readings is the match this drive charged.
    await pauseClock(page);
    // A whole two minute match, played out by the scripted striker.
    const frames = await playUntil(page, 520, 'right', async () => {
      return (await turnText(page)) === 'FULL TIME';
    });
    expect(frames).toBeLessThan(520);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('FULL TIME', SETTLE);

    const board = await scores(page);
    const name = 'Opponent';
    // THE IMPLICATION, both halves: the panel's result is the one SPEC section
    // 13's rule produces from the panel's own two scores, and the score line
    // shows both of them.
    expect(await at(page, 'result')).toBe(resultFor(board.player, board.opponent, name));
    expect(await at(page, 'final-score')).toBe(
      `${String(board.player)} : ${String(board.opponent)}`,
    );
    // Non-vacuous: the match was PLAYED rather than sat out, on either of the
    // two witnesses a played match can leave. A displaced scene is one - the
    // player away from its kickoff spot, or the ball away from the centre.
    // But SPEC section 6.4 returns both circles and the ball to their
    // starting positions after a goal, so a whistle falling shortly after one
    // leaves the scene AT kickoff with the match played and the scoreboard
    // proving it; the guard reads the one quantity a goal erases. A non-zero
    // scoreboard is the witness the reset cannot touch. Both absent is a
    // genuinely vacuous run and still fails.
    const scene = await centres(page);
    const displaced =
      Math.abs(scene.player.x - 300) + Math.abs(scene.ball.x - 640) > 50;
    expect(board.player + board.opponent > 0 || displaced).toBe(true);
    await expect(page.locator('[data-pf="clock"]')).toHaveText('00:00', SETTLE);
  });
});
