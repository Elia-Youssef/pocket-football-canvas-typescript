import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  SETTLE,
  chooseMode,
  leaveToMenu,
  nextFrames,
  startMatch,
} from './support/game';

/**
 * Item J5, method T, evidence `playwright/aim-guide`:
 *
 *   "The aim guide predicts the launching circle's path including exactly one
 *    wall bounce and the first ball contact point, never the resulting ball
 *    path, and defaults on per difficulty as specified."
 *
 * THE GUIDE IS MEASURED, NOT LOOKED AT. A baseline is captured with nothing
 * aimed, the aim is then set to an exact angle through SPEC section 5.0's own
 * controls, and the pixels that changed are the aim's drawing. The arrow is
 * excluded by geometry rather than by colour: SPEC section 6.1 clamps a drag
 * at 180 design units, so nothing the arrow draws lies further than that from
 * the circle it starts at, and every changed pixel beyond 190 belongs to the
 * guide.
 *
 * THE PREDICTION IS CHECKED AGAINST ARITHMETIC WRITTEN OUT HERE, from SPEC
 * section 3's pitch and section 4's radii and from nothing the game exports.
 * The player's circle sits at (300, 360) with a radius of 34, so its centre
 * travels inside the field inset by 34: x from 124 to 1156 and y from 119 to
 * 601. A launch at 60 degrees reaches the top bound at
 * x = 300 + (601 - 360) / tan(60) = 439.2, and the one reflection carries it
 * back down to the bottom bound at x = 439.2 + (601 - 119) / tan(60) = 717.5.
 *
 * "EXACTLY ONE BOUNCE" IS THE ASSERTION THAT NOTHING IS DRAWN PAST THAT. A
 * second reflection would turn the path up again and put drawn pixels beyond
 * x = 717.5; the test requires that band to be empty, which is what makes the
 * word "exactly" testable rather than decorative.
 *
 * "NEVER THE RESULTING BALL PATH" IS THE SAME KIND OF ASSERTION. Aimed
 * straight at the ball, the prediction has to STOP at the contact point, which
 * is 300 + (640 - 300) - (34 + 18) = 588; the ball would leave from there
 * toward the goal at 1190, and no pixel of the guide may follow it.
 */

/** SPEC sections 3 and 4, as literals, read by nothing the game exports. */
const CIRCLE_RADIUS = 34;
const BALL_RADIUS = 18;
const FIELD_TOP_INSET = 635 - CIRCLE_RADIUS;
const FIELD_BOTTOM_INSET = 85 + CIRCLE_RADIUS;
const BALL_CONTACT_X = 640 - (CIRCLE_RADIUS + BALL_RADIUS);

/** Past the arrow's own maximum reach (SPEC section 6.1's 180 unit clamp). */
const PAST_THE_ARROW = 190;

interface Drawn {
  readonly count: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly beyond: number;
}

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

/**
 * Everything drawn since the baseline that lies further than `radius` from the
 * player's circle, in design units: how much of it there is, the box it
 * occupies, and how much of it lies past `limit` in x.
 */
async function drawnBeyond(page: Page, radius: number, limit: number): Promise<Drawn> {
  return page.evaluate(
    (input) => {
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
      // The circle's own centre, from its team fill, so the radius below is
      // measured from where the circle actually is.
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
      let beyond = 0;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
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
          if (Math.hypot(designX - centreX, designY - centreY) < input.radius) {
            continue;
          }
          count += 1;
          minX = Math.min(minX, designX);
          maxX = Math.max(maxX, designX);
          minY = Math.min(minY, designY);
          maxY = Math.max(maxY, designY);
          if (designX > input.limit) {
            beyond += 1;
          }
        }
      }
      return { count, minX, maxX, minY, maxY, beyond };
    },
    { radius, limit },
  );
}

/** Set the aim through SPEC section 5.0's controls, without launching it. */
async function aim(page: Page, degrees: number, percent: number): Promise<void> {
  await at(page, 'aim-angle').fill(String(degrees));
  await at(page, 'power').fill(String(percent));
  await nextFrames(page, 3);
}

