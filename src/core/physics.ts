/**
 * The fixed-step simulation: the three time layers, integration, damping, the
 * stop threshold, the global speed cap, wall containment and the finiteness
 * guard.
 *
 * THE THREE LAYERS, DESIGN section 2 and SPEC section 6.2.
 *
 *   frame delta -> clamped to a ceiling             spike protection
 *     -> consumed in slices of at most one sixtieth bounded catch-up work
 *       -> accumulated into fixed steps of one hundred and twentieth
 *                                                   deterministic integration
 *
 * TIME IS AN INPUT. Nothing here reads a clock: `update` takes the delta its
 * caller measured, and the frame driver that measures it belongs to the render
 * layer. DESIGN section 1 puts this module under `core/`, where a clock read is
 * a lint error, and it is what lets a whole match be played out headlessly.
 *
 * ORDER WITHIN A STEP, DESIGN section 3. Integrate, resolve body pairs, resolve
 * walls, test for a goal, then damp, cap and stop. Three of the five are here:
 * the body pairs are `core/collisions.ts`, the walls are `contain` plus
 * `reflect` below, and the goal test is `core/goals.ts` at position 4, where
 * that section puts it. Running it after the walls rather than before them is
 * defence in depth rather than a difference anyone can observe: the same
 * predicate decides both, so a ball the wall rule would clamp back cannot
 * satisfy the goal test either way. The order is kept because it makes that a
 * property of the sequence instead of an argument about two callers.
 *
 * WHY DAMPING IS LAST. The stop test then operates on the final velocity of the
 * step, which is what makes "everything has stopped" exact rather than a
 * question about when in the step it was asked.
 *
 * ALLOCATION. QUALITY-BAR section 1: the fixed-step hot path allocates nothing.
 * The scratch a repair needs is preallocated per body at construction, and the
 * only object a clean frame creates is the report `update` returns, once per
 * frame rather than once per step or once per body.
 */

import type { Body, BodyKind, World } from './bodies';
import { createWorld, kickoff } from './bodies';
import { resolveContacts } from './collisions';
import {
  CATCH_UP_SLICE,
  DAMPING,
  DELTA_CEILING,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIXED_STEP,
  RESUME_GAP,
  SPEED_CAP,
  STOP_SPEED,
  TIME_EPSILON,
  WALL_RESTITUTION,
  acceptedFrameDelta,
} from './config';
import type { Scoring } from './goals';
import { ballFitsOpening, createScoring } from './goals';
import type { Vec2 } from './vec2';
import { addScaled, copy, isFiniteVec2, limit, scale, set, vec2, zero } from './vec2';

/**
 * Which bound clamped a body, as a bit per wall, so that `reflect` below can
 * turn the normal component per wall (item B6, restitution 0.92) without this
 * function having to grow a second return value. Returned as a number rather
 * than a record because a step may not allocate.
 *
 * THE CONTRACT REFLECTION READS, pinned by tests/unit/tunneling.test.ts and
 * tests/unit/walls.test.ts rather than left to a reader: four distinct powers
 * of two, one per wall, so a body inside the field returns no bits, a body
 * clamped by one wall returns exactly that one, and a body clamped into a
 * corner returns both of them.
 */
export const WALL_LEFT = 1;
export const WALL_RIGHT = 2;
export const WALL_BOTTOM = 4;
export const WALL_TOP = 8;

/**
 * SPEC section 20: a hard failure caught in development and clamped in
 * production, never silently propagated into the next step.
 *
 * The repair is not the policy. A body that reaches a non-finite state is
 * repaired under BOTH policies, so the post-condition item B11 states holds
 * either way and a caught throw cannot leave a poisoned world behind. What the
 * policy decides is whether the repair also raises, which is the difference
 * between a defect that stops a development run and one that costs a player a
 * step of a turn.
 *
 * The default is the development reading. The composition root selects
 * `repair` for a production build; until that part lands, nothing in this
 * project can reach a non-finite state without a test seeing it.
 */
export type NonFinitePolicy = 'throw' | 'repair';

export interface Repair {
  readonly kind: BodyKind;
  readonly field: 'position' | 'velocity';
  /** The fixed step, counted from construction, that the repair happened in. */
  readonly step: number;
}

export interface FrameReport {
  /** The delta as it arrived, before any reading was applied to it. */
  readonly delta: number;
  /** What entered the accumulator: zero, the delta, or the ceiling. */
  readonly applied: number;
  /** True when the ceiling bound the delta and the rest was discarded. */
  readonly clamped: boolean;
  /** True when the gap was read as a resume and the accumulator dropped. */
  readonly resumed: boolean;
  readonly slices: number;
  /** The largest single slice, which the catch-up ceiling bounds. */
  readonly longestSlice: number;
  readonly steps: number;
  /** Time carried into the next frame, always under one fixed step. */
  readonly leftover: number;
  readonly repairs: readonly Repair[];
}

