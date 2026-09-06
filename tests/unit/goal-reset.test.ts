import { describe, expect, it } from 'vitest';

import type { World } from '../../src/core/bodies';
import { launch } from '../../src/core/bodies';
import {
  BALL_START_X,
  BALL_START_Y,
  FIXED_STEP,
  MIDLINE_Y,
  OPPONENT_START_X,
  PLAYER_START_X,
} from '../../src/core/config';
import { GOAL_HOLD_STEPS, createScoring } from '../../src/core/goals';
import type { Goal } from '../../src/core/goals';
import type { Match, MatchState } from '../../src/core/match';
import { createMatch } from '../../src/core/match';
import { createSimulation } from '../../src/core/physics';
import { set } from '../../src/core/vec2';
import { snapshot } from './support/drive';

/**
 * Item D7, Critical: "A goal enters the GOAL state, holds 1.2 s with the ball
 * where it lies, then resets both circles and the ball to their starting
 * positions and clears all velocities, while preserving both scores and the
 * match clock."
 *
 * ONE DRIVEN SEQUENCE for the whole sentence: the goal is scored through the
 * match, the hold is walked one fixed step at a time with the ball asserted
 * bit for bit where it lay, and the reset is graded at the exact positions
 * SPEC section 3 puts each body, with every velocity compared against positive
 * zero and both scores and the clock carried across. The clock is read with
 * the same repeated subtraction the match performs, so "preserved, and still
 * ticking" is exact rather than close.
 *
 * TWO NEGATIVE CONTROLS ARE DELIVERABLES HERE. The restart order is pinned by
 * showing the defect it prevents: a scoreboard reset that reaches the next
 * step before the world has been put back awards a phantom goal into the fresh
 * match, and the control below writes that wrong sequence out and watches it
 * do it. And a First-to-N target reached is pinned by watching the celebration
 * run and then end in GAME_OVER instead of a kickoff.
 *
 * THE HOLD'S ENGINE SIDE IS ALREADY PINNED in
 * tests/unit/goal-detection.test.ts and is extended there rather than
 * duplicated; what is graded here is the match around it.
 */

const STEP = FIXED_STEP;

const BUDGET = 20000;

function stateOf(m: Match): MatchState {
  return m.readout().state;
}

function driveUntil(m: Match, ready: (state: MatchState) => boolean): number {
  let steps = 0;
  while (!ready(stateOf(m))) {
    m.update(STEP);
    steps += 1;
    if (steps > BUDGET) {
      throw new Error('the target state never arrived');
    }
  }
  return steps;
}

/**
 * A scripted goal at the right-hand mouth: the striker is placed a contact
 * away from the ball so a full-power launch transfers almost all of its
 * 900 px/s down the midline, and the defender is parked clear of the path.
 */
function scoreRight(m: Match): Goal {
  set(m.world.opponent.position, OPPONENT_START_X, 150);
  set(m.world.player.position, 640 - 34 - 18 - 1, MIDLINE_Y);
  m.dispatch({ kind: 'launch', angle: 0, power: 1 });
  driveUntil(m, (state) => state.kind === 'GOAL');
  const state = stateOf(m);
  if (state.kind !== 'GOAL') {
    throw new Error('unreachable');
  }
  return state.goal;
}

