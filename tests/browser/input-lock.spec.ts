import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  PLAYER_FILL,
  SETTLE,
  advance,
  centres,
  dispatchAim,
  nextFrames,
  pauseClock,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item C8, method T, evidence `playwright/input-lock`:
 *
 *   "Aiming and launching are impossible during the opponent's turn, while
 *    any body is moving, while paused, and at game over."
 *
 * ALL FOUR CONDITIONS ARE HERE, from PF-9. Game over was the one that was
 * not: nothing in the shipped composition could end a match until SPEC section
 * 9's modes gave one a clock, so the clause was graded in
 * tests/unit/launch.test.ts over a match given a one-second clock, and the
 * split was disclosed rather than hidden. The last test below is that clause
 * re-homed: a real Quick Match run to full time over the built bundle, with
 * the unit-layer table left where it is because it walks every state SPEC
 * section 7's chart has and a browser can only be driven into some of them.
 *
 * PRESENCE BEFORE REACHABILITY. Every test asserts the play surface is in the
 * document in the phase it is testing, because a refusal and a removed
 * element look identical to a test that only looks the surface up.
 *
 * EVERY REFUSAL CARRIES A POSITIVE CONTROL. The same gesture is driven first
 * in the player's own turn and has to begin an aim there. Without it, "the
 * phase stayed idle" would be satisfied by a build whose surface ignores
 * every pointer, which is a defect and not a lock.
 *
 * TWO WAYS OF PRESSING, EACH WHERE IT IS THE HONEST ONE. Where the world is
 * still and nothing covers the surface, the press is a real mouse press
 * through the browser's own hit testing. Where the target is moving, or where
 * the pause overlay covers the pitch by design, the press is a pointer event
 * dispatched at the surface with the coordinates of the circle read in the
 * same task: that removes a race the test would otherwise lose, and it
 * reaches the same listener, so the lock is still what refuses.
 */

/**
 * THE BUDGETS, THE DESIGN SPACE AND THE FILL COME FROM `support/game.ts`. Every
 * one of them used to be retyped here, and a SPEC section 18 fill that lives in
 * two places is a fill this file goes on scanning for after the palette has
 * moved. `SETTLE` and `A_WHOLE_TEST` there are starvation budgets rather than
 * correctness ones, for the reason this file most needs them: a test here reads
 * the whole canvas back and drives real shots to rest, and the mutation harness
 * runs this suite with a build going beside it.
 */

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

async function surfaceBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
}

function clientOf(box: Box, designX: number, designY: number): { x: number; y: number } {
  return {
    x: box.left + (designX * box.width) / LOGICAL_WIDTH,
    y: box.top + ((LOGICAL_HEIGHT - designY) * box.height) / LOGICAL_HEIGHT,
  };
}

/**
 * THE PIXEL SCAN IS THE SHARED ONE, TWICE OVER. This file used to carry the
 * same twenty-eight line scan in two places, once to find the circle to press
 * on and once inside the dispatched attempt, with the design space, the
 * exclusion band and the tolerance retyped in both. `centres` answers the
 * first and `dispatchAim` the second, both from `support/game.ts`, so a change
 * to any of those numbers is one change.
 */

