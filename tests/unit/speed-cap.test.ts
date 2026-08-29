import { describe, expect, it } from 'vitest';

import type { Body } from '../../src/core/bodies';
import { launch, setVelocity } from '../../src/core/bodies';
import { FIXED_STEP, MAX_LAUNCH_SPEED, SPEED_CAP } from '../../src/core/config';
import { createSimulation } from '../../src/core/physics';
import { set } from '../../src/core/vec2';

/**
 * Item B10, Major: "The global speed cap is enforced on all three bodies,
 * including a ball accelerated by an elastic transfer."
 *
 * THE TRANSFER IS PF-3'S, AND THE ITEM CLOSES HERE ANYWAY. Item B4 adds the
 * elastic response at PF-3, and what it produces is a velocity larger than the
 * one the body was carrying. The clause is closed here by injecting that
 * velocity directly, which leaves the same state and strictly dominates it: all
 * three bodies have equal mass and the fastest legal launch is 900 px/s, so no
 * exchange between them can reach the 5000 px/s injected below. Item B10 is
 * graded at PF-2 and nowhere else, and B4's criterion says nothing about the
 * cap, so no later item re-grades this and nothing here waits on one.
 *
 * A handoff to PF-3, a suggestion rather than a debt: run a real transfer and
 * read the cap afterwards, and add the mutation entry for the SECOND cap
 * application, the one at DESIGN section 3's step 5, which becomes detectable
 * the moment something between the two applications can raise a speed.
 *
 * TWO SITES, TWO PROPERTIES. The cap is applied before integration, so nothing
 * is ever integrated over it and the 10 px per step item B9 budgets against is
 * a property of the code; and again after damping, which is DESIGN section 3's
 * position for it and where PF-3's transfer lands. A test that only read the
 * velocity after a step would pass with either one missing, so travel is
 * measured as well.
 */

const OVER_CAP = 5000;

function speedOf(body: Body): number {
  return Math.hypot(body.velocity.x, body.velocity.y);
}

describe('PF-2 the global speed cap, item B10', () => {
  it('caps a velocity injected over it, on all three bodies', () => {
    for (const kind of ['player', 'opponent', 'ball'] as const) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const body = sim.world[kind];
      // Mid-field, so a wall cannot be what shortened the travel below, and
      // clear of the other two bodies, so from PF-3 onward a positional
      // separation cannot be what lengthened it: the centre spot is where the
      // ball already is, and item B5 moves a coincident pair apart by the sum
      // of its radii. 160 px from the nearest body, which needs 52 px to touch.
      set(body.position, 640, 200);
      // A 3-4-5 direction at 5000 px/s, four times the cap.
      set(body.velocity, 4000, -3000);
      expect(speedOf(body)).toBe(OVER_CAP);

      const from = { x: body.position.x, y: body.position.y };
      sim.step();

      const travelled = Math.hypot(body.position.x - from.x, body.position.y - from.y);
      expect(travelled, `${kind} travel in one step`).toBeCloseTo(SPEED_CAP * FIXED_STEP, 9);
      expect(travelled, `${kind} travel in one step`).toBeLessThanOrEqual(10 + 1e-9);
      expect(speedOf(body), `${kind} speed after the step`).toBeLessThanOrEqual(SPEED_CAP);
      // And it was capped rather than zeroed: the body is still moving fast.
      expect(speedOf(body), `${kind} speed after the step`).toBeGreaterThan(SPEED_CAP * 0.9);
    }
  });

  it('keeps the direction the velocity had', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    const ball = sim.world.ball;
    set(ball.velocity, 4000, -3000);
    sim.step();
    const speed = speedOf(ball);
    expect(ball.velocity.x / speed).toBeCloseTo(0.8, 12);
    expect(ball.velocity.y / speed).toBeCloseTo(-0.6, 12);
  });

  it('caps a launch on the way in, exactly at the cap', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.player, Math.PI / 6, 99999);
    expect(speedOf(sim.world.player)).toBeCloseTo(SPEED_CAP, 9);

    setVelocity(sim.world.opponent, 0, -99999);
    expect(speedOf(sim.world.opponent)).toBe(SPEED_CAP);
    expect(sim.world.opponent.velocity.y).toBe(-SPEED_CAP);
  });

  it('leaves a speed at or under the cap alone', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    setVelocity(sim.world.ball, SPEED_CAP, 0);
    expect(sim.world.ball.velocity.x).toBe(SPEED_CAP);

    // The fastest legal launch is well under the cap, so a normal turn never
    // meets this rule at all: SPEC section 6.1 caps at 1200 and launches at 900.
    expect(MAX_LAUNCH_SPEED).toBeLessThan(SPEED_CAP);
    setVelocity(sim.world.player, MAX_LAUNCH_SPEED, 0);
    expect(sim.world.player.velocity.x).toBe(MAX_LAUNCH_SPEED);
    sim.step();
    expect(speedOf(sim.world.player)).toBeLessThan(MAX_LAUNCH_SPEED);
  });

  it('holds the cap over a run that keeps re-injecting over it', () => {
    // Every step for two seconds, which is what a chain of transfers would do.
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (let step = 0; step < 240; step += 1) {
      for (const body of sim.world.bodies) {
        set(body.velocity, OVER_CAP, OVER_CAP);
      }
      sim.step();
      for (const body of sim.world.bodies) {
        expect(speedOf(body), body.kind).toBeLessThanOrEqual(SPEED_CAP);
      }
    }
  });
});
