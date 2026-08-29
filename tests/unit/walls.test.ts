import { describe, expect, it } from 'vitest';

import type { Body, BodyKind, World } from '../../src/core/bodies';
import { createWorld, setVelocity } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  DAMPING,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIXED_STEP,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_HYSTERESIS,
  GOAL_OPENING_LOW,
  SPEED_CAP,
  WALL_RESTITUTION,
} from '../../src/core/config';
import {
  WALL_BOTTOM,
  WALL_LEFT,
  WALL_RIGHT,
  WALL_TOP,
  contain,
  createSimulation,
  reflect,
} from '../../src/core/physics';
import { distance, set } from '../../src/core/vec2';

/**
 * Item B6, Critical: "Every body reflects correctly from every wall section
 * with the stated restitution, and the player and opponent circles can never
 * leave the playfield."
 *
 * TWO CLAUSES, TWO DIFFERENT KINDS OF EVIDENCE, and SPEC section 6.2 is what
 * separates them. Reflection is a velocity rule and is graded by arithmetic:
 * the component along the wall's normal comes back as minus 0.92 times what
 * went in, and the component along the wall does not move at all. Containment
 * is a position guarantee and is graded by a sweep: walls are half-space tests
 * on the field bound rather than slab-overlap tests against the 12 px wall
 * thickness, so no speed can defeat them and the assertion is simply that no
 * body is ever outside, however it got there.
 *
 * THE 0.92 IS WRITTEN OUT. Asserting a reflection against its own symbol passes
 * for whatever value the symbol takes, so the readings below use the number
 * SPEC section 6.1 states: 400 px/s into a wall comes back as 368 px/s.
 *
 * WHAT PF-4 CHANGED HERE. SPEC section 6.4 makes the left and right walls
 * transparent to a ball that fits the goal opening, item B7, so the goal-end
 * case below and the escape reading both state the new truth: a ball inside the
 * opening is neither clamped nor turned, a ball outside it still is, and a
 * circle still is at the very height the ball passed through. Item B7's own
 * evidence is tests/unit/goal-openings.test.ts; what is kept here is the
 * reading item B6 needs, which is that the goal ends are ordinary walls to
 * everything the opening does not exempt.
 */

/** Ten px per step at the cap, so 5 px outside is inside one step of travel. */
const OUTSIDE = 5;

/** Two resting places clear of every wall and of each other, for spare bodies. */
const PARKED: ReadonlyArray<readonly [number, number]> = [
  [500, 360],
  [780, 360],
];

interface WallCase {
  readonly label: string;
  readonly bit: number;
  /** The centre a body of this radius takes once this wall has clamped it. */
  readonly seat: (radius: number) => readonly [number, number];
  /** The unit direction out of the field through this wall. */
  readonly out: readonly [number, number];
  /** A velocity heading into the wall: 400 px/s along its normal, 250 across. */
  readonly into: readonly [number, number];
  /** The same velocity after the reflection SPEC section 6.3 states. */
  readonly back: readonly [number, number];
}

const WALLS: readonly WallCase[] = [
  {
    label: 'left',
    bit: WALL_LEFT,
    seat: (radius) => [FIELD_LEFT + radius, 200],
    out: [-1, 0],
    into: [-400, 250],
    back: [368, 250],
  },
  {
    label: 'right',
    bit: WALL_RIGHT,
    seat: (radius) => [FIELD_RIGHT - radius, 200],
    out: [1, 0],
    into: [400, -250],
    back: [-368, -250],
  },
  {
    label: 'bottom',
    bit: WALL_BOTTOM,
    seat: (radius) => [640, FIELD_BOTTOM + radius],
    out: [0, -1],
    into: [250, -400],
    back: [250, 368],
  },
  {
    label: 'top',
    bit: WALL_TOP,
    seat: (radius) => [640, FIELD_TOP - radius],
    out: [0, 1],
    into: [-250, 400],
    back: [-250, -368],
  },
];

const KINDS: readonly BodyKind[] = ['player', 'opponent', 'ball'];

