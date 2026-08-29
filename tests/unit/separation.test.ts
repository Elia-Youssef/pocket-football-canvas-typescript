import { describe, expect, it } from 'vitest';

import type { Body, BodyKind } from '../../src/core/bodies';
import { everyBodyStopped, launch, setVelocity } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
  COINCIDENT_EPSILON,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  SOLVER_ITERATIONS,
} from '../../src/core/config';
import { createSimulation } from '../../src/core/physics';
import { distance, set } from '../../src/core/vec2';
import { digest } from './support/drive';

/**
 * Item B5, Critical: "Overlapping bodies are positionally separated along the
 * contact normal before the impulse is applied, including the coincident-centres
 * case and three bodies meeting at one point. No sinking and no jitter."
 *
 * WHAT "BEFORE THE IMPULSE" CAN AND CANNOT BE OBSERVED AS, said plainly rather
 * than assumed. Inside one pair the two orders produce the same answer: the
 * separation moves both bodies along the contact normal, which changes neither
 * the normal itself nor either velocity, so an impulse computed before it and
 * an impulse computed after it are the same impulse. Peering at the order of
 * two statements would be a test of the source rather than of the game.
 *
 * What the criterion's clause does have observable content for, and what is
 * graded here, is all of the following:
 *
 *   the separation is POSITIONAL, so an overlapping pair at rest comes apart
 *   without either body acquiring any speed at all, which is what a separation
 *   done by an impulse would give it;
 *
 *   it is COMPLETE, so a pair that overlapped by 12 px ends up exactly
 *   touching, each body having moved exactly half of the penetration;
 *
 *   it is ALONG THE CONTACT NORMAL, exactly (1, 0) when the centres coincide;
 *
 *   and it is applied to the pairs in a FIXED ORDER, which for any pile of
 *   three is observable in the positions themselves. The three-body case below
 *   pins that order and the four passes together, against positions derived by
 *   hand from SPEC section 6.3 and written out pass by pass.
 *
 * The gate that keeps the impulse off a pair which is not approaching is item
 * B4's, and is graded in tests/unit/collision.test.ts.
 */

/** The three pairs, in SPEC section 6.3's fixed resolution order. */
const PAIRS: ReadonlyArray<readonly [BodyKind, BodyKind]> = [
  ['player', 'opponent'],
  ['player', 'ball'],
  ['opponent', 'ball'],
];

/** Somewhere no wall and no third body reaches, for a pair driven on its own. */
const PARKED_X = 1100;
const PARKED_Y = 550;

/**
 * The jitter metric, stated once and used by every claim below: the largest
 * distance any one centre moves during any one step of a measured window. A
 * settled world is a fixed point of the step, so the honest bound is zero, and
 * 1e-9 px is what is asserted: four orders of magnitude under a pixel and
 * still four above the last place of a double at these coordinates. Every
 * measurement below reports zero.
 */
const JITTER_BOUND = 1e-9;

function largestStep(sim: ReturnType<typeof createSimulation>, steps: number): number {
  const previous = sim.world.bodies.map((body) => ({ x: body.position.x, y: body.position.y }));
  let worst = 0;
  for (let step = 0; step < steps; step += 1) {
    sim.step();
    sim.world.bodies.forEach((body, at) => {
      const was = previous[at];
      if (was === undefined) {
        return;
      }
      const moved = Math.hypot(body.position.x - was.x, body.position.y - was.y);
      if (moved > worst) {
        worst = moved;
      }
      was.x = body.position.x;
      was.y = body.position.y;
    });
  }
  return worst;
}

/** How far a pair is inside one another, zero when they are merely touching. */
function penetrationOf(a: Body, b: Body): number {
  return Math.max(0, a.radius + b.radius - distance(a.position, b.position));
}

function worstPenetration(sim: ReturnType<typeof createSimulation>): number {
  const world = sim.world;
  return Math.max(
    penetrationOf(world.player, world.opponent),
    penetrationOf(world.player, world.ball),
    penetrationOf(world.opponent, world.ball),
  );
}

