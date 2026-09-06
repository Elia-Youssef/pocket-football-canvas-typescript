import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Item G5, method T, evidence `playwright/keyboard-aim`:
 *
 *   "A complete keyboard aiming model exists: aim direction adjustable, power
 *    adjustable, launch and cancel bound, with the current aim and power
 *    announced. A full match is playable with no pointer."
 *
 * THE RATES ARE CHECKED AGAINST A SECOND IMPLEMENTATION. `sweptDegrees` below
 * is written from SPEC section 5.1's own numbers - a 250 ms delay, a linear
 * ramp from 60 to 240 degrees per second over one second, then 240 - and
 * imports nothing from the game. The game's own model is in `core/aiming.ts`
 * and this file never reads it, so an agreement here is two readings of the
 * document agreeing rather than one reading agreeing with itself.
 *
 * EVERY KEY WINDOW IS BRACKETED, NOT GUESSED, and measured where the game's
 * own handlers see it rather than out here: the round trip that delivers a key
 * press has been measured taking longer than the section's own 250 ms delay on
 * a machine running three engines at once, at which point the press IS a hold
 * and the model is right to sweep. So each assertion allows exactly what the
 * section says a press of the length this run measured is worth, and the
 * quantisation allowance is the longest frame this run actually took. Both
 * numbers come from the run, so the check keeps its meaning on a loaded
 * machine instead of turning into a wide constant, and closes to a single
 * value on a quiet one.
 *
 * THE TWO MODELS ARE COMPARED IN THE PIXELS. SPEC section 5.1 requires the
 * arrow to render identically from a keyboard aim and from a pointer one. The
 * last test produces the SAME aim both ways - 60 percent power is a 120 unit
 * drag, and straight at the ball is the opening direction - and reads the
 * canvas back both times, so "one presentation path" is measured on the
 * surface rather than inferred from the source.
 *
 * A FULL MATCH WITH NO POINTER is played to full time in
 * tests/unit/discrete-aim.test.ts, over these same modules, because the
 * composition root builds a match with no clock and no goal target and nothing
 * answers the opponent's seam, so a browser match parks after the first shot.
 * What is driven here is the complete keyboard turn over the built bundle. The
 * split is disclosed in this part's report and RE-HOMES AT PF-9, which owns
 * the modes and the opponent driver together; it is not a claim that this file
 * already covers it.
 */

const SETTLE = { timeout: 120_000 };
const A_WHOLE_TEST = 240_000;
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

/** SPEC section 5.1, as literals, and read by nothing the game exports. */
const HOLD_DELAY = 0.25;
const RAMP_SECONDS = 1;
const RATE_FROM = 60;
const RATE_TO = 240;
const TAP_DEGREES = 3;
const FINE_TAP_DEGREES = 1;
const POWER_TAP_PERCENT = 5;
const OPENING_PERCENT = 60;

/**
 * Half of the one degree the aim control carries, which is the whole of the
 * difference between the model's own value and the value it shows.
 */
const ROUNDING = 0.5;

/** QUALITY-BAR section 4's floor between two polite writes, in seconds. */
const ANNOUNCE_INTERVAL = 0.5;

/**
 * The total an unmodified held arrow has swept after `held` seconds, written
 * from SPEC section 5.1 and from nothing else: nothing through the delay, the
 * area under a rate rising linearly from 60 to 240 over the ramp, then the top
 * rate. The section's own worked example, 360 degrees at 2.125 seconds, falls
 * out of it.
 */
function sweptDegrees(held: number): number {
  const active = held - HOLD_DELAY;
  if (active <= 0) {
    return 0;
  }
  const rampTotal = ((RATE_FROM + RATE_TO) * RAMP_SECONDS) / 2;
  if (active >= RAMP_SECONDS) {
    return rampTotal + RATE_TO * (active - RAMP_SECONDS);
  }
  return RATE_FROM * active + ((RATE_TO - RATE_FROM) * active * active) / (2 * RAMP_SECONDS);
}

/**
 * The same for a held power key: nothing through the delay, then 40 points of
 * the percentage scale a second, with no ramp (SPEC section 5.1).
 */
