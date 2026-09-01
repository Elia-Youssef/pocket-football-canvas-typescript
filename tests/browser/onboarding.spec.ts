import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  advance,
  centres,
  chooseMode,
  leaveToMenu,
  nextFrames,
  openGame,
  settleSurface,
  startMatch,
  turnText,
} from './support/game';

/**
 * Item J8, method T, evidence `playwright/onboarding`:
 *
 *   "How to Play is shown on first launch, is reachable at any time, its
 *    dismissal persists, and on a first-ever match the aim guide is on for the
 *    first two turns regardless of difficulty."
 *
 * "REGARDLESS OF DIFFICULTY" IS DRIVEN AT THE DIFFICULTY THAT DEFAULTS IT OFF.
 * SPEC section 11 turns the guide off above Casual, so the two-turn rule is
 * only worth anything at Pro or Ace: the match below is started at Ace with
 * the setting unticked, and the guide has to be drawn anyway for two turns and
 * gone on the third. Testing it at Casual would pass for a build that has no
 * rule at all.
 *
 * THE GUIDE IS MEASURED THE WAY tests/browser/aim-guide.spec.ts MEASURES IT:
 * against a baseline with nothing aimed, counting only what is drawn further
 * than the arrow's own 180 unit maximum from the circle. The aim is chosen per
 * turn as the cardinal direction with the most room, so the prediction is
 * always longer than that maximum wherever the circle has ended up.
 *
 * "DISMISSAL PERSISTS" IS ASSERTED WITHIN THE SESSION, and the split is
 * disclosed. The store the dismissal is written to is `core/modes.ts`'s seam,
 * whose round trip is graded at the unit layer; the document that survives a
 * RELOAD is SPEC section 16's and arrives at PF-10, where item I5's own text
 * names settings surviving a mid-match reload. What is asserted here is every
 * part of the clause the shipped game can answer today: the overlay is shown
 * once, is never shown again after it is put away, and is still reachable on
 * purpose from both screens.
 */

/** Past the arrow's own maximum reach (SPEC section 6.1's 180 unit clamp). */
const PAST_THE_ARROW = 190;

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

async function captureBaseline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('the play surface has no 2d context');
    }
    const store = window as unknown as { __pfBaseline?: Uint8ClampedArray };
    store.__pfBaseline = context.getImageData(0, 0, canvas.width, canvas.height).data;
  });
}

interface Drawn {
  /** Changed pixels lying further than the radius from the circle. */
  readonly count: number;
  /** How far out the nearest and the farthest of them are, in design units. */
  readonly nearest: number;
  readonly farthest: number;
}

/** What is drawn further than `radius` from the player's own circle. */
async function drawnBeyond(page: Page, radius: number): Promise<Drawn> {
  return page.evaluate((limit) => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('the play surface has no 2d context');
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const store = window as unknown as { __pfBaseline?: Uint8ClampedArray };
    const base = store.__pfBaseline;
    if (base === undefined) {
      throw new Error('no baseline was captured');
    }
    const scaleX = canvas.width / 1280;
    const scaleY = canvas.height / 720;
    let sumX = 0;
    let sumY = 0;
    let found = 0;
    for (let row = 0; row < canvas.height; row += 1) {
      for (let column = 0; column < canvas.width; column += 1) {
        const slot = (row * canvas.width + column) * 4;
        const designX = column / scaleX;
        if (designX <= 100) {
          continue;
        }
        if (
          Math.abs(Number(pixels[slot]) - 0x55) > 6 ||
          Math.abs(Number(pixels[slot + 1]) - 0x90) > 6 ||
          Math.abs(Number(pixels[slot + 2]) - 0xce) > 6
        ) {
          continue;
        }
        sumX += designX;
        sumY += 720 - row / scaleY;
        found += 1;
      }
    }
    // The origin this radius is measured from has to be the circle. A default
    // origin in the corner would put EVERY changed pixel beyond the arrow and
    // report a guide that is not drawn, so a circle that cannot be located is
    // an error rather than a fallback.
    if (found === 0) {
      throw new Error('the player circle was not found on the play surface');
    }
    const centreX = sumX / found;
    const centreY = sumY / found;
    let count = 0;
    let nearest = Number.POSITIVE_INFINITY;
    let farthest = 0;
    for (let row = 0; row < canvas.height; row += 1) {
      for (let column = 0; column < canvas.width; column += 1) {
        const slot = (row * canvas.width + column) * 4;
        const moved = Math.max(
          Math.abs(Number(pixels[slot]) - Number(base[slot])),
          Math.abs(Number(pixels[slot + 1]) - Number(base[slot + 1])),
          Math.abs(Number(pixels[slot + 2]) - Number(base[slot + 2])),
        );
        if (moved <= 16) {
          continue;
        }
        const designX = column / scaleX;
        const designY = 720 - row / scaleY;
        const away = Math.hypot(designX - centreX, designY - centreY);
        if (away >= limit) {
          count += 1;
          nearest = Math.min(nearest, away);
          farthest = Math.max(farthest, away);
        }
      }
    }
    return { count, nearest: count === 0 ? 0 : nearest, farthest };
  }, radius);
}

/**
 * The cardinal direction with the most room in front of the circle, avoiding
 * the one the ball sits in: the prediction is then always longer than the
 * arrow, wherever the turn has left the circle standing.
 */
