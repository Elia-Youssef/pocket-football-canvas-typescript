import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The step every browser spec now takes before it can do anything: reach a
 * running match through SPEC section 9's mode menu.
 *
 * WHY THIS EXISTS. Until PF-9 the composition root started a match by itself,
 * so a spec's whole setup was `goto('/')`. The menu replaced that provisional
 * start, and the same six actions would otherwise be copied into every spec in
 * the suite. Everything here is SETUP: it presses real controls in the real
 * document and asserts nothing a criterion is graded on.
 *
 * THE WARM-UP, AND WHY IT IS THE DEFAULT. SPEC section 19 turns the aim guide
 * on for the first two turns of a FIRST-EVER match whatever the difficulty and
 * whatever the setting, so the first match of a session draws a dotted
 * prediction across the pitch. Every spec that reads the canvas back was
 * written against a pitch with no guide on it, so the default here plays a
 * match, leaves it through the pause overlay and starts the wanted one, which
 * is the ordinary journey of a player on their second game. A spec that WANTS
 * the first-ever state asks for it with `firstEver`.
 *
 * TIME IS THE TEST'S, WHERE A TEST NEEDS IT. `page.clock.install()` before the
 * navigation makes every timestamp the page reads the test's own, and
 * `advance` then hands the frame driver deltas of a quarter of a second, which
 * is exactly QUALITY-BAR section 7's ceiling: the simulation consumes all of
 * it and the match clock charges all of it, so the two never disagree. A whole
 * 60 second match is 240 of them, which is seconds of wall clock rather than a
 * minute of waiting.
 */

/** Starvation budgets, not correctness ones, as every spec here uses them. */
export const SETTLE = { timeout: 120_000 };
export const A_WHOLE_TEST = 240_000;

/** The frame delta every driven frame charges, in milliseconds. */
export const FRAME_MS = 250;

/** SPEC section 3's design space, as the readings below convert through it. */
export const LOGICAL_WIDTH = 1280;
export const LOGICAL_HEIGHT = 720;

/** SPEC section 18's fills, as the bytes they are read back as. */
export const PLAYER_FILL = [0x55, 0x90, 0xce] as const;
export const OPPONENT_FILL = [0x6e, 0x17, 0x12] as const;
export const BALL_FILL = [0xfa, 0xfa, 0xf8] as const;

export interface MatchSetup {
  readonly mode?: 'quick' | 'first-to' | 'ladder' | 'hotseat';
  readonly duration?: number;
  readonly target?: number;
  readonly difficulty?: 'casual' | 'pro' | 'ace';
  /** SPEC section 11's setting. Omitted, the guide is switched off. */
  readonly guide?: boolean;
  /** Leave the session on its first-ever match. See the header. */
  readonly firstEver?: boolean;
}

