import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Item C8, method T, evidence `playwright/input-lock`:
 *
 *   "Aiming and launching are impossible during the opponent's turn, while
 *    any body is moving, while paused, and at game over."
 *
 * THREE OF THE FOUR CONDITIONS ARE HERE. Game over is not, and the reason is
 * disclosed in this part's report rather than hidden: nothing in the shipped
 * composition can end a match yet, because the modes that give a match a
 * clock or a goal target arrive at PF-9, so GAME_OVER is not a state a
 * browser can be driven into at this part. That clause is graded in
 * tests/unit/launch.test.ts, over a match given a one-second clock, together
 * with a table over every state SPEC section 7's chart has.
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

interface Attempt {
  readonly pressedAt: { x: number; y: number };
  readonly afterDown: string;
  readonly afterMove: string;
  readonly afterEnd: string;
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

/** The player circle's centre in design units, from the drawn pixels. */
async function playerCentre(page: Page, fill: readonly number[]): Promise<{ x: number; y: number }> {
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
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }, fill);
}

/**
 * A press, a drag and an end, dispatched at the surface with the circle's own
 * coordinates read in the same task. The phase is sampled after each, because
 * a lock that let the press through and tidied up afterwards is not a lock.
 */
async function dispatchAim(
  page: Page,
  units: number,
  ending: 'pointerup' | 'pointercancel',
  fill: readonly number[],
): Promise<Attempt> {
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
      const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + (centre.x * rect.width) / 1280;
      const clientY = rect.top + ((720 - centre.y) * rect.height) / 720;
      const across = (input.units * rect.width) / 1280;
      const fire = (type: string, x: number): void => {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            clientX: x,
            clientY,
            bubbles: true,
          }),
        );
      };
      const phase = (): string => canvas.dataset['pfAim'] ?? '';
      fire('pointerdown', clientX);
      const afterDown = phase();
      fire('pointermove', clientX + across);
      const afterMove = phase();
      fire(input.ending, clientX + across);
      return { pressedAt: centre, afterDown, afterMove, afterEnd: phase() };
    },
    { units, ending, fill },
  );
}

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
    await page.goto('/');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('refuses aiming while any body is moving', async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');

    // The positive control, in the turn that allows an aim: the same press
    // begins one, and a release under the minimum cancels it without a shot.
    const box = await surfaceBox(page);
    const start = await playerCentre(page, PLAYER_FILL);
    await mouseAim(page, box, start, 20);
    await expect(surface).toHaveAttribute('data-pf-aim', 'below-minimum');
    await page.mouse.up();
    await expect(turn).toHaveText('YOUR TURN', SETTLE);

    // A real shot, and then the attempt while it is still running.
    await mouseAim(page, box, start, 40);
    await page.mouse.up();
    await expect(turn).toHaveText('IN PLAY', SETTLE);
    await expect(surface).toHaveCount(1);

    const refused = await dispatchAim(page, 100, 'pointerup', PLAYER_FILL);
    expect(Number.isFinite(refused.pressedAt.x)).toBe(true);
    expect(refused.afterDown).toBe('idle');
    expect(refused.afterMove).toBe('idle');
    expect(refused.afterEnd).toBe('idle');
    // And the turn ran its own course: the refused press launched nothing.
    await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);
  });

  test("refuses aiming during the opponent's turn", async ({ page }) => {
    const surface = page.locator('[data-pf="play-surface"]');
    const turn = page.locator('[data-pf="turn"]');
    const box = await surfaceBox(page);
    const start = await playerCentre(page, PLAYER_FILL);

    await mouseAim(page, box, start, 40);
    await page.mouse.up();
    await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);
    await expect(surface).toHaveCount(1);
    await nextFrames(page);

    // The world is still and nothing covers the pitch, so this is a real
    // mouse press on the circle where it came to rest.
    const settled = await playerCentre(page, PLAYER_FILL);
    await mouseAim(page, box, settled, 100);
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
    await page.mouse.up();
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
    await expect(turn).toHaveText('OPPONENT IS AIMING', SETTLE);
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
    const start = await playerCentre(page, PLAYER_FILL);

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
});