async function roomiestAim(page: Page): Promise<number> {
  const scene = await centres(page);
  const options: readonly (readonly [number, number])[] = [
    [0, 1156 - scene.player.x],
    [180, scene.player.x - 124],
    [90, 601 - scene.player.y],
    [270, scene.player.y - 119],
  ];
  const clear = options.filter(([degrees]) => {
    const alongX = degrees === 0 || degrees === 180;
    const lateral = alongX
      ? Math.abs(scene.player.y - scene.ball.y)
      : Math.abs(scene.player.x - scene.ball.x);
    if (lateral > 70) {
      return true;
    }
    const ahead = alongX
      ? (scene.ball.x - scene.player.x) * (degrees === 0 ? 1 : -1)
      : (scene.ball.y - scene.player.y) * (degrees === 90 ? 1 : -1);
    return ahead < 0;
  });
  const pool = clear.length > 0 ? clear : options;
  let best = pool[0];
  for (const option of pool) {
    if (best === undefined || option[1] > best[1]) {
      best = option;
    }
  }
  return best?.[0] ?? 0;
}

/** Aim, measure how much guide is drawn, then launch the shot. */
async function turnWithGuide(page: Page): Promise<Drawn> {
  await nextFrames(page, 3);
  // The turn comes back the moment the match hands it back, which after a goal
  // is while the celebration is still playing out at the far goal. The baseline
  // below is only a baseline once that has finished.
  await settleSurface(page);
  await captureBaseline(page);
  await nextFrames(page, 2);
  await at(page, 'aim-angle').fill(String(await roomiestAim(page)));
  await at(page, 'power').fill('100');
  await nextFrames(page, 3);
  const drawn = await drawnBeyond(page, PAST_THE_ARROW);
  await at(page, 'aim-launch').click();
  // The shot has to have GONE OUT. SPEC section 19 counts the player's turns,
  // so a Launch refused in place would leave the turn where it was and take
  // the count with it; nothing advances the clock after the click, so the turn
  // cannot have come back on its own by the time this reads.
  await expect(at(page, 'turn')).not.toHaveText('YOUR TURN', SETTLE);
  return drawn;
}

test.describe('PF-9 onboarding, item J8', () => {
  test.beforeEach(({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
  });

  test('is shown on first launch and not again once dismissed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    // First launch: the overlay is up before anything else is touched, and the
    // menu is underneath it rather than instead of it.
    await expect(at(page, 'panel-how-to-play')).toBeVisible(SETTLE);
    await expect(at(page, 'panel-mode')).toBeVisible();
    await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
    await expect(at(page, 'panel-how-to-play')).toBeHidden();

    // Not again: not on the menu it came back to, not on a started match, and
    // not on the menu after that match is left.
    await chooseMode(page, { mode: 'quick', duration: 60 });
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await expect(at(page, 'panel-how-to-play')).toBeHidden();
    await leaveToMenu(page);
    await expect(at(page, 'panel-how-to-play')).toBeHidden();
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await expect(at(page, 'panel-how-to-play')).toBeHidden();
  });

  test('is reachable at any time, from the menu and from a running match', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openGame(page);
    // From the menu, on purpose, after it was dismissed.
    await at(page, 'mode-how-to').click();
    await expect(at(page, 'panel-how-to-play')).toBeVisible();
    await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
    await expect(at(page, 'panel-how-to-play')).toBeHidden();

    // And from a running match, through the pause overlay.
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await at(page, 'pause').click();
    await expect(at(page, 'panel-pause')).toBeVisible();
    await page.locator('[data-pf="panel-pause"] button', { hasText: 'How to play' }).click();
    await expect(at(page, 'panel-how-to-play')).toBeVisible();
    await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
    await expect(at(page, 'panel-how-to-play')).toBeHidden();
    // The pause overlay is still underneath it, so Escape still reaches it.
    await expect(at(page, 'panel-pause')).toBeVisible();
  });

  test(
    'holds the aim guide on for the first two turns of a first-ever match',
    { tag: '@drive' },
    async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Ace, where SPEC section 11 defaults the guide OFF, and the setting left
    // at that default. This is the first match this session has ever started.
    await startMatch(page, {
      mode: 'quick',
      duration: 120,
      difficulty: 'ace',
      firstEver: true,
    });
    await expect(at(page, 'mode-guide')).toHaveCount(1);

    const seen: Drawn[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      // Each turn is aimed, measured and launched, and then the match is
      // driven until the turn comes back.
      seen.push(await turnWithGuide(page));
      for (let frame = 0; frame < 200; frame += 1) {
        await advance(page, 1);
        if ((await turnText(page)) === 'YOUR TURN') {
          break;
        }
      }
      expect(await turnText(page)).toBe('YOUR TURN');
    }
    // SPEC section 19: on for the first two turns whatever the difficulty, and
    // the setting governs from then on, which at Ace is off.
    const report = seen
      .map((drawn) => {
        const span = `${drawn.nearest.toFixed(1)}..${drawn.farthest.toFixed(1)}`;
        return `${String(drawn.count)} px at ${span}`;
      })
      .join('; ');
    expect(
      seen.map((drawn) => drawn.count > 0),
      `past the arrow, turn by turn: ${report}`,
    ).toEqual([true, true, false]);
  });
});
