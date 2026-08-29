import { describe, expect, it } from 'vitest';

import type { Body, BodyKind, World } from '../../src/core/bodies';
import { createWorld, everyBodyStopped, launch } from '../../src/core/bodies';
import {
  CATCH_UP_SLICE,
  DAMPING,
  DELTA_CEILING,
  FIXED_STEP,
  SPEED_CAP,
  TIME_EPSILON,
} from '../../src/core/config';
import { atRest, contain, createSimulation } from '../../src/core/physics';
import { addScaled, distance, scale, set, zero } from '../../src/core/vec2';
import { RATES, driveToSettled, snapshot } from './support/drive';

/**
 * Item B1, Critical: "The simulation is frame-rate independent: the same launch
 * produces the same final positions to within tolerance at 30, 60, 144 and 1000
 * fps, and on a deliberately unstable clock including zero and negative
 * deltas."
 *
 * THE TOLERANCE THIS FILE CLAIMS IS ZERO, and the claim is stronger than the
 * criterion asks for, so it is justified here rather than assumed.
 *
 * Every fixed step integrates with the same dt, so the arithmetic of the Nth
 * step is identical at every frame rate, bit for bit. What differs between two
 * rates is only WHEN a step runs and how much time is left in the accumulator,
 * so two runs compared at an arbitrary moment can be one step apart. Everything
 * stopped is a fixed point of the step: a zero velocity damps to zero, moves
 * nothing, and is zeroed again by the stop threshold, so a run driven past rest
 * is at the same state however many further steps it takes. Comparing settled
 * runs therefore compares the same state rather than two moments, and exact
 * equality is the right assertion.
 *
 * The mid-flight comparison further down cannot make that claim and does not:
 * it states the leftover-fraction bound, one fixed step of travel at the speed
 * the body is carrying, and measures against it.
 *
 * THE CONTROL. A check that cannot fail proves nothing, so the same comparison
 * is run against a variable-step integrator: one step per frame at the frame's
 * own delta, with the damping still in its correct per-second form. That is the
 * shape this whole time model exists to replace, and the check has to reject it
 * by a margin no rounding could explain.
 */

interface Launch {
  readonly kind: BodyKind;
  readonly radians: number;
  readonly speed: number;
}

/**
 * One launch per body, chosen so the run exercises what a turn exercises: a
 * full-power shot, a shot into a wall, and a slow one that stops early.
 */
const LAUNCHES: readonly Launch[] = [
  { kind: 'player', radians: Math.PI / 3, speed: 900 },
  { kind: 'opponent', radians: Math.PI * 0.85, speed: 700 },
  { kind: 'ball', radians: -Math.PI / 2, speed: 450 },
];

function applyLaunches(world: World): void {
  for (const entry of LAUNCHES) {
    launch(world[entry.kind], entry.radians, entry.speed);
  }
}

/** The real simulation, driven at one rate until it has settled. */
function settledAt(fps: number): readonly number[] {
  const sim = createSimulation({ onNonFinite: 'throw' });
  applyLaunches(sim.world);
  driveToSettled(sim, fps);
  return snapshot(sim.world);
}

/**
 * PF-3's scenario: three launches aimed to collide rather than to miss. Both
 * circles converge on the ball at the centre spot from opposite ends, slightly
 * off the midline so the contacts are oblique and the ball leaves at an angle.
 */
const COLLIDING: readonly Launch[] = [
  { kind: 'player', radians: 0.12, speed: 900 },
  { kind: 'opponent', radians: Math.PI - 0.2, speed: 850 },
  { kind: 'ball', radians: Math.PI / 2, speed: 160 },
];

function applyCollidingLaunches(world: World): void {
  for (const entry of COLLIDING) {
    launch(world[entry.kind], entry.radians, entry.speed);
  }
}

function settledColliding(fps: number): readonly number[] {
  const sim = createSimulation({ onNonFinite: 'throw' });
  applyCollidingLaunches(sim.world);
  driveToSettled(sim, fps);
  return snapshot(sim.world);
}

/**
 * PF-4's scenario: a rally that ends in a goal. The player circle is launched
 * into the ball and the ball runs on through the right goal opening, so one run
 * contains a contact, a transparency decision, a detection, SPEC section 6.4's
 * 1.2 s hold and the reset that ends it.
 *
 * TWO BODIES ARE MOVED FIRST, AND BOTH FOR A REASON THE TRAVEL TABLE GIVES. The
 * opponent goes off the shot line, because a rally that ends in a block
 * exercises none of the above. The player starts nearer the ball than kickoff
 * puts it, because SPEC section 6.1's table leaves a full-power shot from the
 * kickoff spot with 497 px of travel in the ball after the transfer, against
 * the 568 px from the centre spot to the goal line: struck from 340 px away the
 * ball stops 71 px short of scoring, which is a fine rally and a poor fixture.
 *
 * The settled world after a goal is the kickoff, by construction, so the
 * reading that carries the claim is the second one: the score, and the fixed
 * step the goal was detected in.
 */
