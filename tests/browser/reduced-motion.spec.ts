import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import {
  A_WHOLE_TEST,
  EVERY_PIXEL,
  FRAME_MS,
  SETTLE,
  advance,
  centres,
  nextFrames,
  pauseClock,
  playUntil,
  scores,
  startMatch,
  turnText,
} from './support/game';
import type { Centres, MatchSetup } from './support/game';

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
 * THREE CLAUSES ARE GRADED AT THE UNIT LAYER, and this is why. The trail, the
 * impact flash and the wall-segment flash are alive only WHILE the world is
 * moving, so a canvas comparison between two modes is comparing two scenes
 * that differ because the ball is in a different place, not because an effect
 * was drawn. All three are asserted over the real effects layer in
 * tests/unit/reduced-motion.test.ts, each with the positive control that the
 * same input draws under the preference off.
 *
 * THE PARTICLES ARE HERE, from PF-9. They are the goal burst, and no goal was
 * reachable in the shipped composition until the opponent driver arrived and a
 * match could get past the player's first turn; until then the clause was
 * graded at the unit layer with the split disclosed. The last test below plays
 * a real match to a real goal in both modes and samples the celebration hold,
 * which is the one window where the world is frozen and the ONLY thing that
 * can change between two frames is the celebration itself.
 *
 * THE STORED SETTING SPEC SECTION 17 ASKS FOR IS NOT HERE EITHER. The
 * composition root reads the platform preference and nothing else, because the
 * token stylesheet answers no `data-motion` selector: an override read only at
 * the root would stop the canvas animating and leave every chrome duration
 * where it was, which is two motion modes at once. The setting lands with the
 * part that owns both halves.
 */

/**
 * THE BUDGETS, THE FILLS AND THE READING COME FROM `support/game.ts`, which is
 * where the design space and SPEC section 18's fills already live. The copies
 * that used to sit here were a second place for a palette change to be missed,
 * and the reading they drove searched the WHOLE canvas, so each circle's
 * bounding box quietly included the goal frame painted in the same team tint.
 */

/** What one scripted turn produced, for the two modes to be compared on. */
interface Turn {
  readonly states: readonly string[];
  readonly centres: Centres;
  /** Frames the drive charged, and the page time it actually consumed. */
  readonly frames: number;
  readonly elapsedMs: number;
}

/**
 * One coordinate at a tenth of a design unit. The comparison the tests make of
 * these is an equality between two arms rather than a measurement of either,
 * and a tenth is the resolution the reading was rounded to before it moved
 * into the shared module.
 */
function tenths(centre: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(centre.x * 10) / 10, y: Math.round(centre.y * 10) / 10 };
}

async function restingCentres(page: Page): Promise<Centres> {
  // EVERY PIXEL, because this reading IS the assertion. The shared reading
  // samples every third pixel by default, which is a ninth of the cost and a
  // bounding box that can sit up to about a design unit and a half from the
  // one every pixel gives; the drives in this suite want that trade and this
  // comparison does not, because what it claims is that two motion modes came
  // to rest in the SAME place.
  const scene = await centres(page, EVERY_PIXEL);
  return {
    player: tenths(scene.player),
    opponent: tenths(scene.opponent),
    ball: tenths(scene.ball),
  };
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
    // THE RECORDING STOPS AT THE HANDOVER, from PF-9. The opponent answers its
    // own turn now, so the match runs on by itself a fraction of a second
    // later; a recorder left running would catch a different amount of the
    // NEXT turn in each arm and compare two windows rather than one turn.
    const observer = new MutationObserver(() => {
      const text = readout.textContent ?? '';
      if (seen.at(-1) !== text) {
        seen.push(text);
      }
      if (text === 'OPPONENT IS AIMING') {
        observer.disconnect();
      }
    });
    observer.observe(readout, { characterData: true, childList: true, subtree: true });
  });
  await page.locator('[data-pf="aim-angle"]').fill('0');
  await page.locator('[data-pf="power"]').fill(power);
  expect(await page.locator('[data-pf="power"]').inputValue()).toBe(power);
  await page.locator('[data-pf="aim-launch"]').click();
  // DRIVEN TO THE HANDOVER AND STOPPED. From PF-9 the opponent answers its own
  // turn, so a reading taken a few frames after the handover would be taken at
  // a different point of the match in each mode; driving one frame at a time
  // and stopping at the handover puts both readings on the same frame.
  //
  // THE PAGE'S CLOCK IS STOPPED BEFORE THIS LOOP RUNS, so the frames below are
  // the only ones there are, and the two readings taken either side of the loop
  // are what lets the test say so. With the clock ticking, the guard between
  // two driven frames is a round trip the machine also drives frames in, and
  // the two arms are then compared after different amounts of match.
  const before = await page.evaluate(() => Date.now());
  let handedOver = false;
  let frames = 0;
  for (; frames < 200 && !handedOver; frames += 1) {
    await advance(page, 1);
    handedOver = (await turnText(page)) === 'OPPONENT IS AIMING';
  }
  expect(handedOver).toBe(true);
  const elapsedMs = (await page.evaluate(() => Date.now())) - before;
  const states = await page.evaluate(
    () => (window as unknown as { __pfStates?: string[] }).__pfStates ?? [],
  );
  return { states, centres: await restingCentres(page), frames, elapsedMs };
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
 *
 * AND WHERE THE TEST OWNS THE CLOCK, IT IS STOPPED THE MOMENT THE MATCH IS
 * RUNNING. An installed clock is not a stopped one; it keeps advancing with
 * real time and keeps firing frames, so a drive that looks frame by frame is
 * also being driven by the machine, and the amount of match that happens
 * between two round trips is whatever the machine had time for. That is the
 * race behind the WebKit flake this file carries on record, and it is what
 * `pauseClock` removes: from here on the ONLY time the page sees is the time
 * `advance` and `fastForward` hand it. The match is started first, because
 * reaching a running match is a wait on real frames.
 */
