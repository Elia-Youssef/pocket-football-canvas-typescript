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

/** Let the page draw, for a reading that is of a frame and not of a gap. */
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
    await page.clock.fastForward(SETTLE_STEP_MS);
    await nextFrames(page, 2);
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

/** Every body's centre in one read, so the three come from one frame. */
export async function centres(page: Page): Promise<Centres> {
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
      const measure = (
        wanted: readonly number[],
        tolerance: number,
        insideOnly: boolean,
      ): { x: number; y: number } => {
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        // Every third pixel: a circle is 68 design units across, so this still
        // samples hundreds of them and moves the centroid by far less than one
        // unit, at a ninth of the cost. A drive takes dozens of these reads.
        for (let row = 0; row < canvas.height; row += 3) {
          for (let column = 0; column < canvas.width; column += 3) {
            const slot = (row * canvas.width + column) * 4;
            const designX = column / scaleX;
            // The two goal frames carry the two team tints and live OUTSIDE
            // the field bounds, so the search runs inside the pitch: a frame
            // counted as part of a circle drags its centre a hundred units
            // toward the goal and every aim taken from it is wrong.
            if (insideOnly && (designX <= 100 || designX >= 1180)) {
              continue;
            }
            if (
              Math.abs(Number(pixels[slot]) - Number(wanted[0])) > tolerance ||
              Math.abs(Number(pixels[slot + 1]) - Number(wanted[1])) > tolerance ||
              Math.abs(Number(pixels[slot + 2]) - Number(wanted[2])) > tolerance
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
      };
      return {
        // The two goal frames carry the team tints, so a circle is searched
        // for inside the field alone; the ball is white, no frame is, and a
        // ball in the net is exactly where a goal has to be able to find it.
        player: measure(fills.player, 6, true),
        opponent: measure(fills.opponent, 6, true),
        ball: measure(fills.ball, 2, false),
      };
    },
    { player: PLAYER_FILL, opponent: OPPONENT_FILL, ball: BALL_FILL },
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
