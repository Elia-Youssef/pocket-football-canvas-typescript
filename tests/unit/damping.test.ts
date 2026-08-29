import { describe, expect, it } from 'vitest';

import { launch } from '../../src/core/bodies';
import {
  CIRCLE_RADIUS,
  DAMPING,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIXED_STEP,
  STOP_SPEED,
} from '../../src/core/config';
import { createSimulation } from '../../src/core/physics';
import { set } from '../../src/core/vec2';
import { RATES, driveSeconds } from './support/drive';

/**
 * Item B2, Critical: "Damping is applied per second rather than per frame, and
 * a negative control using per-frame damping is detected as a failure by the
 * same check."
 *
 * THE CHECK IS ONE FUNCTION, `dampingFailures`, and it is what grades the real
 * integrator and both controls. A control graded by a weaker check of its own
 * proves nothing about the check that grades the shipping code.
 *
 * IT HAS TWO CLAUSES, AND BOTH ARE NEEDED. The obvious clause is that the frame
 * rate does not change the answer. It is not enough on its own, and the case
 * that shows why is the DRESSED per-frame form, `v *= k ** (dt * 60)`: it
 * decays once per frame, which is the defect, but the exponent is normalised by
 * the frame length, so a second of decay leaves the same speed at every rate
 * and rate agreement passes it. The second clause is therefore absolute: after
 * a measured span of simulated time the speed must be the launch speed times
 * the damping constant raised to that span, which is the per-second form
 * written out. The undressed control fails both clauses; the dressed one fails
 * only this second clause, and both are run below.
 *
 * The second control uses QUALITY-BAR section 7's own example, k = 0.98, where
 * the divergence is the published one: a second of decay leaves 0.55 at 30 fps
 * and 0.055 at 144 fps. Those two numbers are re-derived below rather than
 * quoted, so the example the standard is argued from is checked too.
 */

interface DecayRun {
  /** The speed the body is carrying when the run ends. */
  readonly speed: number;
  /** The simulated time the runner actually advanced, in seconds. */
  readonly elapsed: number;
}

type Decay = (fps: number, seconds: number, launchedAt: number) => DecayRun;

const LAUNCH_SPEED = 900;
const SPAN = 1;

