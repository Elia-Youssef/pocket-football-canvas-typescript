import { describe, expect, it } from 'vitest';

import { ACE, CASUAL, OPPONENT_STREAM, PRO, planShot } from '../../src/core/ai'; // the opponent routine
import type { OpponentProfile } from '../../src/core/ai'; // the opponent's profile shape // the opponent routine
import { createWorld, everyBodyStopped, launch } from '../../src/core/bodies';
import {
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  launchSpeed,
} from '../../src/core/config';
import { createSimulation } from '../../src/core/physics';
import { createRng } from '../../src/core/rng';
import { distance, set } from '../../src/core/vec2';
import type { Vec2 } from '../../src/core/vec2';

/**
 * Item D4, Major: "The three difficulties differ measurably in angular
 * error, power band and whiff rate, matching their stated values across a
 * large sample, with power read on the single power01 scale of SPEC 6.1."
 *
 * EVERY CLAUSE IS MEASURED, NOT READ OFF THE PROFILE. The angular error is
 * the routine's own draw, sampled over twelve hundred turns per drawing
 * difficulty and two hundred for the precise one, and asserted uniform over
 * its stated span and bounded by it. The power band is the sampled powers
 * against the stated power01 numbers, and the ends of the band have to be
 * reached, because a band whose ends are never drawn is a band in name
 * only. The whiff rate is counted over turns, which is what the table's
 * row says. Every sample is seeded, so the measured numbers below are the
 * same on every run and every engine.
 */

const TOUCHING = 34 + 18;

interface Sample {
  readonly errorRad: number;
  readonly power: number;
  readonly whiffed: boolean;
}

/** Seeded turns over the whole playfield, one plan per turn. */
function sample(profile: OpponentProfile, name: string, count: number): Sample[] {
  const root = createRng(`diff-${name}`);
  const spots = root.split('layout');
  const shots = root.split(OPPONENT_STREAM);
  const out: Sample[] = [];
  for (let turn = 0; turn < count; turn += 1) {
    const spotIn = (): Vec2 => ({
      x: FIELD_LEFT + 70 + spots.nextFloat() * (FIELD_RIGHT - FIELD_LEFT - 140),
      y: FIELD_BOTTOM + 60 + spots.nextFloat() * (FIELD_TOP - FIELD_BOTTOM - 120),
    });
    let opponent = spotIn();
    const ball = spotIn();
    for (
      let attempt = 0;
      attempt < 50 && distance(opponent, ball) < TOUCHING + 20;
      attempt += 1
    ) {
      opponent = spotIn();
    }
    const world = createWorld();
    set(world.opponent.position, opponent.x, opponent.y);
    set(world.ball.position, ball.x, ball.y);
    const plan = planShot(world, profile, shots);
    out.push({ errorRad: plan.errorRad, power: plan.power, whiffed: plan.whiffed });
  }
  return out;
}

