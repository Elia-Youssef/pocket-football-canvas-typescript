import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { advance, startMatch, turnText } from './support/game';

/**
 * Item C4, method T, evidence `playwright/max-drag`:
 *
 *   "A drag above the 180 px maximum clamps launch strength, and the arrow
 *    stops growing."
 *
 * TWO CLAUSES AND TWO INSTRUMENTS. The arrow is measured in pixels: the
 * canvas is read back against a baseline captured before the press, and the
 * furthest changed pixel from the circle centre is how far the arrow reaches.
 * Launch strength is measured in travel: the same aim launched at 180 units
 * of pull and at 300 has to come to rest in exactly the same place, because
 * the simulation is deterministic and the two shots are the same shot. A
 * shorter pull has to come to rest somewhere else, which is the half that
 * stops the assertion passing for a build that ignores the drag entirely.
 *
 * WHY THE SETTLED POSITION IS A FAIR COMPARISON. The fixed step is
 * bit-identical for identical launches, and a body at rest is a fixed point,
 * so the position a shot settles at does not depend on how the frames were
 * cut. Two runs of the same launch settle in the same place to the pixel; two
 * different launches do not.
 */

/**
 * The two budgets a state read on a busy machine needs, and both are
 * starvation budgets rather than correctness ones. A test here reads the
 * whole canvas back pixel for pixel and drives real shots to rest, so it is
 * seconds of work on a quiet machine; the mutation harness runs this suite
 * with a build going beside it, and a loaded machine has been measured
 * taking ten times as long to answer a navigation. A gate that reports a
 * defect when the machine is busy is a gate nobody trusts.
 */
const SETTLE = { timeout: 120_000 };
const A_WHOLE_TEST = 240_000;
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

/** SPEC section 18's player fill, as the bytes it is read back as. */
const PLAYER_FILL = [0x55, 0x90, 0xce] as const;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Reading {
  readonly phase: string;
  readonly player: { x: number; y: number };
  readonly changed: number;
  readonly furthest: number;
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
 * Let the frame driver draw, so a reading is of a frame and not of a gap.
 * Ten of them at the start of a test, because the surface is sized by a
 * resize observer whose first callback lands after the document has loaded,
 * and a baseline captured before it would be of a scene at another scale.
 * The comparison below then reads colour and not alpha, so an antialiased
 * edge cannot pass for something drawn.
 */
async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (times) => {
    for (let at = 0; at < times; at += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }
  }, count);
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

async function readSurface(page: Page, fill: readonly number[]): Promise<Reading> {
  return page.evaluate((wanted) => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('the play surface has no 2d context');
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const scaleX = canvas.width / 1280;
    const scaleY = canvas.height / 720;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < canvas.height; row += 1) {
      for (let column = 0; column < canvas.width; column += 1) {
        const at = (row * canvas.width + column) * 4;
        const designX = column / scaleX;
        // The left goal frame carries the same tint and lives outside the
        // field bound, so the search starts inside the pitch.
        if (designX <= 100) {
          continue;
        }
        if (
          Math.abs(Number(pixels[at]) - Number(wanted[0])) > 6 ||
          Math.abs(Number(pixels[at + 1]) - Number(wanted[1])) > 6 ||
          Math.abs(Number(pixels[at + 2]) - Number(wanted[2])) > 6
        ) {
          continue;
        }
        const designY = 720 - row / scaleY;
        minX = Math.min(minX, designX);
        maxX = Math.max(maxX, designX);
        minY = Math.min(minY, designY);
        maxY = Math.max(maxY, designY);
      }
    }
    const player = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    const store = window as unknown as { __pfBaseline?: Uint8ClampedArray };
    const base = store.__pfBaseline;
    let changed = 0;
    let furthest = 0;
    if (base !== undefined) {
      for (let row = 0; row < canvas.height; row += 1) {
        for (let column = 0; column < canvas.width; column += 1) {
          const at = (row * canvas.width + column) * 4;
          const moved = Math.max(
            Math.abs(Number(pixels[at]) - Number(base[at])),
            Math.abs(Number(pixels[at + 1]) - Number(base[at + 1])),
            Math.abs(Number(pixels[at + 2]) - Number(base[at + 2])),
          );
          if (moved <= 16) {
            continue;
          }
          changed += 1;
          furthest = Math.max(
            furthest,
            Math.hypot(column / scaleX - player.x, 720 - row / scaleY - player.y),
          );
        }
      }
    }
    return { phase: canvas.dataset['pfAim'] ?? '', player, changed, furthest };
  }, fill);
}

