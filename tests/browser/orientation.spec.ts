import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { A_WHOLE_TEST, SETTLE, advance, centres, startMatch, turnText } from './support/game';

/**
 * Item F5, method T, evidence `playwright/orientation`:
 *
 *   "An orientation change preserves full match state and does not reload the
 *    page."
 *
 * BOTH HALVES, AND THE SECOND ONE IS THE ONE THAT NEEDS PROVING. State that
 * survives is not the same claim as a page that never went away: a build that
 * reloaded and restored from storage would pass a state comparison and fail
 * this criterion, and it is also the build SPEC section 16 says cannot exist,
 * because nothing about a match in progress is stored. So the absence of the
 * navigation is asserted directly, three ways: a value put on the window
 * survives, no page-hide fires, and the play surface still carries a marker
 * put on the element the mount built.
 *
 * FULL MATCH STATE IS THE WHOLE READOUT AND THE WORLD. The turn, both scores
 * and the clock come from the HUD and are compared exactly, at the rotation
 * and again on the way back. The three bodies come off the canvas, which is a
 * pixel reading rather than a state read, so they are compared either side of
 * the ROUND TRIP and bracketed by what that reading can resolve; the note
 * beside that assertion says how the bracket is arrived at.
 *
 * TIME IS THE TEST'S, AND IT IS PAUSED BEFORE THE FIRST READING. An installed
 * page clock is not a stopped one: it keeps advancing with real time and keeps
 * firing frames (measured at review: 1.5 s of real waiting advanced it 1.5 s
 * and fired 94 frames on Chromium and 50 on WebKit), so on a slow engine the
 * rotation and the settle poll between the two readings can cross a whole
 * second of match clock and move the ball, which is the match doing what a
 * running match does and not the rotation losing anything. `pauseAt` stops
 * both, so with it in force no simulation step runs between the two readings
 * and a difference can only be the rotation's doing. The pause target sits
 * well ahead of the moment it is read, because a target the ticking clock has
 * already passed is refused as the past.
 */

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

interface Readout {
  readonly turn: string;
  readonly player: string;
  readonly opponent: string;
  readonly clock: string;
  readonly breakpoint: string;
}

async function readout(page: Page): Promise<Readout> {
  return {
    turn: await turnText(page),
    player: (await at(page, 'score-player').textContent()) ?? '',
    opponent: (await at(page, 'score-opponent').textContent()) ?? '',
    clock: (await at(page, 'clock').textContent()) ?? '',
    breakpoint: await page.evaluate(
      () => document.documentElement.dataset['pfBreakpoint'] ?? '',
    ),
  };
}

/**
 * Three marks a reload would lose, none of which the game itself writes: a
 * value on the window, a page-hide counter, and an attribute on the play
 * surface. The surface is built by script at mount, so a reload rebuilds it
 * from the served document without the attribute; the window mark and the
 * counter say the same thing about the global and about the unload. Three
 * because they fail for different reasons, and none of them depends on the
 * page's own clock, which these tests install.
 */
async function markSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = window as unknown as Record<string, unknown>;
    held['pfSessionMark'] = 'kept-across-the-rotation';
    held['pfPageHides'] = 0;
    window.addEventListener('pagehide', () => {
      held['pfPageHides'] = Number(held['pfPageHides'] ?? 0) + 1;
    });
    document
      .querySelector('[data-pf="play-surface"]')
      ?.setAttribute('data-pf-session-mark', 'kept-across-the-rotation');
  });
}

async function sessionSurvived(page: Page): Promise<{
  mark: unknown;
  hides: unknown;
  surface: string | null;
}> {
  return page.evaluate(() => {
    const held = window as unknown as Record<string, unknown>;
    return {
      mark: held['pfSessionMark'],
      hides: held['pfPageHides'],
      surface:
        document
          .querySelector('[data-pf="play-surface"]')
          ?.getAttribute('data-pf-session-mark') ?? null,
    };
  });
}

/**
 * The design units one sampling step of `centres` covers on the surface as it
 * stands. The shared reading walks every third pixel of the backing store, so
 * this is the finest difference between two of its answers that means
 * anything; the two literals are its own, not this file's guesses.
 */
async function samplingStep(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    return (3 * 1280) / canvas.width;
  });
}

