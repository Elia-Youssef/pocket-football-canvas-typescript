import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  playBothSides,
  playUntil,
  scores,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J6, method T, evidence `playwright/game-over`:
 *
 *   "The game over panel shows both scores and the exact result string for a
 *    player win, an opponent win and a draw, with the specified actions
 *    available."
 *
 * ALL THREE RESULTS ARE DRIVEN, and each in the mode that can be made to
 * produce it without arranging any physics. First to 3 played by the scripted
 * striker ends with the player on three; the same drive aimed at the player's
 * OWN goal ends with the opponent on three, because a ball put through the
 * left mouth is credited to the side attacking it (SPEC section 3). A Quick
 * Match nobody launches in ends level, because a match that never leaves the
 * player's turn cannot be scored in by either side.
 *
 * THE STRINGS ARE LITERALS. SPEC section 13 states them exactly, and a test
 * that built the expected string from the same rule the panel uses would pass
 * for whatever the rule became.
 *
 * THE ACTIONS ARE ASSERTED AS PRESENCE THEN REACHABILITY. All four are in the
 * document at every game over, because QUALITY-BAR section 3 refuses controls
 * in place rather than removing them; which of them are live is the mode's
 * answer, and outside the ladder the two ladder actions are refused.
 */

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/** SPEC section 13's four actions, in the order the panel offers them. */
const ACTIONS: readonly string[] = [
  'play-again',
  'change-mode',
  'next-opponent',
  'restart-ladder',
];

async function expectPanelShape(page: Page, result: string, line: string): Promise<void> {
  await expect(at(page, 'panel-game-over')).toBeVisible();
  await expect(at(page, 'result')).toHaveText(result);
  await expect(at(page, 'final-score')).toHaveText(line);
  // Presence before reachability: every action is in the document.
  for (const action of ACTIONS) {
    await expect(at(page, action)).toHaveCount(1);
  }
  await expect(at(page, 'play-again')).toHaveAttribute('aria-disabled', 'false');
  await expect(at(page, 'change-mode')).toHaveAttribute('aria-disabled', 'false');
  // Outside the ladder there is no next opponent and no ladder to restart.
  await expect(at(page, 'next-opponent')).toHaveAttribute('aria-disabled', 'true');
  await expect(at(page, 'restart-ladder')).toHaveAttribute('aria-disabled', 'true');
}

test.describe('PF-9 the game over panel, item J6', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test('shows a player win exactly', { tag: '@drive' }, async ({ page }) => {
    // DRIVEN IN HOTSEAT, and the reason is that a player win has to be certain
    // rather than earned. Against an opponent that plays its own turns the
    // scoreline is decided by the match, and a criterion that names an exact
    // string cannot be graded on a coin. Hotseat is two humans, so this test
    // drives BOTH of them, and it drives both at the SAME mouth: SPEC section
    // 3 credits the mouth the ball entered, so every goal either of them
    // scores through the right mouth is the player's, and the target is
    // reached by the player with certainty.
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'hotseat', target: 3 });
    const frames = await playBothSides(page, 2000, 'right');
    expect(frames).toBeLessThan(2000);
    const board = await scores(page);
    expect(board.player).toBe(3);
    expect(board.opponent).toBeLessThan(3);
    await expectPanelShape(
      page,
      'You win!',
      `3 : ${String(board.opponent)}`,
    );
  });

  test('shows an opponent win exactly, naming them', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'first-to', target: 3 });
    // The same striker, aimed at the player's own goal: SPEC section 3 credits
    // the mouth the ball entered, so these are the opponent's goals.
    const frames = await playUntil(page, 2000, 'left', async () => {
      return (await turnText(page)) === 'FULL TIME';
    });
    expect(frames).toBeLessThan(2000);
    const board = await scores(page);
    expect(board.opponent).toBe(3);
    expect(board.player).toBeLessThan(3);
    await expectPanelShape(
      page,
      'Opponent wins!',
      `${String(board.player)} : 3`,
    );
  });

  test('shows a draw exactly', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    await advance(page, 260);
    await expect(at(page, 'turn')).toHaveText('FULL TIME', SETTLE);
    await expectPanelShape(page, 'Draw!', '0 : 0');
  });

  test(
    'plays again from the top, five times, without duplicating anything',
    { tag: '@drive' },
    async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    const inventory = async (): Promise<Record<string, number>> =>
      page.evaluate(() => {
        const count: Record<string, number> = {};
        for (const marker of [
          'hud',
          'pause',
          'play-frame',
          'play-surface',
          'aim-controls',
          'panel-mode',
          'panel-pause',
          'panel-settings',
          'panel-how-to-play',
          'panel-game-over',
        ]) {
          count[marker] = document.querySelectorAll(`[data-pf="${marker}"]`).length;
        }
        count['canvas'] = document.querySelectorAll('canvas').length;
        return count;
      });
    const before = await inventory();

    for (let round = 0; round < 5; round += 1) {
      // A shot each time, so the reset has positions and velocities to put
      // back rather than a pitch that never moved.
      await page.locator('[data-pf="aim-angle"]').fill('0');
      await page.locator('[data-pf="power"]').fill('100');
      await page.locator('[data-pf="aim-launch"]').click();
      // Four real frames to get the bodies moving, then ONE jump to the
      // whistle. SPEC section 6.2 is what makes the jump honest: the clock
      // charges what the caller says elapsed, with no ceiling of its own,
      // while the simulation treats a gap past the resume threshold as a
      // resume and steps nothing. So the match ends with the three bodies
      // exactly where the shot left them, mid-flight, which is the state this
      // test wants Play Again to have something to put back.
      //
      // IT IS ALSO WHY THIS TEST STOPPED HANGING. Driving the whole minute
      // frame by frame was 262 round trips a round and 1310 across the five,
      // by a distance the heaviest protocol load in the suite; one of those
      // calls stalled on WebKit inside a mutation sweep and took the run down
      // with it. Thirty round trips cannot.
      await advance(page, 4);
      const moving = await centres(page);
      await page.clock.fastForward(65_000);
      await expect(at(page, 'turn')).toHaveText('FULL TIME', SETTLE);
      // The whistle really did land on a moving pitch: the ball is not on the
      // centre spot it was reset to at the top of this round.
      expect(Math.abs(moving.ball.x - 640) + Math.abs(moving.player.x - 300)).toBeGreaterThan(
        5,
      );
      await at(page, 'play-again').click();
      // SPEC section 13: the clock, both scores, every position and the turn
      // order, back to a fresh match.
      await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
      await expect(at(page, 'clock')).toHaveText('01:00');
      expect(await scores(page)).toEqual({ player: 0, opponent: 0 });
      const kickoff = await centres(page);
      expect(kickoff.player.x).toBeGreaterThan(295);
      expect(kickoff.player.x).toBeLessThan(305);
      expect(kickoff.ball.x).toBeGreaterThan(635);
      expect(kickoff.ball.x).toBeLessThan(645);
    }
    // DESIGN section 8: every node is created once, so five restarts leave the
    // document exactly the shape it started in.
    expect(await inventory()).toEqual(before);
  });
});
