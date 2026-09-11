import { describe, expect, it } from 'vitest';

import {
  ACE,
  CASUAL,
  MIN_STRIKE_SOLIDITY,
  OPPONENT_STREAM,
  PRO,
  chooseStrikeSide,
  planShot,
  respond,
} from '../../src/core/ai'; // the opponent routine
import type { OpponentProfile } from '../../src/core/ai'; // the opponent's profile shape // the opponent routine
import { createWorld, everyBodyStopped, launch } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
  DAMPING,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_LOW,
  LEFT_GOAL_LINE,
  RIGHT_GOAL_LINE,
  STOP_SPEED,
  launchSpeed,
} from '../../src/core/config';
import { createMatch } from '../../src/core/match';
import { createSimulation } from '../../src/core/physics';
import { createRng } from '../../src/core/rng';
import type { Rng } from '../../src/core/rng';
import { distance, set } from '../../src/core/vec2';
import type { Vec2 } from '../../src/core/vec2';
import {
  TOUCHING as REFERENCE_TOUCHING,
  aimAngleFor,
  aimPointFor,
  clampToCone,
  coneBound,
  departureAt,
  firstContact,
  solidityOf,
} from './reference/strike-geometry';

/**
 * Item D3, Critical: "The opponent's aim clamps the strike side into the
 * reachable cone with the stated minimum solidity. A playfield sweep confirms
 * every chosen direction reaches the ball with meaningful speed transfer, and
 * a soak confirms the own-goal rate is bounded and near zero."
 *
 * EVERY EXPECTED SIDE, ANGLE AND DEPARTURE COMES FROM THE REFERENCE, which is
 * `reference/strike-geometry.ts`, written from SPEC sections 4, 6.1, 6.3 and
 * 8.1 alone and importing nothing from `src/`. A test that recomputes the
 * routine's own formula grades the code against itself: the aim-point case
 * below used to do exactly that, which is how an aim 34 px short of the
 * distance section 8.1 fixes survived every gate, measured 2026-09-08.
 *
 * EACH CLAUSE HAS ITS OWN READING HERE. "Clamps the strike side into the
 * reachable cone with the stated minimum solidity" is the analytic half:
 * layouts whose ideal side is inadmissible are clamped to the closest
 * admissible side, and the floor is pinned against the literal 0.25 the
 * section states, never against the symbol beside it. "Every chosen direction
 * reaches the ball with meaningful speed transfer" is the sweep: the playfield
 * grid, launched through `planShot` itself, the real physics forward, the ball
 * struck in every layout, the departure held to the reference's own direction
 * and the transfer graded against the section's 0.25. "Bounded and near zero"
 * is the soak: a thousand seeded turns across the three difficulties, counted
 * by the scoreboard's own mouth.
 *
 * THE SWEEP SWEEPS WHAT THE ROUTINE ACTUALLY DOES. There is no geometric
 * decline to sweep around any more: SPEC section 8 makes the block the
 * profile's own probability and section 8.1 answers the striker-in-the-way
 * layouts with the clamp, so every layout on the grid is struck and the soak
 * measures what the hardest of them concede.
 */

const TOUCHING = CIRCLE_RADIUS + BALL_RADIUS;
const MOUTH_CENTRE_Y = (GOAL_OPENING_LOW + GOAL_OPENING_HIGH) / 2;
const TARGET = { x: LEFT_GOAL_LINE, y: MOUTH_CENTRE_Y };

/** The body nobody is playing is parked in the corner, out of every shot line. */
const PARKED = { x: FIELD_LEFT + CIRCLE_RADIUS, y: FIELD_BOTTOM + CIRCLE_RADIUS };

const STEP_BUDGET = 5000;

/** SPEC section 6.1's damping as pixels of speed lost per pixel travelled. */
const DECAY = -Math.log(DAMPING);

/**
 * The fixed step's own cost, and why the measured transfer is graded with a
 * tolerance at all. A centre advances at most SPEED_CAP / 120 = 10 px per
 * step, so first contact is detected up to 10 px past the touching point and
 * the normal is read at the overlapped centres. Displacing the contact by d
 * along the path takes a transfer t to (52 t - d) / sqrt(2704 - 104 d t +
 * d^2), which falls with d over the whole range, so the worst the step can do
 * to a side sitting on the 0.25 floor is at the full 10 px: (13 - 10) /
 * sqrt(2544) = 0.059479. THE TOLERANCE IS THAT DISPLACEMENT, 0.25 - 0.059479
 * = 0.190521, ROUNDED UP so the assertion is implied by the analysis rather
 * than a hair tighter than it: at 0.19 the floor would be 0.06 and the
 * analytic worst case would fail it. Nothing here is fitted to a run, and the
 * measured minimum over the grid, 0.149243, is pinned separately at six
 * places, which is where a drift in either direction shows.
 */
const DISCRETISATION = 0.2;

/** A world with the striker and the ball placed, the third body parked. */
function layoutAt(opponent: Vec2, ball: Vec2): ReturnType<typeof createSimulation> {
  const world = createWorld();
  set(world.opponent.position, opponent.x, opponent.y);
  set(world.ball.position, ball.x, ball.y);
  set(world.player.position, PARKED.x, PARKED.y);
  return createSimulation({ world });
}