function settledWithAGoal(fps: number): { readonly world: readonly number[]; readonly goal: string } {
  const sim = createSimulation({ onNonFinite: 'throw' });
  set(sim.world.opponent.position, 980, 150);
  set(sim.world.player.position, 500, 360);
  launch(sim.world.player, 0, 900);
  driveToSettled(sim, fps);
  const readout = sim.scoring.readout();
  return {
    world: snapshot(sim.world),
    goal: `${String(readout.player)}-${String(readout.opponent)} at step ${String(
      readout.last?.step ?? -1,
    )}`,
  };
}

/** The three pairs, for the two readings PF-3's run needs about contact. */
function pairsOf(world: World): ReadonlyArray<readonly [Body, Body]> {
  return [
    [world.player, world.opponent],
    [world.player, world.ball],
    [world.opponent, world.ball],
  ];
}

/** True when some pair is at its reach, which a resolved contact leaves it at. */
function inContact(world: World): boolean {
  return pairsOf(world).some(
    ([a, b]) => distance(a.position, b.position) <= a.radius + b.radius + 1e-9,
  );
}

/** How far the deepest pair is inside one another, zero when merely touching. */
function deepestOverlap(world: World): number {
  return Math.max(
    0,
    ...pairsOf(world).map(([a, b]) => a.radius + b.radius - distance(a.position, b.position)),
  );
}

/**
 * The control. One step per frame at the frame's delta, which is the classic
 * variable-step loop. Its damping is deliberately the CORRECT per-second form,
 * so what this isolates is the integration step alone rather than the decay
 * defect item B2 owns.
 */
function variableStepAt(fps: number, seconds: number): readonly number[] {
  const world = createWorld();
  applyLaunches(world);
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  for (let frame = 0; frame < frames; frame += 1) {
    for (const body of world.bodies) {
      addScaled(body.position, body.velocity, dt);
      contain(body);
      scale(body.velocity, DAMPING ** dt);
      if (atRest(body.velocity)) {
        zero(body.velocity);
      }
    }
  }
  return snapshot(world);
}

/**
 * The six position numbers of a reading. The mid-flight comparison uses these
 * alone: two rates read at the same moment can be one step of DECAY apart in
 * velocity, which at 900 px/s is 8.5 px/s and has nothing to say about where a
 * body is. The settled comparisons above use the whole reading, velocities
 * included, because a settled velocity is an exact zero at every rate.
 */
function positionsOf(reading: readonly number[]): readonly number[] {
  return reading.filter((_value, at) => at % 4 < 2);
}

/** The largest disagreement between two readings of the same world. */
function largestGap(one: readonly number[], other: readonly number[]): number {
  expect(one).toHaveLength(other.length);
  let worst = 0;
  for (let at = 0; at < one.length; at += 1) {
    const gap = Math.abs((one[at] ?? Number.NaN) - (other[at] ?? Number.NaN));
    if (!(gap <= worst)) {
      worst = gap;
    }
  }
  return worst;
}

/** The check itself, applied to whatever produces a settled reading. */
function rateDisagreement(readingAt: (fps: number) => readonly number[]): number {
  const baseline = readingAt(RATES[0] ?? 60);
  let worst = 0;
  for (const fps of RATES) {
    worst = Math.max(worst, largestGap(baseline, readingAt(fps)));
  }
  return worst;
}

