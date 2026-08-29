import { describe, expect, it } from 'vitest';

import type { Body, BodyKind } from '../../src/core/bodies';
import { setVelocity } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
  CIRCLE_RESTITUTION,
  DAMPING,
  FIXED_STEP,
  MAX_LAUNCH_SPEED,
  SPEED_CAP,
} from '../../src/core/config';
import { resolvePair } from '../../src/core/collisions';
import { createSimulation } from '../../src/core/physics';
import type { Vec2 } from '../../src/core/vec2';
import { addScaled, copy, dot, normalise, set, subtract, vec2 } from '../../src/core/vec2';

/**
 * Item B4, Critical: "Circle-against-circle collisions are elastic with correct
 * momentum transfer along the contact normal and preserved tangential
 * component, for all three body pairs."
 *
 * THE CRITERION HAS THREE CLAUSES AND EACH IS GRADED SEPARATELY. Elastic is the
 * conservation pair, momentum and kinetic energy, at `e = 1`. Correct transfer
 * along the normal is the impulse SPEC section 6.3 writes out, which is graded
 * BOTH in its general form, at masses that are not equal, and in the reduction
 * this game actually runs, where all three masses are 1 and the impulse becomes
 * an exchange of normal components. Preserved tangential is the third, and it
 * is the one a plausible wrong implementation fails: reflecting the whole
 * relative velocity rather than its normal part looks like a bounce and turns
 * every glancing contact into a head-on one.
 *
 * THE EXPECTED VELOCITIES ARE DERIVED FROM SPEC SECTION 6.3, NOT FROM THE CODE.
 * The oblique case uses a 3-4-5 offset so the contact normal is exactly
 * (0.6, 0.8), which makes every number below one a reader can check by hand,
 * and they are written out as literals rather than recomputed from the same
 * expression the module uses.
 *
 * TOLERANCES. The exchange cases along an axis are exact and are asserted with
 * `toBe`. The oblique cases are asserted to nine decimal places: a normal built
 * from a division and applied by two multiplications carries a handful of
 * rounding steps, which at these speeds is a few units in the last place of a
 * double, or about 1e-13 px/s. Nine places is that with three orders of
 * magnitude to spare and is still 1e-10 of a pixel per second.
 */

/** The three pairs, in SPEC section 6.3's fixed resolution order. */
const PAIRS: ReadonlyArray<readonly [BodyKind, BodyKind]> = [
  ['player', 'opponent'],
  ['player', 'ball'],
  ['opponent', 'ball'],
];

const RADIUS: Readonly<Record<BodyKind, number>> = {
  player: CIRCLE_RADIUS,
  opponent: CIRCLE_RADIUS,
  ball: BALL_RADIUS,
};

/** Somewhere no wall and no third body reaches, for a pair driven on its own. */
const PARKED_X = 1100;
const PARKED_Y = 550;

function speedOf(body: Body): number {
  return Math.hypot(body.velocity.x, body.velocity.y);
}

/** The contact normal SPEC section 6.3 defines, measured by the test itself. */
function normalBetween(a: Body, b: Body): Vec2 {
  const out = vec2();
  copy(out, b.position);
  subtract(out, a.position);
  normalise(out, 1, 0);
  return out;
}

/** A body that is not one of the three, for the general form of the impulse. */
function loose(kind: BodyKind, mass: number, at: readonly [number, number]): Body {
  return {
    kind,
    radius: RADIUS[kind],
    mass,
    position: vec2(at[0], at[1]),
    velocity: vec2(),
  };
}

