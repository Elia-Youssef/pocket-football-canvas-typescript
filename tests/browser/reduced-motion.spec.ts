import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Item E6, method T, evidence `playwright/reduced-motion`:
 *
 *   "prefers-reduced-motion removes every animation entirely, including screen
 *    shake and particles, while leaving simulation timing identical."
 *
 * Driven over the BUILT bundle under the real media preference, one browser
 * context per mode, so the two runs differ in the preference and in nothing
 * else. Every test states the equality or the zero it requires and fails on
 * anything else; nothing here watches a scene and reports what it saw.
 *
 * THE TRAP, AND THE IMPLEMENTATION THIS RULES OUT. A blanket cancel of every
 * animation also stops `transitionend` and `animationend` being delivered, so
 * whatever was sequenced on the end of one never runs and the ORDER of states
 * changes rather than the pacing. QUALITY-BAR section 4 forbids that. The
 * first test is what tells the two implementations apart: the same scripted
 * turn is driven in both modes and the whole sequence of turn states, together
 * with where all three bodies finish, has to come out IDENTICAL.
 *
 * EVERY MEASUREMENT HAS A POSITIVE CONTROL IN THE OTHER MODE. "Nothing moved"
 * is also what a broken renderer produces, so each zero below is paired with
 * the same measurement taken with the preference off, which must not be zero.
 *
 * WHAT THIS FILE GRADES, AND WHAT IT DOES NOT, disclosed rather than left to
 * be found. Two of the criterion's clauses are graded here: the screen shake,
 * which the second test measures as a displacement of the whole scene, and the
 * identical sequence and outcome, which the first test measures as an equality
 * of the turn states and the resting positions. The third test grades "every
 * animation entirely" at whole-canvas granularity, on the one scene where a
 * page can tell the two modes apart: a world at rest with a maximum aim held,
 * where nothing can change between two frames except an animation.
 *
 * FOUR CLAUSES ARE GRADED AT THE UNIT LAYER, and this is why. The trail, the
 * impact flash and the wall-segment flash are alive only WHILE the world is
 * moving, so a canvas comparison between two modes is comparing two scenes
 * that differ because the ball is in a different place, not because an effect
 * was drawn; and the particles are the goal burst, which is not reachable in
 * the shipped composition at all until the opponent driver arrives at PF-9 and
 * a match can get past the player's first turn. All four are asserted over the
 * real effects layer in tests/unit/reduced-motion.test.ts, each with the
 * positive control that the same input draws under the preference off:
 * "draws no trail, no flash, no particle and no pulse" and "removes the
 * particles a goal would have burst, and the frame pulse". The particles
 * clause re-homes into this file at PF-9 with the rest of that part's list.
 *
 * THE STORED SETTING SPEC SECTION 17 ASKS FOR IS NOT HERE EITHER. The
 * composition root reads the platform preference and nothing else, because the
 * token stylesheet answers no `data-motion` selector: an override read only at
 * the root would stop the canvas animating and leave every chrome duration
 * where it was, which is two motion modes at once. The setting lands with the
 * part that owns both halves.
 */

/**
 * Starvation budgets rather than correctness ones. These tests read the whole
 * canvas back pixel for pixel and drive real shots to rest, and the mutation
 * harness runs this suite with a build going beside it.
 */
const SETTLE = { timeout: 120_000 };
const A_WHOLE_TEST = 240_000;

/** SPEC section 18's fills, as the bytes they are read back as. */
const PLAYER_FILL = [0x55, 0x90, 0xce] as const;
const OPPONENT_FILL = [0x6e, 0x17, 0x12] as const;
const BALL_FILL = [0xfa, 0xfa, 0xf8] as const;

/** The centre of each body, in design units, from the drawn pixels. */
interface Centres {
  readonly player: { x: number; y: number };
  readonly opponent: { x: number; y: number };
  readonly ball: { x: number; y: number };
}