/**
 * Every body outside the field bound it should have been clamped to.
 *
 * SPEC section 6.4 gives the ball exactly one legitimate way out, through a
 * goal opening, so a ball whose whole width is inside the opening is not an
 * escape. THE EXEMPTION IS HAND-WRITTEN FROM THAT SECTION rather than taken
 * from `ballFitsOpening`: a sweep that asked the code under test whether an
 * escape was allowed would start exempting circles the moment the predicate
 * stopped checking the kind, which is the one defect it exists to catch. The
 * kind check here is this file's own, and the widened bound is used for both
 * directions because a sweep is not the place to grade the hysteresis.
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
 * A direction per index, deterministic and irrational in turns, so a long run
 * drives every body into every wall and every corner rather than into the one
 * wall a fixed direction would find. The golden angle is the standard choice
 * for a sequence that never repeats a direction.
 *
 * THE INDEX IS A RUN OF STEPS RATHER THAN A STEP, and that is load-bearing. A
 * heading that turns by the golden angle every step is a body orbiting its own
 * starting point: the unit vectors sum to at most 1 / sin(1.2), so the body
 * never gets more than 11 px from where it began and never reaches a wall at
 * all. Held for 24 steps the same sequence is 240 px of travel per direction,
 * which crosses the field.
 */
function heading(index: number): number {
  return index * 2.399963229728653;
}

/** True when some body is seated exactly on a bound, which is a clamp. */
function seatedOnABound(world: World): boolean {
  return world.bodies.some(
    (body) =>
      body.position.x - body.radius === FIELD_LEFT ||
      body.position.x + body.radius === FIELD_RIGHT ||
      body.position.y - body.radius === FIELD_BOTTOM ||
      body.position.y + body.radius === FIELD_TOP,
  );
}

/** True when some pair is at its reach, which a resolved contact leaves it at. */
function inContact(world: World): boolean {
  const pairs: ReadonlyArray<readonly [Body, Body]> = [
    [world.player, world.opponent],
    [world.player, world.ball],
    [world.opponent, world.ball],
  ];
  return pairs.some(([a, b]) => distance(a.position, b.position) <= a.radius + b.radius + 1e-9);
}

/** The bodies other than this one, moved somewhere no wall and nothing else is. */
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

