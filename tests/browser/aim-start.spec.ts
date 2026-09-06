import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Item C1, method T, evidence `playwright/aim-start`:
 *
 *   "Aiming begins only on a press that lands on your own circle, during your
 *    own turn."
 *
 * WHAT IS ASSERTED RATHER THAN OBSERVED. Two independent readings, because
 * either one alone could be satisfied by a game that is not aiming. The
 * surface carries the aim phase as `data-pf-aim`, which is the state; and the
 * canvas is read back pixel for pixel against a baseline captured a frame
 * earlier, which is the drawing. A press that begins an aim changes both. A
 * press that does not must change NEITHER, and "neither" is measured as zero
 * changed pixels rather than as a screenshot somebody looked at.
 *
 * THE CIRCLE IS FOUND, NOT ASSUMED. The player's team fill is located in the
 * pixels and its bounding box gives the centre, so the press lands on the
 * circle wherever the circle has ended up. That matters for the third test,
 * where the turn has passed to the opponent only because the player took a
 * shot and moved.
 *
 * PRESENCE BEFORE REACHABILITY. Each phase asserts the play surface is in the
 * document before asserting that aiming is refused in it, because a refusal
 * and a removed element look identical to a test that only looks the surface
 * up.
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

/**
 * The surface, read back: the aim phase, the player circle's centre in design
 * units, and how the drawing differs from the captured baseline.
 */
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
        // The left goal frame carries the same tint, and it lives outside the
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
          // Colour, not alpha, and past a threshold no antialiasing reaches:
          // anything the arrow draws over the pitch moves a channel by more
          // than a hundred, and the settling described above moves one by a
          // few. Sixteen is comfortably between them.
          const moved = Math.max(
            Math.abs(Number(pixels[at]) - Number(base[at])),
            Math.abs(Number(pixels[at + 1]) - Number(base[at + 1])),
            Math.abs(Number(pixels[at + 2]) - Number(base[at + 2])),
          );
          if (moved <= 16) {
            continue;
          }
          changed += 1;
          const distance = Math.hypot(
            column / scaleX - player.x,
            720 - row / scaleY - player.y,
          );
          furthest = Math.max(furthest, distance);
        }
      }
    }
    return { phase: canvas.dataset['pfAim'] ?? '', player, changed, furthest };
  }, fill);
}

test.describe('PF-5 aiming begins, item C1', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('begins on a press that lands on your own circle, during your own turn', async ({
    page,
  }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    await expect(surface).toHaveCount(1);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');

    const box = await surfaceBox(page);
    await captureBaseline(page);
    await nextFrames(page);
    const start = await readSurface(page, PLAYER_FILL);
    // The circle is where SPEC section 3 puts it at kickoff.
    expect(start.player.x).toBeGreaterThan(295);
    expect(start.player.x).toBeLessThan(305);
    // The control for the whole instrument: a frame HAS been drawn since the
    // baseline, and an idle frame is identical to the one before it, so a
    // later count of zero is a comparison that ran and found nothing rather
    // than a buffer compared against itself.
    expect(start.changed).toBe(0);

    const from = clientOf(box, start.player.x, start.player.y);
    const to = clientOf(box, start.player.x + 100, start.player.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await nextFrames(page);

    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    const aiming = await readSurface(page, PLAYER_FILL);
    // The arrow is drawn, and it reaches about as far as the pull: a hundred
    // design units, from the circle centre, opposite the drag.
    expect(aiming.changed).toBeGreaterThan(0);
    expect(aiming.furthest).toBeGreaterThan(90);
    expect(aiming.furthest).toBeLessThan(115);
    await page.mouse.up();
  });

  test('sits in a box the coordinate chain can trust', async ({ page }) => {
    // QUALITY-BAR section 7: no CSS transform, border or padding may be
    // applied to the canvas, because a rotation or a skew reduces the
    // rectangle to an axis-aligned bounding box and breaks the arithmetic
    // silently. Nothing in the chrome stylesheet targets the surface today,
    // and this is what says so out loud, so a rule added later reddens the
    // suite instead of moving every press by the width of a border.
    const measured = await page.evaluate(() => {
      const canvas = document.querySelector('[data-pf="play-surface"]');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('the play surface is not in the document');
      }
      const style = getComputedStyle(canvas);
      const box = canvas.getBoundingClientRect();
      return {
        transform: style.transform,
        borders: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        padding: [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
        ],
        ratio: box.width / box.height,
      };
    });
    expect(measured.transform).toBe('none');
    expect(measured.borders).toEqual(['0px', '0px', '0px', '0px']);
    expect(measured.padding).toEqual(['0px', '0px', '0px', '0px']);
    // And the box keeps the logical aspect, which is what lets the two axes
    // share one scale in practice even though the mapping gives each its own.
    expect(measured.ratio).toBeCloseTo(1280 / 720, 2);
  });

  test('begins no aim on a press that misses your own circle', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const box = await surfaceBox(page);
    await captureBaseline(page);
    const start = await readSurface(page, PLAYER_FILL);

    const misses: ReadonlyArray<readonly [string, number, number]> = [
      ['sixty units past the rim', start.player.x + 60, start.player.y],
      ['the centre spot, where the ball is', 640, 360],
      ["the opponent's own circle", 980, 360],
    ];
    for (const [name, designX, designY] of misses) {
      const from = clientOf(box, designX, designY);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 100, from.y, { steps: 5 });
      await nextFrames(page);
      await expect(surface, name).toHaveAttribute('data-pf-aim', 'idle');
      const reading = await readSurface(page, PLAYER_FILL);
      expect(reading.changed, name).toBe(0);
      await page.mouse.up();
    }
    // And the turn never moved on, so nothing was launched either.
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
  });

  test('begins no aim once the turn has passed to the opponent', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');
    const box = await surfaceBox(page);
    const start = await readSurface(page, PLAYER_FILL);

    // A real shot, driven the way a player drives one: press on the circle,
    // pull 180 units downward, release, and the arrow points up.
    const from = clientOf(box, start.player.x, start.player.y);
    const to = clientOf(box, start.player.x, start.player.y - 180);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);

    // Presence before reachability, in this phase too.
    await expect(surface).toHaveCount(1);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');

    await captureBaseline(page);
    const settled = await readSurface(page, PLAYER_FILL);
    const press = clientOf(box, settled.player.x, settled.player.y);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await page.mouse.move(press.x + 100, press.y, { steps: 5 });
    await nextFrames(page);

    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
    const refused = await readSurface(page, PLAYER_FILL);
    expect(refused.changed).toBe(0);
    await page.mouse.up();
    await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);
  });
});