/** What one scripted turn produced, for the two modes to be compared on. */
interface Turn {
  readonly states: readonly string[];
  readonly centres: Centres;
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

/** Every body's centre in one read, so the three come from one frame. */
async function centres(page: Page): Promise<Centres> {
  return page.evaluate(
    (fills) => {
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
      const measure = (wanted: readonly number[], tolerance: number): { x: number; y: number } => {
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let row = 0; row < canvas.height; row += 1) {
          for (let column = 0; column < canvas.width; column += 1) {
            const at = (row * canvas.width + column) * 4;
            if (
              Math.abs(Number(pixels[at]) - Number(wanted[0])) > tolerance ||
              Math.abs(Number(pixels[at + 1]) - Number(wanted[1])) > tolerance ||
              Math.abs(Number(pixels[at + 2]) - Number(wanted[2])) > tolerance
            ) {
              continue;
            }
            const designX = column / scaleX;
            const designY = 720 - row / scaleY;
            minX = Math.min(minX, designX);
            maxX = Math.max(maxX, designX);
            minY = Math.min(minY, designY);
            maxY = Math.max(maxY, designY);
          }
        }
        return {
          x: Math.round(((minX + maxX) / 2) * 10) / 10,
          y: Math.round(((minY + maxY) / 2) * 10) / 10,
        };
      };
      return {
        // The two team fills are far from anything else on the pitch; the
        // ball's white is three bytes from the boundary token, so it is
        // matched tightly enough to tell the two apart.
        player: measure(fills.player, 6),
        opponent: measure(fills.opponent, 6),
        ball: measure(fills.ball, 2),
      };
    },
    { player: PLAYER_FILL, opponent: OPPONENT_FILL, ball: BALL_FILL },
  );
}

/**
 * One scripted turn: the aim controls set to an exact angle and an exact
 * strength, Launch pressed, and the turn readout sampled every frame until the
 * turn has passed. The controls are SPEC section 5.0's own path, so the launch
 * is the same launch in both modes rather than a gesture timed by the machine.
 */
async function scriptedTurn(page: Page, power: string): Promise<Turn> {
  // The sequence is recorded by a mutation observer rather than by polling on
  // an animation frame: a state the readout passed through between two frames
  // is a state that happened, and an observer sees it however the frames fall.
  await page.evaluate(() => {
    const readout = document.querySelector('[data-pf="turn"]');
    if (!(readout instanceof HTMLElement)) {
      throw new Error('the turn readout is not in the document');
    }
    const store = window as unknown as { __pfStates?: string[] };
    const seen: string[] = [readout.textContent ?? ''];
    store.__pfStates = seen;
    new MutationObserver(() => {
      const text = readout.textContent ?? '';
      if (seen.at(-1) !== text) {
        seen.push(text);
      }
    }).observe(readout, { characterData: true, childList: true, subtree: true });
  });
  await page.locator('[data-pf="aim-angle"]').fill('0');
  await page.locator('[data-pf="power"]').fill(power);
  expect(await page.locator('[data-pf="power"]').inputValue()).toBe(power);
  await page.locator('[data-pf="aim-launch"]').click();
  await expect(page.locator('[data-pf="turn"]')).toHaveText('OPPONENT IS AIMING', SETTLE);
  await nextFrames(page, 5);
  const states = await page.evaluate(
    () => (window as unknown as { __pfStates?: string[] }).__pfStates ?? [],
  );
  return { states, centres: await centres(page) };
}

/**
 * One page in one motion mode, opened, driven and closed before the other mode
 * is opened at all.
 *
 * ONE PAGE AT A TIME IS THE POINT. Two contexts alive together leave one of
 * their pages unfocused, and an unfocused page has its animation frames
 * throttled to about a second apiece: the arm that is not in front then plays
 * the same turn over four times as much wall clock, and a sampling window
 * counted in frames misses the shot it was opened for. The preference is set
 * on the context, which is what a real platform does, so the stylesheet and the
 * composition root read the same answer.
 */