describe('PF-3 reflection off every wall, item B6', () => {
  it('turns the normal component and leaves the tangential one alone', () => {
    // The reading at its own level: `contain` clamps and says which wall did
    // it, `reflect` turns exactly that component. Every body against every
    // wall, which is twelve cases and is what "every body from every wall
    // section" asks for.
    let checked = 0;
    for (const kind of KINDS) {
      for (const wall of WALLS) {
        const body = createWorld()[kind];
        const [x, y] = wall.seat(body.radius);
        const where = `${kind} at the ${wall.label} wall`;
        // Five px past the bound, which is where half a step at the cap puts a
        // body that was inside when the step began.
        set(body.position, x + wall.out[0] * OUTSIDE, y + wall.out[1] * OUTSIDE);
        setVelocity(body, wall.into[0], wall.into[1]);

        const walls = contain(body);
        expect(walls, where).toBe(wall.bit);
        expect(body.position.x, `${where} clamped in x`).toBe(x);
        expect(body.position.y, `${where} clamped in y`).toBe(y);

        reflect(body, walls);

        expect(body.velocity.x, `${where} x after`).toBeCloseTo(wall.back[0], 9);
        expect(body.velocity.y, `${where} y after`).toBeCloseTo(wall.back[1], 9);
        // The restitution as a ratio on the wall's own normal axis, so the 368
        // above is the 0.92 the spec states rather than a number that matches
        // it; and the axis along the wall carries the velocity it arrived with,
        // to the last bit rather than to a tolerance.
        const acrossWall = wall.out[0] !== 0;
        const outward = acrossWall ? body.velocity.x : body.velocity.y;
        const inward = acrossWall ? wall.into[0] : wall.into[1];
        expect(outward / -inward, `${where} restitution`).toBeCloseTo(WALL_RESTITUTION, 12);
        expect(acrossWall ? body.velocity.y : body.velocity.x, `${where} tangential`).toBe(
          acrossWall ? wall.into[1] : wall.into[0],
        );
        expect(WALL_RESTITUTION).toBe(0.92);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });

  it('reflects through a whole fixed step, at every wall and on every body', () => {
    // The same twelve cases wired into DESIGN section 3's position 3, so that
    // what is graded is the step rather than a function nothing calls. The body
    // starts inside and the step's own integration carries it past the bound.
    const decay = DAMPING ** FIXED_STEP;
    let checked = 0;
    for (const kind of KINDS) {
      for (const wall of WALLS) {
        const sim = createSimulation({ onNonFinite: 'throw' });
        const body = sim.world[kind];
        parkTheRest(sim.world, body);
        const [x, y] = wall.seat(body.radius);
        // Two px clear of the bound, and 600 px/s into it, which is 5 px of
        // travel in one step: inside when the step begins, past it when the
        // integration ends, clamped and turned before the step is over.
        set(body.position, x - wall.out[0] * 2, y - wall.out[1] * 2);
        setVelocity(body, wall.out[0] * 600, wall.out[1] * 600);

        sim.step();

        const where = `${kind} through the ${wall.label} wall`;
        expect(body.position.x, `${where} in x`).toBe(x);
        expect(body.position.y, `${where} in y`).toBe(y);
        // 600 px/s in, 552 px/s out, then the one step of damping that follows
        // the reflection in DESIGN section 3's order.
        const speed = Math.hypot(body.velocity.x, body.velocity.y);
        expect(speed, where).toBeCloseTo(552 * decay, 9);
        expect(escapes(sim.world), where).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });

  it('turns both components at a corner, in one step', () => {
    // Two walls in one step. `contain` reports both bits and each turns its own
    // component, so a corner is not a special case in the code and must not be
    // one in the answer either.
    const corners: ReadonlyArray<readonly [string, number, number, number]> = [
      ['bottom left', FIELD_LEFT, FIELD_BOTTOM, WALL_LEFT | WALL_BOTTOM],
      ['bottom right', FIELD_RIGHT, FIELD_BOTTOM, WALL_RIGHT | WALL_BOTTOM],
      ['top left', FIELD_LEFT, FIELD_TOP, WALL_LEFT | WALL_TOP],
      ['top right', FIELD_RIGHT, FIELD_TOP, WALL_RIGHT | WALL_TOP],
    ];
    for (const [label, boundX, boundY, expected] of corners) {
      const body = createWorld().player;
      const towardsX = boundX === FIELD_LEFT ? -1 : 1;
      const towardsY = boundY === FIELD_BOTTOM ? -1 : 1;
      set(
        body.position,
        boundX - towardsX * body.radius + towardsX * OUTSIDE,
        boundY - towardsY * body.radius + towardsY * OUTSIDE,
      );
      setVelocity(body, towardsX * 400, towardsY * 250);

      const walls = contain(body);
      expect(walls, label).toBe(expected);

      reflect(body, walls);

      expect(body.velocity.x, `${label} in x`).toBeCloseTo(-towardsX * 368, 9);
      expect(body.velocity.y, `${label} in y`).toBeCloseTo(-towardsY * 230, 9);
      expect(body.position.x, `${label} seated in x`).toBe(boundX - towardsX * body.radius);
      expect(body.position.y, `${label} seated in y`).toBe(boundY - towardsY * body.radius);
    }
    expect(corners).toHaveLength(4);
  });

  it('leaves a body that is already travelling away from the wall alone', () => {
    // SPEC section 6.3's approach gate, applied to a wall's half-space and
    // asserted per wall off the mask. A body clamped in from outside while
    // already moving inward has nothing to reflect, and turning it would drive
    // it straight back into the wall it has just left.
    let checked = 0;
    for (const wall of WALLS) {
      const [x, y] = wall.seat(BALL_RADIUS);
      const leaving = createWorld().ball;
      set(leaving.position, x + wall.out[0] * 50, y + wall.out[1] * 50);
      setVelocity(leaving, -wall.out[0] * 300, -wall.out[1] * 300);

      const walls = contain(leaving);
      expect(walls, `${wall.label} wall`).toBe(wall.bit);

      reflect(leaving, walls);

      expect(leaving.velocity.x, `${wall.label} in x`).toBe(-wall.out[0] * 300);
      expect(leaving.velocity.y, `${wall.label} in y`).toBe(-wall.out[1] * 300);
      expect(leaving.position.x, `${wall.label} seated in x`).toBe(x);
      expect(leaving.position.y, `${wall.label} seated in y`).toBe(y);

      // The other direction from the very same place, so the reading above is
      // not passed by a reflection that has stopped happening at all.
      const arriving = createWorld().ball;
      set(arriving.position, x + wall.out[0] * 50, y + wall.out[1] * 50);
      setVelocity(arriving, wall.out[0] * 300, wall.out[1] * 300);
      reflect(arriving, contain(arriving));
      expect(arriving.velocity.x, `${wall.label} turned in x`).toBeCloseTo(
        -wall.out[0] * 276,
        9,
      );
      expect(arriving.velocity.y, `${wall.label} turned in y`).toBeCloseTo(
        -wall.out[1] * 276,
        9,
      );
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it('reflects nothing at all when no wall clamped the body', () => {
    // The other direction, and the one that says the mask is what is being
    // consulted. A body crossing open field is moving into some wall in the
    // sense of pointing at it, so a reflection that read the velocity without
    // reading the mask would turn it back every step and no body would ever
    // reach a wall at all. Every direction, so no single wall can be the one
    // that stopped consulting it.
    const decay = DAMPING ** FIXED_STEP;
    const directions: ReadonlyArray<readonly [string, number, number]> = [
      ['left', -600, 0],
      ['right', 600, 0],
      ['down', 0, -600],
      ['up', 0, 600],
    ];
    for (const [label, vx, vy] of directions) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const body = sim.world.player;
      parkTheRest(sim.world, body);
      // Well inside every bound, and 5 px of travel per step, so nothing is
      // clamped and nothing else is touched.
      set(body.position, 300, 200);
      setVelocity(body, vx, vy);

      sim.step();

      expect(body.velocity.x, `${label} in x`).toBeCloseTo(vx * decay, 9);
      expect(body.velocity.y, `${label} in y`).toBeCloseTo(vy * decay, 9);
      expect(contain(body), `${label} is nowhere near a wall`).toBe(0);
      expect(escapes(sim.world), label).toEqual([]);
    }
    expect(directions).toHaveLength(4);
  });

  it('reflects the ball off the goal ends only where the opening is not', () => {
    // REWRITTEN AT PF-4, AND THE CASE IT USED TO ASSERT IS THE FIRST ONE BELOW.
    // PF-3 shipped with all three bodies turned by all four walls, and said so
    // here, because SPEC section 6.4's transparency is item B7 at PF-4. It has
    // landed, so the truth this file states is the new one: a ball inside the
    // opening is not clamped by the goal end and therefore is not turned by it,
    // a ball outside the opening still is, and a circle always is.
    const middle = (GOAL_OPENING_LOW + GOAL_OPENING_HIGH) / 2;
    expect(middle - BALL_RADIUS).toBeGreaterThanOrEqual(GOAL_OPENING_LOW);
    expect(middle + BALL_RADIUS).toBeLessThanOrEqual(GOAL_OPENING_HIGH);
    // A height the ball does not fit at, well clear of both posts.
    const past = GOAL_OPENING_LOW - 100;
    expect(past - BALL_RADIUS).toBeLessThan(GOAL_OPENING_LOW);

    let checked = 0;
    for (const [label, bound, towards] of [
      ['left', FIELD_LEFT, -1],
      ['right', FIELD_RIGHT, 1],
    ] as const) {
      const bit = towards < 0 ? WALL_LEFT : WALL_RIGHT;

      // Inside the opening: no clamp, no wall bit, and so no reflection. The
      // position is left exactly where the step put it, 5 px outside the field.
      const through = createWorld().ball;
      const beyond = bound - towards * BALL_RADIUS + towards * OUTSIDE;
      set(through.position, beyond, middle);
      setVelocity(through, towards * 400, 0);

      const none = contain(through);
      expect(none, `${label} opening`).toBe(0);
      reflect(through, none);
      expect(through.velocity.x, `${label} opening keeps its speed`).toBe(towards * 400);
      expect(through.position.x, `${label} opening is not clamped`).toBe(beyond);

      // Outside the opening at the same goal end: clamped and turned, exactly
      // as any wall does it, which is the half of the old case that survives.
      const blocked = createWorld().ball;
      set(blocked.position, beyond, past);
      setVelocity(blocked, towards * 400, 0);

      const walls = contain(blocked);
      expect(walls, `${label} goal end`).toBe(bit);
      reflect(blocked, walls);
      expect(blocked.velocity.x, `${label} goal end`).toBeCloseTo(-towards * 368, 9);
      expect(blocked.position.x, `${label} goal end`).toBe(bound - towards * BALL_RADIUS);

      // And a circle at the very height the ball passed through, which is the
      // type rule: it fits the opening geometrically and is turned anyway.
      const circle = createWorld().player;
      const circleBeyond = bound - towards * circle.radius + towards * OUTSIDE;
      set(circle.position, circleBeyond, middle);
      setVelocity(circle, towards * 400, 0);
      expect(middle - circle.radius).toBeGreaterThanOrEqual(GOAL_OPENING_LOW);
      expect(middle + circle.radius).toBeLessThanOrEqual(GOAL_OPENING_HIGH);

      const circleWalls = contain(circle);
      expect(circleWalls, `${label} goal end, circle`).toBe(bit);
      reflect(circle, circleWalls);
      expect(circle.velocity.x, `${label} goal end, circle`).toBeCloseTo(-towards * 368, 9);
      expect(circle.position.x, `${label} goal end, circle`).toBe(
        bound - towards * circle.radius,
      );
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe('PF-3 nothing leaves the playfield, item B6', () => {
  it('contains every body through a long adversarial drive at the cap', () => {
    // The tunneling sweep of item B9, re-run now that a step can also move a
    // body by separating it from another. A pair squeezed against a wall is
    // pushed apart before the walls are resolved, so the containment that
    // follows is what has to hold, and it is checked after every fixed step
    // rather than after every frame.
    const sim = createSimulation({ onNonFinite: 'throw' });
    let contacts = 0;
    let clamps = 0;
    for (let step = 0; step < 4000; step += 1) {
      // A direction per body as well as per run of steps, so the three cross
      // each other's paths rather than travelling as one rigid group, which is
      // what puts a contact and a wall inside the same step.
      sim.world.bodies.forEach((body, at) => {
        const angle = heading(Math.floor(step / 60) + at * 5);
        setVelocity(body, Math.cos(angle) * SPEED_CAP, Math.sin(angle) * SPEED_CAP);
      });
      sim.step();
      expect(escapes(sim.world), `step ${String(step)}`).toEqual([]);
      clamps += seatedOnABound(sim.world) ? 1 : 0;
      contacts += inContact(sim.world) ? 1 : 0;
    }
    // A sweep nobody measured is a sweep that proves whatever it happened to
    // do. The drive really did press bodies against the bounds and really did
    // put them in contact, so containment was tested against a wall and
    // against a separation rather than beside both.
    // The run is deterministic, so these are floors under measured counts
    // rather than hopes: 635 of the 4000 steps ended with a body seated on a
    // bound and 420 of them ended with a pair at its reach.
    expect(clamps).toBeGreaterThan(400);
    expect(contacts).toBeGreaterThan(200);
  });

  it('contains three bodies dropped on one point inside a corner', () => {
    // The hardest case for containment: a pile whose separation has to push
    // two of the three outward, into the two walls that meet there. Every
    // corner, and held for long enough that a body edging out a fraction of a
    // pixel per step would have left.
    const corners: ReadonlyArray<readonly [number, number]> = [
      [FIELD_LEFT, FIELD_BOTTOM],
      [FIELD_RIGHT, FIELD_BOTTOM],
      [FIELD_LEFT, FIELD_TOP],
      [FIELD_RIGHT, FIELD_TOP],
    ];
    for (const [x, y] of corners) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      for (const body of sim.world.bodies) {
        set(body.position, x, y);
      }
      for (let step = 0; step < 500; step += 1) {
        sim.step();
        expect(escapes(sim.world), `corner ${String(x)}, ${String(y)}`).toEqual([]);
      }
    }
    expect(corners).toHaveLength(4);
  });

  it('contains the circles when the ball is driven into them against a wall', () => {
    // The clause names the two circles specifically, so the case that squeezes
    // them is run on its own: both circles parked against the right wall with
    // the ball fired into them at the cap, over and over.
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (let step = 0; step < 2000; step += 1) {
      set(sim.world.player.position, FIELD_RIGHT - 34, 320);
      set(sim.world.opponent.position, FIELD_RIGHT - 34, 400);
      setVelocity(sim.world.ball, SPEED_CAP, Math.sin(heading(step)) * SPEED_CAP);
      set(sim.world.ball.position, FIELD_RIGHT - 100, 360);
      sim.step();
      expect(escapes(sim.world), `step ${String(step)}`).toEqual([]);
    }
  });
});
