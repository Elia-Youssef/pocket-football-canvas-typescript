import { describe, expect, it } from 'vitest';

import type { BodyKind, World } from '../../src/core/bodies';
import { launch } from '../../src/core/bodies';
import { resolvePair } from '../../src/core/collisions';
import { FIELD_LEFT, FIELD_RIGHT } from '../../src/core/config';
import { contain, createSimulation } from '../../src/core/physics';
import { set } from '../../src/core/vec2';
import { driveToRest, snapshot } from './support/drive';

/**
 * Item B11, Critical: "No step ever produces a non-finite position or velocity,
 * and any body reaching a non-finite state is caught rather than propagated."
 *
 * THE READING OF SPEC SECTION 20 THIS FILE GRADES. The section asks for "a hard
 * failure caught in development and clamped in production, never silently
 * propagated into the next step", which is two behaviours over one event. The
 * implementation separates them: the REPAIR is unconditional, so the
 * post-condition in the criterion above holds under either policy and a caught
 * throw cannot leave a poisoned world behind; the POLICY decides only whether
 * the repair also raises. Both halves are graded here.
 *
 * WHY A POISONED VELOCITY REPORTS TWO REPAIRS. Integration reads the velocity,
 * so a velocity that is not finite has already poisoned the position by the
 * time the step ends. Both are caught, the position is restored to the last
 * value that was finite, and the body ends the step exactly where it began it.
 * That rollback is the "never propagated" half made concrete.
 */

const KINDS: readonly BodyKind[] = ['player', 'opponent', 'ball'];
const POISONS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function nonFinite(world: World): string[] {
  const out: string[] = [];
  for (const body of world.bodies) {
    for (const [label, value] of [
      ['position.x', body.position.x],
      ['position.y', body.position.y],
      ['velocity.x', body.velocity.x],
      ['velocity.y', body.velocity.y],
    ] as const) {
      if (!Number.isFinite(value)) {
        out.push(`${body.kind} ${label} is ${String(value)}`);
      }
    }
  }
  return out;
}

