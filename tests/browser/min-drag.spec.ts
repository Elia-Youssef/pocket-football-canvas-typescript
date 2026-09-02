import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { startMatch } from './support/game';

/**
 * Item C3, method T, evidence `playwright/min-drag`:
 *
 *   "A drag below the 30 px minimum cancels without launching and shows a
 *    clear visual signal."
 *
 * THREE CLAUSES, THREE READINGS. "Below the minimum" is a drag measured in
 * design units, so the pull is expressed in design units and converted to CSS
 * pixels through the surface's own rectangle. "Cancels without launching" is
 * read from the turn indicator, which is real DOM derived from the match
 * state: a launch moves the match to IN PLAY and nothing else does, so a
 * turn indicator still reading YOUR TURN after the release is a launch that
 * did not happen. "A clear visual signal" is read from the canvas: the
 * sub-minimum presentation puts a ring outside the circle's rim, so changed
 * pixels appear BEHIND the arrow, past the circle, where a launchable aim
 * puts none.
 *
 * THE EXACT BOUNDARY IS GRADED IN THE UNIT LAYER, in
 * tests/unit/coordinate-transform.test.ts, which drives a drag of exactly 30
 * design units at three viewport scales and asserts it launches. A browser
 * cannot carry that assertion honestly: an engine is free to round a client
 * coordinate, and a test that depended on the rounding would be testing the
 * engine. The bracket here is 24 units and 36, which straddles the bound by
 * six units in each direction, more than any rounding can move it.
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

/** SPEC section 4's circle radius, with a margin for the outline over it. */
const OUTSIDE_THE_CIRCLE = 38;

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
  readonly behind: number;
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

/**
 * The surface, read back: the aim phase, the player circle's centre, and how
 * the drawing differs from the baseline. `behind` is the furthest changed
 * pixel on the far side of the circle from the aim, which is where the
 * sub-minimum ring is and where a launchable arrow is not.
 */
async function readSurface(
  page: Page,
  aimX: number,
  aimY: number,
  fill: readonly number[],
): Promise<Reading> {
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
            Math.abs(Number(pixels[at]) - Number(input.fill[0])) > 6 ||
            Math.abs(Number(pixels[at + 1]) - Number(input.fill[1])) > 6 ||
            Math.abs(Number(pixels[at + 2]) - Number(input.fill[2])) > 6
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
      let behind = 0;
      if (base !== undefined) {
        for (let row = 0; row < canvas.height; row += 1) {
          for (let column = 0; column < canvas.width; column += 1) {
            const at = (row * canvas.width + column) * 4;
            // Colour, not alpha, and past a threshold no antialiasing
            // reaches: the arrow moves a channel by more than a hundred and
            // the settling above moves one by a few.
            const moved = Math.max(
              Math.abs(Number(pixels[at]) - Number(base[at])),
              Math.abs(Number(pixels[at + 1]) - Number(base[at + 1])),
              Math.abs(Number(pixels[at + 2]) - Number(base[at + 2])),
            );
            if (moved <= 16) {
              continue;
            }
            changed += 1;
            const offsetX = column / scaleX - player.x;
            const offsetY = 720 - row / scaleY - player.y;
            const distance = Math.hypot(offsetX, offsetY);
            furthest = Math.max(furthest, distance);
            if (offsetX * input.aimX + offsetY * input.aimY < 0) {
              behind = Math.max(behind, distance);
            }
          }
        }
      }
      return { phase: canvas.dataset['pfAim'] ?? '', player, changed, furthest, behind };
    },
    { aimX, aimY, fill },
  );
}

