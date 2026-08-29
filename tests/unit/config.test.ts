import { describe, expect, it } from 'vitest';

import {
  BALL_RADIUS,
  BALL_START_X,
  BALL_START_Y,
  BODY_MASS,
  CATCH_UP_SLICE,
  CENTRE_CIRCLE_RADIUS,
  CIRCLE_RADIUS,
  CIRCLE_RESTITUTION,
  COINCIDENT_EPSILON,
  DAMPING,
  DELTA_CEILING,
  FIELD_BOTTOM,
  FIELD_HEIGHT,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIELD_WIDTH,
  FIXED_STEP,
  GOAL_FRAME_DEPTH,
  GOAL_HOLD,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_HYSTERESIS,
  GOAL_OPENING_LOW,
  LEFT_GOAL_LINE,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  MAX_DRAG,
  MAX_LAUNCH_SPEED,
  MIDLINE_Y,
  MIN_DRAG,
  MIN_LAUNCH_SPEED,
  OPPONENT_PRELAUNCH_DELAY,
  OPPONENT_START_X,
  PLAYER_START_X,
  RESUME_GAP,
  RIGHT_GOAL_LINE,
  SOLVER_ITERATIONS,
  SPEED_CAP,
  STOP_SPEED,
  WALL_RESTITUTION,
  WALL_THICKNESS,
  launchSpeed,
  power01,
  travelDistance,
} from '../../src/core/config';

/**
 * PF-2 support for every item in the part: a constant that has drifted from the
 * document that owns it is a spec violation rather than a tuning choice, and
 * the only way to say so is to write the document's number out again here.
 *
 * EVERY ASSERTION BELOW USES A LITERAL. Comparing a symbol against itself, or
 * against another symbol derived from it, passes for any value either of them
 * takes. SPEC section 3 owns the pitch, section 4 the radii, section 5 the drag
 * clamps, section 6.1 the physics constants and the power scale, and section
 * 6.2 the three time-model numbers.
 */

/** Two decimal places, which is the precision SPEC section 6.1 quotes travel in. */
function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

describe('PF-2 constants, against the sections that own them', () => {
  it('carries SPEC section 3 pitch geometry', () => {
    expect(LOGICAL_WIDTH).toBe(1280);
    expect(LOGICAL_HEIGHT).toBe(720);
    expect(FIELD_LEFT).toBe(90);
    expect(FIELD_RIGHT).toBe(1190);
    expect(FIELD_BOTTOM).toBe(85);
    expect(FIELD_TOP).toBe(635);
    expect(WALL_THICKNESS).toBe(12);
    expect(CENTRE_CIRCLE_RADIUS).toBe(70);

    // The playable extent, which SPEC section 6.1's invariant is stated in.
    expect(FIELD_WIDTH).toBe(1100);
    expect(FIELD_HEIGHT).toBe(550);
  });

  it('carries SPEC section 3 and 6.4 goal geometry', () => {
    expect(GOAL_OPENING_LOW).toBe(265);
    expect(GOAL_OPENING_HIGH).toBe(455);
    expect(GOAL_OPENING_HIGH - GOAL_OPENING_LOW).toBe(190);
    expect(GOAL_FRAME_DEPTH).toBe(64);
    expect(GOAL_OPENING_HYSTERESIS).toBe(0.5);
    expect(LEFT_GOAL_LINE).toBe(90);
    expect(RIGHT_GOAL_LINE).toBe(1190);
    // SPEC section 6.4's celebration hold, in seconds. The whole number of
    // fixed steps it becomes is derived in src/core/goals.ts and pinned in
    // tests/unit/goal-detection.test.ts, where the hold itself is graded.
    expect(GOAL_HOLD).toBe(1.2);
    expect(Math.round(GOAL_HOLD / FIXED_STEP)).toBe(144);
  });

  it('carries SPEC section 4 radii, and the ratio the section states', () => {
    expect(CIRCLE_RADIUS).toBe(34);
    expect(BALL_RADIUS).toBe(18);
    // "about half the radius of a circle", which is why 20 px of closing per
    // step is measured against a 104 px contact disc rather than against 18.
    expect(BALL_RADIUS / CIRCLE_RADIUS).toBeGreaterThan(0.5);
    expect(BALL_RADIUS / CIRCLE_RADIUS).toBeLessThan(0.55);
  });

  it('carries SPEC section 3 kickoff placement', () => {
    expect(PLAYER_START_X).toBe(300);
    expect(OPPONENT_START_X).toBe(980);
    expect(MIDLINE_Y).toBe(360);
    // "Ball start: exact field centre", and the circles sit on that same line.
    expect(BALL_START_X).toBe(640);
    expect(BALL_START_Y).toBe(360);
    expect(BALL_START_Y).toBe(MIDLINE_Y);
  });

  it('carries SPEC section 6.1 physics constants', () => {
    expect(MIN_LAUNCH_SPEED).toBe(150);
    expect(MAX_LAUNCH_SPEED).toBe(900);
    expect(DAMPING).toBe(0.32);
    expect(STOP_SPEED).toBe(6);
    expect(WALL_RESTITUTION).toBe(0.92);
    expect(CIRCLE_RESTITUTION).toBe(1);
    expect(BODY_MASS).toBe(1);
    expect(SPEED_CAP).toBe(1200);
    expect(OPPONENT_PRELAUNCH_DELAY).toBe(0.45);
    expect(SOLVER_ITERATIONS).toBe(4);
    expect(COINCIDENT_EPSILON).toBe(1e-6);
  });

  it('carries SPEC section 6.2 and QUALITY-BAR section 7 time constants', () => {
    expect(FIXED_STEP).toBe(1 / 120);
    expect(DELTA_CEILING).toBe(0.25);
    expect(CATCH_UP_SLICE).toBe(1 / 60);
    expect(RESUME_GAP).toBe(5);
    // The nesting itself: a slice is a whole number of steps, and the ceiling
    // is a whole number of slices, which is what makes the three layers nest
    // rather than merely follow one another.
    expect(CATCH_UP_SLICE / FIXED_STEP).toBe(2);
    expect(Math.round(DELTA_CEILING / CATCH_UP_SLICE)).toBe(15);
    expect(Math.round(DELTA_CEILING / FIXED_STEP)).toBe(30);
  });

  it('carries SPEC section 5 drag clamps', () => {
    expect(MIN_DRAG).toBe(30);
    expect(MAX_DRAG).toBe(180);
    expect(MAX_DRAG - MIN_DRAG).toBe(150);
  });
});