test.describe('PF-14 an orientation change, item F5', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test(
    'keeps the whole match and never reloads the page',
    { tag: '@drive' },
    async ({ page }) => {
      await page.setViewportSize({ width: 844, height: 500 });
      await page.clock.install({ time: 0 });
      await startMatch(page, { firstEver: true });
      await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);

      // A match with time on it and a world that has been played in, so the
      // comparison below is of something rather than of a kickoff.
      await advance(page, 8);
      await at(page, 'aim-angle').fill('10');
      await at(page, 'power').fill('70');
      await at(page, 'aim-launch').click();
      await advance(page, 12);

      // Freeze time for the comparison. The jump to the pause target fires at
      // most one frame, before anything below is read; from here on nothing
      // ticks until the test ends, so both readings see the same match.
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 2000);

      await markSession(page);
      const before = await readout(page);
      const worldBefore = await centres(page);
      const stepBefore = await samplingStep(page);
      expect(before.breakpoint).toBe('medium');
      // The clock has moved off the whole minute, so "the clock survived" is
      // a statement about a value and not about a constant.
      expect(before.clock).not.toBe('01:00');

      // The rotation. Nothing else happens: no frame is driven, because the
      // page's clock is the test's and it has not been advanced.
      await page.setViewportSize({ width: 500, height: 844 });
      await expect
        .poll(async () => (await readout(page)).breakpoint, SETTLE)
        .toBe('portrait');

      const survived = await sessionSurvived(page);
      // The page did not go away. A reload would clear the mark, fire a
      // page-hide, and rebuild the play surface without the attribute.
      expect(survived.mark).toBe('kept-across-the-rotation');
      expect(survived.hides).toBe(0);
      expect(survived.surface).toBe('kept-across-the-rotation');

      const after = await readout(page);
      expect(after.turn).toBe(before.turn);
      expect(after.player).toBe(before.player);
      expect(after.opponent).toBe(before.opponent);
      expect(after.clock).toBe(before.clock);

      // Back again, because a rotation is not a one-way trip and the return
      // is the same claim.
      await page.setViewportSize({ width: 844, height: 500 });
      await expect
        .poll(async () => (await readout(page)).breakpoint, SETTLE)
        .toBe('medium');
      const returned = await readout(page);
      expect(returned.turn).toBe(before.turn);
      expect(returned.player).toBe(before.player);
      expect(returned.opponent).toBe(before.opponent);
      expect(returned.clock).toBe(before.clock);
      const returnedSession = await sessionSurvived(page);
      expect(returnedSession.mark).toBe('kept-across-the-rotation');
      expect(returnedSession.surface).toBe('kept-across-the-rotation');
      expect(returnedSession.hides).toBe(0);

      // AND THE WORLD ITSELF, BRACKETED BY WHAT THE INSTRUMENT CAN RESOLVE.
      // These centres are read off the canvas by sampling every third pixel of
      // the backing store and taking the midpoint of what matched, so the grid
      // is coarser than a design unit and a surface that is one pixel wider
      // lands it somewhere else: the same still world can answer a few units
      // apart for that reason alone, and the aim readout is a live region
      // whose text can rewrap the bar beneath the pitch and move the fit by a
      // pixel. So the bracket is the instrument's own step, computed from the
      // surface it was measured on rather than guessed, and the coarser of the
      // two is the one that governs. It is worth a few design units against a
      // body radius of 34, and a world an orientation change had actually
      // moved would be tens or hundreds of units away.
      const worldAfter = await centres(page);
      // Bounded by the SUM of the two grids, because each reading is a
      // bounding-box midpoint and each edge of that box sits within one step
      // of the true edge, so each reading sits within one of its own steps of
      // the true centre. Two readings taken on two grids therefore differ by
      // at most the two steps together; the worst measured here is exactly
      // that, and the extra thousandth is floating point rather than slack.
      const bracket = stepBefore + (await samplingStep(page)) + 0.001;
      expect(bracket).toBeLessThan(34);
      for (const body of ['player', 'opponent', 'ball'] as const) {
        expect(Math.abs(worldAfter[body].x - worldBefore[body].x), `${body} x`)
          .toBeLessThanOrEqual(bracket);
        expect(Math.abs(worldAfter[body].y - worldBefore[body].y), `${body} y`)
          .toBeLessThanOrEqual(bracket);
      }
    },
  );

  test('carries a paused match through a rotation without resuming it', async ({ page }) => {
    // The other direction of the same rule: a rotation changes no match state
    // at all, so a match the player paused is still paused afterwards and no
    // overlay opened or closed on its own.
    await page.setViewportSize({ width: 844, height: 500 });
    await startMatch(page, { mode: 'first-to', target: 3, firstEver: true });
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
    await markSession(page);
    await page.setViewportSize({ width: 500, height: 844 });
    await expect
      .poll(
        async () => page.evaluate(() => document.documentElement.dataset['pfBreakpoint'] ?? ''),
        SETTLE,
      )
      .toBe('portrait');
    await expect(at(page, 'panel-pause')).toBeVisible();
    expect(await turnText(page)).toBe('PAUSED');
    const survived = await sessionSurvived(page);
    expect(survived.mark).toBe('kept-across-the-rotation');
    expect(survived.surface).toBe('kept-across-the-rotation');
  });
});