/** One shot, pulled straight down so the arrow and the launch point up. */
async function shoot(page: Page, pull: number): Promise<{ x: number; y: number }> {
  const turn = page.locator('[data-pf="turn"]');
  const box = await surfaceBox(page);
  const start = await readSurface(page, PLAYER_FILL);
  const from = clientOf(box, start.player.x, start.player.y);
  const to = clientOf(box, start.player.x, start.player.y - pull);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  // THE READING IS TAKEN AT A POINT IN THE MATCH, not at a point in wall clock
  // time. From PF-9 the opponent answers its own turn, so the frames are
  // driven one at a time until the handover and then STOPPED: both arms of the
  // comparison below stop at the same frame of the same match, and the
  // opponent's own shot cannot move the circle being measured.
  let handedOver = false;
  for (let frame = 0; frame < 200 && !handedOver; frame += 1) {
    await advance(page, 1);
    handedOver = (await turnText(page)) === 'OPPONENT IS AIMING';
  }
  expect(handedOver).toBe(true);
  await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);
  const settled = await readSurface(page, PLAYER_FILL);
  return settled.player;
}

test.describe('PF-5 the maximum drag, item C4', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('the arrow stops growing past the maximum', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const box = await surfaceBox(page);
    await captureBaseline(page);
    const start = await readSurface(page, PLAYER_FILL);

    const from = clientOf(box, start.player.x, start.player.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();

    const reaches: number[] = [];
    for (const pull of [120, 200, 300]) {
      const to = clientOf(box, start.player.x + pull, start.player.y);
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await nextFrames(page);
      await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
      const reading = await readSurface(page, PLAYER_FILL);
      reaches.push(reading.furthest);
    }
    await page.mouse.up();

    const [shortPull, pastTheMaximum, wellPastTheMaximum] = reaches;
    // Below the maximum the arrow is as long as the pull.
    expect(Number(shortPull)).toBeGreaterThan(110);
    expect(Number(shortPull)).toBeLessThan(130);
    // Above it the arrow is the maximum, 180 units, however far the pull went.
    expect(Number(pastTheMaximum)).toBeGreaterThan(170);
    expect(Number(pastTheMaximum)).toBeLessThan(190);
    expect(Number(pastTheMaximum) - Number(shortPull)).toBeGreaterThan(40);
    // The pull then grew by another hundred and the arrow did not grow at all.
    expect(Number(wellPastTheMaximum)).toBeCloseTo(Number(pastTheMaximum), 1);
  });

  test('clamps the launch strength above the maximum', { tag: '@drive' }, async ({
    page,
  }) => {
    // The page's clock is the test's from before the navigation, so `shoot`
    // below can stop the match at the handover rather than race it.
    await page.clock.install({ time: 0 });
    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await advance(page, 10);
    // Two hundred and three hundred rather than a hundred and eighty and
    // three hundred. Both are above the clamp, which is what the criterion
    // says, and neither sits ON it: a client coordinate that lost a fraction
    // in the round trip would leave a pull of exactly a hundred and eighty at
    // 99.9 percent power and move the settled position by four units, forty
    // times the tolerance below, for a reason that is the engine's rounding
    // and not this game's arithmetic.
    const pastTheMaximum = await shoot(page, 200);

    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await advance(page, 10);
    const wellPastTheMaximum = await shoot(page, 300);

    await startMatch(page);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await advance(page, 10);
    const shortPull = await shoot(page, 120);

    // The same shot: a pull of 300 units is a pull of 200 units once the
    // strength has clamped, so the two come to rest in the same place.
    expect(wellPastTheMaximum.x).toBeCloseTo(pastTheMaximum.x, 1);
    expect(wellPastTheMaximum.y).toBeCloseTo(pastTheMaximum.y, 1);
    // And a pull below the clamp is a weaker shot, so it does not.
    expect(
      Math.hypot(shortPull.x - pastTheMaximum.x, shortPull.y - pastTheMaximum.y),
    ).toBeGreaterThan(20);
  });
});