describe('PF-2 frame-rate independence, item B1', () => {
  it('produces the same final positions at 30, 60, 144 and 1000 fps', () => {
    expect(RATES).toEqual([30, 60, 144, 1000]);
    expect(rateDisagreement(settledAt)).toBe(0);
  });

  it('agrees on every number, not merely on the ones that moved', () => {
    // A comparison that only looked at the launched body would pass while the
    // other two drifted, and would pass over a run in which nothing happened.
    const baseline = settledAt(60);
    expect(baseline).toHaveLength(12);
    const start = snapshot(createWorld());
    expect(baseline).not.toEqual(start);
    for (const fps of RATES) {
      expect(settledAt(fps), `at ${String(fps)} frames per second`).toEqual(baseline);
    }
  });

  it('rejects a variable-step integrator run through the same check', () => {
    // The positive control. A full-power launch decays past the stop threshold
    // in 4.4 s, so six seconds is past rest in every one of these runs and the
    // readings are settled readings compared the same way.
    const gap = rateDisagreement((fps) => variableStepAt(fps, 6));
    expect(gap).toBeGreaterThan(1);
    // And it is not a rounding artefact: the divergence is pixels, in a game
    // whose ball is 18 px across.
    expect(gap).toBeGreaterThan(10);
  });

  it('holds on a deliberately unstable clock, zero and negative deltas included', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    applyLaunches(sim.world);

    // Zero, negative, both non-finite readings, a spike past the ceiling and a
    // gap past the resume threshold, cycled with ordinary frames between them.
    const hostile: readonly number[] = [
      1 / 60,
      0,
      -1 / 60,
      1 / 144,
      Number.NaN,
      1 / 30,
      Number.POSITIVE_INFINITY,
      1 / 60,
      -0,
      3,
      1 / 1000,
      40,
      1 / 60,
      Number.NEGATIVE_INFINITY,
      1 / 240,
    ];

    let at = 0;
    let frames = 0;
    while (!everyBodyStopped(sim.world) || frames < hostile.length * 4) {
      sim.update(hostile[at % hostile.length] ?? 0);
      at += 1;
      frames += 1;
      if (frames > 40000) {
        throw new Error('the unstable clock never came to rest');
      }
    }
    for (let extra = 0; extra < 200; extra += 1) {
      sim.update(hostile[at % hostile.length] ?? 0);
      at += 1;
    }

    expect(snapshot(sim.world)).toEqual(settledAt(60));

    // The readings the clock is made of, each one asserted rather than assumed
    // to have been exercised: a hostile sequence nobody checked is an ordinary
    // sequence with a comment on it.
    const readings = createSimulation({ onNonFinite: 'throw' });
    for (const delta of [0, -1 / 60, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const report = readings.update(delta);
      expect(report.applied, `delta ${String(delta)}`).toBe(0);
      expect(report.steps, `delta ${String(delta)}`).toBe(0);
      expect(report.resumed, `delta ${String(delta)}`).toBe(false);
    }
    expect(readings.update(3).clamped).toBe(true);
    expect(readings.update(3).applied).toBe(0.25);
    expect(readings.update(40).resumed).toBe(true);
    expect(readings.update(40).steps).toBe(0);
  });

  it('consumes a clamped frame in slices no larger than the catch-up ceiling', () => {
    // The middle of the three layers, which is the one with no effect on where
    // a body ends up and every effect on how much work one frame can trigger.
    // DESIGN section 2 nests it between the ceiling and the fixed step.
    const spiked = createSimulation({ onNonFinite: 'throw' });
    const report = spiked.update(3);
    expect(report.applied).toBe(DELTA_CEILING);
    expect(report.clamped).toBe(true);
    expect(report.slices).toBe(15);
    expect(report.longestSlice).toBeLessThanOrEqual(CATCH_UP_SLICE + TIME_EPSILON);
    expect(report.steps).toBeGreaterThanOrEqual(29);
    expect(report.steps).toBeLessThanOrEqual(30);
    expect(report.leftover).toBeLessThan(FIXED_STEP);

    // An ordinary frame is one slice, and a frame shorter than a fixed step is
    // still a slice that runs no step at all.
    const ordinary = createSimulation({ onNonFinite: 'throw' });
    const one = ordinary.update(1 / 60);
    expect(one.slices).toBe(1);
    expect(one.longestSlice).toBeCloseTo(1 / 60, 12);
    expect(one.steps).toBe(2);

    const fast = createSimulation({ onNonFinite: 'throw' });
    const tiny = fast.update(1 / 1000);
    expect(tiny.slices).toBe(1);
    expect(tiny.steps).toBe(0);
    expect(tiny.leftover).toBeCloseTo(1 / 1000, 12);
  });

  it('counts the frames, the clamps and the resumes it reported', () => {
    // The readout is diagnostic, and diagnostics that nothing reads are how a
    // counter comes to mean something other than its name. Every one of them is
    // pinned by literal against a scripted sequence.
    const sim = createSimulation({ onNonFinite: 'throw' });
    const sequence: readonly number[] = [1 / 60, 3, 40, 0, -1, 0.25, 7, Number.NaN];
    for (const delta of sequence) {
      sim.update(delta);
    }
    const readout = sim.readout();
    expect(readout.frames).toBe(8);
    // 3 is past the ceiling; 0.25 is exactly the ceiling and so is not clamped.
    expect(readout.clamps).toBe(1);
    // 40 and 7 are both past the resume threshold.
    expect(readout.resumes).toBe(2);
    expect(readout.repairs).toBe(0);
    // Two frames of a quarter second at thirty steps each, plus two steps from
    // the sixtieth. The leftover is what has not become a step yet.
    expect(readout.steps).toBeGreaterThanOrEqual(58);
    expect(readout.steps).toBeLessThanOrEqual(62);
    expect(readout.leftover).toBeLessThan(FIXED_STEP);
    expect(readout.leftover).toBeGreaterThanOrEqual(0);
  });

  it('produces the same final positions through a scripted pile-up', () => {
    // PF-3 ADDED A SECOND WAY FOR A STEP TO MOVE A BODY, and the zero-tolerance
    // claim above has to survive it. The launches in this run are aimed to
    // collide: both circles converge on the ball at the centre spot, the ball
    // is knocked across the field and into a wall, and the two circles meet
    // each other on the way through. Every fixed step still does identical
    // arithmetic at every rate, and the settled state is still a fixed point of
    // the step, so the assertion is still exact equality rather than a bound.
    expect(rateDisagreement(settledColliding)).toBe(0);

    const baseline = settledColliding(60);
    for (const fps of RATES) {
      expect(settledColliding(fps), `at ${String(fps)} frames per second`).toEqual(baseline);
    }
    // Twice at one rate as well, so the comparison covers repeatability and not
    // only rate agreement.
    expect(settledColliding(60)).toEqual(baseline);
    expect(baseline).not.toEqual(snapshot(createWorld()));
  });

  it('really does collide in that run, and settles to a state nothing can move', () => {
    // A run in which nothing touched anything would agree with itself at every
    // rate and would say nothing about collisions, so the contacts are counted;
    // and the exact comparison above rests on the settled state being a fixed
    // point, so the residual overlap that would make it drift is measured too.
    const sim = createSimulation({ onNonFinite: 'throw' });
    applyCollidingLaunches(sim.world);
    let contacts = 0;
    let steps = 0;
    while (!everyBodyStopped(sim.world)) {
      sim.step();
      steps += 1;
      expect(steps).toBeLessThan(4000);
      contacts += inContact(sim.world) ? 1 : 0;
    }
    expect(contacts).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(300);

    for (let extra = 0; extra < 500; extra += 1) {
      sim.step();
    }
    // Nothing overlaps, so no further step has anything to separate and the
    // settled reading compared above is the same reading at every rate.
    expect(deepestOverlap(sim.world)).toBe(0);
  });

  it('produces the same goal, at the same fixed step, through a scripted rally', () => {
    // PF-4 ADDED A THIRD WAY FOR A STEP TO MOVE A BODY, and a way for one to
    // stop moving it: the celebration hold freezes the world for a whole number
    // of fixed steps. Both are counted in steps rather than in seconds, so the
    // rate a run is driven at cannot change either, and the goal lands in the
    // same numbered step at all four.
    const baseline = settledWithAGoal(60);
    expect(baseline.goal).toBe('1-0 at step 186');
    for (const fps of RATES) {
      const reading = settledWithAGoal(fps);
      expect(reading.goal, `at ${String(fps)} frames per second`).toBe(baseline.goal);
      expect(reading.world, `at ${String(fps)} frames per second`).toEqual(baseline.world);
    }
    // Twice at one rate as well, so this covers repeatability and not only
    // rate agreement, and the settled world is the kickoff the reset produced.
    expect(settledWithAGoal(60)).toEqual(baseline);
    expect(baseline.world).toEqual(snapshot(createWorld()));
  });

  it('stays within one step of travel mid-flight, which is the leftover bound', () => {
    // Two rates read at the same wall time can be one fixed step apart, so the
    // bound is what one step can move a body: at the global cap that is 10 px,
    // and at these launch speeds it is under 8.
    const readings = RATES.map((fps) => {
      const sim = createSimulation({ onNonFinite: 'throw' });
      applyLaunches(sim.world);
      let frames = 0;
      const target = Math.round(0.4 * fps);
      while (frames < target) {
        sim.update(1 / fps);
        frames += 1;
      }
      return {
        fps,
        at: positionsOf(snapshot(sim.world)),
        speeds: sim.world.bodies.map((body) => Math.hypot(body.velocity.x, body.velocity.y)),
      };
    });

    const first = readings[0];
    if (first === undefined) {
      throw new Error('no readings');
    }
    const fastest = Math.max(...readings.flatMap((reading) => reading.speeds));
    const bound = fastest * FIXED_STEP;
    expect(bound).toBeLessThanOrEqual(SPEED_CAP * FIXED_STEP);
    expect(fastest).toBeGreaterThan(0);
    for (const reading of readings) {
      expect(
        largestGap(first.at, reading.at),
        `at ${String(reading.fps)} frames per second`,
      ).toBeLessThanOrEqual(bound);
    }
  });
});