describe('PF-8 the three difficulties differ, item D4', () => {
  const casual = sample(CASUAL, 'casual', 1200);
  const pro = sample(PRO, 'pro', 1200);
  const ace = sample(ACE, 'ace', 200);

  it('draws the angular error uniformly across each stated span', () => {
    const cases: readonly [string, Sample[], number][] = [
      ['casual', casual, 12],
      ['pro', pro, 4],
      ['ace', ace, 1],
    ];
    for (const [name, samples, statedDeg] of cases) {
      const span = statedDeg * (Math.PI / 180);
      let widest = 0;
      let withinHalf = 0;
      for (const sample of samples) {
        const magnitude = Math.abs(sample.errorRad);
        expect(magnitude, `${name} exceeded its stated span`).toBeLessThanOrEqual(
          span + 1e-9,
        );
        widest = Math.max(widest, magnitude);
        if (magnitude <= span / 2) withinHalf += 1;
      }
      // A uniform draw fills its span: the widest of a thousand sits within
      // a whisker of the bound, and half the draws land in the lower half.
      expect(widest, `${name} never approached its span`).toBeGreaterThan(
        0.9 * span,
      );
      expect(withinHalf / samples.length, `${name} error not uniform`).toBeGreaterThan(0.45);
      expect(withinHalf / samples.length, `${name} error not uniform`).toBeLessThan(0.55);
    }
  });

  it('draws the power inside the stated power01 band and reaches both ends', () => {
    const cases: readonly [string, Sample[], number, number, number, number][] = [
      // name, samples, lo, hi, the highest the low end may sit, the lowest the high end may sit
      ['casual', casual, 0.4, 0.7, 0.42, 0.68],
      ['pro', pro, 0.5, 1, 0.53, 0.99],
      ['ace', ace, 0.55, 1, 0.56, 0.99],
    ];
    for (const [name, samples, lo, hi, lowCeiling, highFloor] of cases) {
      let lowest = Infinity;
      let highest = -Infinity;
      for (const sample of samples) {
        expect(sample.power, `${name} fell below its band`).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(sample.power, `${name} rose above its band`).toBeLessThanOrEqual(hi + 1e-9);
        lowest = Math.min(lowest, sample.power);
        highest = Math.max(highest, sample.power);
      }
      expect(lowest, `${name} never neared the floor of its band`).toBeLessThanOrEqual(lowCeiling);
      expect(highest, `${name} never neared the top of its band`).toBeGreaterThanOrEqual(highFloor);
    }
  });

  it('whiffs on the stated share of turns, and never on the other two', () => {
    let whiffs = 0;
    for (const sample of casual) whiffs += sample.whiffed ? 1 : 0;
    const rate = whiffs / casual.length;
    expect(rate).toBeGreaterThanOrEqual(0.15);
    expect(rate).toBeLessThanOrEqual(0.21);
    for (const sample of pro) expect(sample.whiffed).toBe(false);
    for (const sample of ace) expect(sample.whiffed).toBe(false);
  });

  it('separates the difficulties on every one of the three measures', () => {
    const spreadOf = (samples: Sample[]): number =>
      Math.max(...samples.map((sample) => Math.abs(sample.errorRad)));
    const bandMidpoint = (samples: Sample[]): number =>
      samples.reduce((total, sample) => total + sample.power, 0) / samples.length;
    const whiffRate = (samples: Sample[]): number =>
      samples.filter((sample) => sample.whiffed).length / samples.length;

    expect(spreadOf(casual)).toBeGreaterThan(spreadOf(pro));
    expect(spreadOf(pro)).toBeGreaterThan(spreadOf(ace));
    expect(bandMidpoint(pro)).toBeGreaterThan(bandMidpoint(casual));
    expect(whiffRate(casual)).toBeGreaterThan(whiffRate(pro));
    expect(whiffRate(casual)).toBeGreaterThan(whiffRate(ace));
  });

  it('whiffs pass the ball cleanly rather than grazing it', () => {
    // The parameter paragraph's own claim about the whiff: the offset aim
    // lays the launch off the ball, so the launch line must clear the
    // touching distance outright - not the grazing band the fixed step can
    // skip - and the real physics must leave the ball exactly untouched.
    // Seeded until a whiffed casual turn appears at a fixed layout.
    const striker = { x: 900, y: 360 };
    const ball = { x: 640, y: 360 };
    let checked = 0;
    for (let seed = 0; seed < 60 && checked < 3; seed += 1) {
      const world = createWorld();
      set(world.opponent.position, striker.x, striker.y);
      set(world.ball.position, ball.x, ball.y);
      const plan = planShot(
        world,
        CASUAL,
        createRng(`whiff-${String(seed)}`).split(OPPONENT_STREAM),
      );
      if (!plan.whiffed) continue;
      checked += 1;
      const directionX = Math.cos(plan.angle);
      const directionY = Math.sin(plan.angle);
      const impact = Math.abs(
        (ball.x - striker.x) * directionY - (ball.y - striker.y) * directionX,
      );
      // Four clear pixels past the touching distance: an offset factor of
      // less than about 1.1 cannot clear this bar, so the stated 1.15 is
      // what the assertion pins.
      expect(impact, `seed ${String(seed)} grazes the ball`).toBeGreaterThan(TOUCHING + 4);
      const sim = createSimulation({ world });
      launch(sim.world.opponent, plan.angle, launchSpeed(plan.power));
      let peak = 0;
      let steps = 0;
      while (!everyBodyStopped(sim.world) && steps < 5000) {
        const velocity = sim.world.ball.velocity;
        peak = Math.max(peak, Math.hypot(velocity.x, velocity.y));
        sim.step();
        steps += 1;
      }
      expect(peak, `seed ${String(seed)} struck the ball`).toBe(0);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('reads the drawn power onto the one launch scale of SPEC 6.1', () => {
    // The plan's power is power01: the launch it names is the minimum speed
    // plus the band's share of the range, and nothing else.
    for (const sample of casual.slice(0, 50)) {
      expect(launchSpeed(sample.power)).toBeCloseTo(150 + 750 * sample.power, 9);
    }
    // and a launch through the seam carries exactly that speed
    const world = createWorld();
    launch(world.opponent, 0, launchSpeed(casual[0]?.power ?? 0));
    expect(Math.hypot(world.opponent.velocity.x, world.opponent.velocity.y)).toBeCloseTo(
      launchSpeed(casual[0]?.power ?? 0),
      6,
    );
  });
});
