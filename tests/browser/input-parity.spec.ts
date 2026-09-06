import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { advance, startMatch, turnText } from './support/game';

/**
 * Item C11, method T, evidence `playwright/input-parity`:
 *
 *   "Every action is reachable by pointer, by touch and by keyboard, and a
 *    full match is completable using only discrete taps with no dragging
 *    movement at any point, satisfying WCAG 2.2 SC 2.5.7. The no-drag path is
 *    real visible controls, two sliders with stepper buttons plus Launch and
 *    Cancel, not a keyboard-only binding, because a keyboard equivalent
 *    explicitly does not satisfy that criterion."
 *
 * It also carries item C9's two behavioural clauses, because they are pointer
 * facts and this is the pointer file: a drag that leaves the canvas keeps
 * aiming, and `touch-action` is `pinch-zoom` at every moment except inside a
 * capture. C9's first clause, that no mouse or touch listener exists in the
 * source, is the lint rule and lives in tests/unit/pointer-events.test.ts.
 *
 * WHAT IS ASSERTED RATHER THAN OBSERVED. The controls are measured: their
 * boxes are read back from the rendered page against the 44 by 44 minimum and
 * the 8 px clearance, and their visibility is read from the computed style
 * rather than from a screenshot. The no-drag claim is INSTRUMENTED: a probe
 * counts every pointer movement that arrives at the surface between a press
 * and a release, the whole no-drag turn is driven with it armed, and the count
 * has to be zero. A real drag at the end proves the probe can count.
 *
 * THE FULL MATCH IS HERE, from PF-9. It could not be until then: the
 * composition root built a match with no clock and no goal target, because
 * SPEC section 9's modes own both numbers, and nothing answered the opponent's
 * seam either, so a match parked in OPPONENT_TURN after the first shot and the
 * many-turn run was graded over the same modules in
 * tests/unit/discrete-aim.test.ts with the split disclosed. The modes and the
 * opponent driver landed together, and a whole Quick Match played out by taps
 * alone is now driven below, beside the complete single turn by each of the
 * three input methods. The unit-layer run stays where it is: it drives the
 * same modules at frame rates no browser lets a test choose.
 */

const SETTLE = { timeout: 120_000 };
const A_WHOLE_TEST = 240_000;
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

/** QUALITY-BAR section 3's two touch numbers, as literals. */
const TARGET_MIN = 44;
const TARGET_CLEARANCE = 8;

/**
 * A rendered box is measured in fractional CSS pixels, and an engine that
 * lays its boxes out on device pixels reports a declared 8 px gap as
 * 7.9999847 (measured, Firefox). The two thresholds above are still the
 * literals the standard states; this is the width of that rounding, written
 * as its own number so it cannot quietly grow into a weaker rule.
 */
const SUBPIXEL = 0.001;

/** SPEC section 5.1's steps, as literals, so the controls are held to them. */
const ANGLE_STEP = 3;
const POWER_STEP = 5;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The eight controls SPEC section 5.0 names, in tab order. */
const CONTROLS = [
  'aim-left',
  'aim-angle',
  'aim-right',
  'power-down',
  'power',
  'power-up',
  'aim-launch',
  'aim-cancel',
] as const;

function at(page: Page, marker: string): Locator {
  return page.locator(`[data-pf="${marker}"]`);
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
    for (let index = 0; index < times; index += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }
  }, count);
}

/**
 * The drag probe: every pointer movement that reaches the surface while a
 * pointer is down on it. A drag is a press, a movement and a release, and the
 * middle one is the part SC 2.5.7 is about.
 */
async function armDragProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const store = window as unknown as { __pfDrag?: number };
    store.__pfDrag = 0;
    let down = false;
    canvas.addEventListener('pointerdown', () => {
      down = true;
    }, true);
    canvas.addEventListener('pointerup', () => {
      down = false;
    }, true);
    canvas.addEventListener('pointercancel', () => {
      down = false;
    }, true);
    canvas.addEventListener('pointermove', () => {
      if (down) {
        store.__pfDrag = (store.__pfDrag ?? 0) + 1;
      }
    }, true);
  });
}

async function dragCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pfDrag?: number }).__pfDrag ?? 0);
}

