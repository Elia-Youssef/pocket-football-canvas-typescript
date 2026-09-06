/**
 * Aiming: what a drag means, and the one place a drag becomes an aim.
 *
 * SPEC section 5 states all of it. The arrow points OPPOSITE the drag from
 * the circle centre with its length proportional to the clamped drag
 * distance; 30 logical pixels is the minimum below which a release cancels;
 * 180 is the maximum above which strength stops growing; and none of it
 * happens outside the player's own turn. DESIGN section 5 adds the shape:
 * both input models produce the same `AimState`, so there is exactly one
 * thing to draw and exactly one thing to launch.
 *
 * THE DRAG ARRIVES IN DESIGN SPACE ALREADY. Nothing here knows a pointer, a
 * rectangle or a device ratio: the numbers are logical design units by the
 * time they reach this module. SPEC section 5 calls that the single most
 * important coordinate decision in the game, because it is what makes the
 * two constants above mean the same thing on a phone and on a desktop. The
 * mapping that gets them here is `src/render/input.ts`, on the other side of
 * the core boundary.
 *
 * TWO CLAMPS, AND THEY ARE NOT THE SAME CLAMP. Strength is `power01`, which
 * SPEC section 6.1 defines against `clamp(drag, 30, 180)` and which
 * `config.ts` owns; this module calls it and restates nothing. The arrow's
 * REACH is clamped at the maximum only, so a sub-minimum drag draws the short
 * arrow it earned rather than one floored at the minimum. DESIGN section 5 is
 * explicit that the arrowhead defect it records was visible precisely in the
 * sub-minimum-drag case, and a floored reach would hide it.
 *
 * TOTAL BY CONSTRUCTION. A drag component that is not a finite number is no
 * drag at all, which is the reading the simulation already takes of a delta
 * it cannot use, so every function here answers for every input it can be
 * given rather than for the ones a caller is trusted to send.
 */

import type { Body, World } from './bodies';
import { everyBodyStopped } from './bodies';
import { MAX_DRAG, MIN_DRAG, power01 } from './config';
import type { MatchState } from './match';

/** DESIGN section 5: what both input models produce and one launch consumes. */
export interface AimState {
  /** The launch direction, in radians of design space with y up. */
  readonly angleRad: number;
  /** SPEC section 6.1's one power scale, in [0, 1]. */
  readonly power01: number;
}

/** An aim in progress: the aim itself, plus what the arrow needs to draw it. */
export interface AimPreview {
  readonly aim: AimState;
  /** The drag distance clamped at the maximum, in design units. */
  readonly reach: number;
  /** Whether releasing now launches. False below the minimum drag. */
  readonly launchable: boolean;
}

/** A finite drag component, or no drag at all. */
function usable(component: number): number {
  return Number.isFinite(component) ? component : 0;
}

/**
 * The aim a drag produces, taking the drag delta in design units: the current
 * pointer minus the point that was pressed.
 *
 * The direction is the NEGATED delta, which is the slingshot SPEC section 5
 * describes: pull back to shoot forward. Negating both components is what
 * makes it hold in all four quadrants rather than in the two that a mirrored
 * reading happens to agree with.
 */
export function aimFromDrag(dragX: number, dragY: number): AimPreview {
  const x = usable(dragX);
  const y = usable(dragY);
  const dragged = Math.hypot(x, y);
  return {
    aim: { angleRad: Math.atan2(-y, -x), power01: power01(dragged) },
    reach: Math.min(dragged, MAX_DRAG),
    launchable: dragged >= MIN_DRAG,
  };
}

/**
 * SPEC section 5's four refusals, as one predicate. PLAYER_TURN is the only
 * state that aims: OPPONENT_TURN, MOVING, PAUSED and GAME_OVER are the four
 * the criterion names, and MENU, KICKOFF and GOAL refuse under the same rule
 * rather than under a second one. PAUSED carries the state it interrupted and
 * is deliberately not unwrapped: a paused player turn is a pause.
 *
 * The rest half is stated separately from the state half on purpose. A world
 * still carrying a moving body is not a world to aim in whatever the chart
 * says, and PF-7's turn-end conjunction reads the same way for the same
 * reason.
 */
export function aimingAllowed(state: MatchState, world: World): boolean {
  return state.kind === 'PLAYER_TURN' && everyBodyStopped(world);
}

/**
 * Whether a press in design space landed on a body's own disc. The radius is
 * the body's, so nothing here chooses a target size, and the comparison is
 * written the way round that refuses a coordinate which is not a number: a
 * press nobody can locate is not a press on anything.
 */