describe('PF-3 the elastic impulse, item B4', () => {
  it('exchanges the normal component for every one of the three body pairs', () => {
    // Equal masses and e = 1, which SPEC section 6.1 and 6.3 together reduce to
    // an exchange: the mover stops dead and the struck body leaves at the
    // speed the mover arrived with. Placed exactly touching and on one line, so
    // the normal is exactly (1, 0) and the answer is exact.
    let checked = 0;
    for (const [first, second] of PAIRS) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const a = sim.world[first];
      const b = sim.world[second];
      set(a.position, 500, 360);
      set(b.position, 500 + a.radius + b.radius, 360);
      setVelocity(a, 400, 0);

      expect(resolvePair(a, b), `${first} against ${second}`).toBe(true);

      expect(a.velocity.x, `${first} after`).toBe(0);
      expect(a.velocity.y, `${first} after`).toBe(0);
      expect(b.velocity.x, `${second} after`).toBe(400);
      expect(b.velocity.y, `${second} after`).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it('preserves the tangential component through an oblique collision', () => {
    // The 3-4-5 case. The centres are 50 px apart on the offset (30, 40), so
    // the normal is exactly (0.6, 0.8) and the tangent is (-0.8, 0.6).
    //
    //   player  (400, 300)   normal  480   tangential  -140
    //   ball   (-200, -150)  normal -240   tangential    70
    //
    // Approaching by -720 along the normal, so the impulse is 720 and the two
    // normal components change places. The tangential components do not move,
    // which is what makes the pair below the whole of this assertion:
    //
    //   player  -240 * n + -140 * t = ( -32, -276)
    //   ball     480 * n +   70 * t = ( 232,  426)
    const sim = createSimulation({ onNonFinite: 'throw' });
    const player = sim.world.player;
    const ball = sim.world.ball;
    set(player.position, 600, 300);
    set(ball.position, 630, 340);
    setVelocity(player, 400, 300);
    setVelocity(ball, -200, -150);

    const normal = normalBetween(player, ball);
    expect(normal.x).toBe(0.6);
    expect(normal.y).toBe(0.8);
    const tangent = vec2(-normal.y, normal.x);
    const playerTangentialBefore = dot(player.velocity, tangent);
    const ballTangentialBefore = dot(ball.velocity, tangent);
    const playerNormalBefore = dot(player.velocity, normal);
    const ballNormalBefore = dot(ball.velocity, normal);
    expect(playerTangentialBefore).toBeCloseTo(-140, 9);
    expect(ballTangentialBefore).toBeCloseTo(70, 9);
    expect(playerNormalBefore).toBeCloseTo(480, 9);
    expect(ballNormalBefore).toBeCloseTo(-240, 9);

    resolvePair(player, ball);

    // The tangential halves are untouched, which is the clause.
    expect(dot(player.velocity, tangent)).toBeCloseTo(playerTangentialBefore, 9);
    expect(dot(ball.velocity, tangent)).toBeCloseTo(ballTangentialBefore, 9);
    // The normal halves changed places, which is the transfer.
    expect(dot(player.velocity, normal)).toBeCloseTo(ballNormalBefore, 9);
    expect(dot(ball.velocity, normal)).toBeCloseTo(playerNormalBefore, 9);
    // And the whole velocities, written out from the section rather than
    // recomputed from the expression the module evaluates.
    expect(player.velocity.x).toBeCloseTo(-32, 9);
    expect(player.velocity.y).toBeCloseTo(-276, 9);
    expect(ball.velocity.x).toBeCloseTo(232, 9);
    expect(ball.velocity.y).toBeCloseTo(426, 9);
  });

  it('applies the general impulse at masses that are not equal', () => {
    // Every body in this game weighs 1, so the division by `1 / ma + 1 / mb` is
    // invisible in play and a hard-coded halving would pass every other test in
    // this file. The general form is graded on a pair built for the purpose.
    //
    //   a  mass 1  at 500 px/s      b  mass 3  at -100 px/s      n = (1, 0)
    //   j = -(1 + 1) * (-600) / (1 / 1 + 1 / 3) = 1200 / (4 / 3) = 900
    //   a: 500 - 900 / 1 = -400        b: -100 + 900 / 3 = 200
    const a = loose('player', 1, [600, 360]);
    const b = loose('ball', 3, [652, 360]);
    set(a.velocity, 500, 0);
    set(b.velocity, -100, 0);

    expect(resolvePair(a, b)).toBe(true);

    expect(a.velocity.x).toBe(-400);
    expect(b.velocity.x).toBe(200);
    // Momentum and energy both hold at masses that differ, which is what says
    // the divisor is the reduced mass and not a convenient two.
    expect(a.mass * a.velocity.x + b.mass * b.velocity.x).toBe(200);
    expect(0.5 * a.mass * a.velocity.x ** 2 + 0.5 * b.mass * b.velocity.x ** 2).toBe(140000);
  });

  it('conserves momentum and kinetic energy, which is what e = 1 means', () => {
    // Elastic is a conservation statement rather than a coefficient, so both
    // conserved quantities are measured across a batch of contacts: head-on,
    // oblique, one body at rest, and a pair whose masses differ.
    expect(CIRCLE_RESTITUTION).toBe(1);

    interface Case {
      readonly label: string;
      readonly a: Body;
      readonly b: Body;
      readonly aVel: readonly [number, number];
      readonly bVel: readonly [number, number];
    }
    const cases: readonly Case[] = [
      {
        label: 'head-on, equal masses',
        a: loose('player', 1, [600, 360]),
        b: loose('opponent', 1, [666, 360]),
        aVel: [600, 0],
        bVel: [-450, 0],
      },
      {
        label: 'oblique, equal masses',
        a: loose('player', 1, [600, 300]),
        b: loose('ball', 1, [630, 340]),
        aVel: [400, 300],
        bVel: [-200, -150],
      },
      {
        label: 'one body at rest',
        a: loose('opponent', 1, [600, 360]),
        b: loose('ball', 1, [640, 380]),
        aVel: [317, -211],
        bVel: [0, 0],
      },
      {
        label: 'masses that differ',
        a: loose('player', 1, [600, 360]),
        b: loose('ball', 7, [630, 340]),
        aVel: [900, -120],
        bVel: [-80, 640],
      },
    ];

    for (const entry of cases) {
      set(entry.a.velocity, entry.aVel[0], entry.aVel[1]);
      set(entry.b.velocity, entry.bVel[0], entry.bVel[1]);
      const momentumBefore = vec2();
      addScaled(momentumBefore, entry.a.velocity, entry.a.mass);
      addScaled(momentumBefore, entry.b.velocity, entry.b.mass);
      const energyBefore =
        0.5 * entry.a.mass * speedOf(entry.a) ** 2 + 0.5 * entry.b.mass * speedOf(entry.b) ** 2;

      expect(resolvePair(entry.a, entry.b), entry.label).toBe(true);

      const momentumAfter = vec2();
      addScaled(momentumAfter, entry.a.velocity, entry.a.mass);
      addScaled(momentumAfter, entry.b.velocity, entry.b.mass);
      const energyAfter =
        0.5 * entry.a.mass * speedOf(entry.a) ** 2 + 0.5 * entry.b.mass * speedOf(entry.b) ** 2;

      // Relative rather than absolute: an energy near a million and a momentum
      // component near zero cannot share one absolute bound. A double carries
      // sixteen significant figures and the impulse spends about six of the
      // last of them, so 1e-12 is four orders of magnitude of headroom.
      const scale = Math.max(Math.abs(energyBefore), 1);
      expect(Math.abs(energyAfter - energyBefore) / scale, `${entry.label} energy`).toBeLessThan(
        1e-12,
      );
      const momentumScale = Math.max(Math.hypot(momentumBefore.x, momentumBefore.y), 1);
      expect(
        Math.hypot(momentumAfter.x - momentumBefore.x, momentumAfter.y - momentumBefore.y) /
          momentumScale,
        `${entry.label} momentum`,
      ).toBeLessThan(1e-12);
      // The contact did something, so the conservation above is not the
      // conservation of a pair that was never touched.
      expect(energyAfter, entry.label).toBeGreaterThan(0);
    }
    expect(cases).toHaveLength(4);
  });
});

describe('PF-3 the approach gate, item B4', () => {
  it('applies no impulse to an overlapping pair that is already separating', () => {
    // SPEC section 6.3: "If dot(vRel, n) >= 0 the bodies are already
    // separating: apply no impulse." The pair below overlaps by 12 px and is
    // moving apart at 300 px/s, so it is separated positionally and its
    // velocities are left exactly where they were.
    const sim = createSimulation({ onNonFinite: 'throw' });
    const player = sim.world.player;
    const ball = sim.world.ball;
    set(player.position, 600, 360);
    set(ball.position, 640, 360);
    setVelocity(player, -100, 0);
    setVelocity(ball, 200, 0);

    expect(resolvePair(player, ball)).toBe(true);

    expect(player.velocity.x).toBe(-100);
    expect(ball.velocity.x).toBe(200);
    expect(player.velocity.y).toBe(0);
    expect(ball.velocity.y).toBe(0);
    // Separated all the same: the gate governs the impulse and nothing else.
    expect(player.position.x).toBe(594);
    expect(ball.position.x).toBe(646);
  });

  it('does apply one to the same pair when it is approaching', () => {
    // The other direction, so the assertion above is not passed by a resolver
    // that has stopped applying impulses at all.
    const sim = createSimulation({ onNonFinite: 'throw' });
    const player = sim.world.player;
    const ball = sim.world.ball;
    set(player.position, 600, 360);
    set(ball.position, 640, 360);
    setVelocity(player, 100, 0);
    setVelocity(ball, -200, 0);

    resolvePair(player, ball);

    expect(player.velocity.x).toBe(-200);
    expect(ball.velocity.x).toBe(100);
  });

  it('leaves a pair that is not touching entirely alone, on either axis', () => {
    // Apart along x, apart along y, and apart along both. The three readings
    // are not one reading: a touching test that measured a single axis would
    // let two bodies a hundred pixels apart in y collide because they happen to
    // share a column, which on the felt is a ball rebounding off nothing.
    const cases: ReadonlyArray<readonly [string, number, number]> = [
      ['apart along x', 100, 0],
      ['apart along y', 0, 100],
      ['apart along both', 90, 90],
    ];
    for (const [label, dx, dy] of cases) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const player = sim.world.player;
      const ball = sim.world.ball;
      set(player.position, 400, 300);
      set(ball.position, 400 + dx, 300 + dy);
      setVelocity(player, 700, 500);
      setVelocity(ball, -700, -500);

      expect(resolvePair(player, ball), label).toBe(false);

      expect(player.position.x, label).toBe(400);
      expect(player.position.y, label).toBe(300);
      expect(ball.position.x, label).toBe(400 + dx);
      expect(ball.position.y, label).toBe(300 + dy);
      expect(player.velocity.x, label).toBe(700);
      expect(ball.velocity.y, label).toBe(-500);
    }
    expect(cases).toHaveLength(3);
  });

  it('detects the ungated resolver, which locks a pair together instead', () => {
    // THE NEGATIVE CONTROL THE TRAP NAMES. Without the gate, the second of the
    // four passes SPEC section 6.3 requires sees a pair that is now separating
    // and reverses it again, the third reverses it back, and the fourth
    // reverses it once more. Four passes of an ungated resolver therefore leave
    // a head-on pair exactly as it arrived, still driving into each other,
    // which on the felt is two circles stuck together and buzzing.
    const ungated = (a: Body, b: Body): void => {
      const normal = normalBetween(a, b);
      const relative = vec2();
      copy(relative, b.velocity);
      subtract(relative, a.velocity);
      const impulse = -(1 + CIRCLE_RESTITUTION) * dot(relative, normal) / (1 / a.mass + 1 / b.mass);
      addScaled(a.velocity, normal, -(impulse / a.mass));
      addScaled(b.velocity, normal, impulse / b.mass);
    };

    const locked = createSimulation({ onNonFinite: 'throw' });
    set(locked.world.player.position, 500, 360);
    set(locked.world.ball.position, 552, 360);
    setVelocity(locked.world.player, 400, 0);
    for (let pass = 0; pass < 4; pass += 1) {
      ungated(locked.world.player, locked.world.ball);
    }
    expect(locked.world.player.velocity.x).toBe(400);
    expect(locked.world.ball.velocity.x).toBe(0);

    // The shipping resolver over the same four passes: the pair bounces once
    // and the three passes after it find nothing left to do.
    const bounced = createSimulation({ onNonFinite: 'throw' });
    set(bounced.world.player.position, 500, 360);
    set(bounced.world.ball.position, 552, 360);
    setVelocity(bounced.world.player, 400, 0);
    for (let pass = 0; pass < 4; pass += 1) {
      resolvePair(bounced.world.player, bounced.world.ball);
    }
    expect(bounced.world.player.velocity.x).toBe(0);
    expect(bounced.world.ball.velocity.x).toBe(400);
  });
});

describe('PF-3 the shipping step resolves contacts, item B4', () => {
  it('collides each of the three pairs through a whole fixed step', () => {
    // The same exchange as the first case in this file, driven through
    // `step()` rather than through `resolvePair` directly, so that DESIGN
    // section 3's position 2 is graded as being wired in rather than as
    // existing. Damping runs after the transfer, so the struck body carries one
    // step of decay and the mover, left at exactly zero, is zeroed by the stop
    // threshold rather than left carrying a rounding.
    const decay = DAMPING ** FIXED_STEP;
    let checked = 0;
    for (const [first, second] of PAIRS) {
      const sim = createSimulation({ onNonFinite: 'throw' });
      const a = sim.world[first];
      const b = sim.world[second];
      const spare = sim.world.bodies.find((body) => body !== a && body !== b);
      expect(spare).toBeDefined();
      if (spare === undefined) {
        return;
      }
      set(spare.position, PARKED_X, PARKED_Y);
      set(a.position, 500, 360);
      set(b.position, 500 + a.radius + b.radius, 360);
      setVelocity(a, 400, 0);

      sim.step();

      expect(a.velocity.x, `${first} after a step`).toBe(0);
      expect(a.velocity.y, `${first} after a step`).toBe(0);
      expect(b.velocity.x, `${second} after a step`).toBeCloseTo(400 * decay, 9);
      expect(b.velocity.y, `${second} after a step`).toBe(0);
      // The spare body took no part, so the exchange above was this pair's.
      expect(spare.velocity.x, `${spare.kind} untouched`).toBe(0);
      expect(spare.velocity.y, `${spare.kind} untouched`).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it('holds the global speed cap after an elastic transfer', () => {
    // ENGINEERING ARMOUR, NOT A GRADE. Item B10 is a PF-2 item and closed at
    // PF-2, by injecting a velocity larger than any transfer can produce. No
    // sheet item re-grades the cap here and item B4's criterion says nothing
    // about it. What this adds is the case PF-2 could not run: a real transfer,
    // between the two applications of the cap, which is the only thing in the
    // step that can raise a speed after integration.
    //
    // AND THE CASE IS REACHABLE IN PLAY, not only from an injected velocity.
    // SPEC section 6.1 caps a launch at 900 px/s, and two bodies arriving at
    // that ceiling at right angles exchange normal components into 900 along
    // one axis and 900 along the other: 900 * sqrt(2) is 1272.79 px/s, which is
    // over the 1200 px/s cap on its own. The reading below drives the same
    // exchange at the cap instead, because that is the worst case the
    // integrator can present, but the second application of the cap is not
    // decoration on a state only a test can build.
    //
    // The player arrives along x at the cap and the ball along y at the cap.
    // The normal is (1, 0), so the exchange hands the ball the player's whole
    // 1200 px/s of normal component on top of the 1200 px/s of tangential it
    // already had: 1697 px/s, which one step of damping leaves at 1681 px/s.
    const sim = createSimulation({ onNonFinite: 'throw' });
    set(sim.world.opponent.position, PARKED_X, PARKED_Y);
    set(sim.world.player.position, 600, 360);
    set(sim.world.ball.position, 660, 350);
    setVelocity(sim.world.player, SPEED_CAP, 0);
    setVelocity(sim.world.ball, 0, SPEED_CAP);

    const uncapped = SPEED_CAP * Math.SQRT2 * DAMPING ** FIXED_STEP;
    expect(uncapped).toBeGreaterThan(SPEED_CAP);
    expect(Math.round(uncapped)).toBe(1681);
    // The in-play bound, written out: the launch ceiling alone clears the cap.
    expect(Math.round(MAX_LAUNCH_SPEED * Math.SQRT2 * 100) / 100).toBe(1272.79);
    expect(MAX_LAUNCH_SPEED * Math.SQRT2).toBeGreaterThan(SPEED_CAP);

    sim.step();

    const ball = sim.world.ball;
    // The transfer happened: the ball is carrying the player's component now.
    expect(ball.velocity.x).toBeGreaterThan(0);
    expect(sim.world.player.velocity.x).toBe(0);
    // And it left the step at the cap rather than at 1681 px/s.
    expect(speedOf(ball)).toBeCloseTo(SPEED_CAP, 9);
    // `limit` scales both components by ceiling over measured, and the hypot of
    // the scaled pair can land one unit in the last place above the ceiling.
    // 2e-13 px/s is 1.7e-15 px over a whole step.
    expect(speedOf(ball)).toBeLessThanOrEqual(SPEED_CAP + 1e-9);
    expect(ball.velocity.x).toBeCloseTo(ball.velocity.y, 9);
  });
});
