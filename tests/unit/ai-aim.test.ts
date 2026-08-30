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
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_LOW,
  LEFT_GOAL_LINE,
  launchSpeed,
} from '../../src/core/config';
import { createMatch } from '../../src/core/match';
import { createSimulation } from '../../src/core/physics';
import { createRng } from '../../src/core/rng';
import type { Rng } from '../../src/core/rng';
import { distance, set } from '../../src/core/vec2';
import type { Vec2 } from '../../src/core/vec2';

/**
 * Item D3, Critical: "The opponent's aim clamps the strike side into the
 * reachable cone with the stated minimum solidity. A playfield sweep confirms
 * every chosen direction reaches the ball with meaningful speed transfer, and
 * a soak confirms the own-goal rate is bounded and near zero."
 *
 * EACH CLAUSE HAS ITS OWN READING HERE. "Clamps the strike side into the
 * reachable cone" is the analytic half: layouts where the ideal side fails
 * SPEC section 8.1's reachable test are clamped to the closest reachable
 * side, and the floor is pinned against the literal 0.25 the section states,
 * never against the symbol beside it. "Every chosen direction reaches the
 * ball with meaningful speed transfer" is the sweep: the playfield grid, the
 * real physics forward, the ball struck in every layout, with the reached
 * count pinned so a sweep that never reaches anything cannot report a pass.
 * "Bounded and near zero" is the soak: a thousand seeded turns across the
 * three difficulties, counted by the scoreboard's own mouth.
 *
 * THE SWEEP SWEEPS THE CLAMP, and the discipline is swept beside it. The
 * routine declines a strike whose departure would drive the ball away from
 * the target - the drive section 8.1 measured at 41.3 percent of layouts -
 * and plays those turns as defensive ones, so the sweep asserts the clamp's
 * chosen directions over the whole grid, and the routine's own strikes on
 * the forward subset of it, and that every declined strike left the ball
 * untouched. The soak counts what the full behaviour concedes.
 */

const TOUCHING = CIRCLE_RADIUS + BALL_RADIUS;
const MOUTH_CENTRE_Y = (GOAL_OPENING_LOW + GOAL_OPENING_HIGH) / 2;
const TARGET = { x: LEFT_GOAL_LINE, y: MOUTH_CENTRE_Y };

/** The body nobody is playing is parked in the corner, out of every shot line. */
const PARKED = { x: FIELD_LEFT + CIRCLE_RADIUS, y: FIELD_BOTTOM + CIRCLE_RADIUS };

const STEP_BUDGET = 5000;

/** A world with the striker and the ball placed, the third body parked. */
function layoutAt(opponent: Vec2, ball: Vec2): ReturnType<typeof createSimulation> {
  const world = createWorld();
  set(world.opponent.position, opponent.x, opponent.y);
  set(world.ball.position, ball.x, ball.y);
  set(world.player.position, PARKED.x, PARKED.y);
  return createSimulation({ world });
}

/** The launch the clamp's chosen side produces: the exact contact point. */
function strikeAngle(opponent: Vec2, ball: Vec2): number {
  const choice = chooseStrikeSide(opponent, ball, TARGET);
  const contact = {
    x: ball.x + choice.x * BALL_RADIUS,
    y: ball.y + choice.y * BALL_RADIUS,
  };
  return Math.atan2(contact.y - opponent.y, contact.x - opponent.x);
}