test.describe('PF-9 the aim guide, item J5', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('predicts the launching circle, with exactly one wall bounce', async ({ page }) => {
    await startMatch(page, { mode: 'quick', duration: 60, guide: true });
    await nextFrames(page, 10);
    await captureBaseline(page);
    await nextFrames(page, 2);
    // Sixty degrees: up and to the right, into the top bound and back down.
    await aim(page, 60, 100);
    const drawn = await drawnBeyond(page, PAST_THE_ARROW, 745);

    expect(drawn.count).toBeGreaterThan(0);
    // The turn at the top bound, and the far end of the leg after it.
    expect(drawn.maxY).toBeGreaterThan(FIELD_TOP_INSET - 12);
    expect(drawn.maxY).toBeLessThan(FIELD_TOP_INSET + 6);
    expect(drawn.maxX).toBeGreaterThan(700);
    expect(drawn.maxX).toBeLessThan(735);
    expect(drawn.minY).toBeGreaterThan(FIELD_BOTTOM_INSET - 6);
    expect(drawn.minY).toBeLessThan(FIELD_BOTTOM_INSET + 14);
    // EXACTLY ONE: a second reflection would carry the path right again, and
    // there is nothing at all out there.
    expect(drawn.beyond).toBe(0);
  });

  test('stops at the first ball contact, and never follows the ball', async ({ page }) => {
    await startMatch(page, { mode: 'quick', duration: 60, guide: true });
    await nextFrames(page, 10);
    await captureBaseline(page);
    await nextFrames(page, 2);
    // Straight at the ball on the centre spot.
    await aim(page, 0, 100);
    const drawn = await drawnBeyond(page, PAST_THE_ARROW, 620);

    expect(drawn.count).toBeGreaterThan(0);
    // The contact marker sits on the contact point, so the drawing reaches a
    // marker's radius past it and no further.
    expect(drawn.maxX).toBeGreaterThan(BALL_CONTACT_X - 6);
    expect(drawn.maxX).toBeLessThan(BALL_CONTACT_X + 20);
    // NEVER THE BALL'S PATH: from that contact the ball would run to the goal
    // line at 1190, and not one pixel of the guide goes with it.
    expect(drawn.beyond).toBe(0);
  });

  test('is drawn only when it is on', async ({ page }) => {
    // The same aim with the guide switched off draws the arrow and nothing
    // else, which is the control for both measurements above.
    await startMatch(page, { mode: 'quick', duration: 60, guide: false });
    await nextFrames(page, 10);
    await captureBaseline(page);
    await nextFrames(page, 2);
    await aim(page, 60, 100);
    const drawn = await drawnBeyond(page, PAST_THE_ARROW, 745);
    expect(drawn.count).toBe(0);
  });

  test('defaults on at Casual and off above it', async ({ page }) => {
    await startMatch(page, { mode: 'quick', duration: 60 });
    await leaveToMenu(page);
    // SPEC section 11, one difficulty at a time. The checkbox is the setting,
    // and CHOOSING a difficulty is what puts it back to that difficulty's own
    // default, so every step below is a change of choice: checking a radio
    // that is already checked is not a choice and raises nothing, which is the
    // platform's behaviour and not this game's.
    for (const [difficulty, on] of [
      ['pro', false],
      ['ace', false],
      ['casual', true],
    ] as const) {
      await at(page, `difficulty-${difficulty}`).check();
      expect(await at(page, `difficulty-${difficulty}`).isChecked(), difficulty).toBe(true);
      expect(await at(page, 'mode-guide').isChecked(), difficulty).toBe(on);
    }
    // And the ladder takes its rung's difficulty, which SPEC section 10 gives
    // as Casual at rung one.
    await at(page, 'mode-ladder').check();
    expect(await at(page, 'mode-guide').isChecked()).toBe(true);
    // Hotseat has no opponent difficulty at all and answers the same way.
    await at(page, 'mode-hotseat').check();
    expect(await at(page, 'mode-guide').isChecked()).toBe(true);
  });

  test('draws the default it was left at, on the pitch', async ({ page }) => {
    // The setting reaching the canvas, which is what makes the default above
    // a fact about the game rather than about a checkbox. Ace defaults off.
    await startMatch(page, { mode: 'quick', duration: 60, difficulty: 'ace' });
    await leaveToMenu(page);
    await chooseMode(page, { mode: 'quick', duration: 60, difficulty: 'casual' });
    // CHOOSING Ace is what puts the checkbox back to Ace's own default rather
    // than the setting the helper left on it, so the difficulty is changed
    // here and not merely re-asserted.
    await at(page, 'difficulty-ace').check();
    expect(await at(page, 'mode-guide').isChecked()).toBe(false);
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
    await captureBaseline(page);
    await nextFrames(page, 2);
    await aim(page, 60, 100);
    expect((await drawnBeyond(page, PAST_THE_ARROW, 745)).count).toBe(0);

    // And Casual defaults on, over the same aim on the same pitch.
    await leaveToMenu(page);
    await at(page, 'difficulty-casual').check();
    expect(await at(page, 'mode-guide').isChecked()).toBe(true);
    await at(page, 'mode-start').click();
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
    await captureBaseline(page);
    await nextFrames(page, 2);
    await aim(page, 60, 100);
    expect((await drawnBeyond(page, PAST_THE_ARROW, 745)).count).toBeGreaterThan(0);
  });
});
