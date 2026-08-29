import { describe, expect, it } from 'vitest';

import { everyBodyStopped, launch, setVelocity, stopped } from '../../src/core/bodies';
import { DAMPING, FIXED_STEP, STOP_SPEED } from '../../src/core/config';
import { atRest, createSimulation } from '../../src/core/physics';
import { set, zero } from '../../src/core/vec2';
import { driveToRest } from './support/drive';

/**
 * Item B3, Critical: "Any body at or below the 6 px/s stop threshold is zeroed,
 * so the all-stopped test is exact rather than approximate."
 *
 * THE 6 IS WRITTEN OUT. Asserting the threshold against its own symbol passes
 * for any value the symbol takes, so every boundary below uses the literal SPEC
 * section 6.2 states, and the symbol is pinned against that literal once.
 *
 * NEGATIVE ZERO. A stopped velocity is written as the literal 0 rather than
 * reached by multiplication, so both components are POSITIVE zero and
 * `Object.is` holds against 0. That is asserted in both directions below,
 * because `toBe` is Object.is: a component left at -0 by a multiplication would
 * satisfy `=== 0` and fail `toBe(0)`, and the two readings disagreeing is
 * exactly the ambiguity the threshold exists to remove.
 */

describe('PF-2 the stop threshold, item B3', () => {
  it('is the value SPEC section 6.2 states', () => {
    expect(STOP_SPEED).toBe(6);
  });

  it('reads at or below the threshold, not below it', () => {
    // 3.6 and 4.8 are a scaled 3-4-5 triangle, so the magnitude is exactly 6
    // with no rounding to argue about.
    expect(atRest({ x: 6, y: 0 })).toBe(true);
    expect(atRest({ x: 0, y: 6 })).toBe(true);
    expect(atRest({ x: -6, y: 0 })).toBe(true);
    expect(atRest({ x: 3.6, y: 4.8 })).toBe(true);
    expect(Math.hypot(3.6, 4.8)).toBe(6);

    expect(atRest({ x: 0, y: 0 })).toBe(true);
    expect(atRest({ x: 5.999, y: 0 })).toBe(true);
    expect(atRest({ x: 6.000001, y: 0 })).toBe(false);
    expect(atRest({ x: 3.6, y: 4.800001 })).toBe(false);

    // A speed that cannot be measured is not a stopped body.
    expect(atRest({ x: Number.NaN, y: 0 })).toBe(false);
    expect(atRest({ x: Number.POSITIVE_INFINITY, y: 0 })).toBe(false);
  });

  it('zeroes a body the step leaves at or below it, and leaves one above alone', () => {
    // Damping runs before the stop test, so the boundary a whole step sees is
    // the threshold divided by one step of decay: 6.057 px/s.
    const boundary = 6 / DAMPING ** FIXED_STEP;
    expect(boundary).toBeGreaterThan(6);
    expect(boundary).toBeLessThan(6.06);

    const sim = createSimulation({ onNonFinite: 'throw' });
    setVelocity(sim.world.ball, 6.05, 0);
    sim.step();
    expect(stopped(sim.world.ball)).toBe(true);

    setVelocity(sim.world.ball, 6.07, 0);
    sim.step();
    expect(stopped(sim.world.ball)).toBe(false);
    expect(Math.hypot(sim.world.ball.velocity.x, sim.world.ball.velocity.y)).toBeGreaterThan(6);
  });

  it('zeroes to positive zero in both components', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    // Launched left and down, so both components are negative on the way in
    // and a multiplication would leave negative zeros on the way out.
    setVelocity(sim.world.player, -4, -3);
    sim.step();

    const velocity = sim.world.player.velocity;
    expect(velocity.x).toBe(0);
    expect(velocity.y).toBe(0);
    expect(Object.is(velocity.x, 0)).toBe(true);
    expect(Object.is(velocity.y, 0)).toBe(true);
    expect(Object.is(velocity.x, -0)).toBe(false);
    expect(Object.is(velocity.y, -0)).toBe(false);
  });

  it('reads stopped as an equality, so an almost-stopped body is not stopped', () => {
    // The word in the criterion is "exact". An epsilon form of this predicate
    // would call a body carrying a millionth of a millionth of a pixel per
    // second stopped, and that is precisely the approximate test the threshold
    // exists to replace. The step cannot produce that velocity, because it
    // zeroes anything at or below 6, and the predicate must refuse it anyway:
    // what is being graded is the equality, not the arithmetic before it.
    const sim = createSimulation({ onNonFinite: 'throw' });
    const ball = sim.world.ball;

    set(ball.velocity, 1e-12, 0);
    expect(stopped(ball)).toBe(false);
    expect(everyBodyStopped(sim.world)).toBe(false);

    set(ball.velocity, 0, -1e-12);
    expect(stopped(ball)).toBe(false);
    expect(everyBodyStopped(sim.world)).toBe(false);

    // And the same predicate on the state the step does produce.
    zero(ball.velocity);
    expect(stopped(ball)).toBe(true);
    expect(everyBodyStopped(sim.world)).toBe(true);
  });

  it('never leaves a body in the band between zero and the threshold', () => {
    // The exactness claim, swept over a whole run rather than at the end of
    // one: after every step a body is either stopped or carrying more than 6.
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.player, Math.PI / 5, 900);
    launch(sim.world.ball, -Math.PI / 3, 300);

    let steps = 0;
    while (!everyBodyStopped(sim.world)) {
      sim.step();
      steps += 1;
      expect(steps).toBeLessThan(2000);
      for (const body of sim.world.bodies) {
        const speed = Math.hypot(body.velocity.x, body.velocity.y);
        expect(speed === 0 || speed > 6, `${body.kind} at ${String(speed)}`).toBe(true);
      }
    }
    // A launch at full power decays past the threshold in about 4.4 s, which
    // is 528 steps. A sweep that ended in ten would have swept nothing.
    expect(steps).toBeGreaterThan(500);
  });

  it('is what makes the all-stopped test exact, because damping never reaches zero', () => {
    // The load-bearing half. Exponential decay is asymptotic: after a minute
    // of simulated time an undamped-to-zero model is still moving, so a test
    // for "everything has stopped" that read the raw decay would never be true.
    expect(900 * DAMPING ** 60).toBeGreaterThan(0);
    expect(900 * DAMPING ** 600).toBeGreaterThan(0);
    expect(900 * DAMPING ** 60).toBeLessThan(1e-20);

    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.opponent, Math.PI, 900);
    expect(everyBodyStopped(sim.world)).toBe(false);
    driveToRest(sim, 60);
    expect(everyBodyStopped(sim.world)).toBe(true);
    for (const body of sim.world.bodies) {
      expect(body.velocity.x, body.kind).toBe(0);
      expect(body.velocity.y, body.kind).toBe(0);
    }
  });
});