/** The launch the REFERENCE clamp produces for a layout: its aim angle. */
function referenceAngle(opponent: Vec2, ball: Vec2): number {
  return aimAngleFor(
    opponent,
    ball,
    clampToCone(opponent, ball, TARGET, MIN_STRIKE_SOLIDITY),
  );
}

/** What one driven launch produced: the ball's peak, its first direction, the arrival. */
interface Strike {
  /** The ball's highest speed over the run. */
  readonly peak: number;
  /** The unit direction of the ball's velocity at the first step it moves. */
  readonly departure: Vec2 | undefined;
  /** The striker's speed at the step before the ball moved. */
  readonly arrival: number;
  readonly steps: number;
}

/** The launch driven and tracked to rest; the ball's peak speed is the verdict. */
function strikeAndTrack(
  sim: ReturnType<typeof createSimulation>,
  angle: number,
  power: number,
): Strike {
  launch(sim.world.opponent, angle, launchSpeed(power));
  const strikerSpeed = (): number =>
    Math.hypot(sim.world.opponent.velocity.x, sim.world.opponent.velocity.y);
  let peak = 0;
  let steps = 0;
  let arrival = 0;
  let before = strikerSpeed();
  let departure: Vec2 | undefined = undefined;
  for (; steps < STEP_BUDGET; steps += 1) {
    const velocity = sim.world.ball.velocity;
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > 0 && departure === undefined) {
      departure = { x: velocity.x / speed, y: velocity.y / speed };
      arrival = before;
    }
    peak = Math.max(peak, speed);
    if (everyBodyStopped(sim.world) || sim.scoring.frozen()) break;
    before = strikerSpeed();
    sim.step();
  }
  return { peak, departure, arrival, steps };
}

