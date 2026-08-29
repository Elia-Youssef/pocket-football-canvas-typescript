import { describe, expect, it } from 'vitest';

import type { World } from '../../src/core/bodies';
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
  SPEED_CAP,
  WALL_THICKNESS,
} from '../../src/core/config';
import {
  WALL_BOTTOM,
  WALL_LEFT,
  WALL_RIGHT,
  WALL_TOP,
  contain,
  createSimulation,
} from '../../src/core/physics';
import { distance, set } from '../../src/core/vec2';
import { RATES } from './support/drive';

/**
 * Item B9, Critical: "No body tunnels through a wall or past the ball at the
 * global speed cap, at any supported frame rate, including after a delta spike
 * clamped to 0.25 s and a gap over 5 s treated as a resume."
 *
 * THE TWO HALVES ARE NOT THE SAME PROPERTY, and SPEC section 6.2 says so.
 *
 *   Walls are half-space containment tests on the field bound rather than
 *   slab-overlap tests against the 12 px wall thickness, so they cannot be
 *   tunneled at any speed. The thickness is presentational, and the test for
 *   this half is that no body is ever outside the bound, however it got there.
 *
 *   Passing the ball is a sampling question, and it is a budget rather than a
 *   guarantee: at the cap a body moves at most 10 px per step and two bodies
 *   close at most 20 px, against the 104 px contact disc of a circle and the
 *   ball. The arithmetic is asserted below AND measured below, because the
 *   arithmetic alone is a claim about a formula rather than about this code.
 *
 * The grazing case the section discloses is checked rather than glossed: a
 * contact whose impact parameter is within 0.97 px of the touching distance can
 * be skipped by discrete sampling, and that number re-derives here from the
 * step budget rather than being copied.
 *
 * PF-3 owns the collision response that consumes this budget (item B4). What
 * PF-2 owes it is the guarantee that a step never skips over the disc.
 */

/** The touching distance of a circle and the ball, SPEC section 6.2. */
const CONTACT_DISTANCE = CIRCLE_RADIUS + BALL_RADIUS;

/**
 * Every body outside the field bound it should have been clamped to.
 *
 * PF-4 gave the ball one legitimate way out, through a goal opening, SPEC
 * section 6.4, so a ball whose whole width is inside the opening is not an
 * escape. THE EXEMPTION IS HAND-WRITTEN FROM THAT SECTION rather than taken
 * from `ballFitsOpening`: a sweep that asked the code under test whether an
 * escape was allowed would start exempting circles the moment the predicate
 * stopped checking the kind, and a circle leaving through an opening is exactly
 * what this sweep is here to refuse.
 */
function escapes(world: World): string[] {
  const out: string[] = [];
  for (const body of world.bodies) {
    const at = body.position;
    const throughAnOpening =
      body.kind === 'ball' &&
      at.y - body.radius >= GOAL_OPENING_LOW - GOAL_OPENING_HYSTERESIS &&
      at.y + body.radius <= GOAL_OPENING_HIGH + GOAL_OPENING_HYSTERESIS;
    if (!throughAnOpening && !(at.x - body.radius >= FIELD_LEFT)) {
      out.push(`${body.kind} past the left bound at ${String(at.x)}`);
    }
    if (!throughAnOpening && !(at.x + body.radius <= FIELD_RIGHT)) {
      out.push(`${body.kind} past the right bound at ${String(at.x)}`);
    }
    if (!(at.y - body.radius >= FIELD_BOTTOM)) {
      out.push(`${body.kind} past the bottom bound at ${String(at.y)}`);
    }
    if (!(at.y + body.radius <= FIELD_TOP)) {
      out.push(`${body.kind} past the top bound at ${String(at.y)}`);
    }
  }
  return out;
}

/**
 * A direction per frame, deterministic and irrational in turns, so a long run
 * drives every body into every wall and every corner at the cap rather than
 * into the one wall a fixed direction would find. The golden angle is the
 * standard choice for a sequence that never repeats a direction.
 */
function heading(index: number): number {
  return index * 2.399963229728653;
}