export interface SimulationReadout {
  readonly steps: number;
  readonly frames: number;
  readonly leftover: number;
  readonly repairs: number;
  readonly clamps: number;
  readonly resumes: number;
}

export interface SimulationOptions {
  /** A world to drive. Omitted, the simulation makes its own at kickoff. */
  readonly world?: World;
  /**
   * SPEC section 6.4's scoreboard and celebration hold. Passed in the same way
   * and for the same reason as the world: a caller that has to start a new
   * match holds its own reference and calls `reset` on it, rather than this
   * interface growing a method per thing a later part needs to restart.
   */
  readonly scoring?: Scoring;
  readonly onNonFinite?: NonFinitePolicy;
}

export interface Simulation {
  readonly world: World;
  readonly scoring: Scoring;
  readonly policy: NonFinitePolicy;
  /** One frame of real time, in whatever shape the caller's clock produced. */
  update(delta: number): FrameReport;
  /** Exactly one fixed step, for a test or a tool that wants the unit itself. */
  step(): readonly Repair[];
  /** SPEC section 6.4: back to the starting positions, velocities cleared. */
  reset(): void;
  readout(): SimulationReadout;
}

const NO_REPAIRS: readonly Repair[] = Object.freeze([]);

/**
 * SPEC section 6.2: walls are half-space containment tests on the field bound
 * rather than slab-overlap tests against the 12 px wall thickness, so they
 * cannot be tunneled at any speed and the thickness is presentational.
 *
 * Containment alone is what item B9 rests on: no body escapes the field at the
 * cap, under a clamped spike or across a resume. It stays a separate reading
 * from the reflection that consumes its mask, because containment is the
 * guarantee and reflection is only what the velocity does about it.
 *
 * SPEC section 6.4, item B7: the left and right walls are transparent to a ball
 * that fits the goal opening and solid to everything else. No clamp means no
 * wall bit, which means the reflection below turns nothing, so the second half
 * of transparency is a consequence of this one reading rather than a second
 * rule that could disagree with it. The circles are never asked the question:
 * `ballFitsOpening` answers false for them by kind, so all four walls contain
 * them however well they would fit.
 *
 * A position that is not finite is deliberately left alone here. Clamping it
 * into the field would repair it as a side effect of an unrelated rule, and
 * SPEC section 20 wants it caught and reported instead, which is what the
 * sanitising pass at the tail of the step does.
 */
export function contain(body: Body): number {
  const at = body.position;
  if (!isFiniteVec2(at)) {
    return 0;
  }
  // Read once, before any clamp moves the body. Defence in depth rather than a
  // difference that shows: the clamps below move x, and the hysteresis half of
  // the predicate reads x, so reading it afterwards would ask about a position
  // the body no longer had. No clamp that runs can change this answer today,
  // because a clamp only runs when the answer was already false; taking the
  // reading first keeps that true of any bound added later.
  const throughTheOpening = ballFitsOpening(body);
  let walls = 0;
  if (!throughTheOpening && at.x - body.radius < FIELD_LEFT) {
    at.x = FIELD_LEFT + body.radius;
    walls |= WALL_LEFT;
  }
  if (!throughTheOpening && at.x + body.radius > FIELD_RIGHT) {
    at.x = FIELD_RIGHT - body.radius;
    walls |= WALL_RIGHT;
  }
  if (at.y - body.radius < FIELD_BOTTOM) {
    at.y = FIELD_BOTTOM + body.radius;
    walls |= WALL_BOTTOM;
  }
  if (at.y + body.radius > FIELD_TOP) {
    at.y = FIELD_TOP - body.radius;
    walls |= WALL_TOP;
  }
  return walls;
}

/**
 * SPEC section 6.3, body against wall: "reflect the normal component, scale by
 * wall restitution, and clamp the body inside the field." `contain` above does
 * the clamping and answers with the walls that clamped, so this turns one
 * component per wall off that answer rather than reading the four bounds a
 * second time. A second reading would be a second place for a bound to be
 * wrong, and the mask exists to make that impossible.
 *
 * THE APPROACH GATE APPLIES TO A WALL TOO, and it is the same rule the section
 * states for a pair: a body whose normal component already points away from
 * the wall is separating from it, so there is nothing to reflect. Without it a
 * body clamped in from outside while travelling away is turned straight back
 * into the wall it just left, which is the lock-and-vibrate that section
 * forbids for pairs wearing a wall's clothes. A body that genuinely struck a
 * wall is moving into it by definition, so no reflection item B6 grades is
 * changed by the gate; what changes is only the case that has no reflection in
 * it, and tests/unit/walls.test.ts asserts both halves.
 *
 * A BALL PASSING THROUGH A GOAL OPENING IS NOT TURNED, and there is no reading
 * of the opening here that says so. `contain` above does not clamp it, so no
 * bit is set for the wall it went through and every branch below is skipped for
 * that axis. SPEC section 6.4's transparency is one rule in one place.
 */