export function pressLandsOn(body: Body, x: number, y: number): boolean {
  const dx = x - body.position.x;
  const dy = y - body.position.y;
  return dx * dx + dy * dy <= body.radius * body.radius;
}

/**
 * Item C1's whole sentence in one place: a press that lands on your own
 * circle, during your own turn. The circle is `world.player` and never the
 * other one, which is the half of the sentence a hit test written against
 * "a circle" would quietly drop.
 */
export function aimingBegins(
  state: MatchState,
  world: World,
  x: number,
  y: number,
): boolean {
  return aimingAllowed(state, world) && pressLandsOn(world.player, x, y);
}

/* ---------------------------------------------------------------------------
 * The two DISCRETE aim models, SPEC sections 5.0 and 5.1.
 *
 * A drag is a continuous gesture and the two models below are not: a tap names
 * a direction outright, and a key names a step or a rate. Both still produce
 * the `AimState` above and the `AimPreview` above, because DESIGN section 5
 * allows exactly one thing to draw and exactly one thing to launch, and SPEC
 * section 5.1 requires the arrow to render identically whichever model made it.
 *
 * THE HOLD RATES ARE STATED AS AN INTEGRAL, not as a per-frame increment. SPEC
 * section 5.1 says the rates are integrated against real elapsed time so that
 * they are identical at every frame rate; `holdSweptDegrees(t)` is the TOTAL
 * swept after holding for t seconds, and a frame advances the aim by the
 * difference of two such totals. Written that way the partition of the interval
 * cannot matter, which is what "identical at every frame rate" means, and an
 * unstable clock is the same statement about a different partition. A rate
 * multiplied by a frame delta is the form that fails, and it is the form
 * QUALITY-BAR section 7 records as a defect class.
 *
 * THE 250 MS DELAY IS READ AS THE ONE HOLD-ONSET CONVENTION. The table states
 * it for the plain arrows and again for the power keys, and says of the fine
 * modifier only that it has "no ramp". Taking the delay as general is what
 * keeps a 30 ms fine tap worth exactly the one degree the table gives it
 * instead of one degree plus whatever the rate paid out in the meantime; the
 * reading is recorded here because the table is silent rather than contrary.
 * ------------------------------------------------------------------------- */

/** SPEC section 5.1: a tap of an unmodified arrow, in degrees. */
export const ANGLE_TAP_DEGREES = 3;
/** SPEC section 5.1: a tap of a modified arrow, the fine step, in degrees. */
export const ANGLE_FINE_TAP_DEGREES = 1;
/** SPEC section 5.1: the rate a held arrow starts at, degrees per second. */
export const ANGLE_HOLD_FROM_DEGREES = 60;
/** SPEC section 5.1: the rate the ramp reaches and then holds. */
export const ANGLE_HOLD_TO_DEGREES = 240;
/** SPEC section 5.1: a held modified arrow, constant, with no ramp. */
export const ANGLE_FINE_HOLD_DEGREES = 20;
/** SPEC section 5.1: a tap of a power key, in points of the power01 scale. */
export const POWER_TAP = 0.05;
/** SPEC section 5.1: a held power key, in points of power01 per second. */
export const POWER_HOLD_RATE = 0.4;
/** SPEC section 5.1: how long a key is down before any hold rate begins. */
export const HOLD_DELAY = 0.25;
/** SPEC section 5.1: how long the arrow ramp takes to reach its top rate. */
export const HOLD_RAMP = 1;
/** SPEC section 5.1: the power a keyboard aim opens at on the first turn. */
export const OPENING_POWER = 0.6;

/** A whole turn, which is what an aim angle is normalised into. */
export const DEGREES_PER_TURN = 360;
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * The degrees the ramp itself pays out, which is its mean rate over its own
 * length. SPEC section 5.1 quotes it as 150 degrees and derives the 2.1 second
 * sweep from it; it is computed here rather than quoted, so the sweep and the
 * section agree by construction.
 */
const RAMP_DEGREES =
  ((ANGLE_HOLD_FROM_DEGREES + ANGLE_HOLD_TO_DEGREES) * HOLD_RAMP) / 2;

/**
 * A strength held to the one power01 scale. Exported because the input models
 * step it and have to hold the running value themselves: a value clamped only
 * where it is read would let a long hold on the down key bank negative
 * strength that the up key then has to climb back out of.
 */
