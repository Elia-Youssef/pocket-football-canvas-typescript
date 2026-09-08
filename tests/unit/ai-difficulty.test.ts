import { describe, expect, it } from 'vitest';

import {
  ACE,
  CASUAL,
  OPPONENT_STREAM,
  PRO,
  WHIFF_OFFSET,
  planShot,
} from '../../src/core/ai'; // the opponent routine
import type { OpponentProfile } from '../../src/core/ai'; // the opponent's profile shape // the opponent routine
import { createWorld, everyBodyStopped, launch } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
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
import { whiffClearance } from './reference/strike-geometry';

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
 *
 * TWO OF SPEC SECTION 8'S SEVEN PARAMETERS USED TO BE GRADED BY NOBODY, and
 * both are graded here now, measured 2026-09-08. `defensiveBias` is a stated
 * probability, so the rate at which the roll fires is measured against the
 * literal 0.0, 0.15 and 0.30 and the outcome is separated from the roll.
 * `WHIFF_OFFSET` is a stated value, so it is pinned against the literal 1.15
 * rather than left to a mutation that only proves it is non-zero. And the
 * whiff's own purpose, passing the ball cleanly, is swept across the gaps the
 * pitch can produce instead of demonstrated at one comfortable layout.
 *
 * NEITHER OF THOSE TWO IS ITEM D4'S, AND THE SECOND BLOCK BELOW SAYS SO.
 * D4's criterion text grades three measures - angular error, power band,
 * whiff rate - and the power scale they are read on. The parameters above,
 * and the whiff's clean pass, are SPEC section 8 properties no row of the
 * acceptance sheet asks for, so they are gathered under their own heading
 * rather than counted toward a clause that does not carry them.
 */

const TOUCHING = CIRCLE_RADIUS + BALL_RADIUS;

