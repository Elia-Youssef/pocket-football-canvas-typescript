/**
 * Driving a simulation from a test, and reading its state back.
 *
 * Not a test file: the unit suite collects the `.test.ts` files beside it, and
 * this is imported by them. It exists because the same three moves
 * (drive at a rate, drive until nothing is moving, read the world back as
 * comparable data) are what items B1, B2, B3, B9, B10 and B12 all measure, and
 * six private copies of a driver would be six chances for one of them to drift
 * into measuring something easier.
 *
 * It contains no assertion and no expected value. Everything a criterion is
 * graded against is written in the test file that owns the criterion.
 */

import { everyBodyStopped } from '../../../src/core/bodies';
import type { World } from '../../../src/core/bodies';
import type { Simulation } from '../../../src/core/physics';

/**
 * The four rates item B1 names. 30 and 144 are the two ends of a real display,
 * 60 is the common case, and 1000 is well past any of them: at that rate a
 * frame is shorter than a fixed step, so most frames run no step at all and the
 * accumulator carries the remainder.
 */
export const RATES: readonly number[] = [30, 60, 144, 1000];

/** Every number that describes the world, in a fixed order. */
export function snapshot(world: World): readonly number[] {
  const out: number[] = [];
  for (const body of world.bodies) {
    out.push(body.position.x, body.position.y, body.velocity.x, body.velocity.y);
  }
  return out;
}

/**
 * The same numbers as text, at full precision. `String` rather than a rounding
 * formatter on purpose: a transcript compared after rounding agrees with itself
 * across a change that moves every body by a fraction of a pixel.
 */
export function digest(world: World): string {
  return snapshot(world)
    .map((value) => String(value))
    .join(' ');
}

/** One frame of the given rate, repeated. Returns the fixed steps that ran. */
export function driveSeconds(sim: Simulation, fps: number, seconds: number): number {
  const before = sim.readout().steps;
  const frames = Math.round(seconds * fps);
  for (let frame = 0; frame < frames; frame += 1) {
    sim.update(1 / fps);
  }
  return sim.readout().steps - before;
}

/**
 * Drive until every body is stopped. Throws rather than returning when the
 * budget runs out, because a run that never came to rest would otherwise be
 * compared against another run that never came to rest and agree with it.
 */
export function driveToRest(sim: Simulation, fps: number, budget = 40000): number {
  let frames = 0;
  while (!everyBodyStopped(sim.world)) {
    sim.update(1 / fps);
    frames += 1;
    if (frames > budget) {
      throw new Error(
        `nothing came to rest within the frame budget at ${String(fps)} frames per second`,
      );
    }
  }
  return frames;
}

/**
 * Rest, and then a stated number of frames past it. Everything stopped is a
 * fixed point of the step, so this is what makes a comparison between two rates
 * a comparison of the same state rather than of two moments.
 */
export function driveToSettled(sim: Simulation, fps: number, extraFrames = 120): number {
  const frames = driveToRest(sim, fps, 40000);
  for (let frame = 0; frame < extraFrames; frame += 1) {
    sim.update(1 / fps);
  }
  return frames + extraFrames;
}