describe('PF-7 the goal hold and the reset, item D7', () => {
  it('holds 1.2 s where the ball lies, then resets the bodies and nothing else', () => {
    // The one driven sequence, clause by clause.
    const m = createMatch({ duration: 30 });
    m.dispatch({ kind: 'start' });
    scoreRight(m);
    expect(stateOf(m).kind).toBe('GOAL');

    // The hold is the engine's 144 fixed steps, 1.2 s at 1/120 s, and it is
    // still 144 on the step the state noticed it.
    expect(GOAL_HOLD_STEPS).toBe(144);
    expect(m.readout().scoring.hold).toBe(144);

    const lay = { x: m.world.ball.position.x, y: m.world.ball.position.y };
    let clock = m.readout().clock ?? 0;

    // The ball stays exactly where it lies for the whole hold, the clock
    // keeps ticking through it, and the hold counts down one step at a time.
    for (let held = 1; held < GOAL_HOLD_STEPS; held += 1) {
      m.update(STEP);
      clock -= STEP;
      expect(stateOf(m).kind, `held step ${String(held)}`).toBe('GOAL');
      expect(m.world.ball.position.x, `held step ${String(held)}`).toBe(lay.x);
      expect(m.world.ball.position.y, `held step ${String(held)}`).toBe(lay.y);
      expect(m.readout().scoring.hold, `held step ${String(held)}`).toBe(144 - held);
      expect(m.readout().clock, `held step ${String(held)}`).toBe(clock);
      expect(m.readout().scoring.player, `held step ${String(held)}`).toBe(1);
    }

    // The last held step is the one that resets: circles at their SPEC
    // section 3 starts, ball at the centre, every velocity positive zero.
    m.update(STEP);
    clock -= STEP;
    expect(stateOf(m)).toEqual({ kind: 'OPPONENT_TURN' });
    expect(m.readout().scoring.hold).toBe(0);
    expect(m.readout().scoring.frozen).toBe(false);
    expect(m.world.player.position.x).toBe(PLAYER_START_X);
    expect(m.world.player.position.y).toBe(MIDLINE_Y);
    expect(m.world.opponent.position.x).toBe(OPPONENT_START_X);
    expect(m.world.opponent.position.y).toBe(MIDLINE_Y);
    expect(m.world.ball.position.x).toBe(BALL_START_X);
    expect(m.world.ball.position.y).toBe(BALL_START_Y);
    for (const body of m.world.bodies) {
      expect(body.velocity.x, `${body.kind} velocity in x`).toBe(0);
      expect(body.velocity.y, `${body.kind} velocity in y`).toBe(0);
    }

    // Both scores preserved, and the clock preserved but not restored: it is
    // the hold's own ticking shorter, and it never went back to full. The
    // scripted goal costs about 2.3 s of the 30 s, hold included.
    expect(m.readout().scoring.player).toBe(1);
    expect(m.readout().scoring.opponent).toBe(0);
    expect(m.readout().clock).toBe(clock);
    expect(clock).toBeLessThan(30);
    expect(clock).toBeGreaterThan(25);
  });
});