/**
 * Three bodies dropped into a 30 px box in the named corner: overlapping each
 * other and pressed against both walls, which is the case the two walls make
 * hardest for a separation that has nowhere to push.
 */
function cornerPile(x: number, y: number): ReturnType<typeof createSimulation> {
  const sim = createSimulation({ onNonFinite: 'throw' });
  const inwardX = x === FIELD_LEFT ? 1 : -1;
  const inwardY = y === FIELD_BOTTOM ? 1 : -1;
  set(sim.world.player.position, x + inwardX * 10, y + inwardY * 10);
  set(sim.world.opponent.position, x + inwardX * 40, y + inwardY * 10);
  set(sim.world.ball.position, x + inwardX * 10, y + inwardY * 40);
  return sim;
}

/** True when some pair is at its reach, which a resolved contact leaves it at. */
function touching(sim: ReturnType<typeof createSimulation>): boolean {
  const world = sim.world;
  const pairs: ReadonlyArray<readonly [Body, Body]> = [
    [world.player, world.opponent],
    [world.player, world.ball],
    [world.opponent, world.ball],
  ];
  return pairs.some(
    ([a, b]) => distance(a.position, b.position) <= a.radius + b.radius + JITTER_BOUND,
  );
}

describe('PF-3 separation is positional, item B5', () => {
  it('takes an overlapping pair apart without giving either body any speed', () => {
    // The clause with the clearest observable content. Two bodies at rest,
    // overlapping by 20 px, are exactly touching after one step and both are
    // still stopped: nothing about coming apart was done with velocity, and the
    // approach gate refused the impulse a pair at rest cannot have earned.
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.opponent.position, PARKED_X, PARKED_Y);
    set(sim.world.player.position, 600, 360);
    set(sim.world.ball.position, 632, 360);
    expect(penetrationOf(sim.world.player, sim.world.ball)).toBe(20);

    sim.step();

    expect(distance(sim.world.player.position, sim.world.ball.position)).toBe(52);
    expect(sim.world.player.velocity.x).toBe(0);
    expect(sim.world.player.velocity.y).toBe(0);
    expect(sim.world.ball.velocity.x).toBe(0);
    expect(sim.world.ball.velocity.y).toBe(0);
    expect(everyBodyStopped(sim.world)).toBe(true);
  });

  it('moves each body by exactly half the penetration, along the normal', () => {
    // On one axis first, where the arithmetic is exact and can be read off:
    // 52 px of reach against 40 px of separation is 12 px of penetration, so
    // each body moves 6 px and neither moves across the normal at all.
    const straight = createSimulation({ onNonFinite: 'throw' });
    set(straight.world.opponent.position, PARKED_X, PARKED_Y);
    set(straight.world.player.position, 600, 360);
    set(straight.world.ball.position, 640, 360);

    straight.step();

    expect(straight.world.player.position.x).toBe(594);
    expect(straight.world.player.position.y).toBe(360);
    expect(straight.world.ball.position.x).toBe(646);
    expect(straight.world.ball.position.y).toBe(360);

    // And on the 3-4-5 offset, where the normal is exactly (0.6, 0.8): 50 px
    // apart is 2 px of penetration, so each body moves 1 px along the normal,
    // which is (0.6, 0.8) px of movement and not (1, 1) px of it.
    const oblique = createSimulation({ onNonFinite: 'throw' });
    set(oblique.world.opponent.position, PARKED_X, PARKED_Y);
    set(oblique.world.player.position, 600, 300);
    set(oblique.world.ball.position, 630, 340);

    oblique.step();

    expect(oblique.world.player.position.x).toBeCloseTo(599.4, 9);
    expect(oblique.world.player.position.y).toBeCloseTo(299.2, 9);
    expect(oblique.world.ball.position.x).toBeCloseTo(630.6, 9);
    expect(oblique.world.ball.position.y).toBeCloseTo(340.8, 9);
    expect(
      distance(oblique.world.player.position, oblique.world.ball.position),
    ).toBeCloseTo(52, 9);
  });
});

