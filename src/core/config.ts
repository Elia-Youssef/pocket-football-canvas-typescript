/**
 * Every geometry and tuning constant the simulation reads, in one place.
 *
 * SPEC section 3 owns the pitch, section 4 owns the entity radii, section 6.1
 * owns the physics constants and the one power scale, and section 6.2 owns the
 * three time-model numbers. Nothing here is a choice made in this file: a value
 * that disagrees with those sections is a spec violation rather than a tuning
 * decision, which is why tests/unit/config.test.ts pins every one of them
 * against a literal rather than against the symbol beside it.
 *
 * DESIGN section 1 puts this module under `core/`, so it imports nothing, names
 * no platform surface, and reads no clock. Time arrives as a parameter.
 */

/** SPEC section 3: the logical design space, origin bottom-left. */
export const LOGICAL_WIDTH = 1280;
export const LOGICAL_HEIGHT = 720;

/** SPEC section 3: the field bounds, which are what contains every body. */
export const FIELD_LEFT = 90;
export const FIELD_RIGHT = 1190;
export const FIELD_BOTTOM = 85;
export const FIELD_TOP = 635;

/**
 * The playable width, which is the number SPEC section 6.1's required
 * invariant is stated against: a ball struck at the cap from the centre spot
 * has to reach either goal line, and those lines are the field bounds rather
 * than the edges of the design space.
 */
export const FIELD_WIDTH = FIELD_RIGHT - FIELD_LEFT;
export const FIELD_HEIGHT = FIELD_TOP - FIELD_BOTTOM;

/**
 * SPEC section 6.2: presentational. Walls are half-space containment tests on
 * the field bound, never slab-overlap tests against this thickness, which is
 * what makes them untunnelable at any speed.
 */
export const WALL_THICKNESS = 12;

/** SPEC section 3 and section 6.4: the goal opening and its frame. */
export const GOAL_OPENING_LOW = 265;
export const GOAL_OPENING_HIGH = 455;
export const GOAL_FRAME_DEPTH = 64;

/**
 * SPEC section 6.4: the opening test carries this much hysteresis for a ball
 * already outside the field, so a ball skimming a post cannot alternate between
 * transparent and solid under floating-point jitter. Carried here for PF-4,
 * which owns the goal test; nothing at PF-2 reads it.
 */
export const GOAL_OPENING_HYSTERESIS = 0.5;

/** SPEC section 6.4: the lines a goal is measured against. */
export const LEFT_GOAL_LINE = FIELD_LEFT;
export const RIGHT_GOAL_LINE = FIELD_RIGHT;

/**
 * SPEC section 6.4: the celebration hold after a goal, in seconds of
 * simulation time. `src/core/goals.ts` turns it into a whole number of fixed
 * steps, which is what makes it the same hold at every frame rate, and the
 * section's reason for it is that without the hold the reset happens in the
 * step the line is crossed and the player never sees the ball go in.
 */
export const GOAL_HOLD = 1.2;

/** SPEC section 3: markings, carried for the renderer. */
export const CENTRE_CIRCLE_RADIUS = 70;

/** SPEC section 4: the radii. The ball is deliberately about half a circle. */
export const CIRCLE_RADIUS = 34;
export const BALL_RADIUS = 18;

/** SPEC section 3: kickoff placement, on the horizontal midline. */
export const MIDLINE_Y = 360;
export const PLAYER_START_X = 300;
export const OPPONENT_START_X = 980;
export const BALL_START_X = (FIELD_LEFT + FIELD_RIGHT) / 2;
export const BALL_START_Y = (FIELD_BOTTOM + FIELD_TOP) / 2;

/** SPEC section 6.1: the two ends of the one power scale. */
export const MIN_LAUNCH_SPEED = 150;
export const MAX_LAUNCH_SPEED = 900;

/** SPEC section 5: the two drag clamps the power scale is measured between. */
export const MIN_DRAG = 30;
export const MAX_DRAG = 180;