describe('PF-7 the restart order puts the world back before the scoreboard, item D7', () => {
  it('restarts mid-celebration into a fresh match with no phantom goal', () => {
    // A restart taken while the ball still lies in the net is the exact case
    // the order is a rule for: the scoreboard reset clears the celebration but
    // touches no body, so the world has to go back first.
    const m = createMatch({ duration: 30 });
    m.dispatch({ kind: 'start' });
    scoreRight(m);
    for (let held = 0; held < 30; held += 1) {
      m.update(STEP);
    }
    expect(m.readout().scoring.frozen).toBe(true);
    expect(m.readout().scoring.player).toBe(1);

    m.restart();
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });
    expect(m.readout().scoring.player).toBe(0);
    expect(m.readout().scoring.goals).toBe(0);
    expect(m.readout().clock).toBe(30);
    expect(m.world.ball.position.x).toBe(BALL_START_X);
    expect(m.world.ball.position.y).toBe(BALL_START_Y);

    // A hundred steps of the new match, and no goal falls out of the old one.
    for (let step = 0; step < 100; step += 1) {
      m.update(STEP);
      expect(m.readout().scoring.goals, `step ${String(step)}`).toBe(0);
    }
    expect(m.world.ball.position.x).toBe(BALL_START_X);
  });

  it('shows the phantom goal the order prevents, at the level the handles live', () => {
    // THE WRONG ORDER, WRITTEN OUT. The scoreboard reset runs, the world does
    // not, and the next step finds both of SPEC section 6.4's conditions still
    // holding: a fresh match opens 1-0. This is the negative control for the
    // rule the match's own restart obeys (world back, then scoreboard), and it
    // is driven on the simulation the match itself is wired from.
    const wrong = createScoring();
    const sim = createSimulation({ onNonFinite: 'throw', scoring: wrong });
    park(sim.world);
    launch(sim.world.ball, 0, 900);
    while (!wrong.readout().frozen) {
      sim.step();
    }
    for (let held = 0; held < 30; held += 1) {
      sim.step();
    }
    expect(wrong.readout().player).toBe(1);
    expect(wrong.readout().hold).toBe(GOAL_HOLD_STEPS - 30);

    wrong.reset();
    expect(wrong.readout().goals).toBe(0);
    sim.step();
    expect(wrong.readout().goals, 'the ball is still in the net').toBe(1);
    expect(wrong.readout().player).toBe(1);

    // The shipped order, from the same position of the same script: the world
    // goes back first, and a hundred steps of the new match stay scoreless.
    const right = createScoring();
    const other = createSimulation({ onNonFinite: 'throw', scoring: right });
    park(other.world);
    launch(other.world.ball, 0, 900);
    while (!right.readout().frozen) {
      other.step();
    }
    for (let held = 0; held < 30; held += 1) {
      other.step();
    }
    other.reset();
    right.reset();
    for (let step = 0; step < 100; step += 1) {
      other.step();
    }
    expect(right.readout().goals).toBe(0);
    expect(other.world.ball.position.x).toBe(BALL_START_X);
  });
});

describe('PF-7 a target reached ends the match instead of kicking off, item D7', () => {
  it('runs the celebration out, then routes GOAL to GAME_OVER with the score kept', () => {
    // SPEC section 6.4: in a First-to-N match that reaches the target, GOAL
    // leads to GAME_OVER. The celebration still runs to its last step first,
    // and the pitch is left as the goal left it rather than reset.
    const m = createMatch({ target: 1 });
    m.dispatch({ kind: 'start' });
    scoreRight(m);
    expect(stateOf(m).kind).toBe('GOAL');
    expect(m.readout().scoring.over).toBe(true);
    expect(m.readout().scoring.player).toBe(1);

    const lay = { x: m.world.ball.position.x, y: m.world.ball.position.y };
    for (let held = 1; held < GOAL_HOLD_STEPS; held += 1) {
      m.update(STEP);
      if (held === 1 || held === 72 || held === GOAL_HOLD_STEPS - 1) {
        expect(stateOf(m).kind, `held step ${String(held)}`).toBe('GOAL');
        expect(m.world.ball.position.x, `held step ${String(held)}`).toBe(lay.x);
        expect(m.readout().scoring.frozen, `held step ${String(held)}`).toBe(true);
      }
    }

    m.update(STEP);
    expect(stateOf(m), 'the match is over, not kicking off').toEqual({ kind: 'GAME_OVER' });
    expect(m.readout().scoring.player).toBe(1);
    expect(m.readout().scoring.over).toBe(true);
    expect(m.world.ball.position.x).toBe(lay.x);

    // Nothing moves afterwards, and Play Again is a fresh match again.
    const asLeft = snapshot(m.world);
    for (let tick = 0; tick < 50; tick += 1) {
      m.update(STEP);
    }
    expect(snapshot(m.world)).toEqual(asLeft);
    m.restart();
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });
    expect(m.readout().scoring.player).toBe(0);
    expect(m.readout().scoring.over).toBe(false);
    expect(m.readout().clock).toBeUndefined();
  });
});

/** Both circles parked clear of the midline, for a scripted ball-only shot. */
function park(world: World): void {
  set(world.player.position, PLAYER_START_X, 150);
  set(world.opponent.position, OPPONENT_START_X, 150);
}