describe('PF-2 the tunneling budget, item B9', () => {
  it('states the budget SPEC section 6.2 derives, in numbers', () => {
    const perStep = SPEED_CAP * FIXED_STEP;
    expect(perStep).toBe(10);
    expect(perStep * 2).toBe(20);
    expect(CONTACT_DISTANCE * 2).toBe(104);
    expect((CONTACT_DISTANCE * 2) / (perStep * 2)).toBe(5.2);

    // "the threshold is not one body's radius", and it is not the wall either.
    expect(CONTACT_DISTANCE * 2).toBeGreaterThan(BALL_RADIUS * 2);
    expect(CONTACT_DISTANCE * 2).toBeGreaterThan(WALL_THICKNESS);

    // The grazing band: the closest sample can sit half a closing step to
    // either side of the true closest approach, so an impact parameter beyond
    // sqrt(52^2 - 10^2) can be sampled outside the disc on both sides.
    const missable = CONTACT_DISTANCE - Math.sqrt(CONTACT_DISTANCE ** 2 - perStep ** 2);
    expect(Math.round(missable * 100) / 100).toBe(0.97);
    expect(missable).toBeLessThan(1);
  });

  it('moves exactly the budgeted 10 px in a step at the cap', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.player.position, 400, 360);
    setVelocity(sim.world.player, SPEED_CAP, 0);
    sim.step();
    expect(sim.world.player.position.x).toBe(410);
    expect(sim.world.player.position.y).toBe(360);
  });

  it('contains every body held at the cap, at every supported rate', () => {
    for (const fps of RATES) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const frames = Math.max(400, Math.round(fps * 2));
      for (let frame = 0; frame < frames; frame += 1) {
        const angle = heading(frame);
        for (const body of sim.world.bodies) {
          setVelocity(body, Math.cos(angle) * SPEED_CAP, Math.sin(angle) * SPEED_CAP);
        }
        sim.update(1 / fps);
        expect(escapes(sim.world), `at ${String(fps)} frames per second`).toEqual([]);
      }
    }
  });

  it('contains every body held at the cap, checked after every fixed step', () => {
    // Stronger than the frame check above: a frame that ran thirty steps is
    // contained at each of them rather than only where the frame ended.
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (let step = 0; step < 4000; step += 1) {
      const angle = heading(step);
      for (const body of sim.world.bodies) {
        setVelocity(body, Math.cos(angle) * SPEED_CAP, Math.sin(angle) * SPEED_CAP);
      }
      sim.step();
      expect(escapes(sim.world)).toEqual([]);
    }
  });

  it('contains every body across a clamped spike and a resume', () => {
    // The clock item B9 names: an ordinary frame, a spike far past the 0.25 s
    // ceiling, a gap past the 5 s resume threshold, and the readings that are
    // treated as zero.
    const hostile: readonly number[] = [
      1 / 60,
      3,
      1 / 144,
      40,
      0.25,
      -1,
      Number.NaN,
      1 / 30,
      7,
      1 / 1000,
    ];
    const sim = createSimulation({ onNonFinite: 'throw' });
    let clamped = 0;
    let resumed = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const angle = heading(frame);
      for (const body of sim.world.bodies) {
        setVelocity(body, Math.cos(angle) * SPEED_CAP, Math.sin(angle) * SPEED_CAP);
      }
      const report = sim.update(hostile[frame % hostile.length] ?? 0);
      clamped += report.clamped ? 1 : 0;
      resumed += report.resumed ? 1 : 0;
      expect(escapes(sim.world)).toEqual([]);
    }
    // The hostile readings were actually exercised rather than merely listed.
    expect(clamped).toBeGreaterThan(50);
    expect(resumed).toBeGreaterThan(50);
  });

  it('pulls a body placed outside the field back inside within one step', () => {
    // Half-space rather than slab: the test is which side of the bound the
    // body is on, so an arbitrary distance outside is one step from contained.
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.player.position, -5000, 90000);
    set(sim.world.ball.position, 1e6, -1e6);
    sim.step();
    expect(escapes(sim.world)).toEqual([]);
    expect(sim.world.player.position.x).toBe(FIELD_LEFT + CIRCLE_RADIUS);
    expect(sim.world.player.position.y).toBe(FIELD_TOP - CIRCLE_RADIUS);
    expect(sim.world.ball.position.x).toBe(FIELD_RIGHT - BALL_RADIUS);
    expect(sim.world.ball.position.y).toBe(FIELD_BOTTOM + BALL_RADIUS);
  });
});