async function inMotionMode<T>(
  browser: Browser,
  mode: 'reduce' | 'no-preference',
  baseURL: string,
  drive: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    baseURL,
    reducedMotion: mode,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    await nextFrames(page, 10);
    return await drive(page);
  } finally {
    await context.close();
  }
}

/**
 * Two static features of the play surface, as device pixel indices: the
 * leftmost covered column of the top wall band and the topmost covered row
 * above the pitch. Both belong to the cached pitch layer, which never changes
 * between frames, so either one moving means the whole scene was offset, which
 * is the only thing SPEC section 14's shake does.
 *
 * THE WINDOW IS BOUNDED BY THE EVENT, not by a frame count and not by the wall
 * clock, and both of those were tried first. A frame count closes in a third of
 * a second on the engine that runs its frames at better than two hundred a
 * second, before the player has even crossed to the ball; a wall-clock budget
 * closes before the collision on a machine loaded enough that a frame takes
 * longer than QUALITY-BAR section 7's quarter-second ceiling, because the
 * simulation then advances slower than real time by design. So the sampler
 * watches for the ball to start moving, which is the collision itself, and
 * keeps sampling for a fixed number of frames after it. The wall clock is left
 * as a starvation budget and nothing else.
 */
async function railSamples(page: Page, budgetMs: number): Promise<SurfaceSamples> {
  return page.evaluate(async (budget) => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('the play surface has no 2d context');
    }
    const scaleX = canvas.width / 1280;
    const scaleY = canvas.height / 720;
    // Design y 641 is inside the top wall band, which spans 635 to 647, and
    // design x 640 is the centre line, where that band is unbroken.
    const row = Math.round((720 - 641) * scaleY);
    const column = Math.round(640 * scaleX);
    const seen: string[] = [];
    const ball: number[] = [];
    const covered = (value: number): boolean => value > 128;
    // The ball's own line, for the moving control below.
    const ballRow = Math.round((720 - 360) * scaleY);
    const started = performance.now();
    // Frames sampled after the ball first moved. SPEC section 14's shake runs
    // for a fifth of a second of simulation time, so this is generous at every
    // frame rate and does not depend on one.
    const tail = 90;
    let movedAt = -1;
    for (
      let frame = 0;
      frame < 4000 &&
      (movedAt < 0 ? performance.now() - started < budget : frame - movedAt < tail);
      frame += 1
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const band = context.getImageData(0, row, canvas.width, 1).data;
      let leftmost = -1;
      for (let at = 0; at < canvas.width; at += 1) {
        if (covered(Number(band[at * 4 + 3]))) {
          leftmost = at;
          break;
        }
      }
      const strip = context.getImageData(column, 0, 1, canvas.height).data;
      let topmost = -1;
      for (let at = 0; at < canvas.height; at += 1) {
        if (covered(Number(strip[at * 4 + 3]))) {
          topmost = at;
          break;
        }
      }
      seen.push(`${String(leftmost)},${String(topmost)}`);
      // The leftmost pixel of the ball on its own line. It moves in BOTH
      // modes, so it is what proves the launch happened inside the sampled
      // frames rather than after them: without it, "the static features never
      // moved" is also what a window that missed the whole shot reports.
      const line = context.getImageData(0, ballRow, canvas.width, 1).data;
      let ballAt = -1;
      for (let at = 0; at < canvas.width; at += 1) {
        if (
          Math.abs(Number(line[at * 4]) - 0xfa) <= 3 &&
          Math.abs(Number(line[at * 4 + 1]) - 0xfa) <= 3 &&
          Math.abs(Number(line[at * 4 + 2]) - 0xf8) <= 3
        ) {
          ballAt = at;
          break;
        }
      }
      ball.push(ballAt);
      if (movedAt < 0 && ball.length > 1 && ballAt !== ball[0]) {
        movedAt = ball.length - 1;
      }
    }
    return { still: seen, ball, movedAt };
  }, budgetMs);
}