function at(page: Page, marker: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pf="${marker}"]`);
}

/**
 * Load the page and put SPEC section 19's first-launch overlay away. The
 * viewport is deliberately left where the caller set it: a spec that is about
 * a small screen sets one before it opens the game.
 *
 * THE OVERLAY IS PUT AWAY IF IT IS THERE, and from PF-10 that is a real
 * condition rather than a hedge. SPEC section 19 shows it on a FIRST launch
 * and never again once it has been dismissed, and PF-10 made that dismissal
 * survive the navigation, so a spec that opens the game a second time inside
 * one test lands on a session that has already seen it and has nothing to put
 * away. Both halves of the claim itself, shown once and not again, are graded
 * in tests/browser/onboarding.spec.ts against a raw navigation; nothing here
 * is asserted on behalf of a criterion, and what this function owes its
 * callers is the same premise it always owed them: the menu, with no overlay
 * over it.
 */
export async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
  const howTo = at(page, 'panel-how-to-play');
  if (await howTo.isVisible()) {
    await page.locator('[data-pf="panel-how-to-play"] button', { hasText: 'Close' }).click();
  }
  await expect(howTo).toBeHidden(SETTLE);
}

/** Set every control the menu offers to what this setup asks for. */
export async function chooseMode(page: Page, setup: MatchSetup): Promise<void> {
  await at(page, `mode-${setup.mode ?? 'quick'}`).check();
  if (setup.difficulty !== undefined) {
    await at(page, `difficulty-${setup.difficulty}`).check();
  }
  if (setup.duration !== undefined) {
    await at(page, `duration-${String(setup.duration)}`).check();
  }
  if (setup.target !== undefined) {
    await at(page, `target-${String(setup.target)}`).check();
  }
  // Last, because choosing a mode or a difficulty puts the guide back to that
  // choice's own default (SPEC section 11).
  const guide = at(page, 'mode-guide');
  if (setup.guide === true) {
    await guide.check();
  } else {
    await guide.uncheck();
  }
}

/** Pause a running match and quit it, which is SPEC section 7's way to MENU. */
export async function leaveToMenu(page: Page): Promise<void> {
  await at(page, 'pause').click();
  await expect(at(page, 'panel-pause')).toBeVisible(SETTLE);
  await page.locator('[data-pf="panel-pause"] button', { hasText: 'Quit' }).click();
  await expect(at(page, 'panel-mode')).toBeVisible(SETTLE);
}

/** Load the page and reach a running match of this mode. */
export async function startMatch(page: Page, setup: MatchSetup = {}): Promise<void> {
  await openGame(page);
  await chooseMode(page, setup);
  await at(page, 'mode-start').click();
  if (setup.firstEver !== true) {
    await leaveToMenu(page);
    await chooseMode(page, setup);
    await at(page, 'mode-start').click();
  }
  await expect(at(page, 'turn')).not.toHaveText('MENU', SETTLE);
  // The menu hands focus back to the pause control when it closes, which is
  // where every panel in this game hands it and is what keeps a state change
  // off the document body. A tab walk, though, is a statement about the ORDER
  // the document offers from its start, so the setup puts focus back where a
  // freshly loaded page leaves it. Nothing here asserts anything: it restores
  // the premise the specs were written against before the menu existed.
  // Blurring alone is not enough: an engine keeps its sequential navigation
  // starting point at the element that was blurred, so the next Tab carries on
  // from the middle of the document. Focusing the body moves that starting
  // point back to the top, and the temporary tabindex is what makes the body
  // focusable for the one call; it is taken off again immediately.
  await page.evaluate(() => {
    const body = document.body;
    body.setAttribute('tabindex', '-1');
    body.focus();
    body.removeAttribute('tabindex');
  });
}

/**
 * Let the frame driver draw, so a reading is of a frame and not of a gap.
 *
 * TEN OF THEM AT THE START OF A TEST is the pattern most callers use, and the
 * reason is the surface: it is sized by a resize observer whose first callback
 * lands after the document has loaded, so a baseline captured before that is
 * of a scene at another scale, and a comparison against it reads a resize as a
 * change. The specs that read the canvas back then compare colour rather than
 * alpha, so an antialiased edge cannot pass for something drawn.
 */
export async function nextFrames(page: Page, count = 2): Promise<void> {
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

/** Drive `frames` frames of the installed clock, each one FRAME_MS long. */
export async function advance(page: Page, frames: number): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await page.clock.fastForward(FRAME_MS);
  }
}

/**
 * How far ahead of the moment it is read the pause target sits, in
 * milliseconds of the page's own clock.
 *
 * A target the ticking clock has already passed is refused as the past, and
 * the read and the pause are two round trips, so the margin has to outlast a
 * round trip on the slowest engine under load. It is not paid for in
 * simulation: the jump collapses every pending timer onto the target and runs
 * it once, so the page is charged ONE frame however far the target is, and
 * QUALITY-BAR section 7's delta ceiling decides what that one frame is worth.
 */
export const PAUSE_TARGET_MS = 2000;

/**
 * Stop the installed clock, so that from here on the only time the page sees
 * is the time the test hands it.
 *
 * AN INSTALLED CLOCK IS NOT A STOPPED ONE. It keeps advancing with real time
 * and keeps firing frames (measured at the PF-14 close: 1.5 s of real waiting
 * advanced it 1.5 s and fired 94 frames on Chromium and 50 on WebKit), so a
 * window a test believes it is driving frame by frame is being driven by the
 * machine as well, and any premise of the form "nothing ran between these two
 * readings" is unenforced. `tests/browser/orientation.spec.ts` states the same
 * reasoning at length and was the first test here to need it.
 *
 * EVERY DRIVEN TEST THAT INSTALLS THE CLOCK NOW STOPS IT, and that is a rule
 * rather than a habit: `tests/unit/browser-spec-hygiene.test.ts` reads the spec
 * files and reports an install site that is not followed by this call. The
 * evidence it was needed is on record twice, in the WebKit particle flake and
 * in a Quick Match that reached FULL TIME while a max-drag test waited for the
 * handover.
 *
 * THE MATCH IS STARTED FIRST, AND THEN THE FRAMES ARE THE TEST'S. Every
 * control the chrome owns syncs the readouts in its own handler, so a match
 * still STARTS under a stopped clock; what a stopped clock removes is the
 * simulation, so anything the SIMULATION produces - the turn leaving the
 * player, the whistle, and every pixel on the canvas - arrives on a driven
 * frame and nowhere else. A test that used to reach one of those by waiting
 * now drives it, which is the premise being made true rather than assumed.
 *
 * THE PAUSE OUTLIVES A NAVIGATION. It is recorded as an init script, so a
 * document opened after it starts paused as well; one call covers a test that
 * starts several matches.
 */
export async function pauseClock(page: Page): Promise<void> {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + PAUSE_TARGET_MS);
}

/** A cheap stamp of everything the play surface is drawing right now. */
async function surfaceStamp(page: Page): Promise<number> {
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
    let stamp = 0;
    for (let slot = 0; slot < pixels.length; slot += 1) {
      stamp = (Math.imul(stamp, 31) + Number(pixels[slot])) | 0;
    }
    return stamp;
  });
}

/** The step the settle below charges, well inside QUALITY-BAR section 7's ceiling. */
const SETTLE_STEP_MS = 100;

/**
 * The pixel step the readings below sample the surface at, and what it costs.
 *
 * THREE IS A COST DECISION AND ONE IS A RESOLUTION DECISION, so the caller
 * makes it. A circle is 68 design units across, so every third pixel still
 * samples hundreds of them; but a bounding box read on a lattice can miss the
 * outermost covered pixel on each side, which moves the centre by up to about
 * one design unit and a half at this step. A drive takes dozens of these
 * reads, so a drive asks for the cheap one; a test whose subject IS the
 * resting position asks for every pixel and pays for it once.
 */
export const SCAN_STEP = 3;
export const EVERY_PIXEL = 1;

/**
 * Drive until the surface stops changing on its own, and answer the steps it
 * took. Every motion SPEC section 14 states is event driven and expires, so a
 * scene carrying no aim and no outstanding event settles to one image.
 *
 * A measurement against a baseline is a statement about what happened BETWEEN
 * the two reads, and it is only true while nothing else is moving. A goal
 * leaves its celebration and its particles running past the moment the turn
 * comes back, and a baseline taken there attributes a burst fading at the far
 * goal to whatever the test did next. Settling first makes the premise true
 * rather than assumed, and a scene that never settles is an error here rather
 * than a quiet wrong answer somewhere later.
 */
export async function settleSurface(page: Page, budget = 40): Promise<number> {
  let previous = await surfaceStamp(page);
  for (let step = 1; step <= budget; step += 1) {
    // The jump IS the frame: a fast forward moves every pending timer onto its
    // target and runs it, so the animation frame the driver was waiting on has
    // already run and drawn by the time this returns. Waiting on two more
    // would be waiting for frames only real time can deliver, and every caller
    // of this helper now drives a STOPPED clock, where there are none.
    await page.clock.fastForward(SETTLE_STEP_MS);
    const current = await surfaceStamp(page);
    if (current === previous) {
      return step;
    }
    previous = current;
  }
  throw new Error('the play surface never stopped changing on its own');
}

/** The turn indicator's text, which is the match state a player can see. */
export async function turnText(page: Page): Promise<string> {
  return (await at(page, 'turn').textContent()) ?? '';
}

export interface Scores {
  readonly player: number;
  readonly opponent: number;
}

export async function scores(page: Page): Promise<Scores> {
  const player = (await at(page, 'score-player').textContent()) ?? '';
  const opponent = (await at(page, 'score-opponent').textContent()) ?? '';
  return { player: Number(player), opponent: Number(opponent) };
}

/**
 * Drive the clock until `done` answers true, or the budget runs out. The
 * budget is a frame count rather than a wall clock because the page's own
 * time is the test's; a spec states how much MATCH it is prepared to play.
 */
export async function driveUntil(
  page: Page,
  budget: number,
  done: () => Promise<boolean>,
  each?: () => Promise<void>,
): Promise<number> {
  for (let frame = 0; frame < budget; frame += 1) {
    await advance(page, 1);
    if (each !== undefined) {
      await each();
    }
    if (await done()) {
      return frame + 1;
    }
  }
  return budget;
}

export interface Centre {
  readonly x: number;
  readonly y: number;
}

export interface Centres {
  readonly player: Centre;
  readonly opponent: Centre;
  readonly ball: Centre;
}

/**
 * What the readings below share, named once rather than spelt into each of
 * them: a circle's fill is far from anything else on the pitch, the ball's
 * white is three bytes from the boundary token so it is matched tightly enough
 * to tell the two apart, and the two goal frames carry the team tints and live
 * outside the field bounds, so a circle is searched for inside the field.
 */
const FILL_TOLERANCE = 6;
const BALL_TOLERANCE = 2;
const GOAL_TINT_LOW = 100;
const GOAL_TINT_HIGH = 1180;

/** The design space and the bands, as one argument for a page task. */
const SURFACE_READING = {
  width: LOGICAL_WIDTH,
  height: LOGICAL_HEIGHT,
  low: GOAL_TINT_LOW,
  high: GOAL_TINT_HIGH,
};

/**
 * Every body's centre in one read, so the three come from one frame.
 *
 * THE SAMPLING STEP IS THE CALLER'S, because it is a resolution and not a
 * detail. `SCAN_STEP` is what a drive wants: dozens of reads at a ninth of the
 * cost, and a centre that can sit up to about a design unit and a half from
 * the one every pixel would give. A test whose assertion IS the resting
 * position asks for `EVERY_PIXEL`, and item E6's equality between two motion
 * modes is exactly that test.
 */
export async function centres(page: Page, step: number = SCAN_STEP): Promise<Centres> {
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
      const scaleX = canvas.width / input.reading.width;
      const scaleY = canvas.height / input.reading.height;
      const measure = (
        wanted: readonly number[],
        tolerance: number,
        insideOnly: boolean,
      ): { x: number; y: number } => {
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        // The step the caller asked for. See the header above: three samples
        // hundreds of pixels of a 68 unit circle at a ninth of the cost, and
        // one is what a resting-position equality is worth paying for.
        for (let row = 0; row < canvas.height; row += input.step) {
          for (let column = 0; column < canvas.width; column += input.step) {
            const slot = (row * canvas.width + column) * 4;
            const designX = column / scaleX;
            // The two goal frames carry the two team tints and live OUTSIDE
            // the field bounds, so the search runs inside the pitch: a frame
            // counted as part of a circle drags its centre a hundred units
            // toward the goal and every aim taken from it is wrong.
            if (insideOnly && (designX <= input.reading.low || designX >= input.reading.high)) {
              continue;
            }
            if (
              Math.abs(Number(pixels[slot]) - Number(wanted[0])) > tolerance ||
              Math.abs(Number(pixels[slot + 1]) - Number(wanted[1])) > tolerance ||
              Math.abs(Number(pixels[slot + 2]) - Number(wanted[2])) > tolerance
            ) {
              continue;
            }
            const designY = input.reading.height - row / scaleY;
            minX = Math.min(minX, designX);
            maxX = Math.max(maxX, designX);
            minY = Math.min(minY, designY);
            maxY = Math.max(maxY, designY);
          }
        }
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      };
      return {
        // The two goal frames carry the team tints, so a circle is searched
        // for inside the field alone; the ball is white, no frame is, and a
        // ball in the net is exactly where a goal has to be able to find it.
        player: measure(input.player, input.circleTolerance, true),
        opponent: measure(input.opponent, input.circleTolerance, true),
        ball: measure(input.ball, input.ballTolerance, false),
      };
    },
    {
      player: PLAYER_FILL,
      opponent: OPPONENT_FILL,
      ball: BALL_FILL,
      circleTolerance: FILL_TOLERANCE,
      ballTolerance: BALL_TOLERANCE,
      reading: SURFACE_READING,
      step,
    },
  );
}

/** What one dispatched aim attempt saw, phase by phase. */
export interface AimAttempt {
  readonly pressedAt: Centre;
  readonly afterDown: string;
  readonly afterMove: string;
  readonly afterEnd: string;
  /** The turn readout on either side of the attempt, read in the same task. */
  readonly turnBefore: string;
  readonly turnAfter: string;
}

/**
 * A press, a drag and an end, dispatched at the play surface with the pressed
 * circle's own coordinates read IN THE SAME PAGE TASK. The phase is sampled
 * after each event, because a lock that let the press through and tidied up
 * afterwards is not a lock.
 *
 * THE READING IS INLINE AND NOT A CALL TO `centres` ABOVE, and that is the
 * whole reason this helper exists here rather than as two steps in the spec. A
 * page task cannot close over a module function, so a shared reading would be
 * a second round trip, and the phases this is used in are exactly the ones
 * where the body is MOVING: between a separate read and a separate press the
 * circle has gone, the press lands on empty pitch, and a refusal test that
 * pressed nothing passes for the wrong reason. Everything the reading needs
 * is handed in, so the tolerances and the bands have one home.
 */
export async function dispatchAim(
  page: Page,
  units: number,
  ending: 'pointerup' | 'pointercancel',
  fill: readonly number[],
): Promise<AimAttempt> {
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
      const readout = document.querySelector('[data-pf="turn"]');
      if (!(readout instanceof HTMLElement)) {
        throw new Error('the turn readout is not in the document');
      }
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const scaleX = canvas.width / input.reading.width;
      const scaleY = canvas.height / input.reading.height;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let row = 0; row < canvas.height; row += input.step) {
        for (let column = 0; column < canvas.width; column += input.step) {
          const slot = (row * canvas.width + column) * 4;
          const designX = column / scaleX;
          if (designX <= input.reading.low || designX >= input.reading.high) {
            continue;
          }
          if (
            Math.abs(Number(pixels[slot]) - Number(input.fill[0])) > input.tolerance ||
            Math.abs(Number(pixels[slot + 1]) - Number(input.fill[1])) > input.tolerance ||
            Math.abs(Number(pixels[slot + 2]) - Number(input.fill[2])) > input.tolerance
          ) {
            continue;
          }
          const designY = input.reading.height - row / scaleY;
          minX = Math.min(minX, designX);
          maxX = Math.max(maxX, designX);
          minY = Math.min(minY, designY);
          maxY = Math.max(maxY, designY);
        }
      }
      const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + (centre.x * rect.width) / input.reading.width;
      const clientY =
        rect.top + ((input.reading.height - centre.y) * rect.height) / input.reading.height;
      const across = (input.units * rect.width) / input.reading.width;
      const fire = (type: string, x: number): void => {
        canvas.dispatchEvent(
          new PointerEvent(type, { pointerId: 1, clientX: x, clientY, bubbles: true }),
        );
      };
      const phase = (): string => canvas.dataset['pfAim'] ?? '';
      const turnBefore = readout.textContent ?? '';
      fire('pointerdown', clientX);
      const afterDown = phase();
      fire('pointermove', clientX + across);
      const afterMove = phase();
      fire(input.ending, clientX + across);
      return {
        pressedAt: centre,
        afterDown,
        afterMove,
        afterEnd: phase(),
        turnBefore,
        turnAfter: readout.textContent ?? '',
      };
    },
    {
      units,
      ending,
      fill,
      tolerance: FILL_TOLERANCE,
      reading: SURFACE_READING,
      step: SCAN_STEP,
    },
  );
}

/* ---------------------------------------------------------------------------
 * The scripted player, written from the documents and importing nothing from
 * the game.
 *
 * SPEC section 3 puts the goal lines at x 90 and x 1190 and the opening
 * between y 265 and y 455; SPEC section 4 gives the ball an 18 px radius.
 * SPEC section 8.1's own rule is what the aim below is: to send the ball
 * toward a goal, strike the point on its far surface from that goal, and where
 * the striker is already between the ball and the goal, move aside instead of
 * driving the ball back through its own net. It is a second reading of the
 * document rather than a copy of the opponent module, which this file
 * imports nothing from.
 * ------------------------------------------------------------------------- */

const LEFT_GOAL = 90;
const RIGHT_GOAL = 1190;
const MOUTH_CENTRE = (265 + 455) / 2;
const BALL_RADIUS = 18;
const CIRCLE_RADIUS = 34;
const TOUCHING = CIRCLE_RADIUS + BALL_RADIUS;
/** SPEC section 8.1's strike-solidity floor, so a clamp cannot become a graze. */
const MIN_STRIKE_SOLIDITY = 0.25;
/** The strength a turn spent repositioning is worth: enough to move, not to fly. */
const MOVE_ASIDE_PERCENT = 45;

export interface Aim {
  /** Whole degrees, because the angle control is a step-1 range input. */
  readonly degrees: number;
  /** Whole percent, for the same reason. */
  readonly percent: number;
}

/**
 * True when the straight trip to a point cannot touch the ball. Every step of
 * a launch lies on its own segment, so the segment's distance from the ball
 * centre decides it exactly (SPEC section 8.1).
 */
function clearsTheBall(
  from: Centre,
  ball: Centre,
  toX: number,
  toY: number,
): boolean {
  const legX = toX - from.x;
  const legY = toY - from.y;
  const lengthSquared = legX * legX + legY * legY;
  const raw =
    lengthSquared === 0
      ? 0
      : ((ball.x - from.x) * legX + (ball.y - from.y) * legY) / lengthSquared;
  const at = Math.min(Math.max(raw, 0), 1);
  return Math.hypot(from.x + legX * at - ball.x, from.y + legY * at - ball.y) >= TOUCHING;
}

/** Whole degrees in [0, 360), which is the range the angle control offers. */
function whole(degrees: number): number {
  return ((Math.round(degrees) % 360) + 360) % 360;
}

export function strikeAim(scene: Centres, attacking: 'left' | 'right'): Aim {
  const goalX = attacking === 'right' ? RIGHT_GOAL : LEFT_GOAL;
  const ball = scene.ball;
  const me = scene.player;
  if (!Number.isFinite(ball.x) || !Number.isFinite(me.x)) {
    // Nothing to aim at, which a reading taken mid-celebration can produce.
    return { degrees: 0, percent: MOVE_ASIDE_PERCENT };
  }
  // SPEC section 8.1's ideal strike side: the unit vector from the target to
  // the ball, so the ball departs along its opposite and runs at the goal.
  const idealX = ball.x - goalX;
  const idealY = ball.y - MOUTH_CENTRE;
  const idealLength = Math.hypot(idealX, idealY) || 1;
  const ix = idealX / idealLength;
  const iy = idealY / idealLength;

  const towardX = ball.x - me.x;
  const towardY = ball.y - me.y;
  if (towardX * (goalX - ball.x) + towardY * (MOUTH_CENTRE - ball.y) < 0) {
    // Standing between the ball and the goal being attacked. THE SCRIPTED
    // STRIKER'S OWN TACTIC, not a rule of SPEC section 8.1: the clamp below
    // answers this layout with the most goal-ward strike the cone admits, and
    // section 8 substitutes the block on a stated probability and on nothing
    // else, so this branch says only that a driver with no clock to beat
    // prefers to step aside here. It is taken only where the trip cannot run
    // into the ball from an uncontrolled side; where it would, the clamped
    // strike below is what is left.
    const ownGoalX = attacking === 'right' ? LEFT_GOAL : RIGHT_GOAL;
    const blockX = (ball.x + ownGoalX) / 2;
    const blockY = (ball.y + MOUTH_CENTRE) / 2;
    if (clearsTheBall(me, ball, blockX, blockY)) {
      const away = Math.atan2(blockY - me.y, blockX - me.x);
      return { degrees: whole((away * 180) / Math.PI), percent: MOVE_ASIDE_PERCENT };
    }
  }

  // SPEC section 8.1's reachable-cone rule, written from the section: a side
  // is admissible when a launch aimed at its contact point transfers at least
  // the stated minimum solidity to the ball, which inverts to one bound on
  // dot(approach, side) and carries the section's reachability test with it,
  // since that bound exceeds TOUCHING / gap at every gap past the touching
  // distance. Where the ideal side fails it, the closest admissible side is
  // the cone boundary along the ideal's own perpendicular.
  const gap = Math.hypot(towardX, towardY) || 1;
  const ux = -towardX / gap;
  const uy = -towardY / gap;
  const spreadOfFloor = 1 - MIN_STRIKE_SOLIDITY * MIN_STRIKE_SOLIDITY;
  const floor = Math.min(
    1,
    (TOUCHING * spreadOfFloor +
      MIN_STRIKE_SOLIDITY *
        Math.sqrt(Math.max(0, gap * gap - TOUCHING * TOUCHING * spreadOfFloor))) /
      gap,
  );
  const along = ux * ix + uy * iy;
  let sideX = ix;
  let sideY = iy;
  if (along < floor) {
    let perpX = ix - ux * along;
    let perpY = iy - uy * along;
    const perpLength = Math.hypot(perpX, perpY);
    if (perpLength < 1e-9) {
      perpX = -uy;
      perpY = ux;
    } else {
      perpX /= perpLength;
      perpY /= perpLength;
    }
    const spread = Math.sqrt(Math.max(0, 1 - floor * floor));
    sideX = ux * floor + perpX * spread;
    sideY = uy * floor + perpY * spread;
  }

  // The launch aims at SPEC section 8.1's contact point, where the striker's
  // CENTRE stands at the moment it touches the chosen side: the touching
  // distance along that side, with no safety margin. It is the only aim
  // distance the section's reachability test is derivable for, and the one
  // the ball departs along minus the side from; the ball's own surface point,
  // 34 px inside the contact disc, is met at a normal pulled toward the
  // striker's approach and was measured at 20 to 25 degrees of departure
  // error before the aim was corrected.
  const contactX = ball.x + sideX * TOUCHING;
  const contactY = ball.y + sideY * TOUCHING;
  const radians = Math.atan2(contactY - me.y, contactX - me.x);
  return { degrees: whole((radians * 180) / Math.PI), percent: 100 };
}

/** Aim through SPEC section 5.0's own controls and launch. */
export async function launchAim(page: Page, aim: Aim): Promise<void> {
  await at(page, 'aim-angle').fill(String(aim.degrees));
  await at(page, 'power').fill(String(aim.percent));
  await at(page, 'aim-launch').click();
}

/**
 * Play the match with the scripted striker until `done`, one batch of frames
 * at a time. Returns the frames driven, so a spec can assert the drive ran.
 *
 * THE BATCH IS A COST, NOT A CORRECTNESS KNOB. Reading the turn readout back
 * costs a round trip and a turn is many frames long, so checking once every
 * four frames halves the wall clock of a long drive and can cost at most three
 * frames of thinking time before a shot is taken. Nothing is asserted between
 * the frames of a batch, and a spec that needs a state read on an exact frame
 * drives `advance` itself.
 */
export async function playUntil(
  page: Page,
  budget: number,
  attacking: 'left' | 'right',
  done: () => Promise<boolean>,
  actingTurn = 'YOUR TURN',
  batch = 4,
): Promise<number> {
  let frames = 0;
  while (frames < budget) {
    await advance(page, batch);
    frames += batch;
    if (await done()) {
      return frames;
    }
    if ((await turnText(page)) === actingTurn) {
      await launchAim(page, strikeAim(await centres(page), attacking));
    }
  }
  return frames;
}

/**
 * Play a Hotseat match with the scripted striker driving BOTH humans at the
 * same mouth, which is the one way a browser test can settle a scoreline
 * rather than watch one: SPEC section 3 credits the mouth the ball entered, so
 * both sides attacking one mouth put the target past the side that owns it.
 *
 * The aim is taken from the ACTING circle, which in the second human's turn is
 * the opponent's, so the scene is mirrored for that turn before the striker
 * reads it.
 */
export async function playBothSides(
  page: Page,
  budget: number,
  attacking: 'left' | 'right',
  batch = 4,
): Promise<number> {
  let frames = 0;
  while (frames < budget) {
    await advance(page, batch);
    frames += batch;
    const state = await turnText(page);
    if (state === 'FULL TIME') {
      return frames;
    }
    if (state === 'PLAYER 1 IS AIMING') {
      await launchAim(page, strikeAim(await centres(page), attacking));
    } else if (state === 'PLAYER 2 IS AIMING') {
      const scene = await centres(page);
      await launchAim(
        page,
        strikeAim({ player: scene.opponent, opponent: scene.player, ball: scene.ball }, attacking),
      );
    }
  }
  return frames;
}