test.describe('PF-5 the minimum drag, item C3', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    // A MATCH WITH NO CLOCK, because item C3 is about a drag and nothing here
    // is about time. These tests do not install the page's clock, so a Quick
    // Match runs on real seconds and the whole test has to finish inside SPEC
    // section 9's sixty of them; under a full parallel suite it does not
    // always, and the third test then reads FULL TIME where it expects the
    // opponent's turn. SPEC section 9's First to N has no clock at all and
    // cannot time out, and the opponent is the same generic one, so every
    // assertion below is untouched and the only thing removed is a dependence
    // on how loaded the machine was.
    await startMatch(page, { mode: 'first-to' });
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('a drag below the minimum cancels without launching', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');
    const box = await surfaceBox(page);
    await captureBaseline(page);
    const start = await readSurface(page, 1, 0, PLAYER_FILL);

    const from = clientOf(box, start.player.x, start.player.y);
    const to = clientOf(box, start.player.x + 24, start.player.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await nextFrames(page);
    // Twenty-four design units is a real aim in progress, and it is the
    // sub-minimum one.
    await expect(surface).toHaveAttribute('data-pf-aim', 'below-minimum');

    await page.mouse.up();
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
    // The turn never moved on, so nothing launched.
    await expect(turn).toHaveText('YOUR TURN', SETTLE);
    // And the pitch is back to exactly the frame it started from: nothing
    // moved and nothing is drawn over it.
    const after = await readSurface(page, 1, 0, PLAYER_FILL);
    expect(after.changed).toBe(0);
    expect(after.player.x).toBeCloseTo(start.player.x, 1);
    expect(after.player.y).toBeCloseTo(start.player.y, 1);
  });

  test('shows a clear visual signal while the pull is too short', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const box = await surfaceBox(page);
    await captureBaseline(page);
    const start = await readSurface(page, 1, 0, PLAYER_FILL);

    const from = clientOf(box, start.player.x, start.player.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();

    // Too short: the signal reaches past the circle's rim on the far side
    // from the arrow, which is the ring, and nothing else on the pitch does.
    const shortPull = clientOf(box, start.player.x + 20, start.player.y);
    await page.mouse.move(shortPull.x, shortPull.y, { steps: 4 });
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'below-minimum');
    const tooShort = await readSurface(page, -1, 0, PLAYER_FILL);
    expect(tooShort.changed).toBeGreaterThan(0);
    expect(tooShort.behind).toBeGreaterThan(OUTSIDE_THE_CIRCLE);

    // Long enough: the signal is gone, and what is left behind the circle is
    // inside the rim, where the facing marker turned with the aim.
    const longPull = clientOf(box, start.player.x + 60, start.player.y);
    await page.mouse.move(longPull.x, longPull.y, { steps: 4 });
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    const launchable = await readSurface(page, -1, 0, PLAYER_FILL);
    expect(launchable.changed).toBeGreaterThan(0);
    expect(launchable.behind).toBeLessThan(OUTSIDE_THE_CIRCLE);
    // The arrow itself is drawn, on the other side, as long as the pull.
    expect(launchable.furthest).toBeGreaterThan(50);

    await page.mouse.up();
  });

  test('a drag past the minimum launches, opposite the pull', async ({ page }) => {
    // The other side of the bracket: the same gesture, twelve units longer,
    // is a shot. Without this the test above would pass for a build that
    // never launches anything at all. The pull is to the right, so the shot
    // goes left, which is the slingshot end to end through the real
    // composition rather than through the aim alone.
    const turn = page.locator('[data-pf="turn"]');
    const box = await surfaceBox(page);
    const start = await readSurface(page, 1, 0, PLAYER_FILL);

    const from = clientOf(box, start.player.x, start.player.y);
    const to = clientOf(box, start.player.x + 36, start.player.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await expect(turn).toHaveText('IN PLAY', SETTLE);

    // THE TURN HANDED OVER, and both readings of that are accepted because
    // the opponent's turn is TRANSIENT: it takes that turn by itself and
    // hands back, and on a loaded machine the round trip between the two
    // waits can outlast the whole of it, which is a race this assertion lost
    // twice. Neither reading is reachable without the launch the IN PLAY
    // above has already proven, and a launch that never happened leaves the
    // readout on IN PLAY or never leaves YOUR TURN in the first place, so
    // nothing that could fail before can pass now. tests/browser/max-drag.spec.ts
    // takes the other route to the same certainty, driving the clock a frame
    // at a time and stopping ON the handover; that needs the page's clock
    // installed, and these tests deliberately drag in real time.
    await expect(turn).toHaveText(/^(?:OPPONENT IS AIMING|YOUR TURN)$/, SETTLE);
    await nextFrames(page);
    const settled = await readSurface(page, 1, 0, PLAYER_FILL);
    expect(settled.player.x).toBeLessThan(start.player.x - 100);
    expect(settled.player.y).toBeCloseTo(start.player.y, 0);
  });
});
