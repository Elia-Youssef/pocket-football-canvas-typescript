import { expect, test } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  chooseMode,
  leaveToMenu,
  playUntil,
  scores,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J2, method T, evidence `playwright/first-to-n`:
 *
 *   "First to N supports targets of 3, 5 and 7, has no clock, and ends
 *    immediately when a side reaches the target."
 *
 * "NO CLOCK" IS ASSERTED AS A NEGATIVE AND AS A POSITIVE. The clock face is
 * absent from the HUD, which is what SPEC section 12 asks for; and a match
 * driven for longer than the longest Quick Match without either side reaching
 * the target is still running, which is what "no clock" MEANS. The second is
 * the one an implementation with a hidden clock would fail.
 *
 * "IMMEDIATELY" IS ASSERTED AS A SCORELINE, not as a stopwatch. SPEC section
 * 6.4 runs the celebration hold before the match is over, so the honest
 * reading of immediately is that the target goal is the last one: the match
 * ends on it, the scoreboard stops at the target exactly, and no further turn
 * is handed out. All three are checked below.
 *
 * The target is reached by the scripted striker in `support/game.ts`, whose
 * aim is a second reading of SPEC section 8.1 and imports nothing from the
 * game. Time is the test's own from before the navigation, so a match that
 * takes minutes of game time is seconds of wall clock.
 */

const TARGETS: readonly number[] = [3, 5, 7];

test.describe('PF-9 First to N, item J2', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test('supports targets of 3, 5 and 7', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'first-to', target: 3 });
    for (const target of TARGETS) {
      await leaveToMenu(page);
      await chooseMode(page, { mode: 'first-to', target });
      await page.locator('[data-pf="mode-start"]').click();
      await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
      // SPEC section 12: the centre slot carries the goal target and the score
      // line, and the clock face is not there at all.
      await expect(page.locator('[data-pf="target-line"]')).toHaveText(
        `FIRST TO ${String(target)}`,
      );
      await expect(page.locator('[data-pf="target-line"]')).toBeVisible();
      await expect(page.locator('[data-pf="centre-score"]')).toHaveText('0 : 0');
      await expect(page.locator('[data-pf="clock"]')).toBeHidden();
    }
    // And no fourth: the targets are a closed set.
    await leaveToMenu(page);
    await expect(page.locator('[data-pf="panel-mode"] input[name="pf-target"]')).toHaveCount(
      TARGETS.length,
    );
  });

  test('has no clock, over longer than the longest match that does', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'first-to', target: 7 });
    // Six hundred frames is 150 seconds of match, half again as long as the
    // longest Quick Match, and nobody launches so nobody can reach the target.
    await advance(page, 600);
    expect(await turnText(page)).toBe('YOUR TURN');
    await expect(page.locator('[data-pf="panel-game-over"]')).toBeHidden();
    await expect(page.locator('[data-pf="clock"]')).toBeHidden();
    expect(await scores(page)).toEqual({ player: 0, opponent: 0 });
  });

  test('ends immediately when a side reaches the target', { tag: '@drive' }, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page, { mode: 'first-to', target: 3 });
    // "A SIDE", and the side driven to the target is the opponent's, because
    // that is the one a browser test can settle rather than watch: SPEC
    // section 3 credits the mouth the ball entered, so the scripted striker
    // aimed at the player's own goal puts the target past the opponent's name
    // whatever the opponent itself does, and the opponent is attacking the
    // same mouth anyway. Which side reaches it is not what this clause is
    // about; that it ENDS there is.
    const frames = await playUntil(page, 2000, 'left', async () => {
      return (await turnText(page)) === 'FULL TIME';
    });
    expect(frames).toBeLessThan(2000);

    const board = await scores(page);
    // The target goal is the last one: the scoreboard stops AT three rather
    // than past it, and the side that reached it is the side that won.
    expect(Math.max(board.player, board.opponent)).toBe(3);
    expect(Math.min(board.player, board.opponent)).toBeLessThan(3);
    await expect(page.locator('[data-pf="panel-game-over"]')).toBeVisible();

    // And no further turn is handed out: two hundred more frames of driven
    // time, fifty seconds of would-be match, change nothing at all.
    await advance(page, 200);
    expect(await turnText(page)).toBe('FULL TIME');
    expect(await scores(page)).toEqual(board);
  });
});