/** The angle between two unit vectors, in degrees, for a departure reading. */
function degreesBetween(one: Vec2, other: Vec2): number {
  const cosine = one.x * other.x + one.y * other.y;
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

/** Zero-error, zero-whiff, always-full-power: the clamp and nothing else. */
const CLAMP_ONLY: OpponentProfile = {
  angularErrorDeg: 0,
  powerBand: [1, 1],
  useWallShots: false,
  candidateCount: 1,
  whiffChance: 0,
  aggression: 0,
  defensiveBias: 0,
};

interface SweepLayout {
  readonly opponent: Vec2;
  readonly ball: Vec2;
}

const SWEEP_BALLS: readonly Vec2[] = [
  { x: 400, y: 250 },
  { x: 640, y: 360 },
  { x: 880, y: 470 },
  { x: 520, y: 500 },
];

/**
 * The playfield grid. Layouts the parked body would intrude on are excluded
 * by the same clearance the sweep demands of the launch, and the counts are
 * pinned below so a quiet exclusion cannot shrink the sweep. THE LEG IS THE
 * REFERENCE'S LEG: the launch runs to the touching point of the chosen side,
 * 52 px along it, so the exclusion is measured against the path the sweep
 * actually drives rather than against a shorter one.
 */
function sweepLayouts(): { all: SweepLayout[]; excluded: number } {
  const all: SweepLayout[] = [];
  let excluded = 0;
  for (const ox of [160, 320, 480, 640, 800, 960, 1120]) {
    for (const oy of [140, 290, 440, 590]) {
      for (const ball of SWEEP_BALLS) {
        const opponent = { x: ox, y: oy };
        const gap = distance(opponent, ball);
        if (!(gap > TOUCHING + 18 && gap < 620)) continue;
        if (distance(PARKED, opponent) < 100) {
          excluded += 1;
          continue;
        }
        const contact = aimPointFor(
          ball,
          clampToCone(opponent, ball, TARGET, MIN_STRIKE_SOLIDITY),
        );
        const legX = contact.x - opponent.x;
        const legY = contact.y - opponent.y;
        const legLength = Math.hypot(legX, legY);
        const at = Math.min(
          Math.max(((PARKED.x - opponent.x) * legX + (PARKED.y - opponent.y) * legY) / (legLength * legLength), 0),
          1,
        );
        const nearestX = opponent.x + legX * at;
        const nearestY = opponent.y + legY * at;
        if (Math.hypot(nearestX - PARKED.x, nearestY - PARKED.y) < CIRCLE_RADIUS * 2 + 6) {
          excluded += 1;
          continue;
        }
        all.push({ opponent, ball });
      }
    }
  }
  return { all, excluded };
}

describe('PF-8 the reachable cone, item D3', () => {
  it('keeps the ideal strike side when the striker arrives from outside it', () => {
    // The striker sits on the target's far side of the ball, which is the
    // only place the far-side contact point can be struck from; the ideal
    // side passes the reachable test and the clamp must leave it alone. Dead
    // centre on the side's own axis, so the transfer is exactly 1.
    const striker = { x: 900, y: 360 };
    const ball = { x: 640, y: 360 };
    const choice = chooseStrikeSide(striker, ball, TARGET);
    const reference = clampToCone(striker, ball, TARGET, MIN_STRIKE_SOLIDITY);
    expect(choice.clamped).toBe(false);
    expect(reference.clamped).toBe(false);
    expect(choice.x).toBeCloseTo(reference.x, 12);
    expect(choice.y).toBeCloseTo(reference.y, 12);
    expect(choice.x).toBeCloseTo(1, 12); // the far side, straight down the pitch
    expect(choice.solidity).toBeCloseTo(1, 12);
  });

  it('clamps to the closest admissible side when the striker stands between ball and goal', () => {
    // THE layout the section exists for: the striker square on the lane
    // between the ball and the goal it attacks. The ideal side fails the
    // reachable test outright, the clamp fires, and the chosen side sits on
    // the cone boundary - the bound from the approach, on the ideal's own
    // perpendicular, which is the closest admissible point to the ideal.
    const striker = { x: 400, y: 360 };
    const ball = { x: 640, y: 360 };
    const gap = distance(striker, ball);
    expect(gap).toBe(240);
    const choice = chooseStrikeSide(striker, ball, TARGET);
    const reference = clampToCone(striker, ball, TARGET, MIN_STRIKE_SOLIDITY);
    const idealX = (ball.x - TARGET.x) / distance(ball, TARGET);
    const idealY = (ball.y - TARGET.y) / distance(ball, TARGET);
    const offsetX = striker.x - ball.x;
    const offsetY = striker.y - ball.y;
    // Not even reachable: the offset projected on the ideal side is negative,
    // where SPEC section 8.1 wants it past the touching distance in pixels.
    expect(offsetX * idealX + offsetY * idealY).toBe(-240);
    expect(choice.clamped).toBe(true);
    expect(choice.x).toBeCloseTo(reference.x, 12);
    expect(choice.y).toBeCloseTo(reference.y, 12);
    // The cone boundary at this gap, by literal: 48.75 + 0.25 * sqrt(240^2 -
    // 2535), over 240. The transfer there is the section's own floor.
    const approachX = offsetX / gap;
    const approachY = offsetY / gap;
    expect(approachX * choice.x + approachY * choice.y).toBeCloseTo(0.4475617995, 9);
    expect(coneBound(240, 0.25)).toBeCloseTo(0.4475617995, 9);
    expect(choice.solidity).toBeCloseTo(0.25, 9);
    // The tie-break: square behind the ball, the ideal has no perpendicular
    // component and either wall of the cone is equally close.
    const along = approachX * idealX + approachY * idealY;
    expect(Math.hypot(idealX - approachX * along, idealY - approachY * along)).toBeLessThan(
      1e-6,
    );
    // and the strike the chosen side produces lands on the ball and leaves it
    // along minus that side, which is what the clamp promised.
    const sim = layoutAt(striker, ball);
    const { peak, departure } = strikeAndTrack(sim, referenceAngle(striker, ball), 1);
    expect(peak).toBeGreaterThan(STOP_SPEED);
    expect(departure).toBeDefined();
    if (departure !== undefined) {
      expect(degreesBetween(departure, { x: -reference.x, y: -reference.y })).toBeLessThan(
        7,
      );
    }
  });

  it('holds the clamped side at exactly the 0.25 solidity floor when the striker is far away', () => {
    // Far from the ball the cone boundary falls toward the floor itself: at
    // 600 px the bound is 0.3304 against 0.4476 at 240, and the transfer of
    // the chosen side is the section's literal 0.25 at both. The reachability
    // cosine, 52 / 600, is far below either, which is why one bound carries
    // both rules.
    const striker = { x: 500, y: 360 };
    const ball = { x: 1100, y: 360 };
    const gap = distance(striker, ball);
    expect(gap).toBe(600);
    const choice = chooseStrikeSide(striker, ball, TARGET);
    const reference = clampToCone(striker, ball, TARGET, MIN_STRIKE_SOLIDITY);
    expect(TOUCHING / gap).toBeCloseTo(0.0866666666, 9);
    expect(choice.clamped).toBe(true);
    expect(choice.x).toBeCloseTo(reference.x, 12);
    expect(choice.y).toBeCloseTo(reference.y, 12);
    const approachX = (striker.x - ball.x) / gap;
    const approachY = (striker.y - ball.y) / gap;
    expect(approachX * choice.x + approachY * choice.y).toBeCloseTo(0.3303682367, 9);
    expect(coneBound(600, 0.25)).toBeCloseTo(0.3303682367, 9);
    expect(choice.solidity).toBeCloseTo(0.25, 9);
    expect(MIN_STRIKE_SOLIDITY).toBe(0.25);
  });

  it('clamps a reachable ideal whose transfer would still be a graze', () => {
    // THE READING THE FLOOR IS GIVEN HERE, by literal coordinates. The offset
    // projects 60 px onto the ideal side, past the 52 px SPEC section 8.1
    // calls reachable, so the bare reachability test admits it; the launch it
    // would produce transfers 8 / sqrt(240.13^2) = 0.0333 of the arrival
    // speed, which is the graze the same section's floor exists to refuse and
    // which item D3's "every chosen direction" covers. So it is clamped like
    // an unreachable one, and the alternative reading - the floor on the
    // fallback alone - would leave this launch at 0.0333.
    const striker = { x: 700, y: 120 };
    const ball = { x: 640, y: 360 };
    const idealX = (ball.x - TARGET.x) / distance(ball, TARGET);
    const idealY = (ball.y - TARGET.y) / distance(ball, TARGET);
    const reach = (striker.x - ball.x) * idealX + (striker.y - ball.y) * idealY;
    expect(reach).toBe(60);
    expect(reach).toBeGreaterThan(TOUCHING);
    expect(solidityOf(striker, ball, { x: idealX, y: idealY })).toBeCloseTo(0.0333148, 7);
    const choice = chooseStrikeSide(striker, ball, TARGET);
    const reference = clampToCone(striker, ball, TARGET, MIN_STRIKE_SOLIDITY);
    expect(choice.clamped).toBe(true);
    expect(choice.x).toBeCloseTo(reference.x, 12);
    expect(choice.y).toBeCloseTo(reference.y, 12);
    expect(choice.solidity).toBeCloseTo(0.25, 9);
  });

  it('pushes straight out when the striker is already inside the contact distance', () => {
    // Overlapping bodies have no reachable side at all; the straight-out
    // push is the only strike that cannot play the ball backward.
    const striker = { x: 630, y: 360 };
    const ball = { x: 640, y: 360 };
    const choice = chooseStrikeSide(striker, ball, TARGET);
    expect(choice.clamped).toBe(true);
    expect(choice.solidity).toBe(1);
    const approachX = (striker.x - ball.x) / distance(striker, ball);
    const approachY = (striker.y - ball.y) / distance(striker, ball);
    expect(choice.x).toBeCloseTo(approachX, 9);
    expect(choice.y).toBeCloseTo(approachY, 9);
  });

  it('answers a target on the ball and a coordinate that is not a number with a finite side', () => {
    // The three normalisations the routine makes are total. A target
    // coincident with the ball has no ideal direction; a coordinate that is
    // not a number has no approach; either would otherwise put NaN into a
    // launch angle, where the finiteness policy repairs it into a skipped
    // turn nobody can see.
    //
    // THE STATED FALLBACK IS READ BY COORDINATES, NOT BY FINITENESS. When the
    // ideal has no direction the routine strikes along the APPROACH, which
    // sends the ball away from the striker rather than back through it, and a
    // layout square above the ball approaches along (0, 1): a fallback that
    // was reversed, or fixed at the (1, 0) SPEC section 6.3 names for a
    // coincident normal, gives a different answer here. Asserting only that
    // the side is finite and unit leaves the choice ungated, which is what a
    // striker on the goal's own lane would pay for.
    const ball = { x: 640, y: 360 };
    const above = { x: 640, y: 600 };
    const onTheBall = chooseStrikeSide(above, ball, ball);
    expect(Number.isFinite(onTheBall.x)).toBe(true);
    expect(Number.isFinite(onTheBall.y)).toBe(true);
    expect(Math.hypot(onTheBall.x, onTheBall.y)).toBeCloseTo(1, 12);
    expect(onTheBall.x).toBeCloseTo(0, 12);
    expect(onTheBall.y).toBeCloseTo(1, 12);
    expect(onTheBall.clamped).toBe(false);
    expect(onTheBall.solidity).toBeGreaterThanOrEqual(0.25);
    // and a target no arithmetic can point at leaves by the same door with
    // the same side, which is the other way an ideal goes missing.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const unpointable = chooseStrikeSide(above, ball, { x: bad, y: bad });
      expect(Math.hypot(unpointable.x, unpointable.y), String(bad)).toBeCloseTo(1, 12);
      expect(unpointable.x, String(bad)).toBeCloseTo(0, 12);
      expect(unpointable.y, String(bad)).toBeCloseTo(1, 12);
      expect(unpointable.solidity, String(bad)).toBeGreaterThanOrEqual(0.25);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const striker of [{ x: bad, y: 360 }, { x: 900, y: bad }]) {
        const choice = chooseStrikeSide(striker, ball, TARGET);
        expect(Number.isFinite(choice.x), String(bad)).toBe(true);
        expect(Number.isFinite(choice.y), String(bad)).toBe(true);
        expect(Math.hypot(choice.x, choice.y)).toBeCloseTo(1, 12);
        expect(choice.solidity).toBeGreaterThanOrEqual(0.25);
      }
      const coincident = chooseStrikeSide(ball, ball, { x: bad, y: bad });
      expect(Math.hypot(coincident.x, coincident.y)).toBeCloseTo(1, 12);
      expect(coincident.solidity).toBeGreaterThanOrEqual(0.25);
    }
    // and a gap past the point where the cone arithmetic can be computed at
    // all, which is 1.3e154 px against a pitch that holds 1160.31: the same
    // straight-out answer rather than a side of infinite length.
    const absurd = chooseStrikeSide({ x: 1e300, y: 1e300 }, ball, TARGET);
    expect(Math.hypot(absurd.x, absurd.y)).toBeCloseTo(1, 12);
    expect(absurd.solidity).toBeGreaterThanOrEqual(0.25);
  });

  it('holds the floor within a hair of the touching distance, on both branches', () => {
    // THE BAND THE GRID CANNOT REACH. `collisions.ts` separates a contacting
    // pair to exactly the touching distance, so a ball resting against the
    // striker arrives here at a gap of 52 plus a few units in the last place,
    // where the transfer is 0/0 and a formula written as a difference of two
    // large quantities loses every digit of it. The sweep's own layouts start
    // at 72.111, so nothing else in this file visits the band. Both branches
    // are walked: an ideal square behind the ball, which clamps, and one
    // along the approach, which is dead centre and does not.
    const ball = { x: 640, y: 360 };
    let worstClamped = 1;
    let worstFree = 1;
    let clampedSeen = 0;
    let freeSeen = 0;
    for (let step = 0; step < 4000; step += 1) {
      const gap = 52 + (step / 4000) * 4e-6;
      const behind = chooseStrikeSide({ x: ball.x - gap, y: ball.y }, ball, TARGET);
      const beyond = chooseStrikeSide({ x: ball.x + gap, y: ball.y }, ball, TARGET);
      for (const choice of [behind, beyond]) {
        expect(Math.hypot(choice.x, choice.y)).toBeCloseTo(1, 9);
        if (choice.clamped) {
          clampedSeen += 1;
          worstClamped = Math.min(worstClamped, choice.solidity);
        } else {
          freeSeen += 1;
          worstFree = Math.min(worstFree, choice.solidity);
        }
        expect(choice.solidity, String(gap)).toBeGreaterThanOrEqual(0.25);
      }
    }
    // Both branches must actually be exercised, or the assertion above is a
    // statement about one of them.
    expect(clampedSeen).toBeGreaterThan(1000);
    expect(freeSeen).toBeGreaterThan(1000);
    expect(worstClamped).toBe(0.25);
    expect(worstFree).toBe(1);
  });

  it('aims the launch at the touching point of the chosen side, with no safety margin', () => {
    // THE EXPECTED ANGLE COMES FROM THE REFERENCE, not from a restatement of
    // the routine's own formula: three layouts, one of them clamped, and the
    // aim is the point where the striker's centre stands at contact. A margin
    // past the touching distance is the prior build's 69.4 percent whiff, and
    // an aim short of it is the 20 to 25 degrees of departure error the sweep
    // below measures.
    const ball = { x: 640, y: 360 };
    const cases: readonly [Vec2, boolean][] = [
      [{ x: 900, y: 300 }, false],
      [{ x: 1120, y: 590 }, false],
      [{ x: 400, y: 360 }, true],
    ];
    for (const [striker, clamped] of cases) {
      const world = createWorld();
      set(world.opponent.position, striker.x, striker.y);
      set(world.ball.position, ball.x, ball.y);
      const plan = planShot(
        world,
        { ...CASUAL, angularErrorDeg: 0, whiffChance: 0 },
        createRng('aim').split(OPPONENT_STREAM),
      );
      expect(plan.clamped, JSON.stringify(striker)).toBe(clamped);
      expect(plan.angle, JSON.stringify(striker)).toBeCloseTo(
        referenceAngle(striker, ball),
        9,
      );
      // and that aim point is where the centre path first meets the contact
      // disc, which is the property section 8.1's reachable test is derived
      // from and the property the ball's own surface point does not have.
      const reference = clampToCone(striker, ball, TARGET, MIN_STRIKE_SOLIDITY);
      const aim = aimPointFor(ball, reference);
      const contact = firstContact(striker, ball, aim);
      expect(contact).toBeDefined();
      expect(Math.hypot((contact?.x ?? 0) - aim.x, (contact?.y ?? 0) - aim.y)).toBeLessThan(
        1e-9,
      );
      expect(distance(aim, ball)).toBeCloseTo(TOUCHING, 12);
      expect(TOUCHING).toBe(52);
      expect(REFERENCE_TOUCHING).toBe(TOUCHING);
      expect(BALL_RADIUS).toBe(18);
    }
  });
});

