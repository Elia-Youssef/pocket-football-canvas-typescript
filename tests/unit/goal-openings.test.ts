import { describe, expect, it } from 'vitest';

import type { Body, BodyKind, World } from '../../src/core/bodies';
import { createWorld, setVelocity } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIXED_STEP,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_HYSTERESIS,
  GOAL_OPENING_LOW,
  LEFT_GOAL_LINE,
  RIGHT_GOAL_LINE,
  SPEED_CAP,
} from '../../src/core/config';
import { ballFitsOpening, trailingEdgePast } from '../../src/core/goals';
import { contain, createSimulation, reflect } from '../../src/core/physics';
import { set } from '../../src/core/vec2';

/**
 * Item B7, Critical: "The ball passes through the goal openings and the circles
 * never do. The rule is by body type, not by body size."
 *
 * THE TRAP THE CRITERION IS WRITTEN AGAINST. A circle fits the opening
 * geometrically, 68 px against 190 px, so a predicate that asked how big a body
 * is rather than which body it is would let both circles leave the pitch
 * through a 122 px band of centre positions. SPEC section 6.4 states that band;
 * the sweep below drives circles across every pixel of it, at two speeds and
 * three angles, into both mouths, and requires zero escapes.
 *
 * WHAT IS ASSERTED, AND WHAT IS ONLY MEASURED. The escape count is the
 * criterion. The count of runs that actually pressed a circle against a goal
 * line inside the opening is measured beside it, because a sweep that never
 * reached the mouth would report zero escapes and would have tested nothing.
 *
 * THE OPENING BOUNDS ARE WRITTEN OUT. Asserting a boundary against the symbol
 * that defines it passes for whatever value the symbol takes, so the readings
 * below use SPEC section 6.4's own numbers: 265 and 455 for a ball on its way
 * in, 264.5 and 455.5 for one that is already through.
 */

/** SPEC section 6.4: the centre positions at which a circle would fit. */
const BAND_LOW = GOAL_OPENING_LOW + CIRCLE_RADIUS;
const BAND_HIGH = GOAL_OPENING_HIGH - CIRCLE_RADIUS;

/** The same for the ball, which is the band it genuinely does pass through. */
const BALL_BAND_LOW = GOAL_OPENING_LOW + BALL_RADIUS;
const BALL_BAND_HIGH = GOAL_OPENING_HIGH - BALL_RADIUS;

interface Mouth {
  readonly label: string;
  /** The goal line this mouth sits on. */
  readonly line: number;
  /** The direction out of the field through it. */
  readonly out: number;
}

const MOUTHS: readonly Mouth[] = [
  { label: 'left', line: LEFT_GOAL_LINE, out: -1 },
  { label: 'right', line: RIGHT_GOAL_LINE, out: 1 },
];

/** Somewhere no wall and no goal mouth is, for the bodies a case is not about. */
const PARKED: ReadonlyArray<readonly [number, number]> = [
  [500, 150],
  [780, 150],
];

function parkTheRest(world: World, keep: Body): void {
  let at = 0;
  for (const body of world.bodies) {
    if (body === keep) {
      continue;
    }
    const spot = PARKED[at];
    if (spot !== undefined) {
      set(body.position, spot[0], spot[1]);
    }
    at += 1;
  }
}

/**
 * True when this body is outside the field bound in x.
 *
 * WRITTEN FROM SPEC SECTION 3 rather than taken from `contain`, because a
 * reading that asked the code under test whether a body had escaped would agree
 * with it however wrong it became.
 *
 * TWO SENSES OF "OUTSIDE" ARE IN PLAY, and they are deliberately different.
 * This one is the leading edge: any part of a body past the bound has escaped,
 * which is what containment means. `centrePastAGoalLine` in the source uses the
 * centre instead, because the question it settles is whether the ball is
 * already THROUGH a mouth rather than whether it has left the pitch. Each is
 * the right reading for its own question, and neither is a copy of the other.
 */
function outsideInX(body: Body): boolean {
  return (
    body.position.x - body.radius < FIELD_LEFT || body.position.x + body.radius > FIELD_RIGHT
  );
}

function outsideInY(body: Body): boolean {
  return (
    body.position.y - body.radius < FIELD_BOTTOM || body.position.y + body.radius > FIELD_TOP
  );
}

/** A body seated exactly on the goal line it was driven at. */
function seatedOn(body: Body, mouth: Mouth): boolean {
  return body.position.x + mouth.out * body.radius === mouth.line;
}