function sweptPercent(held: number): number {
  return Math.max(0, held - HOLD_DELAY) * 40;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Reading {
  readonly changed: number;
  readonly furthest: number;
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

interface Press {
  readonly key: string;
  /** Seconds the key was down, measured where the game's own handlers see it. */
  readonly seconds: number;
}

interface KeyRecord {
  readonly presses: readonly Press[];
  /** The longest frame this page took while a key was down, in seconds. */
  readonly maxGap: number;
}

/**
 * The probe every key assertion in this file is judged against, measured in
 * the page rather than out here.
 *
 * A PRESS IS NOT INSTANTANEOUS. `keyboard.press` is a round trip, and on a
 * machine running three engines at once it has been measured taking longer
 * than SPEC section 5.1's own 250 ms delay - at which point the press is a
 * HOLD by the section's definition and pays out a rate as well as its tap.
 * The model is right to do that, so the test measures how long each key was
 * actually down and allows each press exactly what the section says a press
 * of that length is worth. Where the machine is quiet the allowance is zero
 * and the assertions are exact.
 *
 * THE FRAME PROBE records the longest frame of the window, which is the whole
 * of the quantisation error: a model driven by frames can be a frame ahead at
 * the start and a frame behind at the end, and by nothing else. It keeps
 * recording for one frame past the last release, because the frame that
 * straddles a release is exactly the one the model did not get.
 */
async function armKeyProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector('[data-pf="play-frame"]');
    if (!(frame instanceof HTMLElement)) {
      throw new Error('the play surface frame is not in the document');
    }
    const probe = {
      presses: [] as { key: string; seconds: number }[],
      maxGap: 0,
      open: new Map<string, number>(),
      settle: 0,
    };
    (window as unknown as { __pfKeys?: typeof probe }).__pfKeys = probe;
    frame.addEventListener(
      'keydown',
      (event) => {
        if (event instanceof KeyboardEvent && !event.repeat) {
          probe.open.set(event.key, performance.now());
        }
      },
      true,
    );
    frame.addEventListener(
      'keyup',
      (event) => {
        if (!(event instanceof KeyboardEvent)) {
          return;
        }
        const started = probe.open.get(event.key);
        if (started === undefined) {
          return;
        }
        probe.open.delete(event.key);
        probe.presses.push({
          key: event.key,
          seconds: (performance.now() - started) / 1000,
        });
        probe.settle = 1;
      },
      true,
    );
    let previous: number | null = null;
    const tick = (now: number): void => {
      const watching = probe.open.size > 0;
      if (previous !== null && (watching || probe.settle > 0)) {
        probe.maxGap = Math.max(probe.maxGap, (now - previous) / 1000);
        if (!watching) {
          probe.settle -= 1;
        }
      }
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readKeys(page: Page): Promise<KeyRecord> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __pfKeys?: { presses: { key: string; seconds: number }[]; maxGap: number };
      }
    ).__pfKeys;
    return { presses: probe?.presses ?? [], maxGap: probe?.maxGap ?? 0 };
  });
}

/** The last press of a key, which is the one an assertion has just made. */
function lastPress(record: KeyRecord, key: string): number {
  for (let at = record.presses.length - 1; at >= 0; at -= 1) {
    const press = record.presses[at];
    if (press !== undefined && press.key === key) {
      return press.seconds;
    }
  }
  throw new Error(`the probe recorded no press of ${key}`);
}

/**
 * The most a press of this length could have swept beyond its tap. The frame
 * that was already in flight when the key went down carries time from before
 * it, so the model's own hold can be a frame longer than the press was.
 */
function slackDegrees(record: KeyRecord, key: string): number {
  return sweptDegrees(lastPress(record, key) + record.maxGap);
}

function slackPercent(record: KeyRecord, key: string): number {
  return sweptPercent(lastPress(record, key) + record.maxGap);
}

/**
 * A shown direction against a window that may straddle a whole turn. Past 360
 * degrees the reading folds, which is what the slider's own range means, so
 * containment is an arc: the direction has to lie within the window's own
 * width of its start, going the way the key turns.
 */
