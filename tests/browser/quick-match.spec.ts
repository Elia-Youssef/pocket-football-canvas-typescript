import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  chooseMode,
  leaveToMenu,
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

    // Down to the last seconds, then a full-strength shot, so the whistle
    // lands with three bodies moving rather than on a still pitch. The clock
    // is driven to a READING rather than to a frame count, because the page's
    // own animation frames are not a currency a test can count on.
    let face = '';
    for (let frame = 0; frame < 300 && face !== '00:03'; frame += 1) {
      await advance(page, 1);
      face = (await page.locator('[data-pf="clock"]').textContent()) ?? '';
    }
    expect(face).toBe('00:03');
    await page.locator('[data-pf="aim-angle"]').fill('0');
    await page.locator('[data-pf="power"]').fill('100');
    await page.locator('[data-pf="aim-launch"]').click();

    // The positive control: the bodies really were moving in the frames
    // before the whistle, so "nothing moved" afterwards is a statement about
    // the whistle and not about a scene that was already at rest.
    await advance(page, 2);
    const moving = await centres(page);
    await advance(page, 2);
    const later = await centres(page);
    expect(later.ball.x).not.toBeCloseTo(moving.ball.x, 3);

    await advance(page, 6);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('FULL TIME', SETTLE);
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
    // Non-vacuous: the match was PLAYED rather than sat out. The player left
    // its kickoff spot and the ball left the centre, so the scoreboard the
    // implication was checked against is the scoreboard of a real match.
    const scene = await centres(page);
    expect(Math.abs(scene.player.x - 300) + Math.abs(scene.ball.x - 640)).toBeGreaterThan(50);
    await expect(page.locator('[data-pf="clock"]')).toHaveText('00:00', SETTLE);
  });
});