export function clampPower(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

/** An angle in degrees, folded into one turn. A turn is not a rotation. */
export function normaliseDegrees(degrees: number): number {
  const value = usable(degrees) % DEGREES_PER_TURN;
  return value < 0 ? value + DEGREES_PER_TURN : value;
}

export function degreesToRadians(degrees: number): number {
  return usable(degrees) * RADIANS_PER_DEGREE;
}

/** Radians as degrees in [0, 360), which is the range every control uses. */
export function radiansToDegrees(radians: number): number {
  return normaliseDegrees(usable(radians) / RADIANS_PER_DEGREE);
}

/**
 * The aim as the two whole numbers the controls carry and the announcement
 * reads: degrees in [0, 360) and percent in [0, 100]. Rounded here rather than
 * in each consumer, so a slider, a spoken readout and a test cannot disagree
 * about what the aim currently is. A rounding that lands on a whole turn is
 * folded back to zero, because 360 degrees is not a direction the range of
 * this function contains.
 */
export function aimDegrees(aim: AimState): number {
  return Math.round(radiansToDegrees(aim.angleRad)) % DEGREES_PER_TURN;
}

export function aimPercent(aim: AimState): number {
  return Math.round(clampPower(aim.power01) * 100);
}

/**
 * The total an unmodified held arrow has swept after `held` seconds down: zero
 * through the delay, the integral of a rate ramping linearly from 60 to 240
 * degrees per second through the ramp, then the top rate for as long as the key
 * stays down. SPEC section 5.1's own worked example is 360 degrees at 2.125
 * seconds, and it falls out of this rather than being asserted beside it.
 */
export function holdSweptDegrees(held: number): number {
  const active = usable(held) - HOLD_DELAY;
  if (active <= 0) {
    return 0;
  }
  if (active >= HOLD_RAMP) {
    return RAMP_DEGREES + ANGLE_HOLD_TO_DEGREES * (active - HOLD_RAMP);
  }
  return (
    ANGLE_HOLD_FROM_DEGREES * active +
    ((ANGLE_HOLD_TO_DEGREES - ANGLE_HOLD_FROM_DEGREES) * active * active) /
      (2 * HOLD_RAMP)
  );
}

/** The same total for a MODIFIED held arrow: constant, and no ramp at all. */
export function holdSweptFineDegrees(held: number): number {
  const active = usable(held) - HOLD_DELAY;
  return active <= 0 ? 0 : ANGLE_FINE_HOLD_DEGREES * active;
}

/** The same total for a held power key, in points of the power01 scale. */
export function holdSweptPower(held: number): number {
  const active = usable(held) - HOLD_DELAY;
  return active <= 0 ? 0 : POWER_HOLD_RATE * active;
}

/**
 * The drag length a strength of `power01` was earned by, which is the exact
 * inverse of `power01()` over the clamped range that function is defined on.
 * A discrete aim has no drag to measure, so the arrow's reach is derived from
 * the strength instead and the two models draw the same arrow for the same
 * shot. Zero percent is the minimum drag rather than nothing, which is the
 * reading `config.ts` already states: keyboard zero and a minimum drag are the
 * same shot.
 */
export function reachFor(power01Value: number): number {
  return MIN_DRAG + clampPower(power01Value) * (MAX_DRAG - MIN_DRAG);
}

/** The one constructor every discrete aim goes through: folded and clamped. */
export function normalisedAim(angleRad: number, power01Value: number): AimState {
  return {
    angleRad: degreesToRadians(radiansToDegrees(angleRad)),
    power01: clampPower(power01Value),
  };
}

/**
 * A discrete aim as the preview the arrow draws. It is never sub-minimum:
 * the reach scale starts AT the minimum drag, so the cancel signal belongs to
 * the drag model alone and a tap or a key press always names a real shot.
 */
export function aimPreviewFor(aim: AimState): AimPreview {
  const reach = reachFor(aim.power01);
  return { aim, reach, launchable: reach >= MIN_DRAG };
}

/**
 * SPEC section 5.0: tapping a point on the pitch aims TOWARD it. This is not
 * the drag's negation and must not be written as one: a drag is a slingshot
 * pulled back from the circle, and a tap is a destination named directly.
 *
 * A tap on the circle's own centre names no direction at all; the zero it
 * returns is the aim the caller already had for every practical purpose,
 * because a press that close to the centre is a drag rather than a tap.
 */
export function aimTowardPoint(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  return Math.atan2(usable(toY) - usable(fromY), usable(toX) - usable(fromX));
}

/**
 * SPEC section 5.1: what a keyboard aim opens at when nothing has been aimed
 * yet, which is the ball at 60 percent power. The last used aim is the
 * caller's to remember; this is only the first turn of a match.
 */
export function openingAim(world: World): AimState {
  return normalisedAim(
    aimTowardPoint(
      world.player.position.x,
      world.player.position.y,
      world.ball.position.x,
      world.ball.position.y,
    ),
    OPENING_POWER,
  );
}