interface Sample {
  readonly errorRad: number;
  readonly power: number;
  readonly whiffed: boolean;
  readonly rolled: boolean;
  readonly defensive: boolean;
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
    out.push({
      errorRad: plan.errorRad,
      power: plan.power,
      whiffed: plan.whiffed,
      rolled: plan.rolled,
      defensive: plan.defensive,
    });
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

describe('PF-8 SPEC section 8 properties the acceptance sheet does not grade', () => {
  /**
   * NO ROW OF THE ACCEPTANCE SHEET ASKS FOR THESE, and that is why they sit
   * apart. Item D4 grades angular error, power band and whiff rate, matching
   * their stated values across a large sample, with power read on the single
   * power01 scale of SPEC section 6.1; delete any test below and D4 is still
   * satisfied by its own criterion text. What these grade is SPEC section 8
   * itself: `defensiveBias` as the probability of substituting the block, the
   * whiff offset's stated multiple, the side that offset is laid on, and the
   * whiff's stated purpose of passing the ball cleanly.
   *
   * SO THEY ARE PARKED, NOT CLAIMED. The workspace rule is that a clause with
   * no criterion home is parked openly and never counted toward an item whose
   * text does not carry it. The route to a home is a D4 criterion extension
   * through the drafted-approval workflow, which is where the E6 and C4
   * extensions went, and it is a decision to be drafted rather than a change
   * to make here. The tests run either way; only the claim is withheld. The
   * mutation entries that protect them keep their D4 tag, because the harness
   * groups an entry by the nearest item and has no tag for a parked property.
   */

  it('substitutes the block at the probability its profile states, and for no other reason', () => {
    // SPEC section 8: "`defensiveBias` in [0, 1] is THE probability of
    // substituting the blocking target for the strike", 0.0, 0.15 and 0.30.
    // Measured over twelve hundred seeded turns per difficulty on random
    // layouts, against those literals. Casual's is exactly zero, which is the
    // strongest form: a single geometric reason to substitute, of the kind
    // the routine carried until this was measured, put its rate near a third.
    const cases: readonly [string, OpponentProfile, number][] = [
      ['casual', CASUAL, 0],
      ['pro', PRO, 0.15],
      ['ace', ACE, 0.3],
    ];
    const measured = new Map<string, { rolled: number; defensive: number }>();
    for (const [name, profile, stated] of cases) {
      const samples = sample(profile, `roll-${name}`, 1200);
      let rolled = 0;
      let defensive = 0;
      for (const one of samples) {
        rolled += one.rolled ? 1 : 0;
        defensive += one.defensive ? 1 : 0;
        // The outcome never fires without the roll: that is the whole claim.
        if (one.defensive) expect(one.rolled).toBe(true);
      }
      measured.set(name, { rolled, defensive });
      expect(Math.abs(rolled / samples.length - stated), `${name} roll rate`).toBeLessThan(
        0.03,
      );
    }
    // Casual's stated probability is zero, so its measured rate is zero
    // exactly rather than within a band.
    expect(measured.get('casual')).toEqual({ rolled: 0, defensive: 0 });
    // The two rates the roll produces, pinned as literals. The gap between
    // them is the fall-through: a rolled block whose straight trip to the
    // block point would run the striker into the ball is refused and the
    // ordinary strike is taken instead, which is a lane refusal and not a
    // second substitution rule. Pinned so the share cannot grow unnoticed.
    expect(measured.get('pro')).toEqual({ rolled: 185, defensive: 152 });
    expect(measured.get('ace')).toEqual({ rolled: 362, defensive: 288 });
    const fallThrough = (name: string): number => {
      const one = measured.get(name);
      return one === undefined ? -1 : one.rolled - one.defensive;
    };
    expect(fallThrough('pro')).toBe(33);
    expect(fallThrough('ace')).toBe(74);
  });

  it('offsets a whiff by the multiple of the touching distance the table states', () => {
    // SPEC section 8 states the whiff offset by value: (r_opponent + r_ball)
    // * 1.15. A constant the specification states is pinned against its
    // literal, because a mutation that only proves it is non-zero passes 1.16
    // and 2.0 alike.
    expect(WHIFF_OFFSET).toBe(1.15);
    expect(WHIFF_OFFSET * TOUCHING).toBeCloseTo(59.8, 12);
  });

  it('passes on the side the error draw names, and on both sides across seeds', () => {
    // The whiff's side is not stated by SPEC section 8, so what is graded is
    // that it is DECIDED rather than fixed: the sign rides on the error draw,
    // which keeps the turn at four draws and keeps a seeded match repeatable.
    // Measured as the SIGNED offset of the ball from the launch line, so a
    // sign the routine stopped consulting collapses this to one value.
    const striker = { x: 900, y: 360 };
    const ball = { x: 640, y: 360 };
    const sides = new Map<number, number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const world = createWorld();
      set(world.opponent.position, striker.x, striker.y);
      set(world.ball.position, ball.x, ball.y);
      const plan = planShot(
        world,
        { ...CASUAL, whiffChance: 1 },
        createRng(`whiff-side-${String(seed)}`).split(OPPONENT_STREAM),
      );
      expect(plan.whiffed).toBe(true);
      const signed =
        (ball.x - striker.x) * Math.sin(plan.angle) -
        (ball.y - striker.y) * Math.cos(plan.angle);
      const side = Math.sign(signed);
      sides.set(side, (sides.get(side) ?? 0) + 1);
      // and the side is the one the draw named, every time
      expect(side, `seed ${String(seed)}`).toBe(plan.errorRad < 0 ? -1 : 1);
    }
    expect(sides.get(1) ?? 0).toBeGreaterThan(5);
    expect(sides.get(-1) ?? 0).toBeGreaterThan(5);
    expect((sides.get(1) ?? 0) + (sides.get(-1) ?? 0)).toBe(40);
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
      // Four clear pixels past the touching distance at this one layout,
      // which is the property the gap sweep below generalises. The stated
      // 1.15 is pinned by its own literal, not by this bar: every factor from
      // about 1.078 upward clears it at a gap of 260.
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

  it('passes the ball cleanly at every gap the pitch can produce', () => {
    // THE SWEEP THE ONE LAYOUT ABOVE CANNOT BE. The clearance an aim point
    // laid off the ball centre gives a launch LINE falls with the gap, so the
    // property held at 260 px and failed under 105.3 px, where the "whiff"
    // struck the ball on one rolled whiff in five, measured 2026-09-08.
    // Three approach axes, each anchored so the striker stays
    // inside the field for the whole range, 2 px apart from 54 px to the
    // longest separation that axis admits.
    //
    // THE LONGEST IS NOT THE GOAL-LINE DIAGONAL: a circle centre stops 34 px
    // short of each edge and a ball centre 18 px short, so the widest
    // centre-to-centre separation the pitch holds is hypot(1048, 498) =
    // 1160.31, not the 1229.84 of the rectangle itself.
    const axes: readonly { name: string; ball: Vec2; angle: number; longest: number }[] = [
      {
        name: 'along the pitch',
        ball: { x: FIELD_LEFT + BALL_RADIUS, y: 360 },
        angle: 0,
        longest: FIELD_RIGHT - CIRCLE_RADIUS - (FIELD_LEFT + BALL_RADIUS),
      },
      {
        name: 'the diagonal',
        ball: { x: FIELD_LEFT + BALL_RADIUS, y: FIELD_BOTTOM + BALL_RADIUS },
        angle: Math.atan2(
          FIELD_TOP - CIRCLE_RADIUS - (FIELD_BOTTOM + BALL_RADIUS),
          FIELD_RIGHT - CIRCLE_RADIUS - (FIELD_LEFT + BALL_RADIUS),
        ),
        longest: Math.hypot(
          FIELD_RIGHT - CIRCLE_RADIUS - (FIELD_LEFT + BALL_RADIUS),
          FIELD_TOP - CIRCLE_RADIUS - (FIELD_BOTTOM + BALL_RADIUS),
        ),
      },
      {
        name: 'across the pitch',
        ball: { x: 640, y: FIELD_BOTTOM + BALL_RADIUS },
        angle: Math.PI / 2,
        longest: FIELD_TOP - CIRCLE_RADIUS - (FIELD_BOTTOM + BALL_RADIUS),
      },
    ];
    expect(axes[0]?.longest).toBe(1048);
    expect(axes[1]?.longest).toBeCloseTo(1160.3051, 4);
    expect(axes[2]?.longest).toBe(498);
    const forced: OpponentProfile = { ...CASUAL, whiffChance: 1 };
    let sampled = 0;
    let leastClearance = Infinity;
    let leastFromSixtyFour = Infinity;
    let returnedByAWall = 0;
    for (const axis of axes) {
      for (let gap = 54; gap <= axis.longest; gap += 2) {
        const striker = {
          x: axis.ball.x + gap * Math.cos(axis.angle),
          y: axis.ball.y + gap * Math.sin(axis.angle),
        };
        const world = createWorld();
        set(world.opponent.position, striker.x, striker.y);
        set(world.ball.position, axis.ball.x, axis.ball.y);
        // Parked in the one corner none of the three axes ends in: the
        // diagonal finishes in the far corner, so parking there would start
        // the longest layouts with two coincident circles.
        set(world.player.position, FIELD_LEFT + CIRCLE_RADIUS, FIELD_TOP - CIRCLE_RADIUS);
        const plan = planShot(
          world,
          forced,
          createRng(`whiff-sweep-${String(gap)}`).split(OPPONENT_STREAM),
        );
        expect(plan.whiffed, `${axis.name} ${String(gap)}`).toBe(true);
        sampled += 1;
        // The launch LINE's perpendicular distance from the ball centre,
        // which is what the launch clears the ball by.
        const clearance = Math.abs(
          (axis.ball.x - striker.x) * Math.sin(plan.angle) -
            (axis.ball.y - striker.y) * Math.cos(plan.angle),
        );
        leastClearance = Math.min(leastClearance, clearance);
        if (gap >= 64) leastFromSixtyFour = Math.min(leastFromSixtyFour, clearance);
        // The reference's reading of SPEC section 8's purpose: the stated
        // offset where the gap admits that tangent, the gap itself where the
        // striker stands inside the offset circle and no line through it can
        // clear more.
        expect(clearance, `${axis.name} ${String(gap)}`).toBeCloseTo(
          whiffClearance(gap, WHIFF_OFFSET),
          9,
        );
        expect(clearance, `${axis.name} ${String(gap)}`).toBeGreaterThanOrEqual(
          Math.min(gap, 56) - 1e-9,
        );
        if (gap >= 64) {
          // Four clear pixels past the touching distance at every gap the
          // sweep can reach a tangent from.
          expect(clearance, `${axis.name} ${String(gap)}`).toBeGreaterThanOrEqual(56);
        }
        // and the real physics leaves the ball untouched on the launch leg.
        const sim = createSimulation({ world });
        launch(sim.world.opponent, plan.angle, launchSpeed(plan.power));
        const heading = { x: Math.cos(plan.angle), y: Math.sin(plan.angle) };
        let onLeg = 0;
        let peak = 0;
        let reflected = false;
        for (let steps = 0; steps < 5000; steps += 1) {
          const velocity = sim.world.ball.velocity;
          const speed = Math.hypot(velocity.x, velocity.y);
          peak = Math.max(peak, speed);
          if (!reflected) onLeg = Math.max(onLeg, speed);
          if (everyBodyStopped(sim.world) || sim.scoring.frozen()) break;
          sim.step();
          const own = sim.world.opponent.velocity;
          const speedOf = Math.hypot(own.x, own.y);
          if (
            speedOf > 0 &&
            (own.x * heading.x + own.y * heading.y) / speedOf < 0.999999
          ) {
            reflected = true;
          }
        }
        expect(onLeg, `${axis.name} ${String(gap)} struck the ball`).toBe(0);
        if (peak !== 0) returnedByAWall += 1;
      }
    }
    expect(sampled).toBe(1275);
    expect(leastClearance).toBeCloseTo(54, 9); // the shortest gap swept
    expect(leastFromSixtyFour).toBeCloseTo(59.8, 9); // the stated offset itself
    // Counted rather than assumed: no layout in this sweep sees the ball
    // again after the launch has passed it. A striker returned by a wall into
    // a ball it has already cleared is not the graze SPEC section 8's offset
    // is about - the assertion above is the one that grades the offset - but
    // a count of zero here is worth keeping, because it is the number that
    // moves first if the launch stops leaving the ball's neighbourhood.
    expect(returnedByAWall).toBe(0);
  });
});