/** The same gesture as a real mouse press, for the phases that allow one. */
async function mouseAim(
  page: Page,
  box: Box,
  centre: { x: number; y: number },
  units: number,
): Promise<void> {
  const from = clientOf(box, centre.x, centre.y);
  const to = clientOf(box, centre.x + units, centre.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
}

test.describe('PF-5 the input lock, item C8', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('refuses aiming while any body is moving', { tag: '@drive' }, async ({ page }) => {
    // Drive this run from a clock installed before its navigation.  Waiting on
    // real frames here can let a busy runner consume the Quick Match clock
    // before the launched body settles, which turns this into a full-time
    // assertion instead of an input-lock assertion.
    await page.clock.install({ time: 0 });
    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    // AND STOPPED. An installed clock is not a stopped one: it ticks with real
    // time and keeps firing frames, which is the whole of the race the comment
    // above describes as handled and was not.
    await pauseClock(page);
    await advance(page, 4);

    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');

    // The positive control, in the turn that allows an aim: the same press
    // begins one, and a release under the minimum cancels it without a shot.
    const box = await surfaceBox(page);
    const start = (await centres(page)).player;
    await mouseAim(page, box, start, 20);
    await expect(surface).toHaveAttribute('data-pf-aim', 'below-minimum');
    await page.mouse.up();
    await expect(turn).toHaveText('YOUR TURN', SETTLE);

    // A real shot, and then the attempt while it is still running.
    await mouseAim(page, box, start, 40);
    await page.mouse.up();
    // ONE FRAME, because the readout follows the SIMULATION and the simulation
    // only runs on the frames this test drives. A quarter of a second is far
    // inside the flight of a shot this size, which the drive below then plays
    // out one frame at a time.
    await advance(page, 1);
    await expect(turn).toHaveText('IN PLAY', SETTLE);
    await expect(surface).toHaveCount(1);

    const refused = await dispatchAim(page, 100, 'pointerup', PLAYER_FILL);
    expect(Number.isFinite(refused.pressedAt.x)).toBe(true);
    expect(refused.afterDown).toBe('idle');
    expect(refused.afterMove).toBe('idle');
    expect(refused.afterEnd).toBe('idle');
    // And the turn ran its own course: the refused press launched nothing.
    let reached = false;
    for (let frame = 0; frame < 200 && !reached; frame += 1) {
      await advance(page, 1);
      reached = (await turnText(page)) === 'OPPONENT IS AIMING';
    }
    expect(reached).toBe(true);
  });

  test("refuses aiming during the opponent's turn", { tag: '@drive' }, async ({ page }) => {
    // THE PAGE'S CLOCK IS THE TEST'S, from before the navigation. From PF-9 the
    // opponent answers its own turn, so that turn lasts SPEC section 8's
    // pre-launch delay and then moves on by itself; the frames are driven by
    // hand to reach it and then stopped, which holds the match in the turn
    // this test is about however loaded the machine is, once the clock is
    // STOPPED: installed alone, it keeps ticking and keeps firing frames.
    await page.clock.install({ time: 0 });
    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await pauseClock(page);
    await advance(page, 4);

    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');
    const box = await surfaceBox(page);
    const start = (await centres(page)).player;

    await mouseAim(page, box, start, 40);
    await page.mouse.up();
    let reached = false;
    for (let frame = 0; frame < 200 && !reached; frame += 1) {
      await advance(page, 1);
      reached = (await turnText(page)) === 'OPPONENT IS AIMING';
    }
    expect(reached).toBe(true);
    await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);
    await expect(surface).toHaveCount(1);

    // THE WHOLE ATTEMPT IN ONE PAGE TASK, from PF-9. The opponent answers its
    // own turn now, so that turn lasts SPEC section 8's pre-launch delay and
    // then moves on by itself; a press and a canvas read taken as separate
    // round trips would be asking about whichever state the machine had
    // reached by then. The dispatched press reaches the same listener a mouse
    // press does, and the readout sampled on either side of it is what says
    // which turn the refusal belongs to.
    const refused = await dispatchAim(page, 100, 'pointerup', PLAYER_FILL);
    expect(Number.isFinite(refused.pressedAt.x)).toBe(true);
    expect(refused.turnBefore).toBe('OPPONENT IS AIMING');
    expect(refused.turnAfter).toBe(refused.turnBefore);
    expect(refused.afterDown).toBe('idle');
    expect(refused.afterMove).toBe('idle');
    expect(refused.afterEnd).toBe('idle');
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
  });

  test('ends an aim already in progress when the match is paused under it', async ({
    page,
  }) => {
    // The hole this closes. The lock at the press and the lock at the release
    // both hold, and between them a match can still leave the player's turn:
    // the pause control is chrome, and a keyboard or a second finger reaches
    // it while the first finger is still down. An aim that survived that
    // would keep drawing, keep taking adjustment against a frozen pitch, and
    // launch on release, which is aiming while paused by any reading.
    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');
    const box = await surfaceBox(page);
    const start = (await centres(page)).player;

    await mouseAim(page, box, start, 120);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');

    // The pause arrives without touching the pointer, which is what a key
    // press or a second finger does. The click is dispatched at the control
    // rather than aimed at it, because the drag holds the pointer capture.
    await page.locator('[data-pf="pause"]').dispatchEvent('click');
    await expect(turn).toHaveText('PAUSED', SETTLE);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');

    // The aim is gone before the release, and the release launches nothing.
    await page.mouse.up();
    await expect(turn).toHaveText('PAUSED', SETTLE);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
  });

  test('refuses aiming while paused', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');
    const pause = page.locator('[data-pf="pause"]');

    // The positive control first, in the turn that allows an aim.
    const allowed = await dispatchAim(page, 100, 'pointercancel', PLAYER_FILL);
    expect(allowed.afterDown).toBe('below-minimum');
    expect(allowed.afterMove).toBe('aiming');
    expect(allowed.afterEnd).toBe('idle');
    await expect(turn).toHaveText('YOUR TURN', SETTLE);

    await expect(pause).toHaveAttribute('aria-disabled', 'false');
    await pause.click();
    await expect(turn).toHaveText('PAUSED', SETTLE);
    await expect(surface).toHaveCount(1);

    const refused = await dispatchAim(page, 100, 'pointerup', PLAYER_FILL);
    expect(refused.afterDown).toBe('idle');
    expect(refused.afterMove).toBe('idle');
    expect(refused.afterEnd).toBe('idle');
    await expect(turn).toHaveText('PAUSED', SETTLE);

    // And resuming gives the aim back, so the refusal was the pause and not
    // a surface that had stopped listening.
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'Resume' }).click();
    await expect(turn).toHaveText('YOUR TURN', SETTLE);
    const again = await dispatchAim(page, 100, 'pointercancel', PLAYER_FILL);
    expect(again.afterMove).toBe('aiming');
  });

  test('refuses aiming at game over', { tag: '@drive' }, async ({ page }) => {
    // The fourth condition, re-homed from the unit layer at PF-9. The clock is
    // the test's own from before the navigation, so a whole 60 second Quick
    // Match is 260 frames of a quarter of a second rather than a minute of
    // waiting; every one of them is exactly QUALITY-BAR section 7's ceiling,
    // so the simulation consumes all of it and the match clock charges all of
    // it. No launch is taken, so the pitch is still at the whistle and the
    // refusal below is graded on a scene that cannot be moving for any other
    // reason.
    await page.clock.install({ time: 0 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    // AND STOPPED: the whole minute below is the 260 frames this test drives,
    // so the whistle lands where the test put it.
    await pauseClock(page);

    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');

    // The positive control first, in the turn that allows an aim.
    const allowed = await dispatchAim(page, 100, 'pointercancel', PLAYER_FILL);
    expect(allowed.afterMove).toBe('aiming');
    await expect(turn).toHaveText('YOUR TURN', SETTLE);

    await advance(page, 260);
    await expect(turn).toHaveText('FULL TIME', SETTLE);
    await expect(surface).toHaveCount(1);

    const refused = await dispatchAim(page, 100, 'pointerup', PLAYER_FILL);
    expect(refused.turnBefore).toBe('FULL TIME');
    expect(refused.turnAfter).toBe('FULL TIME');
    expect(refused.afterDown).toBe('idle');
    expect(refused.afterMove).toBe('idle');
    expect(refused.afterEnd).toBe('idle');
  });
});