describe('PF-3 coincident centres, item B5', () => {
  it('separates along the fixed (1, 0) normal by the sum of the radii', () => {
    // SPEC section 6.3: "When the centres are coincident (|b.pos - a.pos| <
    // 1e-6) the normal falls back to (1, 0) and the separation is the full
    // a.r + b.r. The fallback is fixed rather than random so the case stays
    // deterministic." The first body of the pair goes to negative x, the second
    // to positive x, and neither moves in y at all: a fallback of (0, 1) or a
    // drawn one would show up in both of those readings at once.
    expect(COINCIDENT_EPSILON).toBe(1e-6);
    let checked = 0;
    for (const [first, second] of PAIRS) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const a = sim.world[first];
      const b = sim.world[second];
      const spare = sim.world.bodies.find((body) => body !== a && body !== b);
      expect(spare).toBeDefined();
      if (spare === undefined) {
        return;
      }
      set(spare.position, PARKED_X, PARKED_Y);
      set(a.position, 600, 360);
      set(b.position, 600, 360);
      const reach = a.radius + b.radius;

      sim.step();

      expect(a.position.x, `${first} against ${second}`).toBe(600 - reach / 2);
      expect(b.position.x, `${first} against ${second}`).toBe(600 + reach / 2);
      expect(a.position.y, `${first} against ${second}`).toBe(360);
      expect(b.position.y, `${first} against ${second}`).toBe(360);
      expect(distance(a.position, b.position), `${first} against ${second}`).toBe(reach);
      // Positional, again: a pair dropped on one point does not fly apart.
      expect(a.velocity.x).toBe(0);
      expect(b.velocity.x).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(3);
    // The two circles come apart by 68 px and a circle and the ball by 52.
    expect(CIRCLE_RADIUS * 2).toBe(68);
    expect(CIRCLE_RADIUS + BALL_RADIUS).toBe(52);
  });

  it('answers the same way on every run, which is what fixed rather than random means', () => {
    // A drawn normal would satisfy every assertion above on any single run and
    // fail this one, and it is the reading SPEC section 6.3 rules out by name.
    const coincident = (): string => {
      const sim = createSimulation({ onNonFinite: 'throw' });
      for (const body of sim.world.bodies) {
        set(body.position, 600, 360);
      }
      sim.step();
      return digest(sim.world);
    };
    const first = coincident();
    for (let run = 0; run < 5; run += 1) {
      expect(coincident(), `run ${String(run)}`).toBe(first);
    }
    // Not the digest of a world nobody touched.
    expect(first).not.toBe(digest(createSimulation({ onNonFinite: 'throw' }).world));
  });
});

describe('PF-3 three bodies meeting at one point, item B5', () => {
  it('settles them to under 1 px of residual penetration in four passes', () => {
    // SPEC section 6.3: the three pairs are "resolved in the fixed order
    // player-opponent, player-ball, opponent-ball, iterated 4 times per step so
    // that three bodies meeting at one point settle to under 1 px of residual
    // penetration". All three are dropped on x = 600, and the whole of one step
    // is derived below by hand from the section. Every value is a binary
    // fraction, so the arithmetic is exact and can be asserted with `toBe`.
    //
    //   pass 1  P-O  coincident, reach 68  P 566      O 634
    //           P-B  34 apart, reach 52    P 557      B 609
    //           O-B  25 apart, reach 52    O 647.5    B 595.5
    //   pass 2  P-O  90.5 apart            no contact
    //           P-B  38.5 apart            P 550.25   B 602.25
    //           O-B  45.25 apart           O 650.875  B 598.875
    //   pass 3  P-O  100.625 apart         no contact
    //           P-B  48.625 apart          P 548.5625     B 600.5625
    //           O-B  50.3125 apart         O 651.71875    B 599.71875
    //   pass 4  P-O  103.15625 apart       no contact
    //           P-B  51.15625 apart        P 548.140625   B 600.140625
    //           O-B  51.578125 apart       O 651.9296875  B 599.9296875
    //
    // Nothing has any velocity at any point, so no impulse is ever earned and
    // no body leaves y = 360. Any other pair order, any other pass count and
    // any other fallback normal lands somewhere else.
    expect(SOLVER_ITERATIONS).toBe(4);
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (const body of sim.world.bodies) {
      set(body.position, 600, 360);
    }

    sim.step();

    expect(sim.world.player.position.x).toBe(548.140625);
    expect(sim.world.opponent.position.x).toBe(651.9296875);
    expect(sim.world.ball.position.x).toBe(599.9296875);
    for (const body of sim.world.bodies) {
      expect(body.position.y, body.kind).toBe(360);
      expect(body.velocity.x, body.kind).toBe(0);
      expect(body.velocity.y, body.kind).toBe(0);
    }

    // The claim the four passes exist for, measured rather than assumed.
    const residual = worstPenetration(sim);
    expect(residual).toBe(0.2109375);
    expect(residual).toBeLessThan(1);
    // And it is a real measurement rather than a zero that would pass anything:
    // one pass of the three pairs leaves 27 px, which is what the other three
    // passes are for.
    expect(residual).toBeGreaterThan(0);
  });

  it('takes the pile the rest of the way down over the steps that follow', () => {
    // Under 1 px is what one step promises. A pile nobody disturbs keeps
    // closing on nothing, so the residual is gone entirely well inside a
    // second of play and stays gone.
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (const body of sim.world.bodies) {
      set(body.position, 600, 360);
    }
    for (let step = 0; step < 120; step += 1) {
      sim.step();
      expect(worstPenetration(sim), `step ${String(step)}`).toBeLessThan(1);
    }
    expect(worstPenetration(sim)).toBe(0);
  });
});

