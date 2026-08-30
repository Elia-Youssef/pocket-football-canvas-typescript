import { describe, expect, it } from 'vitest';

import { LADDER, OPPONENT_STREAM, PRO, planShot } from '../../src/core/ai'; // the opponent routine
import type { OpponentProfile } from '../../src/core/ai'; // the opponent's profile shape // the opponent routine
import { createWorld } from '../../src/core/bodies';
import {
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
} from '../../src/core/config';
import { createRng } from '../../src/core/rng';
import { distance, set } from '../../src/core/vec2';
import type { Vec2 } from '../../src/core/vec2';

/**
 * Item D8, Minor: "Each ladder opponent applies its stated quirk through
 * parameters on the shared aim routine, and the six are distinguishable in
 * measured behaviour."
 *
 * BOTH HALVES ARE MEASURED OVER THE SAME SEEDED TURNS. The quirks are
 * asserted where SPEC section 10 names them - Sparks always at the top of
 * its band, Bolt wider and hotter than the casual base, Anchor blocking most
 * turns, Vector buying precision and wall candidates, Cinder lifting the
 * floor off its band, Meridian half a degree and capped - and each
 * opponent's behaviour is then fingerprinted over ninety seeded layouts and
 * compared pairwise: mean power, the widest angular error, the defensive
 * share, the whiff share and the wall-shot share. Every pair must separate
 * on at least one measure beyond its tolerance, which is what
 * "distinguishable" means when the opponents are parameters on one routine.
 */

const TOUCHING = 34 + 18;

interface Fingerprint {
  readonly meanPower: number;
  readonly maxErrorDeg: number;
  readonly defensiveRate: number;
  readonly whiffRate: number;
  readonly wallRate: number;
  readonly minPower: number;
  readonly maxPower: number;
  readonly powers: number[];
}

function fingerprintOf(name: string, profile: OpponentProfile, count: number): Fingerprint {
  const root = createRng(`ladder-${name}`);
  const spots = root.split('layout');
  const shots = root.split(OPPONENT_STREAM);
  let sumPower = 0;
  let maxError = 0;
  let defensive = 0;
  let whiff = 0;
  let wall = 0;
  let minPower = Infinity;
  let maxPower = -Infinity;
  const powers: number[] = [];
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
    sumPower += plan.power;
    maxError = Math.max(maxError, Math.abs(plan.errorRad));
    defensive += plan.defensive ? 1 : 0;
    whiff += plan.whiffed ? 1 : 0;
    wall += plan.wallShot ? 1 : 0;
    minPower = Math.min(minPower, plan.power);
    maxPower = Math.max(maxPower, plan.power);
    powers.push(plan.power);
  }
  return {
    meanPower: sumPower / count,
    maxErrorDeg: (maxError * 180) / Math.PI,
    defensiveRate: defensive / count,
    whiffRate: whiff / count,
    wallRate: wall / count,
    minPower,
    maxPower,
    powers,
  };
}

const COUNT = 90;
const TOLERANCE = {
  meanPower: 0.04,
  maxErrorDeg: 0.2,
  defensiveRate: 0.1,
  whiffRate: 0.1,
  wallRate: 0.1,
} as const;