async function inMotionMode<T>(
  browser: Browser,
  mode: 'reduce' | 'no-preference',
  baseURL: string,
  drive: (page: Page) => Promise<T>,
  setup: MatchSetup = {},
  ownClock = false,
): Promise<T> {
  const context = await browser.newContext({
    baseURL,
    reducedMotion: mode,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    if (ownClock) {
      // Installed before the navigation, so every timestamp the page reads is
      // the test's; the frames below are then driven rather than waited for.
      await page.clock.install({ time: 0 });
    }
    await startMatch(page, setup);
    await expect(page.locator('[data-pf="turn"]')).toHaveText('YOUR TURN', SETTLE);
    if (ownClock) {
      await pauseClock(page);
      await advance(page, 10);
    } else {
      await nextFrames(page, 10);
    }
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

/**
 * SPEC section 6.4 freezes the world for 1.2 s after a goal, as a literal,
 * because a bound asserted against the symbol that defines it passes for
 * whatever value the symbol takes; and the step the celebration is sampled in,
 * small enough that a dozen samples fit well inside that freeze.
 */
const CELEBRATION_HOLD_MS = 1200;
const SAMPLE_STEP_MS = 25;

/** What one sampled celebration produced, in both motion modes. */
interface Celebration {
  readonly images: string[];
  readonly goals: number;
  /** Page time between the first sample and the last, on the page's own clock. */
  readonly spanMs: number;
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
  test(
    'plays the same turn to the same finish with the preference both ways',
    { tag: '@drive' },
    async ({ browser, baseURL }) => {
    test.setTimeout(A_WHOLE_TEST);
    const reduced = await inMotionMode(
      browser,
      'reduce',
      baseURL ?? '',
      (page) => scriptedTurn(page, '60'),
      {},
      true,
    );
    const full = await inMotionMode(
      browser,
      'no-preference',
      baseURL ?? '',
      (page) => scriptedTurn(page, '60'),
      {},
      true,
    );
    // THE DRIVE ADMITTED NO REAL TIME, in either arm, and that is asserted
    // before anything is compared: every frame the loop charged is FRAME_MS
    // long, so a page whose clock is stopped advances by exactly that many
    // milliseconds and one whose clock is still ticking advances by more.
    // Without it the two arms are compared after different amounts of match.
    for (const [mode, turn] of [
      ['reduce', reduced],
      ['no-preference', full],
    ] as const) {
      expect(turn.frames, mode).toBeGreaterThan(0);
      expect(turn.elapsedMs, mode).toBe(turn.frames * FRAME_MS);
    }
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
  test(
    'bursts no particles at a goal, where it bursts them without',
    { tag: '@drive' },
    async ({ browser, baseURL }) => {
    test.setTimeout(A_WHOLE_TEST);
    // The particles clause, re-homed from tests/unit/reduced-motion.test.ts at
    // PF-9. A goal needs an opponent to hand the turn back and a mode that
    // does not stop the match first, so this is a First to 3 played by the
    // scripted striker in `support/game.ts`, whose aim is a second reading of
    // SPEC section 8.1 rather than a copy of the game's own routine.
    //
    // THE CELEBRATION HOLD IS THE WINDOW, and it is the only honest one: SPEC
    // section 6.4 freezes the world for 1.2 s after a goal, so nothing in the
    // scene can change from frame to frame except the celebration, which is
    // the burst and the goal-frame pulse. The samples are taken in fiftieths
    // of a second of the test's own clock, so a dozen of them fit inside it.
    const toTheGoal = async (page: Page): Promise<Celebration> => {
      // Caught within ONE driven frame of the goal, because SPEC section 6.4
      // freezes the world for only 1.2 s and a batched drive could spend most
      // of that before it noticed. The sampling window below has to sit inside
      // the hold or it is comparing a celebration against a kickoff.
      const frames = await playUntil(
        page,
        900,
        'right',
        async () => {
          return (await turnText(page)) === 'GOAL';
        },
        'YOUR TURN',
        1,
      );
      expect(frames).toBeLessThan(900);
      // THE WINDOW IS BOUNDED BY THE STATE, not by a count of samples. SPEC
      // section 6.4's hold is 1.2 s of SIMULATION time and the engines do not
      // agree on how much of it a driven frame consumes, so a fixed number of
      // samples runs past the whistle on one of them and compares a
      // celebration against the kickoff that follows it. Sampling only while
      // the readout still says GOAL cannot: everything below is inside one
      // celebration on every engine.
      //
      // AND THE PAGE'S OWN CLOCK IS RECORDED BESIDE EVERY SAMPLE, because the
      // readout alone cannot say the window was inside the hold: the clock was
      // installed and not stopped until PF-15's fix, so between the guard and
      // the capture real time reached the page, fired frames, and could expire
      // the hold with the loop still believing it was inside one celebration.
      // That is the WebKit flake on record. With the clock stopped, the stamps
      // below are the steps this loop drove and nothing else, and the span they
      // cover is asserted against SPEC section 6.4's own 1.2 s.
      const images: string[] = [];
      const stamps: number[] = [];
      while (images.length < 12 && (await turnText(page)) === 'GOAL') {
        await page.clock.fastForward(SAMPLE_STEP_MS);
        if ((await turnText(page)) !== 'GOAL') {
          break;
        }
        const sample = await page.evaluate(() => {
          const canvas = document.querySelector('[data-pf="play-surface"]');
          if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error('the play surface is not in the document');
          }
          return { image: canvas.toDataURL(), at: Date.now() };
        });
        images.push(sample.image);
        stamps.push(sample.at);
      }
      const board = await scores(page);
      const first = stamps[0] ?? 0;
      const last = stamps[stamps.length - 1] ?? 0;
      return { images, goals: board.player + board.opponent, spanMs: last - first };
    };
    const reduced = await inMotionMode(
      browser,
      'reduce',
      baseURL ?? '',
      toTheGoal,
      { mode: 'first-to', target: 3 },
      true,
    );
    const full = await inMotionMode(
      browser,
      'no-preference',
      baseURL ?? '',
      toTheGoal,
      { mode: 'first-to', target: 3 },
      true,
    );
    // Non-vacuous: a goal really was scored in both arms, and the window each
    // one sampled really held a series rather than a single frame.
    expect(reduced.goals).toBeGreaterThan(0);
    expect(full.goals).toBeGreaterThan(0);
    // At least two frames of the same celebration in each arm. The engines
    // do not agree on how much simulation a driven frame consumes, so how many
    // fit inside SPEC section 6.4's 1.2 s hold is theirs to decide; what the
    // comparison needs is more than one, and the assertions below are then
    // about what changed BETWEEN frames of one celebration.
    expect(reduced.images.length).toBeGreaterThanOrEqual(2);
    expect(full.images.length).toBeGreaterThanOrEqual(2);
    // THE WHOLE SAMPLED SPAN LIES INSIDE SPEC SECTION 6.4's HOLD, and it is
    // made of the test's own steps alone. The span between the first stamp and
    // the last is asserted to be exactly the steps this loop drove, which is
    // only true of a page whose clock is stopped, and then to be inside the
    // 1.2 s the section freezes the world for, which is what makes every
    // sample a sample of one celebration on every engine and under any load.
    for (const [mode, arm] of [
      ['reduce', reduced],
      ['no-preference', full],
    ] as const) {
      expect(arm.spanMs, mode).toBe((arm.images.length - 1) * SAMPLE_STEP_MS);
      expect(arm.spanMs, mode).toBeGreaterThan(0);
      expect(arm.spanMs, mode).toBeLessThan(CELEBRATION_HOLD_MS);
    }
    // The measurement itself, recorded on the run rather than only asserted
    // about, because this test's whole subject is a window that used to be
    // decided by the machine: a reader of a report can see what the sampled
    // span actually was on the engine that reported it.
    test.info().annotations.push({
      type: 'sampled span',
      description:
        `reduce ${String(reduced.spanMs)} ms over ${String(reduced.images.length)} samples, ` +
        `no-preference ${String(full.spanMs)} ms over ${String(full.images.length)} samples, ` +
        `hold ${String(CELEBRATION_HOLD_MS)} ms`,
    });
    // The celebration is already over the moment it is born: one image, over
    // the whole sampled window.
    expect([...new Set(reduced.images)]).toHaveLength(1);
    expect(reduced.images[0]?.startsWith('data:image/png')).toBe(true);
    // THE POSITIVE CONTROL: with the preference off the same goal bursts, so
    // the frames are not all the same image.
    expect(new Set(full.images).size).toBeGreaterThan(1);
  });
});