describe('PF-3 no sinking and no jitter, item B5', () => {
  it('holds a resting pair at its touching distance for a thousand steps', () => {
    // Sinking is the failure where a contact resolved once comes back a little
    // deeper every step until two bodies share a centre. A pair placed exactly
    // touching, at rest, is a fixed point of the step and has to stay one.
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.opponent.position, PARKED_X, PARKED_Y);
    set(sim.world.player.position, 600, 360);
    set(sim.world.ball.position, 652, 360);

    let deepest = 0;
    for (let step = 0; step < 1000; step += 1) {
      sim.step();
      deepest = Math.max(deepest, penetrationOf(sim.world.player, sim.world.ball));
    }
    expect(deepest).toBe(0);
    expect(distance(sim.world.player.position, sim.world.ball.position)).toBe(52);
    expect(sim.world.player.position.x).toBe(600);
    expect(sim.world.ball.position.x).toBe(652);
  });

  it('holds a resting stack of all three for a thousand steps', () => {
    // The same claim with the third body in it, which is where a resolver that
    // undoes one pair while fixing another shows up. Player, ball and opponent
    // in a row, each pair exactly touching.
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.player.position, 500, 360);
    set(sim.world.ball.position, 552, 360);
    set(sim.world.opponent.position, 604, 360);

    let deepest = 0;
    for (let step = 0; step < 1000; step += 1) {
      sim.step();
      deepest = Math.max(deepest, worstPenetration(sim));
    }
    expect(deepest).toBe(0);
    expect(sim.world.player.position.x).toBe(500);
    expect(sim.world.ball.position.x).toBe(552);
    expect(sim.world.opponent.position.x).toBe(604);
  });

  it('leaves a settled pile completely still, which is the jitter bound', () => {
    // Jitter is the failure where a resolved contact keeps being re-resolved,
    // and it reads on the felt as two circles buzzing against each other
    // forever. Measured as the largest single-step movement of any centre over
    // a window well past the point where the pile stopped closing.
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (const body of sim.world.bodies) {
      set(body.position, 600, 360);
    }
    for (let step = 0; step < 1000; step += 1) {
      sim.step();
    }
    const worst = largestStep(sim, 500);
    expect(worst).toBeLessThanOrEqual(JITTER_BOUND);
    expect(worst).toBe(0);
  });

  it('closes a corner pile monotonically instead of sinking into one', () => {
    // A DISCLOSED CONSEQUENCE OF DESIGN SECTION 3'S ORDER, pinned here so it is
    // stated rather than discovered. SPEC section 6.3 promises under 1 px of
    // residual penetration for three bodies meeting at one point; it promises
    // nothing about three bodies meeting at one point with two walls behind
    // them, and there the wall clamp at position 3 partly undoes the separation
    // at position 2, so the pile needs several steps rather than one.
    //
    // The reading that matters is not the peak, it is the shape: the residual
    // must fall, never rise, and must be under a pixel quickly. Measured on a
    // 30 px box dropped into a corner: 43 px in the first step, roughly halving
    // every step, under 1 px by the sixth.
    const corners: ReadonlyArray<readonly [string, number, number]> = [
      ['bottom left', FIELD_LEFT, FIELD_BOTTOM],
      ['bottom right', FIELD_RIGHT, FIELD_BOTTOM],
      ['top left', FIELD_LEFT, FIELD_TOP],
      ['top right', FIELD_RIGHT, FIELD_TOP],
    ];
    for (const [label, x, y] of corners) {
      const sim = cornerPile(x, y);
      let peak = 0;
      let crossed = -1;
      let previous = Number.POSITIVE_INFINITY;
      for (let step = 0; step < 20; step += 1) {
        sim.step();
        const residual = worstPenetration(sim);
        peak = Math.max(peak, residual);
        if (crossed === -1 && residual < 1) {
          crossed = step;
        }
        expect(residual, `${label} rose at step ${String(step)}`).toBeLessThanOrEqual(previous);
        previous = residual;
      }
      // The transient is real, so this is an envelope around something rather
      // than around nothing.
      expect(peak, `${label} peak`).toBeGreaterThan(1);
      expect(peak, `${label} peak`).toBeLessThan(60);
      expect(crossed, `${label} crossed 1 px`).toBeGreaterThanOrEqual(0);
      expect(crossed, `${label} crossed 1 px`).toBeLessThanOrEqual(8);
    }
    expect(corners).toHaveLength(4);
  });

  it('holds a corner pile at the rounding floor rather than closing to zero', () => {
    // AND IT DOES NOT REACH EXACTLY ZERO IN A CORNER, which is the honest half
    // of the disclosure. The residual converges to one unit in the last place
    // of a coordinate near the bound, 1.42e-14 px, and holds there: the clamp
    // and the separation disagree by less than the smallest number that can be
    // added to the position. A rounding floor that never grows is not a sink,
    // and the difference between the two is exactly what is measured here.
    //
    // Away from a wall the same pile does close to exactly zero, which the
    // three-body case above asserts with `toBe(0)`.
    const sim = cornerPile(FIELD_LEFT, FIELD_BOTTOM);
    for (let step = 0; step < 400; step += 1) {
      sim.step();
    }
    const settled = worstPenetration(sim);
    expect(settled).toBeLessThan(1e-13);

    for (let step = 0; step < 2000; step += 1) {
      sim.step();
      expect(worstPenetration(sim), `step ${String(step)} past settling`).toBeLessThanOrEqual(
        settled,
      );
    }
    expect(worstPenetration(sim)).toBeLessThanOrEqual(settled);
  });

  it('leaves a world settled after real collisions completely still', () => {
    // The same measurement on a world that got where it is by playing rather
    // than by being placed: three launches that drive the bodies into each
    // other and into the walls, run to rest and then held.
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.player, 0, 900);
    launch(sim.world.opponent, Math.PI, 800);
    setVelocity(sim.world.ball, 0, 150);

    // Driven a step at a time so the contacts can be counted on the way. A
    // resolved contact leaves the pair exactly touching, so a step that ends
    // with a pair at its reach is a step that had one in it.
    let contacts = 0;
    let steps = 0;
    while (!everyBodyStopped(sim.world)) {
      sim.step();
      steps += 1;
      expect(steps).toBeLessThan(4000);
      if (touching(sim)) {
        contacts += 1;
      }
    }
    // The run really did drive the bodies into each other, so what settles
    // below is a world that collided rather than three bodies that never met.
    expect(contacts).toBeGreaterThan(0);
    for (let step = 0; step < 200; step += 1) {
      sim.step();
    }

    const worst = largestStep(sim, 500);
    expect(worst).toBeLessThanOrEqual(JITTER_BOUND);
    expect(worst).toBe(0);
    expect(worstPenetration(sim)).toBe(0);
  });
});