describe('PF-8 the playfield sweep, item D3', () => {
  const { all, excluded } = sweepLayouts();

  it('reaches the ball with meaningful speed transfer on every chosen strike direction', () => {
    // THE SWEEP, THROUGH planShot ITSELF. Every layout, the real physics
    // forward, the ball struck, and the reached count pinned against the
    // layout count because a sweep that never reaches the ball reports no own
    // goals and has tested nothing.
    //
    // THREE READINGS OF "MEANINGFUL SPEED TRANSFER", and the first is the
    // section's own number. The reference's transfer for each chosen side is
    // at or above the literal 0.25 exactly; the transfer MEASURED on the
    // physics, the ball's peak over the striker's speed at the step before
    // contact, is at or above 0.25 less the fixed step's ANALYTIC worst case,
    // with the measured minimum pinned separately below; and the
    // absolute peak is pinned beside what the reference predicts for it,
    // which is the transfer times the arrival speed the damping leaves after
    // the leg. PF-8 read this clause as "the peak clears 150 px/s", which was
    // a reading of the aim it shipped rather than of the section.
    expect(all.length).toBe(96);
    expect(excluded).toBe(3);
    let reached = 0;
    let strikes = 0;
    let minimumPeak = Infinity;
    let minimumPredicted = Infinity;
    let minimumTransfer = Infinity;
    for (const layout of all) {
      const sim = layoutAt(layout.opponent, layout.ball);
      const plan = planShot(sim.world, CLAMP_ONLY, createRng('sweep').split(OPPONENT_STREAM));
      if (plan.defensive) continue;
      strikes += 1;
      const reference = clampToCone(
        layout.opponent,
        layout.ball,
        TARGET,
        MIN_STRIKE_SOLIDITY,
      );
      const { peak, arrival } = strikeAndTrack(sim, plan.angle, plan.power);
      if (peak > STOP_SPEED) reached += 1;
      minimumPeak = Math.min(minimumPeak, peak);
      const leg = distance(layout.opponent, aimPointFor(layout.ball, reference));
      minimumPredicted = Math.min(
        minimumPredicted,
        reference.solidity * (launchSpeed(1) - DECAY * leg),
      );
      expect(arrival, JSON.stringify(layout)).toBeGreaterThan(0);
      minimumTransfer = Math.min(minimumTransfer, peak / arrival);
      expect(reference.solidity, JSON.stringify(layout)).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(peak / arrival, JSON.stringify(layout)).toBeGreaterThanOrEqual(
        0.25 - DISCRETISATION,
      );
      expect(sim.readout().repairs).toBe(0);
    }
    expect(strikes).toBe(96);
    expect(reached).toBe(all.length);
    // Pinned exactly, so a drift in either direction shows: the measured
    // envelope of the discretisation cost, and the slowest strike on the grid
    // against the reference's prediction for that same layout.
    expect(minimumTransfer).toBeCloseTo(0.149243, 6);
    expect(minimumPeak).toBeCloseTo(61.0106, 4);
    expect(minimumPredicted).toBeCloseTo(61.7593, 4);
    expect(minimumPeak / minimumPredicted).toBeGreaterThan(0.98);
  });

  it('leaves the ball along minus the chosen side on every layout of the grid', () => {
    // THE PROPERTY SECTION 8.1 STATES AND THE OLD GATE COULD NOT SEE: "the
    // ball departs along -side". Measured as the ball's velocity at the first
    // step it moves, against the REFERENCE clamp's side, over the whole grid,
    // and against the direction to the target goal on the unclamped subset,
    // where the ideal side is the chosen one and the departure is the shot.
    // The bounds are literals: the fixed step's overshoot puts the measured
    // departure a few degrees off the geometric one, and further at the
    // glancing end, which is what the 7 allows for. The aim at the ball's own
    // surface measured 24.6 degrees of mean error against these same layouts.
    expect(all.length).toBe(96);
    let free = 0;
    let clamped = 0;
    let worstSide = 0;
    let worstTarget = 0;
    for (const layout of all) {
      const reference = clampToCone(
        layout.opponent,
        layout.ball,
        TARGET,
        MIN_STRIKE_SOLIDITY,
      );
      if (reference.clamped) clamped += 1;
      else free += 1;
      const sim = layoutAt(layout.opponent, layout.ball);
      const plan = planShot(sim.world, CLAMP_ONLY, createRng('sweep').split(OPPONENT_STREAM));
      const { departure } = strikeAndTrack(sim, plan.angle, plan.power);
      expect(departure, JSON.stringify(layout)).toBeDefined();
      if (departure === undefined) continue;
      const offSide = degreesBetween(departure, { x: -reference.x, y: -reference.y });
      worstSide = Math.max(worstSide, offSide);
      expect(offSide, JSON.stringify(layout)).toBeLessThan(7);
      if (!reference.clamped) {
        const toTarget = {
          x: (TARGET.x - layout.ball.x) / distance(TARGET, layout.ball),
          y: (TARGET.y - layout.ball.y) / distance(TARGET, layout.ball),
        };
        const offTarget = degreesBetween(departure, toTarget);
        worstTarget = Math.max(worstTarget, offTarget);
        expect(offTarget, JSON.stringify(layout)).toBeLessThan(6);
      }
    }
    // The grid must exercise both branches, and the counts are pinned so a
    // quiet change to the bound cannot empty one of them.
    expect(clamped).toBe(56);
    expect(free).toBe(40);
    expect(worstSide).toBeCloseTo(5.8121, 3);
    expect(worstTarget).toBeCloseTo(4.4487, 3);
  });

  it('holds every chosen side at or above the stated minimum solidity across the grid', () => {
    // The analytic half, and the routine against the reference: the same side
    // to twelve places on every layout, and the transfer at or above the
    // literal 0.25 everywhere.
    expect(all.length).toBe(96);
    let clampedCount = 0;
    for (const layout of all) {
      const choice = chooseStrikeSide(layout.opponent, layout.ball, TARGET);
      const reference = clampToCone(
        layout.opponent,
        layout.ball,
        TARGET,
        MIN_STRIKE_SOLIDITY,
      );
      expect(choice.solidity).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(choice.x, JSON.stringify(layout)).toBeCloseTo(reference.x, 12);
      expect(choice.y, JSON.stringify(layout)).toBeCloseTo(reference.y, 12);
      expect(choice.solidity, JSON.stringify(layout)).toBeCloseTo(reference.solidity, 12);
      expect(choice.clamped, JSON.stringify(layout)).toBe(reference.clamped);
      if (choice.clamped) clampedCount += 1;
    }
    // The grid must exercise the clamp, not only the free ideal side.
    expect(clampedCount).toBe(56);
  });

  it('agrees with itself about where the contact is and what it transfers', () => {
    // The reference reaches its two answers by two routes: the quadratic for
    // the first contact of the centre path with the disc, and the closed form
    // for the transfer. Over the grid the first contact of an aim at the
    // touching point IS that point, the normal there is minus the side, and
    // the closed form matches the cosine measured at the contact. A reference
    // that disagreed with itself would be grading the routine against
    // arithmetic nobody had checked.
    expect(all.length).toBe(96);
    for (const layout of all) {
      const reference = clampToCone(
        layout.opponent,
        layout.ball,
        TARGET,
        MIN_STRIKE_SOLIDITY,
      );
      const aim = aimPointFor(layout.ball, reference);
      const measured = departureAt(layout.opponent, layout.ball, aim);
      expect(measured, JSON.stringify(layout)).toBeDefined();
      if (measured === undefined) continue;
      // A ten-thousandth of a degree: the quadratic's two roots meet at the
      // tangent, so the contact position it returns carries the cancellation
      // error of that meeting, which the closed form does not have.
      expect(degreesBetween(measured.direction, { x: -reference.x, y: -reference.y })).
        toBeLessThan(1e-4);
      expect(measured.transfer, JSON.stringify(layout)).toBeCloseTo(
        solidityOf(layout.opponent, layout.ball, reference),
        12,
      );
      expect(measured.transfer, JSON.stringify(layout)).toBeCloseTo(reference.solidity, 12);
    }
  });

  it('strikes every layout on the grid, because nothing but the roll substitutes the block', () => {
    // The geometric decline is gone: SPEC section 8 makes the substitution
    // the profile's own probability, so a profile that never rolls it never
    // takes it, whatever the layout. Item D4's own case measures the rates.
    expect(all.length).toBe(96);
    let declined = 0;
    for (const layout of all) {
      const sim = layoutAt(layout.opponent, layout.ball);
      const plan = planShot(sim.world, CLAMP_ONLY, createRng('sweep').split(OPPONENT_STREAM));
      expect(plan.rolled).toBe(false);
      if (plan.defensive) declined += 1;
    }
    expect(declined).toBe(0);
  });
});