async function resetDragProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __pfDrag?: number }).__pfDrag = 0;
  });
}

/** A press and a release at one point, with no movement in between. */
async function tapAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * The same tap as a TOUCH, dispatched at the element with `pointerType`
 * touch. Playwright's engines are not touch devices and QUALITY-BAR section 2
 * puts a real one on the release gate; what is asserted here is that the touch
 * path reaches the same listener the pointer path does, which is the parity
 * claim, and never that an emulated touch is a finger.
 */
async function touchTap(
  page: Page,
  selector: string,
  point?: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    (input) => {
      const element = document.querySelector(input.selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`no element at ${input.selector}`);
      }
      const box = element.getBoundingClientRect();
      const clientX = input.point?.x ?? box.left + box.width / 2;
      const clientY = input.point?.y ?? box.top + box.height / 2;
      const shape = {
        pointerId: 21,
        pointerType: 'touch',
        isPrimary: true,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      };
      element.dispatchEvent(new PointerEvent('pointerdown', shape));
      element.dispatchEvent(new PointerEvent('pointerup', shape));
      // A tap on a control is a click to the platform, and a click is what a
      // button listens for; it is fired for a pointer, a touch and a key.
      element.dispatchEvent(new PointerEvent('click', shape));
    },
    { selector, point },
  );
}

async function valueOf(page: Page, marker: string): Promise<number> {
  return Number(await at(page, marker).inputValue());
}

/** How long a control gets to accept a click before the turn is treated as gone. */
const A_LOST_RACE = 2_000;

/**
 * Click a control while the turn is still offering it, and answer whether the
 * click landed.
 *
 * QUALITY-BAR section 3 refuses a control IN PLACE rather than removing it, so
 * a control that stops being offered mid-turn stays in the document and never
 * becomes clickable again. Reading the turn and acting on it are two moments,
 * and a goal, its 1.2 second hold or the whistle can land between them; waiting
 * out a refusal there spends the whole test budget on a turn that already
 * ended. A lost race is not a failure of the no-drag claim, so it costs one
 * turn of the drive and the loop takes the next one. It cannot hide a real
 * break either: the drive still has to reach FULL TIME and still has to have
 * completed three whole turns to pass.
 */
async function clickWhileOffered(page: Page, marker: string): Promise<boolean> {
  const control = at(page, marker);
  if ((await control.getAttribute('aria-disabled')) !== 'false') {
    return false;
  }
  try {
    await control.click({ timeout: A_LOST_RACE });
  } catch (refused) {
    // Only the race is absorbed. Anything else is a break and is re-thrown.
    if (refused instanceof Error && refused.name === 'TimeoutError') {
      return false;
    }
    throw refused;
  }
  return true;
}