describe('PF-2 the one power scale, SPEC section 6.1', () => {
  it('reads a drag as a normalised strength between the two clamps', () => {
    expect(power01(30)).toBe(0);
    expect(power01(180)).toBe(1);
    expect(power01(90)).toBeCloseTo(0.4, 12);
    expect(power01(105)).toBeCloseTo(0.5, 12);
    expect(power01(135)).toBeCloseTo(0.7, 12);
  });

  it('clamps both ends rather than extrapolating past them', () => {
    expect(power01(0)).toBe(0);
    expect(power01(29.9)).toBe(0);
    expect(power01(-40)).toBe(0);
    expect(power01(400)).toBe(1);
    // A drag length that is not a finite number is no drag at all, which is
    // the same reading as one below the minimum rather than a clamp to the
    // maximum: a measurement that produced Infinity measured nothing.
    expect(power01(Number.NaN)).toBe(0);
    expect(power01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(power01(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('turns strength into the speeds the section tabulates', () => {
    // "150 + 750 * power01", so 40 percent means 450 px/s everywhere.
    expect(launchSpeed(0)).toBe(150);
    expect(launchSpeed(0.4)).toBe(450);
    expect(launchSpeed(0.5)).toBe(525);
    expect(launchSpeed(0.7)).toBe(675);
    expect(launchSpeed(1)).toBe(900);
    expect(launchSpeed(power01(30))).toBe(150);
    expect(launchSpeed(power01(180))).toBe(900);
  });

  it('re-derives SPEC section 6.1 travel table from the constants', () => {
    // Total travel of an exponentially damped body, and the reason the damping
    // constant and the kickoff positions were chosen together.
    expect(Math.round(travelDistance(150))).toBe(126);
    expect(Math.round(travelDistance(450))).toBe(390);
    expect(Math.round(travelDistance(525))).toBe(455);
    expect(Math.round(travelDistance(675))).toBe(587);
    expect(Math.round(travelDistance(900))).toBe(785);

    // "A circle must travel 340 - 34 - 18 = 288 px to touch the ball."
    const toTheBall = BALL_START_X - PLAYER_START_X - CIRCLE_RADIUS - BALL_RADIUS;
    expect(BALL_START_X - PLAYER_START_X).toBe(340);
    expect(toTheBall).toBe(288);

    // The weakest legal shot is a nudge; the floor of the Casual band reaches.
    expect(travelDistance(150)).toBeLessThan(toTheBall);
    expect(travelDistance(450)).toBeGreaterThan(toTheBall);
    // "with 497 px to spare" at full power.
    expect(round(travelDistance(900) - toTheBall, 0)).toBe(497);
  });
});