/** The launch pressed and the surface sampled inside one page task. */
async function launchAndSampleRail(page: Page, budgetMs: number): Promise<SurfaceSamples> {
  await page.locator('[data-pf="aim-angle"]').fill('0');
  await page.locator('[data-pf="power"]').fill('100');
  const sampling = railSamples(page, budgetMs);
  await page.locator('[data-pf="aim-launch"]').click();
  return sampling;
}

/** Whole-canvas images, and the wall clock they were taken across. */
interface Held {
  readonly images: readonly string[];
  readonly span: number;
}

/** What one sampling run saw: two static features, and one that must move. */
interface SurfaceSamples {
  readonly still: readonly string[];
  readonly ball: readonly number[];
  /** The sample the ball first moved in, which is the collision, or -1. */
  readonly movedAt: number;
}

/**
 * Consecutive whole-canvas snapshots, for a scene nothing may animate in.
 *
 * TWO CONDITIONS, BOTH REQUIRED, and neither implies the other. The window has
 * to span a whole period of the arrow's pulse, or the control in the other mode
 * is comparing two points of one sweep rather than a sweep; and it has to hold
 * enough images that "they are all the same one" is a statement about a series.
 * Reading a canvas back costs a quarter of a second on one engine under load
 * and a millisecond on another, so a count does not imply a span and a span
 * does not imply a count. The wall clock is a starvation budget on top of both.
 */
async function snapshots(page: Page, budgetMs: number): Promise<Held> {
  return page.evaluate(async (budget) => {
    const canvas = document.querySelector('[data-pf="play-surface"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('the play surface is not in the document');
    }
    const seen: string[] = [];
    const wanted = 6;
    const period = 700;
    const started = performance.now();
    while (
      (seen.length < wanted || performance.now() - started < period) &&
      performance.now() - started < budget
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      seen.push(canvas.toDataURL());
    }
    return { images: seen, span: performance.now() - started };
  }, budgetMs);
}