function expectDirectionWithin(
  shown: number,
  floor: number,
  ceiling: number,
  label: string,
): void {
  // Not a claim about the build: a window wider than a turn would make the
  // containment below true of every direction, so it is refused as a guard on
  // this file's own arithmetic.
  const width = ceiling - floor;
  expect(width, `${label} window width`).toBeLessThan(360);
  const along = (((shown - floor) % 360) + 360) % 360;
  expect(
    along,
    `${label}: ${String(shown)} against ${String(floor)}..${String(ceiling)}`,
  ).toBeLessThanOrEqual(width);
}

async function valueOf(page: Page, marker: string): Promise<number> {
  return Number(await page.locator(`[data-pf="${marker}"]`).inputValue());
}

/**
 * The scroll offset once it has stopped moving. Focusing an element below the
 * fold scrolls it into view, and an engine may take several frames over it, so
 * a reading taken immediately afterwards is of a scroll still in progress and
 * would be blamed on whatever key was pressed next.
 */
async function settledScroll(page: Page): Promise<number> {
  let last = Number.NaN;
  for (let step = 0; step < 30; step += 1) {
    const now = await page.evaluate(() => window.scrollY);
    if (now === last) {
      return now;
    }
    last = now;
    await nextFrames(page, 2);
  }
  throw new Error('the page never stopped scrolling');
}

async function focusSurface(page: Page): Promise<void> {
  // A real Tab walk, never element.focus(): the pause control leads the
  // document and the play surface follows it.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const marker = await page.evaluate(
    () => document.activeElement?.getAttribute('data-pf') ?? '',
  );
  expect(marker).toBe('play-frame');
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
 * How the surface differs from the captured baseline: how many pixels moved,
 * and how far the furthest of them is from the player's circle. The circle is
 * at its kickoff place in every test here, so the centre is the spec's own.
 */
async function readSurface(page: Page): Promise<Reading> {
  return page.evaluate(() => {
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
    let changed = 0;
    let furthest = 0;
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
          Math.hypot(column / scaleX - 300, 720 - row / scaleY - 360),
        );
      }
    }
    return { changed, furthest };
  });
}