describe('PF-4 the ball passes through the goal openings, item B7', () => {
  it('is neither clamped nor turned by a goal end it fits', () => {
    // The reading at its own level, and both halves of transparency in it: no
    // clamp, so no wall bit, so the reflection that consumes the mask turns
    // nothing. There is no second reading of the opening inside `reflect`, and
    // this is what says so.
    const middle = (GOAL_OPENING_LOW + GOAL_OPENING_HIGH) / 2;
    let checked = 0;
    for (const mouth of MOUTHS) {
      const ball = createWorld().ball;
      const beyond = mouth.line + mouth.out * (5 - BALL_RADIUS);
      set(ball.position, beyond, middle);
      setVelocity(ball, mouth.out * 400, 0);

      const walls = contain(ball);
      expect(walls, `${mouth.label} mouth sets no wall bit`).toBe(0);
      expect(ball.position.x, `${mouth.label} mouth does not clamp`).toBe(beyond);

      reflect(ball, walls);
      expect(ball.velocity.x, `${mouth.label} mouth does not turn`).toBe(mouth.out * 400);
      expect(ball.velocity.y, `${mouth.label} mouth leaves y alone`).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it('carries the whole ball out through both mouths, in the shipping step', () => {
    // The same claim wired into DESIGN section 3's step order, so what is
    // graded is the simulation rather than a function nothing calls.
    const middle = (GOAL_OPENING_LOW + GOAL_OPENING_HIGH) / 2;
    for (const mouth of MOUTHS) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const ball = sim.world.ball;
      parkTheRest(sim.world, ball);
      set(ball.position, mouth.line - mouth.out * 100, middle);
      setVelocity(ball, mouth.out * 900, 0);

      let steps = 0;
      while (trailingEdgePast(ball) === undefined) {
        const before = ball.position.x;
        sim.step();
        steps += 1;
        // Never turned back on the way out: every step moves it further out.
        expect(
          (ball.position.x - before) * mouth.out,
          `${mouth.label} mouth, step ${String(steps)}`,
        ).toBeGreaterThan(0);
        expect(steps).toBeLessThan(200);
      }
      expect(trailingEdgePast(ball), `${mouth.label} mouth`).toBe(mouth.label);
      expect(outsideInX(ball), `${mouth.label} mouth`).toBe(true);
      // The velocity kept its sign the whole way, so nothing reflected it.
      expect(ball.velocity.x * mouth.out, `${mouth.label} mouth`).toBeGreaterThan(0);
    }
  });

  it('passes at every height the whole ball fits and at no other', () => {
    // The band itself, half a pixel at a time from post to post. A ball on its
    // way in is judged at SPEC section 6.4's exact bound rather than at the
    // widened one, so 282.5 is refused and 283 is not: the hysteresis is for a
    // ball that is already through, and this is the reading that says so.
    let passed = 0;
    let contained = 0;
    for (const mouth of MOUTHS) {
      for (let y = GOAL_OPENING_LOW; y <= GOAL_OPENING_HIGH; y += 0.5) {
        const sim = createSimulation({ onNonFinite: 'throw' });
        const ball = sim.world.ball;
        parkTheRest(sim.world, ball);
        set(ball.position, mouth.line - mouth.out * 60, y);
        setVelocity(ball, mouth.out * 900, 0);
        for (let step = 0; step < 40; step += 1) {
          sim.step();
        }
        const fits = y - BALL_RADIUS >= GOAL_OPENING_LOW && y + BALL_RADIUS <= GOAL_OPENING_HIGH;
        const where = `${mouth.label} mouth at ${String(y)}`;
        expect(outsideInX(ball), where).toBe(fits);
        expect(outsideInY(ball), where).toBe(false);
        passed += fits ? 1 : 0;
        contained += fits ? 0 : 1;
      }
    }
    // 154 px of centre positions at half a pixel, both mouths, and the rest of
    // the opening's height refused because part of the ball would be in a post.
    expect(BALL_BAND_HIGH - BALL_BAND_LOW).toBe(154);
    expect(passed).toBe(2 * (154 / 0.5 + 1));
    expect(contained).toBe(2 * (GOAL_OPENING_HIGH - GOAL_OPENING_LOW - 154) / 0.5);
  });
});

describe('PF-4 the circles never pass, item B7', () => {
  it('contains both circles across the whole 122 px band, at every speed and angle', () => {
    // The sweep the criterion's second sentence is graded by. Every pixel of
    // the band SPEC section 6.4 names, both circles, both mouths, two speeds
    // and three angles, driven long enough to reach the mouth and be pressed
    // into it.
    const kinds: readonly BodyKind[] = ['player', 'opponent'];
    const speeds: readonly number[] = [600, SPEED_CAP];
    const turns: readonly number[] = [-0.3, 0, 0.3];
    let runs = 0;
    let pressed = 0;
    const escaped: string[] = [];

    for (const kind of kinds) {
      for (const mouth of MOUTHS) {
        for (let y = BAND_LOW; y <= BAND_HIGH; y += 1) {
          for (const speed of speeds) {
            for (const turn of turns) {
              const sim = createSimulation({ onNonFinite: 'throw' });
              const circle = sim.world[kind];
              parkTheRest(sim.world, circle);
              set(circle.position, mouth.line - mouth.out * 80, y);
              const heading = mouth.out < 0 ? Math.PI + turn : turn;
              setVelocity(circle, Math.cos(heading) * speed, Math.sin(heading) * speed);

              let atTheMouth = false;
              for (let step = 0; step < 24; step += 1) {
                sim.step();
                if (outsideInX(circle) || outsideInY(circle)) {
                  escaped.push(
                    `${kind} at ${String(y)} through the ${mouth.label} mouth, ` +
                      `step ${String(step)}, x ${String(circle.position.x)}`,
                  );
                }
                atTheMouth ||=
                  seatedOn(circle, mouth) &&
                  circle.position.y >= GOAL_OPENING_LOW &&
                  circle.position.y <= GOAL_OPENING_HIGH;
              }
              pressed += atTheMouth ? 1 : 0;
              runs += 1;
            }
          }
        }
      }
    }

    expect(escaped).toEqual([]);
    // The band is the one the section states, and the sweep really is the whole
    // of it: 122 px of centre positions, a pixel apart, is 123 heights.
    expect(BAND_HIGH - BAND_LOW).toBe(122);
    expect(runs).toBe(2 * 2 * 123 * 2 * 3);
    // And it really did press circles against the goal line inside the
    // opening, rather than reporting no escapes from somewhere else.
    expect(pressed).toBeGreaterThan(runs / 2);
  });

  it('refuses the question for a circle that fits the opening geometrically', () => {
    // The type rule, stated twice over: the circle DOES fit, and the predicate
    // says no anyway, and the wall clamps it. A generalised predicate would
    // agree with the first of the three and break the other two.
    let checked = 0;
    for (const kind of ['player', 'opponent'] as const) {
      for (const mouth of MOUTHS) {
        for (let y = BAND_LOW; y <= BAND_HIGH; y += 1) {
          const circle = createWorld()[kind];
          set(circle.position, mouth.line + mouth.out * 5, y);

          // It fits, by the same arithmetic the ball is judged with.
          expect(y - circle.radius, `${kind} at ${String(y)}`).toBeGreaterThanOrEqual(
            GOAL_OPENING_LOW,
          );
          expect(y + circle.radius, `${kind} at ${String(y)}`).toBeLessThanOrEqual(
            GOAL_OPENING_HIGH,
          );
          // And it is refused, and clamped back to the line.
          expect(ballFitsOpening(circle), `${kind} at ${String(y)}`).toBe(false);
          expect(contain(circle), `${kind} at ${String(y)}`).not.toBe(0);
          expect(circle.position.x, `${kind} at ${String(y)}`).toBe(
            mouth.line - mouth.out * circle.radius,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * 2 * 123);
    // The ball is asked and answers yes at the same heights, so what separates
    // them is the kind and nothing else.
    const ball = createWorld().ball;
    set(ball.position, RIGHT_GOAL_LINE + 5, BAND_LOW);
    expect(ballFitsOpening(ball)).toBe(true);
  });
});

describe('PF-4 the opening test carries 0.5 px of hysteresis, item B7', () => {
  it('judges a ball on its way in at the exact bound', () => {
    // SPEC section 6.4, condition 2: `y - r >= 265 && y + r <= 455`. A ball
    // whose centre is still inside the field gets no slack at either post.
    const ball = createWorld().ball;
    const insideTheField = RIGHT_GOAL_LINE - 1;

    set(ball.position, insideTheField, GOAL_OPENING_LOW + BALL_RADIUS);
    expect(ball.position.y - BALL_RADIUS).toBe(265);
    expect(ballFitsOpening(ball)).toBe(true);

    set(ball.position, insideTheField, GOAL_OPENING_LOW + BALL_RADIUS - 0.5);
    expect(ball.position.y - BALL_RADIUS).toBe(264.5);
    expect(ballFitsOpening(ball)).toBe(false);

    set(ball.position, insideTheField, GOAL_OPENING_HIGH - BALL_RADIUS);
    expect(ball.position.y + BALL_RADIUS).toBe(455);
    expect(ballFitsOpening(ball)).toBe(true);

    set(ball.position, insideTheField, GOAL_OPENING_HIGH - BALL_RADIUS + 0.5);
    expect(ball.position.y + BALL_RADIUS).toBe(455.5);
    expect(ballFitsOpening(ball)).toBe(false);
  });

  it('judges a ball that is already through at the widened bound', () => {
    // The other half of the same sentence: a ball currently outside the field
    // passes at `y - r >= 264.5 && y + r <= 455.5`. Read here, as in the code,
    // as the ball's centre being past the line, which is the reading that
    // leaves condition 2's exact bound binding on the way in.
    let checked = 0;
    for (const mouth of MOUTHS) {
      const ball = createWorld().ball;
      const through = mouth.line + mouth.out * 1;

      set(ball.position, through, GOAL_OPENING_LOW + BALL_RADIUS - 0.5);
      expect(ball.position.y - BALL_RADIUS).toBe(264.5);
      expect(ballFitsOpening(ball), `${mouth.label} low post`).toBe(true);

      set(ball.position, through, GOAL_OPENING_LOW + BALL_RADIUS - 0.51);
      expect(ballFitsOpening(ball), `${mouth.label} low post, past it`).toBe(false);

      set(ball.position, through, GOAL_OPENING_HIGH - BALL_RADIUS + 0.5);
      expect(ball.position.y + BALL_RADIUS).toBe(455.5);
      expect(ballFitsOpening(ball), `${mouth.label} high post`).toBe(true);

      set(ball.position, through, GOAL_OPENING_HIGH - BALL_RADIUS + 0.51);
      expect(ballFitsOpening(ball), `${mouth.label} high post, past it`).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(2);
    expect(GOAL_OPENING_HYSTERESIS).toBe(0.5);
  });

  it('reads the goal line strictly, so a centre exactly on it gets no slack', () => {
    // THE BOUNDARY THE WHOLE READING TURNS ON, and the two tests above never
    // touch it: they place the ball a pixel inside the line or a pixel past it.
    // "Already through" is a strict comparison, so a ball whose centre is
    // exactly ON the line is not through yet and is judged at SPEC section
    // 6.4's exact bound. Read as "at or past", the ball would collect the slack
    // meant for one that had already gone through at the very position where it
    // is deciding whether to go through at all, and condition 2's bound would
    // stop binding at the one place it can bind.
    let checked = 0;
    for (const mouth of MOUTHS) {
      for (const [post, y] of [
        ['low post', GOAL_OPENING_LOW + BALL_RADIUS - 0.25],
        ['high post', GOAL_OPENING_HIGH - BALL_RADIUS + 0.25],
      ] as const) {
        const ball = createWorld().ball;
        set(ball.position, mouth.line, y);
        const where = `${mouth.label} line, ${post}`;
        // Exactly on the line, and a quarter of a pixel proud of the opening:
        // inside the 0.5 px of hysteresis, outside the bound that applies on
        // the way in. The two readings disagree here and nowhere else.
        expect(ball.position.x, where).toBe(mouth.line);
        expect(ballFitsOpening(ball), where).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
    // And a quarter of a pixel further out, where the centre IS past, the same
    // ball is held: the strictness is a boundary rather than a refusal.
    const through = createWorld().ball;
    set(through.position, RIGHT_GOAL_LINE + 0.25, GOAL_OPENING_LOW + BALL_RADIUS - 0.25);
    expect(ballFitsOpening(through)).toBe(true);
  });

  it('cannot alternate transparent and solid on a ball skimming a post', () => {
    // THE SCENARIO THE HYSTERESIS EXISTS FOR, rather than its boundary numbers.
    // A ball already THROUGH the line, skimming the low post with its lower
    // edge on the exact bound and a few units in the last place of jitter on
    // its height, is judged over and over. The strict reading of condition 2
    // flips on every step. The shipped one does not, and the ball is never
    // clamped back.
    //
    // THE SIDE THIS IS SCOPED TO, and why the other side needs no guard of its
    // own. An answer that flaps can only do damage where the ball keeps being
    // asked from the same place, which is inside the mouth. On the way IN the
    // predicate alone would alternate too, and harmlessly: the first refusal
    // clamps the ball and the reflection carries it away from the band, so
    // there is no second reading at that height to disagree with the first.
    const jitter = 1e-9;
    const base = GOAL_OPENING_LOW + BALL_RADIUS;
    const strict: boolean[] = [];
    const shipped: boolean[] = [];

    const ball = createWorld().ball;
    set(ball.position, RIGHT_GOAL_LINE + 1, base);
    for (let step = 0; step < 16; step += 1) {
      // Creeping through the mouth, and still short of the trailing edge test.
      ball.position.x += 0.2;
      ball.position.y = base + (step % 2 === 0 ? jitter : -jitter);
      strict.push(ball.position.y - BALL_RADIUS >= GOAL_OPENING_LOW);
      shipped.push(ballFitsOpening(ball));
      expect(contain(ball), `step ${String(step)}`).toBe(0);
      expect(trailingEdgePast(ball), `step ${String(step)}`).toBeUndefined();
    }

    // The control: without the 0.5 px the answer really would alternate, and
    // every alternation is a 36 px clamp back into the field.
    expect(new Set(strict).size).toBe(2);
    expect(strict.slice(0, 4)).toEqual([true, false, true, false]);
    // The shipped reading is one answer for the whole run.
    expect(new Set(shipped).size).toBe(1);
    expect(shipped.every((answer) => answer)).toBe(true);

    // And the guard is a window rather than an unconditional yes: half a pixel
    // lower, the same ball is refused and clamped.
    const dropped = createWorld().ball;
    set(dropped.position, RIGHT_GOAL_LINE + 1, base - 0.6);
    expect(ballFitsOpening(dropped)).toBe(false);
    expect(contain(dropped)).not.toBe(0);
  });
});

describe('PF-4 the clamp back, item B7', () => {
  it('pulls a ball that no longer fits back inside by the ball diameter', () => {
    // SPEC section 6.4: "a ball whose trailing edge is past the goal line but
    // which no longer fits the opening is clamped back inside the field by the
    // wall rule, a discontinuity of at most 36 px. Accepted rather than
    // smoothed." At the position the section describes it is exactly 36, which
    // is the ball's diameter and not a coincidence: the clamp seats the ball's
    // near edge on the line it had just cleared with its far edge.
    let checked = 0;
    for (const mouth of MOUTHS) {
      const ball = createWorld().ball;
      set(ball.position, mouth.line + mouth.out * BALL_RADIUS, GOAL_OPENING_LOW - 100);
      const before = ball.position.x;
      expect(trailingEdgePast(ball), `${mouth.label} mouth`).toBe(mouth.label);
      expect(ballFitsOpening(ball), `${mouth.label} mouth`).toBe(false);

      const walls = contain(ball);
      expect(walls, `${mouth.label} mouth`).not.toBe(0);
      expect(Math.abs(before - ball.position.x), `${mouth.label} mouth`).toBe(36);
      expect(BALL_RADIUS * 2).toBe(36);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it('measures the worst a whole step can make of it, which is a step longer', () => {
    // A DISCLOSED READING, and a finding rather than a defect. The section's
    // 36 px is the discontinuity measured at the position it names, the
    // trailing edge exactly on the line. The wall rule is asked once per step,
    // at DESIGN section 3's position 3, so a ball that was legally through at
    // the start of a step and no longer fits at the end of it is clamped from
    // wherever that step's integration left it, which is up to one step of
    // travel at the cap further out. The bound is the diameter plus 10 px, and
    // the case is reachable: the ball below is on the widened bound and half a
    // pixel of drift takes it off.
    const sim = createSimulation({ onNonFinite: 'throw' });
    const ball = sim.world.ball;
    parkTheRest(sim.world, ball);
    // Through the line, unscored, and exactly on the bound it keeps.
    set(ball.position, RIGHT_GOAL_LINE + BALL_RADIUS - 0.01, GOAL_OPENING_LOW + BALL_RADIUS - 0.5);
    expect(ballFitsOpening(ball)).toBe(true);
    expect(trailingEdgePast(ball)).toBeUndefined();
    setVelocity(ball, 1199.99, -0.5);

    const before = ball.position.x;
    sim.step();

    expect(ballFitsOpening(ball)).toBe(false);
    expect(ball.position.x).toBe(FIELD_RIGHT - BALL_RADIUS);
    expect(sim.scoring.readout().goals).toBe(0);

    const travelled = 1199.99 * FIXED_STEP;
    const jumped = before + travelled - ball.position.x;
    expect(jumped).toBeGreaterThan(36);
    expect(jumped).toBeLessThanOrEqual(BALL_RADIUS * 2 + SPEED_CAP * FIXED_STEP);
    expect(BALL_RADIUS * 2 + SPEED_CAP * FIXED_STEP).toBe(46);
    expect(Math.round(jumped * 100) / 100).toBe(45.99);
  });
});