describe('PF-8 the own-goal soak, item D3', () => {
  it('bounds the own-goal rate across the three difficulties over a thousand turns', () => {
    // A thousand seeded turns over the whole playfield, every difficulty at
    // its stated behaviour, counted by the scoreboard's mouth: a goal in the
    // mouth the striker defends can only be its own doing, because nobody
    // else is playing. The bound is pinned at two percent of turns, where
    // SPEC section 8.1 asks for a rate that is non-zero but bounded.
    //
    // THE RESIDUE IS A GEOMETRIC CLASS, AND IT IS GRADED AS ONE. The ball
    // leaves along minus the chosen side and every admissible side lies
    // within arccos(coneBound(gap)) of the approach, so the departures a
    // layout can produce are a fan of that half-angle about the axis running
    // from the striker through the ball. Where that fan reaches the mouth the
    // striker defends, an own goal is geometrically available and no aim
    // inside the cone removes it; where it does not, one cannot happen. The
    // fan class is 406 of the thousand turns and concedes 6; the other 594
    // concede none. The predicate is computed from the REFERENCE's own bound,
    // so it is a statement about the specification and not about the routine.
    const cases: readonly [string, OpponentProfile, number][] = [
      ['casual', CASUAL, 400],
      ['pro', PRO, 400],
      ['ace', ACE, 200],
    ];
    let own = 0;
    let scored = 0;
    let inFan = 0;
    let ownInFan = 0;
    let played = 0;
    for (const [name, profile, count] of cases) {
      const root = createRng(`soak-${name}`);
      const spots = root.split('layout');
      const shots = root.split(OPPONENT_STREAM);
      for (let turn = 0; turn < count; turn += 1) {
        const spotIn = (): Vec2 => ({
          x: FIELD_LEFT + 80 + spots.nextFloat() * (FIELD_RIGHT - FIELD_LEFT - 160),
          y: FIELD_BOTTOM + 80 + spots.nextFloat() * (FIELD_TOP - FIELD_BOTTOM - 160),
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
        const sim = layoutAt(opponent, ball);
        const plan = planShot(sim.world, profile, shots);
        strikeAndTrack(sim, plan.angle, plan.power);
        played += 1;
        const reachesOwnMouth = fanReachesOwnMouth(opponent, ball);
        if (reachesOwnMouth) inFan += 1;
        const last = sim.scoring.readout().last;
        if (last !== undefined) {
          if (last.mouth === 'right') {
            own += 1;
            if (reachesOwnMouth) ownInFan += 1;
          } else scored += 1;
        }
      }
    }
    expect(played).toBe(1000);
    expect(own).toBe(6);
    expect(own).toBeLessThanOrEqual(20);
    expect(scored).toBe(15);
    expect(scored).toBeGreaterThanOrEqual(5);
    // Every own goal came from the class the geometry cannot answer, and the
    // class is a minority of turns rather than the whole soak.
    expect(ownInFan).toBe(own);
    expect(inFan).toBe(406);
  });
});

/** An angle folded into (-pi, pi], for comparing two bearings. */
function wrapped(angle: number): number {
  const folded = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return folded - Math.PI;
}

/**
 * True when the fan of departures the cone admits, of half-angle
 * arccos(coneBound(gap)) about the axis from the striker through the ball,
 * reaches the mouth this striker defends: the class of layout where an own
 * goal is geometrically available whatever side the clamp picks.
 *
 * THE CONDITION IS INTERVAL OVERLAP, and it is tested as one rather than
 * sampled. Two angular intervals overlap exactly when one of them contains an
 * endpoint of the other, so both readings are taken: a post inside the fan,
 * and a fan edge inside the mouth's subtense. Sampling the mouth at its posts
 * and centre misses the second reading outright, which is the case of a
 * narrow fan lying wholly inside a wide mouth - a striker close behind the
 * ball, where the cone bound approaches 1 and the half-angle approaches 0.
 * Both post bearings have a positive x component, because the ball centre
 * never reaches the goal line it is measured against, so the mouth interval
 * never wraps and a plain comparison decides it.
 */
function fanReachesOwnMouth(striker: Vec2, ball: Vec2): boolean {
  const gap = distance(striker, ball);
  if (!(gap >= TOUCHING)) return true;
  const half = Math.acos(Math.min(1, coneBound(gap, MIN_STRIKE_SOLIDITY)));
  const axis = Math.atan2(ball.y - striker.y, ball.x - striker.x);
  const toLow = Math.atan2(GOAL_OPENING_LOW - ball.y, RIGHT_GOAL_LINE - ball.x);
  const toHigh = Math.atan2(GOAL_OPENING_HIGH - ball.y, RIGHT_GOAL_LINE - ball.x);
  for (const post of [toLow, toHigh]) {
    if (Math.abs(wrapped(post - axis)) <= half) return true;
  }
  const low = Math.min(toLow, toHigh);
  const high = Math.max(toLow, toHigh);
  for (const edge of [axis - half, axis + half]) {
    const bearing = wrapped(edge);
    if (bearing >= low && bearing <= high) return true;
  }
  return false;
}

describe('PF-8 the opponent sits on the launch seam', () => {
  it('answers a raised seam with the planned launch and nothing else', () => {
    // The same seat PF-7's stub used, now held by the routine: the match is
    // driven, the seam rises, respond answers it with an ordinary launch
    // intent, and the striker's velocity is the plan's power on the plan's
    // angle - read back from an identical seated stream, because respond
    // spends its draws internally.
    const match = createMatch();
    match.dispatch({ kind: 'start' });
    const plan = planShotFor(match, 'seam');
    match.dispatch({ kind: 'launch', angle: 0, power: 0 });
    let steps = 0;
    while (match.readout().state.kind !== 'OPPONENT_TURN') {
      match.update(1 / 120);
      steps += 1;
      expect(steps).toBeLessThan(20000);
    }
    expect(respond(match, CASUAL, stream('seam'))).toBe(false);
    expect(match.readout().state.kind).toBe('OPPONENT_TURN');
    while (!match.readout().opponentReady) {
      match.update(1 / 120);
      steps += 1;
      expect(steps).toBeLessThan(20000);
    }
    expect(respond(match, CASUAL, stream('seam'))).toBe(true);
    expect(match.readout().state).toEqual({ kind: 'MOVING', launchedBy: 'opponent' });
    const velocity = match.world.opponent.velocity;
    const speed = launchSpeed(plan.power);
    expect(velocity.x).toBeCloseTo(Math.cos(plan.angle) * speed, 6);
    expect(velocity.y).toBeCloseTo(Math.sin(plan.angle) * speed, 6);
  });

  it('plans the same shot from the same seated stream, and different ones from different seats', () => {
    const world = createWorld();
    set(world.opponent.position, 900, 320);
    set(world.ball.position, 640, 380);
    const one = planShot(world, ACE, stream('seat-one'));
    const two = planShot(world, ACE, stream('seat-one'));
    expect(two.angle).toBe(one.angle);
    expect(two.power).toBe(one.power);
    const three = planShot(world, ACE, stream('seat-two'));
    expect([three.angle === one.angle, three.power === one.power]).not.toEqual([true, true]);
  });
});

describe('PF-8 changing the candidate count shifts no other consumer', () => {
  it('the player stream replays identically while the opponent scores three candidates instead of one', () => {
    // The B12 armour this part owes: the opponent is seated on
    // root.split(OPPONENT_STREAM) and the player on root.split('launch');
    // varying the REAL candidate count through the REAL routine must leave
    // the other consumer's draws untouched. The opponent's own plans are
    // asserted to change somewhere, so the variation is real and the
    // invariance is not the vacuous kind.
    const layouts: readonly [Vec2, Vec2][] = [
      [{ x: 900, y: 320 }, { x: 640, y: 380 }],
      [{ x: 500, y: 500 }, { x: 700, y: 300 }],
      [{ x: 1100, y: 200 }, { x: 900, y: 480 }],
      [{ x: 300, y: 200 }, { x: 500, y: 300 }],
      [{ x: 1000, y: 500 }, { x: 800, y: 300 }],
      [{ x: 700, y: 150 }, { x: 900, y: 250 }],
    ];
    const run = (candidates: number): { player: number[]; plans: string[] } => {
      const root = createRng('the-transcript');
      const player = root.split('launch');
      const opponent = root.split(OPPONENT_STREAM);
      const profile: OpponentProfile = { ...ACE, candidateCount: candidates };
      const drawn: number[] = [];
      const plans: string[] = [];
      for (const [striker, ball] of layouts) {
        const world = createWorld();
        set(world.opponent.position, striker.x, striker.y);
        set(world.ball.position, ball.x, ball.y);
        const plan = planShot(world, profile, opponent);
        plans.push(`${plan.angle} ${plan.power}`);
        drawn.push(player.nextFloat(), player.nextFloat(), player.nextFloat());
      }
      return { player: drawn, plans };
    };
    const base = run(1);
    for (const candidates of [2, 3, 5]) {
      const shifted = run(candidates);
      expect(shifted.player, `${String(candidates)} candidates`).toEqual(base.player);
    }
    const three = run(3);
    expect(three.plans).not.toEqual(base.plans);
  });
});

/** An independent seat on the stream the opponent owns, for reading a plan back. */
function stream(name: string): Rng {
  return createRng(`the-opponent-${name}`).split(OPPONENT_STREAM);
}

/** The plan respond will answer the seam with, read from an identical seat. */
function planShotFor(match: ReturnType<typeof createMatch>, name: string) {
  return planShot(match.world, CASUAL, stream(name));
}