describe('PF-2 the wall mask, which is the contract PF-3 reads, item B9', () => {
  /**
   * `contain` returns which bounds clamped a body, and PF-3's item B6 reflects
   * the normal component per wall off that answer. Nothing at PF-2 reads it, so
   * without this block the whole mask could drop a bit, share a value between
   * two walls, or collapse a pair, and every test in this file would still
   * pass. The contract is pinned here BEFORE the part that builds on it.
   */
  it('is four distinct powers of two, one per wall', () => {
    expect(WALL_LEFT).toBe(1);
    expect(WALL_RIGHT).toBe(2);
    expect(WALL_BOTTOM).toBe(4);
    expect(WALL_TOP).toBe(8);

    const bits = [WALL_LEFT, WALL_RIGHT, WALL_BOTTOM, WALL_TOP];
    expect(new Set(bits).size).toBe(4);
    for (const bit of bits) {
      expect(Number.isInteger(Math.log2(bit)), `${String(bit)} is a power of two`).toBe(true);
    }
    // No two walls share a bit, which is what makes a corner readable at all.
    expect(bits.reduce((all, bit) => all | bit, 0)).toBe(15);
  });

  it('returns exactly the wall that clamped, and both of them at a corner', () => {
    const ball = createWorld().ball;
    const out = 100;
    // THE TWO GOAL-LINE CASES ARE READ CLEAR OF THE OPENING, and the two that
    // are not are the last pair. PF-4 made the goal ends transparent to a ball
    // that fits the opening, SPEC section 6.4, so a ball at the midline is not
    // clamped by them and the mask it answers with is empty. That is the same
    // contract rather than an exception to it: a bit per wall that CLAMPED.
    const cases: ReadonlyArray<readonly [string, number, number, number, number]> = [
      ['inside the field', 640, 360, 0, 0],
      ['past the left bound, clear of the opening', FIELD_LEFT - out, 200, WALL_LEFT, 1],
      ['past the right bound, clear of the opening', FIELD_RIGHT + out, 200, WALL_RIGHT, 1],
      ['past the bottom bound', 640, FIELD_BOTTOM - out, WALL_BOTTOM, 1],
      ['past the top bound', 640, FIELD_TOP + out, WALL_TOP, 1],
      ['into the bottom left corner', FIELD_LEFT - out, FIELD_BOTTOM - out, 5, 2],
      ['into the top left corner', FIELD_LEFT - out, FIELD_TOP + out, 9, 2],
      ['into the bottom right corner', FIELD_RIGHT + out, FIELD_BOTTOM - out, 6, 2],
      ['into the top right corner', FIELD_RIGHT + out, FIELD_TOP + out, 10, 2],
      ['through the left goal opening', FIELD_LEFT - out, 360, 0, 0],
      ['through the right goal opening', FIELD_RIGHT + out, 360, 0, 0],
    ];

    for (const [label, x, y, expected, bits] of cases) {
      set(ball.position, x, y);
      const walls = contain(ball);
      // The literal answer, so a swapped or dropped bit cannot agree with
      // itself, and the count of bits, so a corner cannot answer with one wall.
      expect(walls, label).toBe(expected);
      expect(
        [WALL_LEFT, WALL_RIGHT, WALL_BOTTOM, WALL_TOP].filter((bit) => (walls & bit) !== 0).length,
        `${label} sets one bit per wall that clamped`,
      ).toBe(bits);
    }
    expect(cases).toHaveLength(11);
  });

  it('never reports a wall it did not clamp', () => {
    // The other direction: a body well inside answers with nothing, at every
    // position a body can legally hold.
    const ball = createWorld().ball;
    for (let x = FIELD_LEFT + BALL_RADIUS; x <= FIELD_RIGHT - BALL_RADIUS; x += 50) {
      for (let y = FIELD_BOTTOM + BALL_RADIUS; y <= FIELD_TOP - BALL_RADIUS; y += 50) {
        set(ball.position, x, y);
        expect(contain(ball), `${String(x)}, ${String(y)}`).toBe(0);
      }
    }
  });
});

describe('PF-2 discrete sampling never skips the contact disc, item B9', () => {
  /** The closest the two bodies were ever sampled during a head-on approach. */
  function closestApproach(impact: number): number {
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.player.position, 400, 360);
    set(sim.world.ball.position, 900, 360 + impact);
    setVelocity(sim.world.player, SPEED_CAP, 0);
    setVelocity(sim.world.ball, -SPEED_CAP, 0);

    let closest = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 240; step += 1) {
      sim.step();
      closest = Math.min(closest, distance(sim.world.player.position, sim.world.ball.position));
    }
    return closest;
  }

  it('samples inside the disc for every impact parameter that should touch', () => {
    // THE ULP ALLOWANCE IS PF-3'S, and it is an allowance rather than a
    // loosening. A sample is taken after a whole step, and from PF-3 a step
    // that finds a pair inside the disc separates it back out to exactly the
    // touching distance before the sample is taken (item B5). The closest
    // reading a resolved contact can produce is therefore the touching distance
    // itself, which `Math.hypot` of the separated centres can land one ulp
    // above. 1e-9 px against 52 px is two parts in a hundred thousand million;
    // the near misses below are 8 px clear, so nothing else fits in the gap.
    let checked = 0;
    for (let impact = 0; impact <= 51; impact += 1) {
      expect(closestApproach(impact), `impact parameter ${String(impact)}`).toBeLessThanOrEqual(
        CONTACT_DISTANCE + 1e-9,
      );
      checked += 1;
    }
    expect(checked).toBe(52);
  });

  it('does not manufacture a contact that was never there', () => {
    // The other direction, so the check above is not passed by a measurement
    // that reports zero for everything.
    for (const impact of [60, 80, 120]) {
      expect(closestApproach(impact), `impact parameter ${String(impact)}`).toBeGreaterThan(
        CONTACT_DISTANCE,
      );
    }
  });
});