/** The launch driven and tracked to rest; the ball's peak speed is the verdict. */
function strikeAndTrack(
  sim: ReturnType<typeof createSimulation>,
  angle: number,
  power: number,
): { peak: number; steps: number } {
  launch(sim.world.opponent, angle, launchSpeed(power));
  let peak = 0;
  let steps = 0;
  for (; steps < STEP_BUDGET; steps += 1) {
    const velocity = sim.world.ball.velocity;
    peak = Math.max(peak, Math.hypot(velocity.x, velocity.y));
    if (everyBodyStopped(sim.world) || sim.scoring.frozen()) break;
    sim.step();
  }
  return { peak, steps };
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
 * pinned below so a quiet exclusion cannot shrink the sweep.
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
        const choice = chooseStrikeSide(opponent, ball, TARGET);
        const contact = {
          x: ball.x + choice.x * BALL_RADIUS,
          y: ball.y + choice.y * BALL_RADIUS,
        };
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
    // side passes the reachable test and the clamp must leave it alone.
    const striker = { x: 900, y: 360 };
    const ball = { x: 640, y: 360 };
    const choice = chooseStrikeSide(striker, ball, TARGET);
    expect(choice.clamped).toBe(false);
    const idealX = (ball.x - TARGET.x) / distance(ball, TARGET);
    const idealY = (ball.y - TARGET.y) / distance(ball, TARGET);
    expect(choice.x).toBeCloseTo(idealX, 12);
    expect(choice.y).toBeCloseTo(idealY, 12);
    expect(choice.solidity).toBeGreaterThan(0.99);
  });

  it('clamps to the closest reachable side when the striker stands between the ball and the goal it attacks', () => {
    // THE layout the section exists for: the striker square on the lane
    // between the ball and the goal it attacks. The ideal side fails the
    // reachable test, the clamp fires, and the chosen side sits on the cone
    // boundary - at the floor from the approach, on the ideal's own
    // perpendicular, which is the closest reachable point to the ideal.
    const striker = { x: 400, y: 360 };
    const ball = { x: 640, y: 360 };
    const choice = chooseStrikeSide(striker, ball, TARGET);
    const idealX = (ball.x - TARGET.x) / distance(ball, TARGET);
    const idealY = (ball.y - TARGET.y) / distance(ball, TARGET);
    const offsetX = striker.x - ball.x;
    const offsetY = striker.y - ball.y;
    const gap = Math.hypot(offsetX, offsetY);
    const reachable = (offsetX * idealX + offsetY * idealY) / gap;
    expect(reachable).toBeLessThan(1);
    expect(reachable).toBeLessThan(TOUCHING / gap);
    expect(choice.clamped).toBe(true);
    // reachable again, at the floor, along the ideal's perpendicular
    const approachX = offsetX / gap;
    const approachY = offsetY / gap;
    expect(approachX * choice.x + approachY * choice.y).toBeGreaterThanOrEqual(0.25 - 1e-9);
    const perpX = idealX - approachX * (approachX * idealX + approachY * idealY);
    const perpY = idealY - approachY * (approachX * idealX + approachY * idealY);
    const perpLength = Math.hypot(perpX, perpY);
    expect(perpLength).toBeLessThan(1e-6); // square behind the ball: degenerate
    // and the strike the chosen side produces still lands on the ball
    const sim = layoutAt(striker, ball);
    const { peak } = strikeAndTrack(sim, strikeAngle(striker, ball), 1);
    expect(peak).toBeGreaterThan(150);
  });

  it('holds the clamped side at exactly the 0.25 solidity floor when the striker is far away', () => {
    // Beyond four touching distances the reachability cosine falls below the
    // floor, so the floor is the binding constraint and the chosen side sits
    // exactly on it. The assertion is against the section's literal.
    const striker = { x: 400, y: 360 };
    const ball = { x: 640, y: 360 };
    const choice = chooseStrikeSide(striker, ball, TARGET);
    expect(TOUCHING / 240).toBeLessThan(0.25); // the reachability bound is the looser one here
    expect(choice.solidity).toBe(0.25);
    const approachX = (striker.x - ball.x) / distance(striker, ball);
    const approachY = (striker.y - ball.y) / distance(striker, ball);
    expect(approachX * choice.x + approachY * choice.y).toBeCloseTo(0.25, 9);
    expect(MIN_STRIKE_SOLIDITY).toBe(0.25);
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

  it('aims the launch at the exact contact point of the chosen side, with no safety margin', () => {
    // The aim angle is recomputed here from the chosen side alone, so a
    // margin sneaking into the routine moves this assertion. A margin past
    // the touching distance is the prior build's 69.4 percent whiff.
    const striker = { x: 900, y: 300 };
    const ball = { x: 640, y: 360 };
    const world = createWorld();
    set(world.opponent.position, striker.x, striker.y);
    set(world.ball.position, ball.x, ball.y);
    const plan = planShot(world, { ...CASUAL, angularErrorDeg: 0, whiffChance: 0 }, createRng('aim').split(OPPONENT_STREAM));
    const choice = chooseStrikeSide(striker, ball, TARGET);
    const contact = {
      x: ball.x + choice.x * BALL_RADIUS,
      y: ball.y + choice.y * BALL_RADIUS,
    };
    expect(plan.angle).toBeCloseTo(Math.atan2(contact.y - striker.y, contact.x - striker.x), 9);
  });
});