describe('PF-8 the ladder opponents, item D8', () => {
  const prints = LADDER.map((opponent) => ({
    name: opponent.name,
    profile: opponent.profile,
    print: fingerprintOf(opponent.name, opponent.profile, COUNT),
  }));

  it('names six opponents in ladder order on the three difficulties', () => {
    expect(LADDER.map((opponent) => opponent.name)).toEqual([
      'Sparks',
      'Bolt',
      'Anchor',
      'Vector',
      'Cinder',
      'Meridian',
    ]);
    // Two rungs per difficulty in the section's order, read off the band
    // floor each difficulty states: casual 0.4, pro 0.5, ace 0.55. Cinder's
    // high-power quirk lifts the ace floor, which is the one deviation.
    const floors = [0.4, 0.4, 0.5, 0.5, 0.7, 0.55];
    for (const [index, opponent] of LADDER.entries()) {
      expect(opponent.profile.candidateCount).toBeGreaterThanOrEqual(1);
      expect(opponent.profile.powerBand[0]).toBe(floors[index]);
    }
  });

  it('expresses each stated quirk as parameters on the shared profile shape', () => {
    const [sparks, bolt, anchor, vector, cinder, meridian] = LADDER;
    // Sparks overhits constantly: the draw sits permanently at the top.
    expect(sparks?.profile.aggression).toBe(1);
    // Bolt is fast but wild: a wider error than the casual base and a
    // hotter draw than it.
    expect(bolt?.profile.angularErrorDeg).toBeGreaterThan(CASUAL_BASE_ERROR);
    expect(bolt?.profile.aggression).toBeGreaterThan(CASUAL_BASE_AGGRESSION);
    // Anchor plays defensively, aims to block: the substitution most turns.
    expect(anchor?.profile.defensiveBias).toBeGreaterThan(0.6);
    // Vector is precise and uses wall angles: a tighter error than the pro
    // base and the wall candidates bought.
    expect(vector?.profile.angularErrorDeg).toBeLessThan(PRO.angularErrorDeg);
    expect(vector?.profile.useWallShots).toBe(true);
    expect(vector?.profile.candidateCount).toBe(3);
    // Cinder is aggressive, high power: the floor lifted off the band.
    expect(cinder?.profile.powerBand[0]).toBeGreaterThanOrEqual(0.7);
    // Meridian is near-perfect and patient: half a degree, capped band.
    expect(meridian?.profile.angularErrorDeg).toBeLessThanOrEqual(0.5);
    expect(meridian?.profile.powerBand[1]).toBeLessThanOrEqual(0.85);
  });

  it('measures each quirk in the behaviour the routine produces', () => {
    const byName = new Map(prints.map((entry) => [entry.name, entry.print]));
    const sparks = byName.get('Sparks');
    const bolt = byName.get('Bolt');
    const anchor = byName.get('Anchor');
    const vector = byName.get('Vector');
    const cinder = byName.get('Cinder');
    const meridian = byName.get('Meridian');
    // overhits constantly: every launch at the top of the band
    for (const power of sparks?.powers ?? []) {
      expect(power).toBeCloseTo(0.7, 9);
    }
    // wild: a wider measured error than Sparks', and fast: hotter than the
    // casual base draws
    expect(bolt?.maxErrorDeg ?? 0).toBeGreaterThan((sparks?.maxErrorDeg ?? 0) + 2);
    expect(bolt?.meanPower ?? 0).toBeGreaterThan(0.62);
    // aims to block: the defensive share dominates
    expect(anchor?.defensiveRate ?? 0).toBeGreaterThan(0.6);
    // precise and wall-seeking
    expect(vector?.maxErrorDeg ?? 9).toBeLessThan(2.5);
    expect(vector?.wallRate ?? 0).toBeGreaterThan(0.1);
    // high power: nothing weak ever leaves Cinder
    expect(cinder?.minPower ?? 0).toBeGreaterThanOrEqual(0.69);
    // near-perfect aim, patient: the narrowest error of the six, capped power
    expect(meridian?.maxErrorDeg ?? 9).toBeLessThan(0.7);
    expect(meridian?.maxPower ?? 9).toBeLessThanOrEqual(0.87);
    expect((meridian?.meanPower ?? 0)).toBeLessThan((cinder?.meanPower ?? 0));
  });

  it('separates every pair on at least one measured behaviour', () => {
    const measures = Object.keys(TOLERANCE) as ReadonlyArray<keyof typeof TOLERANCE>;
    for (let one = 0; one < prints.length; one += 1) {
      for (let other = one + 1; other < prints.length; other += 1) {
        const first = prints[one];
        const second = prints[other];
        if (first === undefined || second === undefined) continue;
        const separating = measures.filter(
          (measure) =>
            Math.abs(first.print[measure] - second.print[measure]) > TOLERANCE[measure],
        );
        expect(
          separating.length,
          `${String(first.name)} and ${String(second.name)} are indistinguishable`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

const CASUAL_BASE_ERROR = 12;
const CASUAL_BASE_AGGRESSION = 0.2;