/** Relative rather than absolute: these speeds span fifteen orders of magnitude. */
function relativeGap(measured: number, expected: number): number {
  const scale = Math.max(Math.abs(expected), Math.abs(measured), Number.MIN_VALUE);
  return Math.abs(measured - expected) / scale;
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * The whole grading of item B2, in one place.
 *
 * Clause one, the per-second form: the speed left after a run equals the launch
 * speed times DAMPING raised to the SIMULATED seconds the run advanced. Reading
 * the runner's own elapsed time rather than the wall time it was asked for is
 * what keeps the clause exact: a fixed-step run at 30 fps may have taken 119
 * steps rather than 120 when the second is up, and that is the accumulator
 * doing its job rather than a decay defect.
 *
 * Clause two, rate agreement: every rate leaves the same speed to within one
 * step of decay, which is 0.95 percent.
 */
function dampingFailures(run: Decay): string[] {
  const failures: string[] = [];
  const readings = RATES.map((fps) => ({ fps, ...run(fps, SPAN, LAUNCH_SPEED) }));
  if (readings.length !== 4) {
    failures.push('the check ran against fewer than four rates');
  }

  for (const reading of readings) {
    const expected = LAUNCH_SPEED * DAMPING ** reading.elapsed;
    if (relativeGap(reading.speed, expected) > 1e-9) {
      failures.push(
        `per-second form at ${String(reading.fps)} frames per second: ` +
          `${String(reading.speed)} where the form gives ${String(expected)}`,
      );
    }
  }

  const oneStep = 1 - DAMPING ** FIXED_STEP;
  const first = readings[0];
  for (const reading of readings) {
    if (first !== undefined && relativeGap(reading.speed, first.speed) > oneStep * 1.2) {
      failures.push(
        `rate agreement at ${String(reading.fps)} frames per second: ` +
          `${String(reading.speed)} against ${String(first.speed)}`,
      );
    }
  }
  return failures;
}

/**
 * The shipping integrator, driven through its own public entry point.
 *
 * THE LANE IS PART OF THE MEASUREMENT. PF-3 gave a wall a velocity effect (item
 * B6, restitution 0.92) and gave a contact one (item B4), and either inside the
 * measured second would be a second rule contaminating a measurement of the
 * first. A full-power launch covers 537 px in that second, so the body starts
 * in the bottom-left corner and runs along the bottom of the field: 1032 px of
 * clear width ahead of it and 241 px of clearance from the nearest body, which
 * needs 52 px to touch. Before PF-3 the direction did not matter, because
 * containment moved a body without ever changing its speed.
 */
const fixedStep: Decay = (fps, seconds, launchedAt) => {
  const sim = createSimulation({ onNonFinite: 'throw' });
  set(sim.world.player.position, FIELD_LEFT + CIRCLE_RADIUS, FIELD_BOTTOM + CIRCLE_RADIUS);
  launch(sim.world.player, 0, launchedAt);
  driveSeconds(sim, fps, seconds);
  const velocity = sim.world.player.velocity;
  return {
    speed: Math.hypot(velocity.x, velocity.y),
    elapsed: sim.readout().steps * FIXED_STEP,
  };
};

/** The negative control: `v *= k` once per frame, which is the defect itself. */
function perFrame(k: number): Decay {
  return (fps, seconds, launchedAt) => {
    const frames = Math.round(seconds * fps);
    let speed = launchedAt;
    for (let frame = 0; frame < frames; frame += 1) {
      speed *= k;
    }
    return { speed, elapsed: frames / fps };
  };
}

/**
 * The same defect, dressed. It still decays once per frame, but the exponent is
 * normalised by the frame length, so every rate agrees on the answer and only
 * the absolute clause can tell it apart from the per-second form. This is the
 * control the second clause exists for, and it is the one a reviewer is likeliest
 * to see written in a real loop, because it looks like the right shape.
 */
function perFrameDressed(k: number): Decay {
  return (fps, seconds, launchedAt) => {
    const frames = Math.round(seconds * fps);
    const dt = 1 / fps;
    let speed = launchedAt;
    for (let frame = 0; frame < frames; frame += 1) {
      speed *= k ** (dt * 60);
    }
    return { speed, elapsed: frames / fps };
  };
}

describe('PF-2 damping is per second, item B2', () => {
  it('leaves the launch speed times the constant after one second', () => {
    // The form written out, at the rate a display most often runs at: after a
    // second a 900 px/s launch is carrying 288 px/s, and it is nowhere near
    // the stop threshold, so the threshold is not what is being measured.
    const run = fixedStep(60, 1, LAUNCH_SPEED);
    expect(run.elapsed).toBeCloseTo(1, 2);
    expect(run.speed).toBeGreaterThan(STOP_SPEED * 10);
    expect(run.speed / LAUNCH_SPEED).toBeCloseTo(0.32, 2);
    // A second of wall time is 119 or 120 fixed steps depending on where the
    // accumulator lands, which is a one-step band rather than a decay defect.
    // The exact form is clause one's to grade, against the steps that ran.
    expect(run.speed).toBeGreaterThan(285);
    expect(run.speed).toBeLessThan(292);
  });

  it('passes the check at every rate', () => {
    expect(dampingFailures(fixedStep)).toEqual([]);
  });

  it('detects a per-frame control at the constant this game ships', () => {
    // Caught by both clauses: the speeds left are fifteen orders of magnitude
    // apart between 30 and 1000 frames per second, and none of them is what a
    // second of per-second decay leaves.
    const failures = dampingFailures(perFrame(DAMPING));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.filter((entry) => entry.startsWith('per-second form'))).toHaveLength(4);
    expect(failures.filter((entry) => entry.startsWith('rate agreement')).length).toBeGreaterThan(0);
  });

  it('detects the dressed per-frame control, which only the absolute clause sees', () => {
    // `v *= k ** (dt * 60)` per frame: rate agreement passes it, because the
    // total exponent over a second is 60 at every rate. It is still a per-frame
    // decay and it still leaves the wrong speed, and the clause that says so is
    // the one comparing against the per-second form.
    const failures = dampingFailures(perFrameDressed(DAMPING));
    expect(failures.filter((entry) => entry.startsWith('per-second form'))).toHaveLength(4);
    expect(failures.filter((entry) => entry.startsWith('rate agreement'))).toHaveLength(0);
    expect(failures).toHaveLength(4);
  });

  it('detects a per-frame control at the constant QUALITY-BAR section 7 argues from', () => {
    const failures = dampingFailures(perFrame(0.98));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.filter((entry) => entry.startsWith('per-second form')).length).toBeGreaterThan(0);
    expect(failures.filter((entry) => entry.startsWith('rate agreement')).length).toBeGreaterThan(0);
  });

  it('re-derives the two numbers that standard quotes', () => {
    // "at k = 0.98, one second of decay leaves 0.55 at 30 fps and 0.055 at 144
    // fps, so the same shot travels three different distances on three
    // machines."
    expect(round(0.98 ** 30, 2)).toBe(0.55);
    expect(round(0.98 ** 144, 3)).toBe(0.055);
    expect(0.98 ** 30 / 0.98 ** 144).toBeGreaterThan(9);

    // And the per-second form of the same constant does not diverge at all:
    // the per-step factor applied for a second of frames returns the constant,
    // whatever the rate.
    for (const fps of RATES) {
      const perStep = 0.98 ** (1 / fps);
      expect(perStep ** fps, `at ${String(fps)} frames per second`).toBeCloseTo(0.98, 12);
    }
  });

  it('damps all three bodies identically, SPEC section 6.2', () => {
    // "All three bodies are damped identically by the one constant, and the
    // uniformity is deliberate rather than an omission."
    const sim = createSimulation({ onNonFinite: 'throw' });
    for (const body of sim.world.bodies) {
      launch(body, Math.PI / 2, 600);
    }
    driveSeconds(sim, 60, 0.5);
    const speeds = sim.world.bodies.map((body) => Math.hypot(body.velocity.x, body.velocity.y));
    const first = speeds[0] ?? Number.NaN;
    for (const speed of speeds) {
      expect(speed).toBe(first);
    }
    expect(first).toBeLessThan(600);
    expect(first).toBeGreaterThan(STOP_SPEED);
  });
});