test.describe('PF-6 input parity and the no-drag path, item C11', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await startMatch(page);
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('carries the no-drag path as real visible controls, sized for a finger', async ({
    page,
  }) => {
    // Presence first, and the shape the criterion names: two sliders with a
    // stepper on each side, plus Launch and Cancel. Eight controls, and the
    // two range inputs are real ones, so role, name and value come from the
    // platform rather than from an ARIA construction.
    for (const marker of CONTROLS) {
      await expect(at(page, marker), marker).toHaveCount(1);
      await expect(at(page, marker), marker).toBeVisible();
    }
    const shape = await page.evaluate((markers) => {
      return markers.map((marker) => {
        const element = document.querySelector(`[data-pf="${marker}"]`);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`no element marked ${marker}`);
        }
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          marker,
          tag: element.tagName,
          type: element.getAttribute('type') ?? '',
          name: element.getAttribute('aria-label') ?? element.textContent ?? '',
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        };
      });
    }, [...CONTROLS]);

    expect(shape.map((entry) => entry.tag)).toEqual([
      'BUTTON', 'INPUT', 'BUTTON', 'BUTTON', 'INPUT', 'BUTTON', 'BUTTON', 'BUTTON',
    ]);
    expect(shape.filter((entry) => entry.type === 'range')).toHaveLength(2);
    expect(shape.map((entry) => entry.name.trim())).toEqual([
      'Aim left',
      'Aim angle in degrees',
      'Aim right',
      'Less power',
      'Power percent',
      'More power',
      'Launch',
      'Cancel',
    ]);

    // VISIBLE, which is the half of the criterion a keyboard binding fails.
    // An earlier form of QUALITY-BAR section 4 had these visually hidden, and
    // SC 2.5.7 rules that out: the alternative to a drag must be tappable.
    for (const entry of shape) {
      expect(entry.display, entry.marker).not.toBe('none');
      expect(entry.visibility, entry.marker).toBe('visible');
      expect(Number(entry.opacity), entry.marker).toBeGreaterThan(0);
      expect(entry.width, `${entry.marker} width`).toBeGreaterThanOrEqual(
        TARGET_MIN - SUBPIXEL,
      );
      expect(entry.height, `${entry.marker} height`).toBeGreaterThanOrEqual(
        TARGET_MIN - SUBPIXEL,
      );
    }

    // And no two of them are closer than the clearance, measured on the axis
    // that separates them, so a finger cannot land on two at once.
    for (let one = 0; one < shape.length; one += 1) {
      for (let other = one + 1; other < shape.length; other += 1) {
        const a = shape[one];
        const b = shape[other];
        if (a === undefined || b === undefined) {
          throw new Error('the control measurements went missing');
        }
        const gapX = Math.max(a.left, b.left) - Math.min(a.left + a.width, b.left + b.width);
        const gapY = Math.max(a.top, b.top) - Math.min(a.top + a.height, b.top + b.height);
        expect(
          Math.max(gapX, gapY),
          `${a.marker} against ${b.marker}`,
        ).toBeGreaterThanOrEqual(TARGET_CLEARANCE - SUBPIXEL);
      }
    }
  });

  test('completes a whole turn by discrete taps, with no dragging movement', async ({
    page,
  }) => {
    await armDragProbe(page);
    const box = await surfaceBox(page);
    const surface = at(page, 'play-surface');

    // THE PROBE CAN COUNT, proved before it is trusted and inside the same
    // turn, because a zero from an instrument that never fires reads exactly
    // like a zero from a clean run. The gesture is a real drag on the circle,
    // kept under the minimum so it cancels and the turn stays where it is.
    const circle = clientOf(box, 300, 360);
    await page.mouse.move(circle.x, circle.y);
    await page.mouse.down();
    await page.mouse.move(circle.x - 20, circle.y, { steps: 4 });
    await expect(surface).toHaveAttribute('data-pf-aim', 'below-minimum');
    await page.mouse.up();
    expect(await dragCount(page)).toBeGreaterThan(0);
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await resetDragProbe(page);

    // A tap on the pitch names the direction. One press, one release, in one
    // place: the probe counts every movement that arrives between them.
    const target = clientOf(box, 1100, 500);
    await tapAt(page, target.x, target.y);
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    const aimed = await valueOf(page, 'aim-angle');
    expect(await valueOf(page, 'power')).toBe(60);

    // The steppers adjust it, each one worth exactly the step the matching
    // key tap is worth.
    await at(page, 'aim-left').click();
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBe((aimed + ANGLE_STEP) % 360);
    await at(page, 'aim-right').click();
    await at(page, 'aim-right').click();
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBe((aimed - ANGLE_STEP + 360) % 360);
    await at(page, 'power-up').click();
    await at(page, 'power-up').click();
    await nextFrames(page);
    expect(await valueOf(page, 'power')).toBe(60 + 2 * POWER_STEP);

    // And Launch takes the shot, which is the whole turn with no drag in it.
    await at(page, 'aim-launch').click();
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
    expect(await dragCount(page)).toBe(0);
  });

  test(
    'completes a FULL match by discrete taps, with no dragging movement',
    { tag: '@drive' },
    async ({ page }) => {
    // THE FULL-MATCH HALF OF THE CRITERION, re-homed at PF-9 from
    // tests/unit/discrete-aim.test.ts, where it was graded over the same
    // modules while the shipped composition had no mode that could end a
    // match and nobody answering the opponent's seam. Both exist now, so the
    // claim is made where the criterion makes it: over the built bundle.
    //
    // The clock is the test's own from before the navigation, so a whole 60
    // second Quick Match is a few hundred frames of a quarter of a second
    // rather than a minute of waiting.
    await page.clock.install({ time: 0 });
    await startMatch(page, { mode: 'quick', duration: 60 });
    await armDragProbe(page);
    const box = await surfaceBox(page);
    const surface = at(page, 'play-surface');

    // THE PROBE CAN COUNT, proved first and with a real drag, because a zero
    // from an instrument that never fires reads like a zero from a clean run.
    const circle = clientOf(box, 300, 360);
    await page.mouse.move(circle.x, circle.y);
    await page.mouse.down();
    await page.mouse.move(circle.x - 20, circle.y, { steps: 4 });
    await expect(surface).toHaveAttribute('data-pf-aim', 'below-minimum');
    await page.mouse.up();
    expect(await dragCount(page)).toBeGreaterThan(0);
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await resetDragProbe(page);

    // The match, played out: every turn is a tap on the pitch, two steppers
    // and Launch, and not one movement between a press and a release.
    let turns = 0;
    for (let frame = 0; frame < 400; frame += 1) {
      await advance(page, 1);
      const state = (await at(page, 'turn').textContent()) ?? '';
      if (state === 'FULL TIME') {
        break;
      }
      if (state === 'YOUR TURN') {
        const target = clientOf(box, 1150, 360);
        await tapAt(page, target.x, target.y);
        // Every control of the turn, while the turn is still offering them.
        // Short-circuiting is the point: a stepper that is no longer offered
        // means this turn is gone, and launching into the next one would be
        // taking a shot the player did not aim.
        const took =
          (await clickWhileOffered(page, 'power-up')) &&
          (await clickWhileOffered(page, 'power-up')) &&
          (await clickWhileOffered(page, 'aim-launch'));
        if (took) {
          turns += 1;
        }
      }
    }
    await expect(at(page, 'turn')).toHaveText('FULL TIME', SETTLE);
    // Several complete turn cycles, not one: the player aims and launches, the
    // opponent answers, and the turn comes back.
    expect(turns).toBeGreaterThanOrEqual(3);
    // THE CLAIM ITSELF: not one movement event arrived between a press and a
    // release in the whole match.
    expect(await dragCount(page)).toBe(0);
  });

  test('cancels an aim by pointer, by touch and by keyboard', async ({ page }) => {
    const box = await surfaceBox(page);
    const surface = at(page, 'play-surface');
    const aimHere = clientOf(box, 1000, 300);

    await tapAt(page, aimHere.x, aimHere.y);
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    await at(page, 'aim-cancel').click();
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');

    await touchTap(page, '[data-pf="play-surface"]', aimHere);
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    await touchTap(page, '[data-pf="aim-cancel"]');
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');

    await at(page, 'play-frame').press('ArrowLeft');
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    await at(page, 'play-frame').press('Escape');
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'idle');
    // Nothing was launched by any of the three, so each really cancelled.
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
  });

  test('reaches every aim action by touch, on the same listeners', async ({ page }) => {
    await armDragProbe(page);
    const box = await surfaceBox(page);

    await touchTap(page, '[data-pf="play-surface"]', clientOf(box, 1100, 420));
    await nextFrames(page);
    await expect(at(page, 'play-surface')).toHaveAttribute('data-pf-aim', 'aiming');
    const aimed = await valueOf(page, 'aim-angle');

    await touchTap(page, '[data-pf="aim-left"]');
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBe((aimed + ANGLE_STEP) % 360);
    await touchTap(page, '[data-pf="power-down"]');
    await nextFrames(page);
    expect(await valueOf(page, 'power')).toBe(60 - POWER_STEP);

    await touchTap(page, '[data-pf="aim-launch"]');
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
    // A touch is a tap and never a drag either.
    expect(await dragCount(page)).toBe(0);
  });

  test('shows an off-multiple strength exactly, on a real range input', async ({ page }) => {
    // A range input SNAPS its value to a multiple of its own step, and only a
    // real one does: a stand-in stores whatever it is given. A drag reaches a
    // strength that is not a multiple of five easily - a hundred units of pull
    // is 47 percent of the scale - and a track stepping in fives would have
    // shown 45 while the arrow was drawn at 47 and the readout announced 47.
    const box = await surfaceBox(page);
    const from = clientOf(box, 300, 360);
    const to = clientOf(box, 200, 360);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await nextFrames(page);

    // (100 - 30) / (180 - 30) is 0.4667, which rounds to 47 percent.
    expect(await valueOf(page, 'power')).toBe(47);
    await expect(at(page, 'aim-readout')).toHaveText(/, power 47 percent$/, SETTLE);
    // The element is holding the value, not merely displaying it: what the
    // steppers step from next is what the track reports.
    await page.mouse.up();
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
  });

  test('reaches the chrome controls by touch as well as the aim ones', async ({ page }) => {
    // "Every action", not every aim action: the pause control and the buttons
    // inside the overlay it opens are actions too, and a touch has to reach
    // all of them. The panel buttons carry no marker of their own, so they are
    // selected the way the rest of the suite selects them.
    await touchTap(page, '[data-pf="pause"]');
    await expect(at(page, 'turn')).toHaveText('PAUSED', SETTLE);
    await expect(at(page, 'panel-pause')).toBeVisible();

    // Settings is the second button of the pause panel; opening it and
    // closing it again is two more touch-reached controls. Its Close carries
    // a marker of its own from PF-10, when SPEC section 17's Reset all data
    // and the two halves of its confirmation joined the panel ahead of it: a
    // control selected by position is one that quietly starts naming a
    // different control the day another is added in front of it.
    await touchTap(page, '[data-pf="panel-pause"] button:nth-of-type(2)');
    await expect(at(page, 'panel-settings')).toBeVisible();
    await touchTap(page, '[data-pf="settings-close"]');
    await expect(at(page, 'panel-settings')).toBeHidden();

    await touchTap(page, '[data-pf="panel-pause"] button:nth-of-type(1)');
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await expect(at(page, 'panel-pause')).toBeHidden();
  });

  test('reaches every aim action by keyboard, with no pointer at all', async ({ page }) => {
    // A real Tab walk, so the surface is focused the way a player focuses it.
    // What each key is WORTH is graded in tests/browser/keyboard-aim.spec.ts
    // and in the unit suite, where a press can be timed: a key held past SPEC
    // section 5.1's 250 ms is a hold by the section's own definition, and a
    // round trip on a loaded machine can outlast that. The claim here is the
    // parity one, that every aim action is reachable from the keyboard.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute('data-pf') ?? '',
      ),
    ).toBe('play-frame');
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBe(0);

    await page.keyboard.press('ArrowLeft');
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBeGreaterThanOrEqual(ANGLE_STEP);

    await page.keyboard.press('ArrowUp');
    await nextFrames(page);
    const raised = await valueOf(page, 'power');
    expect(raised).toBeGreaterThanOrEqual(60 + POWER_STEP);
    await page.keyboard.press('ArrowDown');
    await nextFrames(page);
    expect(await valueOf(page, 'power')).toBeLessThanOrEqual(raised - POWER_STEP);

    await page.keyboard.press('Space');
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
  });

  test('keeps a drag aiming after the pointer leaves the canvas, item C9', async ({
    page,
  }) => {
    // The capture clause. Without setPointerCapture on pointerdown, the
    // pointermove events stop arriving the moment the pointer crosses the
    // canvas edge and the aim freezes half way through the gesture.
    const box = await surfaceBox(page);
    const surface = at(page, 'play-surface');
    const from = clientOf(box, 300, 360);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 60, from.y, { steps: 4 });
    await nextFrames(page);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    const inside = await valueOf(page, 'aim-angle');

    // Off the bottom edge of the canvas, into the controls below it, and far
    // enough that the aim has to have turned if it is still tracking.
    const outside = { x: box.left + box.width / 2, y: box.top + box.height + 80 };
    await page.mouse.move(outside.x, outside.y, { steps: 6 });
    await nextFrames(page);
    const beyond = await valueOf(page, 'aim-angle');
    expect(beyond).not.toBe(inside);
    await expect(surface).toHaveAttribute('data-pf-aim', 'aiming');
    await page.mouse.up();
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
  });

  test('carries touch-action pinch-zoom outside a capture, item C9', async ({ page }) => {
    // QUALITY-BAR section 3: `none` for the duration of an active capture and
    // at no other moment, because `none` denies magnification as well as
    // panning, and a phone is where both matter most.
    const readTouchAction = async (): Promise<string> =>
      page.evaluate(() => {
        const canvas = document.querySelector('[data-pf="play-surface"]');
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('the play surface is not in the document');
        }
        return getComputedStyle(canvas).touchAction;
      });

    expect(await readTouchAction()).toBe('pinch-zoom');

    // The drag is kept under the minimum so that it cancels rather than
    // launching, which leaves the turn where it is for the tap below.
    const box = await surfaceBox(page);
    const from = clientOf(box, 300, 360);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 20, from.y, { steps: 3 });
    expect(await readTouchAction()).toBe('none');
    await page.mouse.up();
    await expect(at(page, 'play-surface')).toHaveAttribute('data-pf-aim', 'idle');
    expect(await readTouchAction()).toBe('pinch-zoom');

    // And a tap, which takes no capture at all, never takes it away.
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    const spot = clientOf(box, 1000, 300);
    await tapAt(page, spot.x, spot.y);
    await nextFrames(page);
    await expect(at(page, 'play-surface')).toHaveAttribute('data-pf-aim', 'aiming');
    expect(await readTouchAction()).toBe('pinch-zoom');
  });

  test('refuses the whole no-drag path outside the player s own turn', { tag: '@drive' }, async ({
    page,
  }) => {
    // THE PAGE'S CLOCK IS THE TEST'S, from before the navigation. From PF-9 a
    // launched turn runs on by itself and comes back to the player a few
    // seconds later, so a phase that refuses is a phase a test has to HOLD
    // rather than race: the frames below are driven by hand and then stopped.
    await page.clock.install({ time: 0 });
    await startMatch(page);
    await expect(at(page, 'turn')).toHaveText('YOUR TURN', SETTLE);
    await advance(page, 4);

    // The positive control first, in the turn that allows an aim: the same
    // controls are offered and the same press works. Without it, "nothing
    // happened" would be satisfied by a row of controls that never worked.
    const box = await surfaceBox(page);
    for (const marker of CONTROLS) {
      await expect(at(page, marker), marker).toHaveCount(1);
      await expect(at(page, marker), marker).toHaveAttribute('aria-disabled', 'false');
    }
    const spot = clientOf(box, 1100, 400);
    await tapAt(page, spot.x, spot.y);
    await advance(page, 1);
    const aimed = await valueOf(page, 'aim-angle');
    await at(page, 'aim-left').dispatchEvent('click');
    await advance(page, 1);
    expect(await valueOf(page, 'aim-angle')).toBe((aimed + ANGLE_STEP) % 360);

    // Then the same row in a phase that refuses. Presence before
    // reachability: every control is still in the document and still
    // focusable, and it is the refusal that stops it rather than the control
    // having been taken away, so a phase change cannot drop focus on the body.
    await at(page, 'aim-launch').click();
    let inPlay = false;
    for (let frame = 0; frame < 40 && !inPlay; frame += 1) {
      await advance(page, 1);
      inPlay = (await turnText(page)) === 'IN PLAY';
    }
    expect(inPlay).toBe(true);
    await expect(at(page, 'turn')).toHaveText('IN PLAY', SETTLE);
    for (const marker of CONTROLS) {
      await expect(at(page, marker), marker).toHaveCount(1);
      await expect(at(page, marker), marker).toBeVisible();
      await expect(at(page, marker), marker).toHaveAttribute('aria-disabled', 'true');
    }
    // Dispatched rather than clicked, because a refused control is one the
    // driver itself declines to press: the listener has to be reached for the
    // refusal to be the game's and not the harness's.
    const refusedAngle = await valueOf(page, 'aim-angle');
    await at(page, 'aim-left').dispatchEvent('click');
    await at(page, 'power-up').dispatchEvent('click');
    await at(page, 'aim-launch').dispatchEvent('click');
    await advance(page, 1);
    expect(await valueOf(page, 'aim-angle')).toBe(refusedAngle);
    await expect(at(page, 'play-surface')).toHaveAttribute('data-pf-aim', 'idle');
  });
});