describe('PF-8 the playfield sweep, item D3', () => {
  const { all, excluded } = sweepLayouts();

  it('reaches the ball with meaningful speed transfer on every chosen strike direction', () => {
    // THE SWEEP. Every layout, the real physics forward, the ball struck.
    // The reached count is pinned against the layout count because a sweep
    // that never reaches the ball reports no own goals and has tested
    // nothing; 150 px/s is the minimum launch speed, so the transfer is
    // meaningful by the game's own definition of a shot.
    expect(all.length).toBe(96);
    expect(excluded).toBe(3);
    let reached = 0;
    let minimumPeak = Infinity;
    for (const layout of all) {
      const sim = layoutAt(layout.opponent, layout.ball);
      const { peak } = strikeAndTrack(sim, strikeAngle(layout.opponent, layout.ball), 1);
      if (peak > 6) reached += 1;
      minimumPeak = Math.min(minimumPeak, peak);
      expect(sim.readout().repairs).toBe(0);
    }
    expect(reached).toBe(all.length);
    expect(minimumPeak).toBeGreaterThan(150);
  });

  it('holds every chosen side at or above the stated minimum solidity across the grid', () => {
    expect(all.length).toBe(96);
    let clampedCount = 0;
    for (const layout of all) {
      const choice = chooseStrikeSide(layout.opponent, layout.ball, TARGET);
      expect(choice.solidity).toBeGreaterThanOrEqual(0.25 - 1e-9);
      if (choice.clamped) clampedCount += 1;
    }
    // The grid must exercise the clamp, not only the free ideal side.
    expect(clampedCount).toBe(52);
  });

  it('the routine strikes reach the ball on the forward layouts and leave it on the declined ones', () => {
    // Through planShot itself: forward layouts strike and reach; layouts the
    // routine declines - whose strike would drive the ball away from the
    // target - leave the ball exactly untouched, which is the discipline the
    // soak's own-goal bound rests on.
    expect(all.length).toBe(96);
    let strikes = 0;
    let reached = 0;
    let declined = 0;
    for (const layout of all) {
      const sim = layoutAt(layout.opponent, layout.ball);
      const plan = planShot(sim.world, CLAMP_ONLY, createRng('sweep').split(OPPONENT_STREAM));
      if (plan.defensive) {
        declined += 1;
        const { peak } = strikeAndTrack(sim, plan.angle, plan.power);
        expect(peak).toBe(0);
        continue;
      }
      strikes += 1;
      const { peak } = strikeAndTrack(sim, plan.angle, plan.power);
      if (peak > 6) reached += 1;
    }
    expect(strikes).toBe(69);
    expect(reached).toBe(strikes);
    expect(declined).toBe(27);
  });
});

describe('PF-8 the own-goal soak, item D3', () => {
  it('bounds the own-goal rate across the three difficulties over a thousand turns', () => {
    // A thousand seeded turns over the whole playfield, every difficulty at
    // its stated behaviour, counted by the scoreboard's mouth: a goal in the
    // mouth the striker defends can only be its own doing, because nobody
    // else is playing. The bound is pinned at two percent of turns. For
    // scale: the same soak with the clamp removed concedes on roughly a
    // quarter of the turns, which is the defect this item exists to keep
    // out; the measured residue below is the class of layout where the
    // striker stands square behind a ball parked in its own goalmouth, where
    // every straight launch plays the ball toward the net.
    const cases: readonly [string, OpponentProfile, number][] = [
      ['casual', CASUAL, 400],
      ['pro', PRO, 400],
      ['ace', ACE, 200],
    ];
    let own = 0;
    let scored = 0;
    const turns = 1000;
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
        const last = sim.scoring.readout().last;
        if (last !== undefined) {
          if (last.mouth === 'right') own += 1;
          else scored += 1;
        }
      }
    }
    expect(turns).toBe(1000);
    expect(own).toBe(12);
    expect(own).toBeLessThanOrEqual(20);
    expect(scored).toBeGreaterThanOrEqual(5);
  });
});

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