test.describe('PF-6 the keyboard aiming model, item G5', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(A_WHOLE_TEST);
    page.setDefaultTimeout(SETTLE.timeout);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
  });

  test('enters aim mode on focusing the surface, at the ball and 60 percent', async ({
    page,
  }) => {
    await expect(page.locator('[data-pf="play-surface"]')).toHaveAttribute(
      'data-pf-aim',
      'idle',
    );
    // SPEC section 5.1: a single focusable element with an accessible name.
    // The canvas cannot be it - QUALITY-BAR section 1 keeps the scene out of
    // the accessibility tree, and an aria-hidden element may not be focusable
    // - so the frame around it carries the tabindex, the name and the keys.
    const frame = page.locator('[data-pf="play-frame"]');
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute('tabindex', '0');
    await expect(frame).toHaveAttribute('aria-label', 'Play surface');
    await expect(frame).toHaveAttribute('role', 'application');
    await expect(page.locator('[data-pf="play-surface"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    await focusSurface(page);
    await nextFrames(page);
    await expect(page.locator('[data-pf="play-surface"]')).toHaveAttribute(
      'data-pf-aim',
      'aiming',
    );
    // SPEC section 5.1: pointing at the ball at 60 percent on the first turn.
    // The player and the ball share the midline at kickoff, so the opening
    // direction is straight down the pitch.
    expect(await valueOf(page, 'aim-angle')).toBe(0);
    expect(await valueOf(page, 'power')).toBe(OPENING_PERCENT);
  });

  test('adjusts the direction by the tap step, and by the fine step', async ({ page }) => {
    await armKeyProbe(page);
    await focusSurface(page);
    await nextFrames(page);

    // The aim is bracketed rather than equated, and the bracket closes to a
    // single value whenever the press was short enough to be only a tap. Left
    // turns the aim the way the design space turns and right turns it back.
    let low = 0;
    let high = 0;
    const step = async (
      key: string,
      arrow: string,
      degrees: number,
      forward: boolean,
    ): Promise<void> => {
      await page.keyboard.press(key);
      await nextFrames(page);
      const shown = await valueOf(page, 'aim-angle');
      const slack = slackDegrees(await readKeys(page), arrow);
      if (forward) {
        low += degrees;
        high += degrees + slack;
      } else {
        low -= degrees + slack;
        high -= degrees;
      }
      // The half degree on each side is the slider's own rounding and nothing
      // else: the aim is a whole number of degrees on the control, so a true
      // value anywhere in the window shows as a value in this one.
      expectDirectionWithin(shown, low - ROUNDING, high + ROUNDING, key);
    };

    await step('ArrowLeft', 'ArrowLeft', TAP_DEGREES, true);
    await step('ArrowLeft', 'ArrowLeft', TAP_DEGREES, true);
    await step('ArrowRight', 'ArrowRight', TAP_DEGREES, false);
    // The modifier is the fine step, one degree, and it is not a ramp.
    await step('Shift+ArrowLeft', 'ArrowLeft', FINE_TAP_DEGREES, true);
    // The bracket carries the whole claim. A build that gave the modifier the
    // unmodified step would have had to land two degrees outside the last one.
  });

  test('adjusts the power by five points a tap, in both directions', async ({ page }) => {
    await armKeyProbe(page);
    await focusSurface(page);
    await nextFrames(page);

    await page.keyboard.press('ArrowUp');
    await nextFrames(page);
    const raised = await valueOf(page, 'power');
    const up = slackPercent(await readKeys(page), 'ArrowUp');
    expect(raised).toBeGreaterThanOrEqual(OPENING_PERCENT + POWER_TAP_PERCENT);
    expect(raised).toBeLessThanOrEqual(
      Math.ceil(OPENING_PERCENT + POWER_TAP_PERCENT + up),
    );

    await page.keyboard.press('ArrowDown');
    await nextFrames(page);
    const first = slackPercent(await readKeys(page), 'ArrowDown');
    await page.keyboard.press('ArrowDown');
    await nextFrames(page);
    const second = slackPercent(await readKeys(page), 'ArrowDown');
    const lowered = await valueOf(page, 'power');
    const expected = raised - 2 * POWER_TAP_PERCENT;
    expect(lowered).toBeLessThanOrEqual(expected);
    expect(lowered).toBeGreaterThanOrEqual(Math.floor(expected - first - second));
  });

  test('integrates a held arrow against real elapsed time', async ({ page }) => {
    await armKeyProbe(page);
    await focusSurface(page);
    await nextFrames(page);

    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(1400);
    await page.keyboard.up('ArrowLeft');
    await nextFrames(page);
    const swept = await valueOf(page, 'aim-angle');
    const record = await readKeys(page);
    const hold = { held: lastPress(record, 'ArrowLeft'), maxGap: record.maxGap };
    expect(hold.maxGap).toBeGreaterThan(0);
    expect(hold.held).toBeGreaterThan(1);

    // The model integrates the frame deltas that arrive between the two key
    // events, so it can be a frame ahead at the start and a frame behind at
    // the end, and by nothing else. Both bounds are the second implementation
    // of the section's own rates evaluated at the window this run measured.
    const ceiling = TAP_DEGREES + sweptDegrees(hold.held + hold.maxGap) + ROUNDING;
    const floor =
      TAP_DEGREES + sweptDegrees(Math.max(0, hold.held - hold.maxGap)) - ROUNDING;
    expectDirectionWithin(swept, floor, ceiling, 'a held arrow');
    // And a hold is worth vastly more than the tap that began it, so a build
    // that had lost the hold entirely could not land in that window.
    expect(floor).toBeGreaterThan(4 * TAP_DEGREES);
  });

  test('sweeps a whole turn in about two seconds, as the section derives', async ({
    page,
  }) => {
    await armKeyProbe(page);
    await focusSurface(page);
    await nextFrames(page);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(2125);
    await page.keyboard.up('ArrowLeft');
    await nextFrames(page);
    const shown = await valueOf(page, 'aim-angle');
    const record = await readKeys(page);
    const hold = { held: lastPress(record, 'ArrowLeft'), maxGap: record.maxGap };

    const ceiling = TAP_DEGREES + sweptDegrees(hold.held + hold.maxGap) + ROUNDING;
    const floor =
      TAP_DEGREES + sweptDegrees(Math.max(0, hold.held - hold.maxGap)) - ROUNDING;
    // The hold really did pay out a whole turn, which is the claim SPEC
    // section 5.1 derives: 0.25 s of delay, 150 degrees of ramp, then 210
    // degrees at the top rate.
    expect(ceiling).toBeGreaterThan(360);
    expectDirectionWithin(shown, floor, ceiling, 'a whole turn');
  });

  test('launches on Space and cancels on Escape, then opens the pause', async ({ page }) => {
    await focusSurface(page);
    await nextFrames(page);
    await expect(page.locator('[data-pf="play-surface"]')).toHaveAttribute(
      'data-pf-aim',
      'aiming',
    );

    // Escape with an aim active cancels it and launches nothing.
    await page.keyboard.press('Escape');
    await nextFrames(page);
    await expect(page.locator('[data-pf="play-surface"]')).toHaveAttribute(
      'data-pf-aim',
      'idle',
    );
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);

    // Escape again, with no aim to cancel, opens the pause overlay.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('PAUSED', SETTLE);
    await expect(page.locator('[data-pf="panel-pause"]')).toBeVisible();
    await page
      .locator('[data-pf="panel-pause"] button', { hasText: 'Resume' })
      .click();
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);

    // And Space launches the aim it was showing.
    await page.locator('[data-pf="play-frame"]').press('ArrowUp');
    await nextFrames(page);
    expect(await valueOf(page, 'power')).toBe(OPENING_PERCENT + POWER_TAP_PERCENT);
    await page.locator('[data-pf="play-frame"]').press('Space');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('IN PLAY', SETTLE);
  });

  test('launches on Enter as well as on Space', async ({ page }) => {
    await focusSurface(page);
    await nextFrames(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('IN PLAY', SETTLE);
  });

  test('takes the arrows off the page only while the surface has focus', async ({
    page,
  }) => {
    // A viewport the page is taller than, so that scrolling is something the
    // browser would actually do. Without it "the page did not scroll" is
    // satisfied by a page that could not scroll anyway.
    await page.setViewportSize({ width: 700, height: 400 });
    await page.goto('/');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight,
    );
    expect(scrollable).toBe(true);
    await armKeyProbe(page);

    // The control: the same key, on a control that does not handle it, moves
    // the page. That is the behaviour the surface has to suppress.
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-pf') ?? ''),
    ).toBe('pause');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.scrollY > 0);
    // Nothing was aimed by it either: the keys are bound to the surface and
    // never to the document.
    await expect(page.locator('[data-pf="play-surface"]')).toHaveAttribute(
      'data-pf-aim',
      'idle',
    );

    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-pf') ?? ''),
    ).toBe('play-frame');
    // The baseline is read AFTER the focus move has finished scrolling the
    // surface into view, because that scroll is the platform's and not the
    // arrow key's. What is asserted is that the key moved nothing at all.
    const parked = await settledScroll(page);
    await page.keyboard.press('ArrowDown');
    await nextFrames(page);
    expect(await settledScroll(page)).toBe(parked);

    // The key reached the aim instead of the page. Bracketed rather than
    // equated for the reason every other key assertion here is: a round trip
    // on a loaded machine can outlast SPEC section 5.1's 250 ms, at which
    // point the press IS a hold and the model is right to sweep further. On a
    // quiet machine the slack is zero and this is the exact five-point tap.
    const lowered = await valueOf(page, 'power');
    const slack = slackPercent(await readKeys(page), 'ArrowDown');
    expect(lowered).toBeLessThanOrEqual(OPENING_PERCENT - POWER_TAP_PERCENT);
    expect(lowered).toBeGreaterThanOrEqual(
      Math.floor(OPENING_PERCENT - POWER_TAP_PERCENT - slack),
    );
  });

  test('announces the aim and the power, throttled, as a percentage', async ({ page }) => {
    const readout = page.locator('[data-pf="aim-readout"]');
    await expect(readout).toHaveAttribute('aria-live', 'polite');
    await expect(readout).toBeVisible();

    await page.evaluate(() => {
      const target = document.querySelector('[data-pf="aim-readout"]');
      if (!(target instanceof HTMLElement)) {
        throw new Error('the aim readout is not in the document');
      }
      const store = window as unknown as { __pfSaid?: string[] };
      store.__pfSaid = [];
      new MutationObserver(() => {
        store.__pfSaid?.push(target.textContent ?? '');
      }).observe(target, { childList: true, characterData: true, subtree: true });
    });

    const opened = Date.now();
    await focusSurface(page);
    await nextFrames(page);
    await expect(readout).toHaveText(/^Aim \d+ degrees, power 60 percent$/);

    // A held arrow sweeps 240 degrees a second, so an unthrottled region
    // would be rewritten on every frame of the hold. The floor is half a
    // second between polite writes, so a hold of this length can pay out only
    // a handful, and the last of them is the newest value rather than the
    // oldest one queued behind it.
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(1200);
    await page.keyboard.up('ArrowLeft');
    // Long enough afterwards for the write the throttle was still holding to
    // land, so the last line said is the aim as it finally stands.
    await page.waitForTimeout(700);
    await nextFrames(page, 4);
    const observed = (Date.now() - opened) / 1000;

    const said = await page.evaluate(
      () => (window as unknown as { __pfSaid?: string[] }).__pfSaid ?? [],
    );
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said.length).toBeLessThanOrEqual(
      Math.ceil(observed / ANNOUNCE_INTERVAL) + 2,
    );
    for (const line of said) {
      expect(line).toMatch(/^Aim \d+ degrees, power \d+ percent$/);
    }
    // The last thing said is what the controls are showing, so the region
    // never falls behind the aim it is describing.
    const shown = await valueOf(page, 'aim-angle');
    expect(said[said.length - 1]).toBe(`Aim ${String(shown)} degrees, power 60 percent`);
  });

  test('draws the same arrow a pointer aim draws, from one presentation path', async ({
    page,
  }) => {
    // The keyboard aim: straight at the ball at 60 percent power.
    await captureBaseline(page);
    await nextFrames(page);
    const still = await readSurface(page);
    // The control for the instrument: an idle frame is identical to the one
    // before it, so a count below is a comparison that ran.
    expect(still.changed).toBe(0);
    await focusSurface(page);
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBe(0);
    expect(await valueOf(page, 'power')).toBe(OPENING_PERCENT);
    const byKey = await readSurface(page);
    expect(byKey.changed).toBeGreaterThan(0);

    // The same aim as a drag. Sixty percent of the power scale is a drag of
    // 120 design units, and pulling back along the pitch aims down it, so the
    // two models are being asked for exactly the same shot.
    await page.goto('/');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
    await captureBaseline(page);
    await nextFrames(page);
    const box = await surfaceBox(page);
    const from = clientOf(box, 300, 360);
    const to = clientOf(box, 180, 360);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await nextFrames(page);
    expect(await valueOf(page, 'aim-angle')).toBe(0);
    expect(await valueOf(page, 'power')).toBe(OPENING_PERCENT);
    const byDrag = await readSurface(page);
    await page.mouse.up();

    // The same pixels, to within antialiasing: one arrow, drawn once, by one
    // path that neither model owns.
    expect(byDrag.changed).toBeGreaterThan(0);
    expect(Math.abs(byKey.furthest - byDrag.furthest)).toBeLessThan(2);
    expect(Math.abs(byKey.changed - byDrag.changed) / byDrag.changed).toBeLessThan(0.02);
    // And the arrow reaches as far as the strength says it should: 60 percent
    // of the way from the 30 unit minimum to the 180 unit maximum is 120.
    expect(byKey.furthest).toBeGreaterThan(110);
    expect(byKey.furthest).toBeLessThan(140);
  });
});