describe('PF-2 the finiteness guard, item B11', () => {
  it('catches a poisoned velocity, on every body and for every poison', () => {
    for (const kind of KINDS) {
      for (const poison of POISONS) {
        const sim = createSimulation({ onNonFinite: 'repair' });
        const body = sim.world[kind];
        const from = { x: body.position.x, y: body.position.y };
        body.velocity.x = poison;
        body.velocity.y = 12;

        const repairs = sim.step();

        expect(nonFinite(sim.world), `${kind} with ${String(poison)}`).toEqual([]);
        expect(repairs.map((entry) => `${entry.kind} ${entry.field}`)).toEqual([
          `${kind} position`,
          `${kind} velocity`,
        ]);
        // Rolled back rather than moved somewhere arbitrary.
        expect(body.position.x).toBe(from.x);
        expect(body.position.y).toBe(from.y);
        expect(body.velocity.x).toBe(0);
        expect(body.velocity.y).toBe(0);
        expect(Object.is(body.velocity.x, -0)).toBe(false);
      }
    }
  });

  it('catches a poisoned position, on every body and for every poison', () => {
    for (const kind of KINDS) {
      for (const poison of POISONS) {
        const sim = createSimulation({ onNonFinite: 'repair' });
        const body = sim.world[kind];
        const from = { x: body.position.x, y: body.position.y };
        body.position.x = poison;

        const repairs = sim.step();

        expect(nonFinite(sim.world), `${kind} with ${String(poison)}`).toEqual([]);
        expect(repairs.map((entry) => `${entry.kind} ${entry.field}`)).toEqual([
          `${kind} position`,
        ]);
        // The last position that WAS finite, which at the first step is where
        // the body was placed at kickoff.
        expect(body.position.x).toBe(from.x);
        expect(body.position.y).toBe(from.y);
      }
    }
  });

  it('leaves a non-finite position for the guard rather than clamping it silently', () => {
    // Containment must not repair a poisoned position as a side effect of an
    // unrelated rule: it would be corrected, but nothing would be reported and
    // SPEC section 20 asks for it to be caught.
    const sim = createSimulation({ onNonFinite: 'repair' });
    const ball = sim.world.ball;
    set(ball.position, Number.POSITIVE_INFINITY, Number.NaN);
    expect(contain(ball)).toBe(0);
    expect(ball.position.x).toBe(Number.POSITIVE_INFINITY);

    // And a finite position at an absurd distance IS containment's business.
    // Clear of the goal opening in y, because SPEC section 6.4 makes the goal
    // ends transparent to a ball that fits it and the reading here is about the
    // guard rather than about item B7's exemption.
    set(ball.position, 1e12, 200);
    expect(contain(ball)).toBeGreaterThan(0);
    expect(ball.position.x).toBeLessThan(FIELD_RIGHT);
    expect(ball.position.x).toBeGreaterThan(FIELD_LEFT);
  });

  it('raises under the development policy, after repairing', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    expect(sim.policy).toBe('throw');
    sim.world.player.velocity.x = Number.NaN;

    expect(() => sim.step()).toThrowError(/non-finite/);
    // Repair first, escalate second: the caught throw left a world the next
    // step can read.
    expect(nonFinite(sim.world)).toEqual([]);
    expect(sim.readout().repairs).toBe(2);
    expect(() => sim.step()).not.toThrow();
  });

  it('defaults to the development policy', () => {
    // SPEC section 20 wants the hard failure during development. The
    // composition root selects `repair` for a production build; until that
    // part lands, nothing can reach this state without a test seeing it.
    expect(createSimulation().policy).toBe('throw');
  });

  it('raises out of a frame as well as out of a single step', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    sim.world.ball.position.y = Number.NEGATIVE_INFINITY;
    expect(() => sim.update(1 / 60)).toThrowError(/non-finite/);
    expect(nonFinite(sim.world)).toEqual([]);
  });

  it('treats a hostile delta as no time rather than as a poisoned step', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.player, 1, 400);
    const before = snapshot(sim.world);
    for (const delta of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -0,
      0,
    ]) {
      const report = sim.update(delta);
      expect(report.steps, `delta ${String(delta)}`).toBe(0);
      expect(report.repairs, `delta ${String(delta)}`).toEqual([]);
      expect(report.slices, `delta ${String(delta)}`).toBe(0);
    }
    expect(snapshot(sim.world)).toEqual(before);
    expect(nonFinite(sim.world)).toEqual([]);
  });

  it('carries on simulating correctly after a repair', () => {
    const sim = createSimulation({ onNonFinite: 'repair' });
    launch(sim.world.player, Math.PI / 4, 800);
    sim.world.ball.velocity.x = Number.NaN;
    const repaired = sim.step();
    expect(repaired.length).toBeGreaterThan(0);

    driveToRest(sim, 60);
    expect(nonFinite(sim.world)).toEqual([]);
    expect(sim.readout().repairs).toBe(2);
    // The repaired body is back at rest where it belongs, and the untouched
    // one has completed its run.
    expect(sim.world.ball.velocity.x).toBe(0);
    expect(sim.world.player.position.x).toBeGreaterThan(300);
  });

  it('hands out a copy of the repair list rather than the list it keeps', () => {
    // The list is reused frame to frame, so returning it directly would hand a
    // caller an array that empties itself and refills with somebody else's
    // repairs. A caller that logs a frame's repairs is the obvious victim, and
    // nothing about the bug is visible in the frame where it happens.
    const sim = createSimulation({ onNonFinite: 'repair' });
    sim.world.ball.velocity.x = Number.NaN;
    const first = sim.update(1 / 60);
    expect(first.repairs.map((entry) => entry.kind)).toEqual(['ball', 'ball']);

    sim.world.player.velocity.y = Number.POSITIVE_INFINITY;
    const second = sim.update(1 / 60);
    expect(second.repairs.map((entry) => entry.kind)).toEqual(['player', 'player']);
    // The captured reading still says what it said, and it is not the same
    // array as the second one.
    expect(first.repairs.map((entry) => entry.kind)).toEqual(['ball', 'ball']);
    expect(second.repairs).not.toBe(first.repairs);

    // A clean frame hands out an empty reading nobody can write into.
    const clean = sim.update(1 / 60);
    expect(clean.repairs).toEqual([]);
    expect(Object.isFrozen(clean.repairs)).toBe(true);
  });

  it('names the step a repair happened in', () => {
    // Diagnostic, and pinned rather than left as an unread field: the count is
    // taken after the step that produced the repair, so the first step is 1.
    const sim = createSimulation({ onNonFinite: 'repair' });
    sim.world.ball.position.x = Number.NaN;
    expect(sim.step().map((entry) => entry.step)).toEqual([1]);

    sim.world.ball.position.x = Number.NaN;
    expect(sim.step().map((entry) => entry.step)).toEqual([2]);
    expect(sim.readout().steps).toBe(2);
  });

  it('re-arms the repair source and drops the accumulator on a reset', () => {
    // SPEC section 6.4's reset, from the finiteness side: after it, the value a
    // repair restores is the kickoff position rather than wherever the body
    // happened to be before, and no part of a frame survives into the new turn.
    const sim = createSimulation({ onNonFinite: 'repair' });
    launch(sim.world.ball, 0, 900);
    driveToRest(sim, 60);
    expect(sim.world.ball.position.x).toBeGreaterThan(700);

    sim.update(1 / 1000);
    expect(sim.readout().leftover).toBeGreaterThan(0);

    sim.reset();
    expect(sim.readout().leftover).toBe(0);
    expect(sim.world.ball.position.x).toBe(640);

    sim.world.ball.position.x = Number.NaN;
    const repairs = sim.step();
    expect(repairs.map((entry) => entry.field)).toEqual(['position']);
    expect(sim.world.ball.position.x).toBe(640);
    expect(sim.world.ball.position.y).toBe(360);
  });

  it('reports no repair on a clean run', () => {
    const sim = createSimulation({ onNonFinite: 'throw' });
    launch(sim.world.player, 2.1, 900);
    launch(sim.world.opponent, -1.2, 900);
    launch(sim.world.ball, 0.3, 900);
    driveToRest(sim, 144);
    expect(sim.readout().repairs).toBe(0);
    expect(nonFinite(sim.world)).toEqual([]);
    expect(sim.readout().steps).toBeGreaterThan(500);
  });
});