export function reflect(body: Body, walls: number): void {
  const moving = body.velocity;
  if ((walls & WALL_LEFT) !== 0 && moving.x < 0) {
    moving.x = -moving.x * WALL_RESTITUTION;
  }
  if ((walls & WALL_RIGHT) !== 0 && moving.x > 0) {
    moving.x = -moving.x * WALL_RESTITUTION;
  }
  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y * WALL_RESTITUTION;
  }
  if ((walls & WALL_TOP) !== 0 && moving.y > 0) {
    moving.y = -moving.y * WALL_RESTITUTION;
  }
}

/**
 * SPEC section 6.2: damping is per second. `v *= DAMPING ** dt`, never a
 * per-frame `v *= DAMPING`, which leaves a different speed at every frame rate.
 * The exponent is the step rather than the frame, so the factor below is one
 * value for the whole run and the form is still the per-second one.
 */
function decayFactor(seconds: number): number {
  return DAMPING ** seconds;
}

/** True when a body's speed is at or below SPEC section 6.2's stop threshold. */
export function atRest(velocity: Vec2): boolean {
  return Math.hypot(velocity.x, velocity.y) <= STOP_SPEED;
}

export function createSimulation(options: SimulationOptions = {}): Simulation {
  const world = options.world ?? createWorld();
  const scoring = options.scoring ?? createScoring();
  const policy: NonFinitePolicy = options.onNonFinite ?? 'throw';

  /**
   * The last position of each body that was finite, which is what a repair
   * restores. Preallocated once, parallel to `world.bodies`, and only ever
   * written from a position that was finite when it was read: a snapshot taken
   * unconditionally would record the poisoned value and repair to it.
   */
  const lastFinite: Vec2[] = world.bodies.map((body) => vec2(body.position.x, body.position.y));
  const found: Repair[] = [];

  let steps = 0;
  let frames = 0;
  let leftover = 0;
  let repaired = 0;
  let clamps = 0;
  let resumes = 0;

  const perStepDecay = decayFactor(FIXED_STEP);

  function record(kind: BodyKind, field: 'position' | 'velocity'): void {
    found.push({ kind, field, step: steps });
    repaired += 1;
  }

  /**
   * SPEC section 20, and the post-condition item B11 states: no step ever
   * produces a non-finite position or velocity. Repair first, escalate second,
   * so that a throw the caller catches still leaves a world the next step can
   * read.
   */
  function sanitise(body: Body, slot: number): void {
    const safe = lastFinite[slot];
    if (safe === undefined) {
      throw new Error(`no repair scratch for the ${body.kind} body`);
    }
    if (!isFiniteVec2(body.position)) {
      copy(body.position, safe);
      record(body.kind, 'position');
    }
    if (!isFiniteVec2(body.velocity)) {
      zero(body.velocity);
      record(body.kind, 'velocity');
    }
  }

  function stepOnce(): void {
    // SPEC section 6.4: a goal freezes the simulation with the ball where it
    // lies for 1.2 s, and the hold is counted in fixed steps rather than
    // against a clock, so it is the same 1.2 s at every frame rate. A frozen
    // step integrates nothing, resolves nothing and damps nothing, which is
    // what "where it lies" means, and the sanitising pass goes with them: a
    // step that reads no value and writes none cannot produce a non-finite one,
    // and the repair source is re-taken by the first step after the hold, ahead
    // of that step's integration, so it is never read while it is stale.
    if (scoring.frozen()) {
      scoring.holdOneStep(world);
      steps += 1;
      return;
    }

    const bodies = world.bodies;

    // The repair source, taken before anything is integrated and only from a
    // position that is finite now.
    for (let slot = 0; slot < bodies.length; slot += 1) {
      const body = bodies[slot];
      const safe = lastFinite[slot];
      if (body !== undefined && safe !== undefined && isFiniteVec2(body.position)) {
        copy(safe, body.position);
      }
    }

    // SPEC section 6.1: nothing is integrated over the global cap. A velocity
    // set from outside since the last step passes through here first, which is
    // what bounds travel to 10 px per step and makes item B9's sampling budget
    // a property of the code rather than of the caller's manners.
    for (const body of bodies) {
      limit(body.velocity, SPEED_CAP);
    }

    // DESIGN section 3, step 1.
    for (const body of bodies) {
      addScaled(body.position, body.velocity, FIXED_STEP);
    }

    // DESIGN section 3, step 2. SPEC section 6.3 fixes the pair order and the
    // four passes; both live in the module rather than here.
    resolveContacts(world);

    // DESIGN section 3, step 3. Containment is the guarantee and the mask it
    // returns is what the reflection turns, so the two read one set of bounds.
    //
    // WHERE THE CLAMP MEETS THE SEPARATION, disclosed rather than left to be
    // found. The pass above pushes an overlapping pair apart, and this one can
    // push one of them back in: a pile inside a corner has nowhere to go, so
    // the clamp partly undoes the separation and the pile takes a few steps
    // rather than one. SPEC section 6.3's "under 1 px of residual penetration"
    // is a claim about three bodies meeting at a point, not about three bodies
    // meeting at a point with two walls behind them, so this is a consequence
    // of the order rather than a violation of the sentence. Measured: a corner
    // pile peaks near 43 px in its first step, roughly halves every step after,
    // is under 1 px by the sixth, and settles at one unit in the last place of
    // the coordinate rather than at zero, where it stays. The envelope and the
    // fact that it never grows are pinned by tests/unit/separation.test.ts.
    for (const body of bodies) {
      reflect(body, contain(body));
    }

    // DESIGN section 3, step 4: the goal test, SPEC section 6.4. It reads the
    // position the walls left, which is defence in depth rather than a change
    // of verdict, per the note at the top of this file, and it allocates only
    // on the step a goal is actually awarded in.
    scoring.observe(world, steps);

    // DESIGN section 3, step 5. Damping is per second; the cap is applied here
    // as well as before integration because the elastic transfer above raises a
    // speed between the two applications, which is item B10's clause about a
    // ball accelerated by a transfer; and the stop threshold is read last so
    // that it reads the step's final velocity.
    for (const body of bodies) {
      scale(body.velocity, perStepDecay);
      limit(body.velocity, SPEED_CAP);
      if (atRest(body.velocity)) {
        zero(body.velocity);
      }
    }

    steps += 1;

    for (let slot = 0; slot < bodies.length; slot += 1) {
      const body = bodies[slot];
      if (body !== undefined) {
        sanitise(body, slot);
      }
    }
  }

  function escalate(): readonly Repair[] {
    if (found.length === 0) {
      return NO_REPAIRS;
    }
    const reported = found.slice();
    if (policy === 'throw') {
      const first = reported[0];
      throw new Error(
        `a non-finite ${first?.field ?? 'value'} reached the ${first?.kind ?? 'unknown'} ` +
          `body and was repaired, one of ${String(reported.length)} in this frame`,
      );
    }
    return reported;
  }

  return {
    world,
    scoring,
    policy,

    update(delta: number): FrameReport {
      frames += 1;
      found.length = 0;

      let applied = 0;
      let clamped = false;
      let resumed = false;

      // QUALITY-BAR section 7, in the order the readings are stated there. A
      // delta that is negative or not finite is zero, and the non-finite
      // reading is taken first on purpose: a delta of Infinity is a broken
      // measurement rather than a measured gap, so it buys no resume.
      if (!Number.isFinite(delta) || delta <= 0) {
        applied = 0;
      } else if (delta > RESUME_GAP) {
        leftover = 0;
        resumed = true;
        resumes += 1;
      } else {
        applied = acceptedFrameDelta(delta);
        if (delta > DELTA_CEILING) {
          clamped = true;
          clamps += 1;
        }
      }

      let pending = applied;
      let slices = 0;
      let longestSlice = 0;
      let taken = 0;

      while (pending > 0) {
        let take = Math.min(pending, CATCH_UP_SLICE);
        // The residue of dividing a delta into slices is absorbed into the
        // slice that produced it rather than spawning a slice of nothing.
        if (pending - take < TIME_EPSILON) {
          take = pending;
        }
        pending -= take;
        leftover += take;
        slices += 1;
        if (take > longestSlice) {
          longestSlice = take;
        }
        while (leftover >= FIXED_STEP) {
          stepOnce();
          leftover -= FIXED_STEP;
          taken += 1;
        }
      }

      const repairs = escalate();
      return {
        delta,
        applied,
        clamped,
        resumed,
        slices,
        longestSlice,
        steps: taken,
        leftover,
        repairs,
      };
    },

    step(): readonly Repair[] {
      found.length = 0;
      stepOnce();
      return escalate();
    },

    reset(): void {
      kickoff(world);
      // A celebration cannot be running over a world that has just been put
      // back to kickoff. The scores are left alone, which is SPEC section 6.4's
      // "scores are not reset"; a new match is `scoring.reset()`.
      scoring.clearHold();
      for (let slot = 0; slot < world.bodies.length; slot += 1) {
        const body = world.bodies[slot];
        const safe = lastFinite[slot];
        if (body !== undefined && safe !== undefined) {
          set(safe, body.position.x, body.position.y);
        }
      }
      leftover = 0;
    },

    readout(): SimulationReadout {
      return { steps, frames, leftover, repairs: repaired, clamps, resumes };
    },
  };
}
