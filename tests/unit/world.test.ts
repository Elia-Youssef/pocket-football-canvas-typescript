import { describe, expect, it } from 'vitest';

import { createWorld, everyBodyStopped, kickoff, launch, stopped } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  BALL_START_X,
  BALL_START_Y,
  BODY_MASS,
  CIRCLE_RADIUS,
  MIDLINE_Y,
  OPPONENT_START_X,
  PLAYER_START_X,
} from '../../src/core/config';
import { createSimulation } from '../../src/core/physics';
import { driveToRest, snapshot } from './support/drive';

/**
 * PF-2 support for items B1, B3 and B11: the world every one of them is driven
 * through, and the two ways it is put back to a known state.
 *
 * DESIGN section 8 makes a restart a mutation rather than a rebuild, so both
 * `kickoff` and `reset` write into the world that already exists. That is what
 * item H5's Play Again cycles will rest on later, and it is also why the
 * clearing has to be asserted rather than assumed: a rebuild would be obviously
 * clean, and a mutation that forgot one field would not be.
 */

describe('PF-2 the three-body world', () => {
  it('places every body where SPEC section 3 puts it, stopped', () => {
    const world = createWorld();
    expect(world.bodies).toHaveLength(3);
    expect(world.bodies.map((body) => body.kind)).toEqual(['player', 'opponent', 'ball']);

    expect(world.player.position.x).toBe(PLAYER_START_X);
    expect(world.player.position.y).toBe(MIDLINE_Y);
    expect(world.opponent.position.x).toBe(OPPONENT_START_X);
    expect(world.opponent.position.y).toBe(MIDLINE_Y);
    expect(world.ball.position.x).toBe(BALL_START_X);
    expect(world.ball.position.y).toBe(BALL_START_Y);

    expect(world.player.radius).toBe(CIRCLE_RADIUS);
    expect(world.opponent.radius).toBe(CIRCLE_RADIUS);
    expect(world.ball.radius).toBe(BALL_RADIUS);
    for (const body of world.bodies) {
      expect(body.mass, body.kind).toBe(BODY_MASS);
      expect(stopped(body), body.kind).toBe(true);
    }
    expect(everyBodyStopped(world)).toBe(true);
  });

  it('gives the three bodies three separate vectors', () => {
    // One shared scratch object between two bodies is a defect that looks like
    // a working game until two of them move at once.
    const world = createWorld();
    world.player.position.x = 1;
    world.player.velocity.y = 2;
    expect(world.opponent.position.x).toBe(OPPONENT_START_X);
    expect(world.ball.position.x).toBe(BALL_START_X);
    expect(world.opponent.velocity.y).toBe(0);
    expect(world.ball.velocity.y).toBe(0);
  });
});

describe('PF-2 kickoff and reset put the world back', () => {
  it('clears every velocity and every position on a kickoff', () => {
    const world = createWorld();
    for (const body of world.bodies) {
      launch(body, 1.2, 900);
      body.position.x += 17;
      body.position.y -= 23;
    }
    expect(everyBodyStopped(world)).toBe(false);

    kickoff(world);

    expect(everyBodyStopped(world)).toBe(true);
    for (const body of world.bodies) {
      // Positive zero in both components, the same guarantee the stop
      // threshold makes, because `toBe` is Object.is.
      expect(body.velocity.x, body.kind).toBe(0);
      expect(body.velocity.y, body.kind).toBe(0);
    }
    expect(snapshot(world)).toEqual(snapshot(createWorld()));
  });

  it('puts a simulation back to kickoff and drops the accumulator', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.player, Math.PI / 4, 900);
    driveToRest(sim, 60);
    sim.update(1 / 1000);

    const moved = snapshot(sim.world);
    expect(moved).not.toEqual(snapshot(createWorld()));
    expect(sim.readout().leftover).toBeGreaterThan(0);

    sim.reset();

    expect(snapshot(sim.world)).toEqual(snapshot(createWorld()));
    expect(sim.readout().leftover).toBe(0);
    expect(everyBodyStopped(sim.world)).toBe(true);
    // The counters are a record of the run and are deliberately not reset:
    // reset puts the pitch back, not the session.
    expect(sim.readout().steps).toBeGreaterThan(0);
    expect(sim.readout().frames).toBeGreaterThan(0);
  });

  it('leaves a reset simulation running from the new state', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.opponent, Math.PI, 900);
    driveToRest(sim, 60);
    sim.reset();

    launch(sim.world.opponent, Math.PI, 900);
    driveToRest(sim, 60);
    const afterReset = snapshot(sim.world);

    // The same launch from the same starting state lands in the same place, so
    // the reset restored the state rather than something near it.
    const fresh = createSimulation({ onNonFinite: 'throw' });
    launch(fresh.world.opponent, Math.PI, 900);
    driveToRest(fresh, 60);
    expect(afterReset).toEqual(snapshot(fresh.world));
  });
});