test.describe('PF-12 reduced motion, item E6', () => {
  test('plays the same turn to the same finish with the preference both ways', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(A_WHOLE_TEST);
    const reduced = await inMotionMode(browser, 'reduce', baseURL ?? '', (page) =>
      scriptedTurn(page, '60'),
    );
    const full = await inMotionMode(browser, 'no-preference', baseURL ?? '', (page) =>
      scriptedTurn(page, '60'),
    );
    // THE SEQUENCE OF STATES, in order, with no state added, dropped or
    // reordered. This is the clause a blanket animation cancel breaks.
    expect(reduced.states).toEqual(full.states);
    // Non-vacuous: the turn really passed through play rather than sitting in
    // the state it started in.
    expect(full.states).toEqual(['YOUR TURN', 'IN PLAY', 'OPPONENT IS AIMING']);
    // THE OUTCOME. Where all three bodies came to rest, to a tenth of a design
    // unit, read off the surface itself.
    expect(reduced.centres).toEqual(full.centres);
    // And the shot really did move things: the player left its kickoff spot
    // and the ball left the centre.
    expect(full.centres.player.x).toBeGreaterThan(320);
    expect(full.centres.ball.x).toBeGreaterThan(660);
  });

  test('shakes the surface by exactly nothing, where it shakes without', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(A_WHOLE_TEST);
    // A full-strength launch straight into the ball, sampled until the ball
    // moves and for ninety frames after it. The wall clock below is a
    // starvation budget on a loaded machine, not the window.
    const reduced = await inMotionMode(browser, 'reduce', baseURL ?? '', (page) =>
      launchAndSampleRail(page, 60_000),
    );
    const full = await inMotionMode(browser, 'no-preference', baseURL ?? '', (page) =>
      launchAndSampleRail(page, 60_000),
    );
    {
      // THE TIMING CONTROL, and it comes first: the collision happened INSIDE
      // the sampled frames and ninety more were taken after it. Without it,
      // "the static features never moved" is also what a window that missed
      // the whole shot would report.
      for (const [mode, samples] of [
        ['reduce', reduced],
        ['no-preference', full],
      ] as const) {
        expect(samples.movedAt, mode).toBeGreaterThan(0);
        expect(samples.still.length - samples.movedAt, mode).toBe(90);
        expect(new Set(samples.ball).size, mode).toBeGreaterThan(1);
      }
      // The static features never moved: one reading, all ninety frames.
      expect([...new Set(reduced.still)]).toHaveLength(1);
      // The reading is a real reading and not a blank canvas.
      expect(reduced.still[0]).not.toBe('-1,-1');
      // THE POSITIVE CONTROL: the same launch with the preference off moves
      // the whole scene on the backing store at least once.
      expect(new Set(full.still).size).toBeGreaterThan(1);
      // And it moved the scene rather than losing it: every reading is a real
      // one, so the difference is an offset and not a frame that failed.
      expect(full.still.filter((sample) => sample === '-1,-1')).toEqual([]);
    }
    // The chrome never moves in either mode: the shake is on the backing store,
    // and DESIGN section 7 keeps it off the DOM.
    for (const mode of ['reduce', 'no-preference'] as const) {
      const boxes = await inMotionMode(browser, mode, baseURL ?? '', (page) =>
        page.evaluate(() => {
          const frame = document.querySelector('[data-pf="play-frame"]');
          const hud = document.querySelector('[data-pf="hud"]');
          const canvas = document.querySelector('[data-pf="play-surface"]');
          if (
            !(frame instanceof HTMLElement) ||
            !(hud instanceof HTMLElement) ||
            !(canvas instanceof HTMLElement)
          ) {
            throw new Error('the play frame, the HUD and the surface are not all present');
          }
          return {
            frame: getComputedStyle(frame).transform,
            hud: getComputedStyle(hud).transform,
            canvas: getComputedStyle(canvas).transform,
          };
        }),
      );
      expect(boxes.frame, mode).toBe('none');
      expect(boxes.hud, mode).toBe('none');
      expect(boxes.canvas, mode).toBe('none');
    }
  });

  test('holds a still scene perfectly still, where it animates without', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(A_WHOLE_TEST);
    // A maximum aim held over a world at rest. Nothing in the scene can change
    // from one frame to the next except an animation, so the whole canvas is
    // the measurement and the arrow's maximum pulse is the one animation left
    // to find.
    const holdMaximum = async (page: Page): Promise<Held> => {
      await page.locator('[data-pf="aim-angle"]').fill('0');
      await page.locator('[data-pf="power"]').fill('100');
      await expect(page.locator('[data-pf="aim-readout"]')).toHaveText(
        /power 100 percent$/,
        SETTLE,
      );
      return snapshots(page, 60_000);
    };
    const reduced = await inMotionMode(browser, 'reduce', baseURL ?? '', holdMaximum);
    const full = await inMotionMode(browser, 'no-preference', baseURL ?? '', holdMaximum);
    // The window really covered a whole period of the pulse, 640 ms, in both
    // arms: without that the control below is comparing two points of one
    // sweep rather than a sweep. Reading the canvas back is slow enough on one
    // engine that the count of images is no evidence of the span at all.
    for (const [mode, held] of [
      ['reduce', reduced],
      ['no-preference', full],
    ] as const) {
      expect(held.span, mode).toBeGreaterThan(640);
      expect(held.images.length, mode).toBeGreaterThanOrEqual(6);
    }
    // A scene that is not allowed to move, over that whole period: one image.
    expect([...new Set(reduced.images)]).toHaveLength(1);
    expect(reduced.images[0]?.startsWith('data:image/png')).toBe(true);
    // THE POSITIVE CONTROL: with the preference off the same held aim pulses,
    // so the frames are not all the same image.
    expect(new Set(full.images).size).toBeGreaterThan(1);
  });
});