describe('PF-3 a poisoned body moves nobody else, item B11', () => {
  /**
   * "Caught rather than propagated" acquired a second meaning at PF-3, and the
   * repair list does not carry it. A repair restores the body it names; it
   * says nothing about a HEALTHY body that a poisoned one pushed on the way
   * through, and a shove like that survives the repair entirely.
   *
   * The route is the contact resolution. A position that is not a number
   * measures a distance that is not a number, and a touching test written as
   * `distance > reach` answers false to that, because every comparison against
   * NaN is false. The pair is then treated as a contact: the normal falls back
   * to (1, 0), the penetration reads as the whole reach, and four passes hand
   * the healthy partner 4 x reach / 2 of displacement. For a circle and the
   * ball that is 104 px in one step, and the sanitiser at the tail of the step
   * repairs only the poisoned body, so the 104 px stays.
   *
   * Both guards in `core/collisions.ts` are therefore written as refusals of a
   * proven fact rather than as the comparison they replace, and this block is
   * what grades them. Without it either guard could be flipped back to its
   * plain form with every other test in this project still green.
   */

  it('leaves every other body bit-identical, for every body and every poison', () => {
    let checked = 0;
    for (const kind of KINDS) {
      for (const poison of POISONS) {
        for (const field of ['position', 'velocity'] as const) {
          const sim = createSimulation({ onNonFinite: 'repair' });
          const body = sim.world[kind];
          const bystanders = sim.world.bodies
            .filter((other) => other !== body)
            .map((other) => ({ kind: other.kind, x: other.position.x, y: other.position.y }));
          expect(bystanders).toHaveLength(2);
          if (field === 'position') {
            body.position.x = poison;
          } else {
            body.velocity.x = poison;
          }

          sim.step();

          const where = `${kind} ${field} ${String(poison)}`;
          for (const was of bystanders) {
            const other = sim.world[was.kind];
            expect(other.position.x, `${was.kind} x after ${where}`).toBe(was.x);
            expect(other.position.y, `${was.kind} y after ${where}`).toBe(was.y);
            expect(other.velocity.x, `${was.kind} velocity x after ${where}`).toBe(0);
            expect(other.velocity.y, `${was.kind} velocity y after ${where}`).toBe(0);
          }
          // The poison was real and was caught, so the reading above is not a
          // reading of a step in which nothing happened.
          expect(nonFinite(sim.world), where).toEqual([]);
          expect(sim.readout().repairs, where).toBeGreaterThan(0);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(18);
  });

  it('spreads a relative velocity that is not a number to nobody', () => {
    // The second guard, at the level it lives at. It cannot be reached through
    // a whole step: integration reads the velocity first, so a velocity that is
    // not a number has already poisoned the position by the time the pairs are
    // resolved, where the first guard refuses it. The pair resolver is asked
    // directly instead, which is the level `resolvePair` is exported at.
    //
    // SPEC section 6.3 states the gate as `dot(vRel, n) >= 0`. A relative
    // velocity of NaN satisfies neither that comparison nor its negation, so
    // the plain form falls through to the impulse and multiplies NaN into the
    // healthy body. An INFINITE relative velocity is deliberately a different
    // case and not this one: it is an approach, the gate lets it through
    // exactly as the section says, and what it produces is caught by the
    // sanitiser at the tail of the step.
    for (const axis of ['x', 'y'] as const) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const player = sim.world.player;
      const ball = sim.world.ball;
      // Exactly touching, so there is no separation to confuse the reading and
      // the only thing the resolver can do to the ball is apply an impulse.
      set(player.position, 600, 360);
      set(ball.position, 652, 360);
      player.velocity[axis] = Number.NaN;

      expect(resolvePair(player, ball), `poison on ${axis}`).toBe(true);

      expect(ball.velocity.x, `ball velocity x, poison on ${axis}`).toBe(0);
      expect(ball.velocity.y, `ball velocity y, poison on ${axis}`).toBe(0);
      expect(ball.position.x, `ball x, poison on ${axis}`).toBe(652);
      expect(ball.position.y, `ball y, poison on ${axis}`).toBe(360);
    }
  });
});