/**
 * SPEC section 6.1 and 6.2. Damping is per second and is applied as
 * `v *= DAMPING ** dt`; a per-frame `v *= DAMPING` is frame-rate dependent and
 * is the defect class QUALITY-BAR section 7 records.
 */
export const DAMPING = 0.32;

/**
 * SPEC section 6.2: exponential damping never reaches zero, so this threshold
 * is what ends a turn. Any body at or below it is zeroed, which is what makes
 * "everything has stopped" an exact test rather than an approximate one.
 */
export const STOP_SPEED = 6;

/** SPEC section 6.1: restitution. The wall value lands at PF-3 with item B6. */
export const WALL_RESTITUTION = 0.92;
export const CIRCLE_RESTITUTION = 1;

/** SPEC section 6.1: all three bodies weigh the same, so an impulse exchanges. */
export const BODY_MASS = 1;

/**
 * SPEC section 6.1 and 6.2: at this cap a body moves at most 10 px per fixed
 * step and two bodies close at most 20 px, against the 104 px contact disc of a
 * circle and the ball.
 */
export const SPEED_CAP = 1200;

/** SPEC section 6.1 and 6.2, DESIGN section 2: the three time layers. */
export const FIXED_STEP = 1 / 120;
export const DELTA_CEILING = 0.25;
export const CATCH_UP_SLICE = 1 / 60;

/**
 * QUALITY-BAR section 7: a gap longer than this is a resume rather than elapsed
 * time, and the accumulator is dropped rather than consumed. Consuming a
 * background gap as simulation is the tab-restore defect that section records.
 */
export const RESUME_GAP = 5;

/** SPEC section 6.1: carried here for PF-8, which owns the opponent. */
export const OPPONENT_PRELAUNCH_DELAY = 0.45;

/**
 * SPEC section 6.3: three bodies meeting at one point settle to under 1 px of
 * residual penetration in this many passes. Carried for PF-3.
 */
export const SOLVER_ITERATIONS = 4;

/**
 * SPEC section 6.3: below this separation two centres are coincident and the
 * contact normal takes its fixed fallback, so the case stays deterministic.
 */
export const COINCIDENT_EPSILON = 1e-6;

/**
 * The floor below which a leftover of a divided frame delta is absorbed into
 * the slice that produced it rather than spawning another slice. Fifteen slices
 * of one sixtieth do not sum to a quarter in binary floating point, and a
 * residue of a few times ten to the minus seventeen is not a slice of work.
 */
export const TIME_EPSILON = 1e-12;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * SPEC section 6.1: the normalised launch strength in [0, 1], and the only
 * meaning of "power" or "percent power" anywhere in this game. Every consumer
 * reads this one scale, so keyboard 0 percent and a minimum drag are the same
 * shot. PF-6 owns aiming and calls this rather than restating it.
 *
 * Total by construction: a drag length that is not a finite number is no drag
 * at all, which is the same reading as one below the minimum.
 */
export function power01(dragLength: number): number {
  if (!Number.isFinite(dragLength)) {
    return 0;
  }
  return (clamp(dragLength, MIN_DRAG, MAX_DRAG) - MIN_DRAG) / (MAX_DRAG - MIN_DRAG);
}

/**
 * SPEC section 6.1: the speed a launch at that strength leaves with. The
 * shortest legal drag is the minimum launch speed rather than zero, so the
 * weakest legal shot is a nudge rather than a cancelled turn.
 */
export function launchSpeed(power: number): number {
  const strength = Number.isFinite(power) ? clamp(power, 0, 1) : 0;
  return MIN_LAUNCH_SPEED + (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED) * strength;
}

/**
 * SPEC section 6.1: total travel of an exponentially damped body, which is what
 * the damping constant and the kickoff positions were chosen against together.
 * The required invariant in that section is stated in these terms, and
 * tests/unit/determinism.test.ts re-derives it from the constants above.
 */
export function travelDistance(launchedAt: number): number {
  return (launchedAt - STOP_SPEED) / -Math.log(DAMPING);
}
