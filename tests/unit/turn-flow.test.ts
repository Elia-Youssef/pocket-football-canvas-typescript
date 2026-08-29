import { describe, expect, it } from 'vitest';

import type { Body, World } from '../../src/core/bodies';
import { everyBodyStopped, setVelocity, stopped } from '../../src/core/bodies';
import {
  BALL_START_X,
  BALL_START_Y,
  FIXED_STEP,
  MIDLINE_Y,
  OPPONENT_START_X,
  PLAYER_START_X,
} from '../../src/core/config';
import type { Goal } from '../../src/core/goals';
import type { Match, MatchState } from '../../src/core/match';
import { createMatch } from '../../src/core/match';
import { createRng } from '../../src/core/rng';
import { set } from '../../src/core/vec2';
import { digest, snapshot } from './support/drive';

/**
 * Item D1, Critical: "A turn ends only after every body has stopped, in both
 * directions: a short launch that contacts nothing still routes through the
 * moving state, and control returns to the player only after every body set in
 * motion by the opponent's launch has stopped."
 *
 * BOTH DIRECTIONS, SEPARATELY. The first direction is the chart's no-special-
 * case rule (SPEC section 7: "short shots that hit nothing still route through
 * MOVING"); the second is that the handback waits for the LAST body, not the
 * first. The trap that binds the two halves of the turn-end conjunction is
 * driven here as well: a world at rest with the celebration frozen must not end
 * the turn, which is what stops rest alone from handing the turn out mid-goal.
 *
 * THE CONJUNCTION IS ASSERTED AT THE FLIP. Each driver below walks the match
 * one fixed step at a time, so the handback is graded against the world that
 * caused it rather than against a step count somebody computed by hand. What
 * is pinned exactly is the fixture (positions, speeds, the 1/120 s step); what
 * is asserted structurally is that the turn never ends a step early.
 *
 * THE SCORING-LEVEL PINS LIVE IN tests/unit/goal-detection.test.ts and are
 * extended there rather than duplicated here: this file drives the match layer
 * over a simulation whose own behaviour PF-2 through PF-4 already pinned.
 */

const STEP = FIXED_STEP;

/** A hard bound every loop below carries, so a broken scenario throws. */
const BUDGET = 20000;

function stateOf(m: Match): MatchState {
  return m.readout().state;
}

/**
 * Drive one fixed step at a time until the reading answers true, and answer
 * with the number of steps that took. A run that never arrives throws rather
 * than returning, because a scenario that cannot reach its target would
 * otherwise be graded against whatever state it did reach.
 */
function stepUntil(m: Match, ready: (state: MatchState) => boolean, budget = BUDGET): number {
  let steps = 0;
  while (!ready(stateOf(m))) {
    m.update(STEP);
    steps += 1;
    if (steps > budget) {
      throw new Error(`the target state never arrived within ${String(budget)} steps`);
    }
  }
  return steps;
}

/**
 * Spend the opening turn the cheapest way the rules allow: a minimum-power
 * launch straight down the midline. 150 px/s travels 126 px (SPEC section
 * 6.1's table), so the circle stops near x 426 and the ball at x 640 is never
 * touched. The match hands the turn to the opponent when the world stops.
 */
function spendOpeningTurn(m: Match): number {
  m.dispatch({ kind: 'launch', angle: 0, power: 0 });
  return stepUntil(m, (state) => state.kind === 'OPPONENT_TURN');
}

/** The opponent's whole pre-launch wait, driven one fixed step at a time. */
function waitOutTheOpponent(m: Match): number {
  return stepUntil(m, () => m.readout().opponentReady, 200);
}

/** The bodies that are still moving, as a count a loop can compare. */
function movingCount(world: World): number {
  return world.bodies.filter((body: Body) => !stopped(body)).length;
}

function positionOf(body: Body): { readonly x: number; readonly y: number } {
  return { x: body.position.x, y: body.position.y };
}

/**
 * A scripted goal through the match layer, at the right-hand mouth: the
 * striker is placed a contact away from the ball so a full-power launch
 * transfers almost all of its 900 px/s, and the defender is parked clear of
 * the midline. Used by the clock, the pause and the restart probes below; the
 * goal itself is graded in the files that own D6 and D7.
 */
function scriptAGoal(m: Match): Goal {
  set(m.world.opponent.position, OPPONENT_START_X, 150);
  set(m.world.player.position, 640 - 34 - 18 - 1, MIDLINE_Y);
  m.dispatch({ kind: 'launch', angle: 0, power: 1 });
  stepUntil(m, (state) => state.kind === 'GOAL');
  const state = stateOf(m);
  if (state.kind !== 'GOAL') {
    throw new Error('the scripted shot never reached the goal');
  }
  return state.goal;
}

describe('PF-7 a turn ends only after every body has stopped, item D1', () => {
  it('routes a short launch that contacts nothing through MOVING, and ends it only at rest', () => {
    // DIRECTION ONE. The weakest legal shot, aimed straight down the midline
    // from the kickoff: it moves one circle, contacts nothing, and the chart
    // still has to route it through MOVING with no special case. The turn ends
    // on the one update where the world comes to rest, and on no earlier one.
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });

    const ballBefore = positionOf(m.world.ball);
    m.dispatch({ kind: 'launch', angle: 0, power: 0 });
    expect(stateOf(m), 'the launch enters MOVING always').toEqual({
      kind: 'MOVING',
      launchedBy: 'player',
    });

    let steps = 0;
    while (stateOf(m).kind === 'MOVING') {
      // The load-bearing reading: a turn that ended here would have ended
      // while something was still moving.
      expect(everyBodyStopped(m.world), `step ${String(steps)}: not at rest yet`).toBe(false);
      m.update(STEP);
      steps += 1;
      if (steps > BUDGET) {
        throw new Error('the short shot never came to rest');
      }
      // The shot contacts nothing: the ball is never asked to move.
      expect(m.world.ball.velocity.x, `step ${String(steps)}`).toBe(0);
      expect(m.world.ball.velocity.y, `step ${String(steps)}`).toBe(0);
      expect(m.world.ball.position.x, `step ${String(steps)}`).toBe(ballBefore.x);
      expect(m.world.ball.position.y, `step ${String(steps)}`).toBe(ballBefore.y);
      if (!everyBodyStopped(m.world)) {
        expect(stateOf(m).kind, `step ${String(steps)}`).toBe('MOVING');
      }
    }

    // The handback is the update rest arrived in, and no other. 150 px/s dies
    // below the stop threshold in a little over 2.8 s, about 340 fixed steps.
    expect(steps).toBeGreaterThan(300);
    expect(steps).toBeLessThan(400);
    expect(everyBodyStopped(m.world), 'the handback found a world at rest').toBe(true);
    expect(stateOf(m)).toEqual({ kind: 'OPPONENT_TURN' });
  });

  it('returns control only after the last body the opponent set in motion has stopped', () => {
    // DIRECTION TWO. The opponent's launch strikes the ball off the midline, so
    // two bodies are set in motion and they come to rest at different steps.
    // Control comes back to the player on the step the LAST of them stops, and
    // on no earlier step, which is what the counted readings below pin.
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    spendOpeningTurn(m);
    waitOutTheOpponent(m);

    const before = digest(m.world);
    m.dispatch({ kind: 'launch', angle: Math.PI - 0.12, power: 0.7 });
    expect(stateOf(m)).toEqual({ kind: 'MOVING', launchedBy: 'opponent' });

    let steps = 0;
    let sawAPartialRest = false;
    while (stateOf(m).kind === 'MOVING') {
      const stillMoving = movingCount(m.world);
      expect(stillMoving, `step ${String(steps)}: something is still moving`).toBeGreaterThan(0);
      // The load-bearing reading: with one body already stopped and another
      // still moving, the turn is not over, and this run proves it held.
      if (stillMoving < m.world.bodies.length) {
        sawAPartialRest = true;
      }
      m.update(STEP);
      steps += 1;
      if (steps > BUDGET) {
        throw new Error('the scatter never came to rest');
      }
      // The scenario is a scatter, not a goal: a goal here would mean the
      // fixture missed, and it is graded in its own files besides.
      expect(m.readout().scoring.goals, `step ${String(steps)}`).toBe(0);
      if (!everyBodyStopped(m.world)) {
        expect(stateOf(m).kind, `step ${String(steps)}`).toBe('MOVING');
      }
    }

    // It really was a multi-body turn, and it really waited for the last one.
    expect(digest(m.world)).not.toBe(before);
    expect(sawAPartialRest, 'some body stopped while another was still moving').toBe(true);
    expect(everyBodyStopped(m.world), 'the handback found a world at rest').toBe(true);
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });
  });

  it('does not end the turn while a world at rest sits under a frozen celebration', () => {
    // THE MID-CELEBRATION TRAP, in the flesh. A ball placed short of the right
    // goal line creeps in at 160 px/s and crosses the trailing edge on the very
    // step damping finally takes it below the stop threshold, so the scoring
    // step zeroes it: the world comes to rest AND the celebration freezes on
    // the same step. The opponent, launched away from the ball at minimum
    // power, has been at rest for several steps by then. Rest alone would hand
    // the turn back here; the frozen half of the conjunction is what does not.
    //
    // THE FIXTURE NUMBERS ARE HUNTED, NOT FOUND BY DRIVING. A ball let go at
    // 160 px/s coasts a measured 135.81 px above the stop threshold before
    // damping finally takes it under, and the placement below asks 1208 -
    // 1072.22 = 135.78 of it, so the trailing edge crosses the line on the
    // very step the tail of the step zeroes the ball. Measured on this
    // fixture: the opponent, launched away at minimum power, has been at rest
    // for seven steps when the crossing comes, at fixed step 346 of the turn.
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    spendOpeningTurn(m);
    waitOutTheOpponent(m);

    set(m.world.ball.position, 1072.22, MIDLINE_Y);
    setVelocity(m.world.ball, 160, 0);
    m.dispatch({ kind: 'launch', angle: Math.PI, power: 0 });
    expect(stateOf(m)).toEqual({ kind: 'MOVING', launchedBy: 'opponent' });

    let steps = 0;
    while (stateOf(m).kind === 'MOVING') {
      m.update(STEP);
      steps += 1;
      if (steps > BUDGET) {
        throw new Error('the creeping ball never reached its rest');
      }
    }
    expect(steps).toBeGreaterThan(300);
    expect(steps).toBeLessThan(400);

    // Both halves of the conjunction hold at once, and the state is GOAL.
    expect(everyBodyStopped(m.world), 'the world is at rest at the flip').toBe(true);
    expect(m.readout().scoring.frozen, 'the celebration is running at the flip').toBe(true);
    const flipped = stateOf(m);
    expect(flipped.kind, 'rest alone did not end the turn').toBe('GOAL');
    if (flipped.kind !== 'GOAL') {
      throw new Error('unreachable');
    }
    expect(flipped.goal.scorer).toBe('player');
    expect(flipped.goal.conceded).toBe('opponent');
    expect(flipped.goal.mouth).toBe('right');
    expect(m.readout().scoring.player).toBe(1);

    // And the turn goes nowhere for the hold: the same trap, held for steps.
    const lay = positionOf(m.world.ball);
    for (let held = 0; held < 20; held += 1) {
      m.update(STEP);
      expect(stateOf(m).kind, `held step ${String(held)}`).toBe('GOAL');
      expect(m.world.ball.position.x, `held step ${String(held)}`).toBe(lay.x);
    }
  });
});

describe('PF-7 the chart routes every intent, SPEC section 7', () => {
  it('refuses a launch wherever the chart draws no edge for one', () => {
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    // MID-FLIGHT and paused both hold the ball in play, and neither is a turn;
    // the launch is refused and the state is kept.
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    expect(stateOf(m).kind).toBe('MOVING');
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    expect(stateOf(m).kind).toBe('MOVING');
    m.dispatch({ kind: 'pause' });
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    expect(stateOf(m).kind).toBe('PAUSED');
    m.dispatch({ kind: 'resume' });

    const menu = createMatch();
    menu.dispatch({ kind: 'launch', angle: 0, power: 1 });
    expect(stateOf(menu)).toEqual({ kind: 'MENU' });

    const spent = createMatch({ duration: 0.05 });
    spent.dispatch({ kind: 'start' });
    spent.dispatch({ kind: 'launch', angle: 0, power: 1 });
    stepUntil(spent, (state) => state.kind === 'GAME_OVER');
    spent.dispatch({ kind: 'launch', angle: 0, power: 1 });
    expect(stateOf(spent)).toEqual({ kind: 'GAME_OVER' });
  });

  it('starts into the configured opening side, and only from MENU', () => {
    const playerFirst = createMatch();
    playerFirst.dispatch({ kind: 'start' });
    expect(stateOf(playerFirst)).toEqual({ kind: 'PLAYER_TURN' });

    const opponentFirst = createMatch({ first: 'opponent' });
    opponentFirst.dispatch({ kind: 'start' });
    expect(stateOf(opponentFirst)).toEqual({ kind: 'OPPONENT_TURN' });

    // A started match has left MENU, and the chart draws no second start edge.
    playerFirst.dispatch({ kind: 'start' });
    expect(stateOf(playerFirst).kind).toBe('PLAYER_TURN');
  });
});

describe('PF-7 the match clock, the binding reading', () => {
  it('ticks in the two turn states and in MOVING, and charges the exact delta', () => {
    const m = createMatch({ duration: 30 });
    m.dispatch({ kind: 'start' });

    // PLAYER_TURN, exact to the float: one update charges exactly one delta,
    // which is why the expected value is built by the same repeated
    // subtraction the clock performs rather than by a multiplication.
    let expected = 30;
    for (let tick = 0; tick < 10; tick += 1) {
      m.update(STEP);
      expected -= STEP;
      expect(m.readout().clock, `tick ${String(tick)}`).toBe(expected);
    }

    // OPPONENT_TURN, through the whole wait: the clock does not stop for it.
    spendOpeningTurn(m);
    let charged = m.readout().clock ?? 0;
    const waited = waitOutTheOpponent(m);
    for (let tick = 0; tick < waited; tick += 1) {
      charged -= STEP;
    }
    expect(m.readout().clock).toBe(charged);

    // MOVING: the clock runs while the world does, and the opponent's shot
    // hands control back to the player when it is spent.
    const atLaunch = m.readout().clock ?? 0;
    m.dispatch({ kind: 'launch', angle: 0, power: 0 });
    stepUntil(m, (state) => state.kind === 'PLAYER_TURN');
    expect(m.readout().clock ?? 0).toBeLessThan(atLaunch);
  });

  it('is frozen in MENU, PAUSED and GAME_OVER, and steps nothing there', () => {
    const menu = createMatch({ duration: 30 });
    menu.update(STEP);
    menu.update(STEP);
    expect(menu.readout().clock).toBe(30);
    expect(menu.readout().state.kind).toBe('MENU');

    const m = createMatch({ duration: 30 });
    m.dispatch({ kind: 'start' });
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    stepUntil(m, (state) => state.kind === 'MOVING');
    m.update(STEP);
    m.update(STEP);
    m.dispatch({ kind: 'pause' });
    const frozen = snapshot(m.world);
    const clock = m.readout().clock;
    for (let tick = 0; tick < 50; tick += 1) {
      m.update(STEP);
    }
    expect(m.readout().clock).toBe(clock);
    expect(snapshot(m.world)).toEqual(frozen);

    const spent = createMatch({ duration: 0.05 });
    spent.dispatch({ kind: 'start' });
    spent.dispatch({ kind: 'launch', angle: 0, power: 1 });
    stepUntil(spent, (state) => state.kind === 'GAME_OVER');
    const over = snapshot(spent.world);
    const overClock = spent.readout().clock;
    for (let tick = 0; tick < 50; tick += 1) {
      spent.update(STEP);
    }
    expect(spent.readout().clock).toBe(overClock);
    expect(snapshot(spent.world)).toEqual(over);
  });

  it('reaches exactly zero and moves a ticking state to GAME_OVER mid-flight', () => {
    // A 0.05 s match cannot outlive its opening shot: the launch is still
    // moving when the whistle goes, and the match is over with the world where
    // it was, at exactly zero and not a rounding under it.
    const m = createMatch({ duration: 0.05 });
    m.dispatch({ kind: 'start' });
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    stepUntil(m, (state) => state.kind === 'GAME_OVER');
    expect(m.readout().clock).toBe(0);
    expect(everyBodyStopped(m.world), 'the shot did not stop on its own').toBe(false);
  });

  it('charges a goal scored in the last step before the whistle, then ends the match', () => {
    // THE WORLD MOVES FIRST AND TIME IS CHARGED AFTER. The first match drives
    // its scripted goal one update at a time and takes the clock's reading on
    // either side of the goal update; the second is built with the midpoint of
    // that one-step window as its duration, so the whistle lands inside the
    // goal update itself, half a step from either edge of it. The goal is on
    // the scoreboard, and the state is over.
    const probe = createMatch({ duration: 30 });
    probe.dispatch({ kind: 'start' });
    set(probe.world.opponent.position, OPPONENT_START_X, 150);
    set(probe.world.player.position, 640 - 34 - 18 - 1, MIDLINE_Y);
    probe.dispatch({ kind: 'launch', angle: 0, power: 1 });
    let clockBefore = probe.readout().clock ?? 0;
    while (stateOf(probe).kind !== 'GOAL') {
      probe.update(STEP);
      if (stateOf(probe).kind === 'GOAL') {
        break;
      }
      clockBefore = probe.readout().clock ?? 0;
    }
    const clockAfter = probe.readout().clock ?? 0;
    expect(stateOf(probe).kind).toBe('GOAL');
    const duration = clockBefore - (clockBefore - clockAfter) / 2;

    const m = createMatch({ duration });
    m.dispatch({ kind: 'start' });
    set(m.world.opponent.position, OPPONENT_START_X, 150);
    set(m.world.player.position, 640 - 34 - 18 - 1, MIDLINE_Y);
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    stepUntil(m, (state) => state.kind === 'GAME_OVER');
    expect(m.readout().scoring.player, 'the goal counted before the whistle').toBe(1);
    expect(m.readout().clock).toBe(0);
  });

  it('crossing zero mid-celebration overrules the kickoff and keeps the score', () => {
    // GOAL ticks, so the whistle can arrive while the celebration is still
    // running. The first match measures how long its scripted goal took to
    // arrive; the second is built so its clock expires about a quarter of the
    // way into the hold that follows. The match ends mid-celebration with the
    // goal on the scoreboard, and the kickoff it was holding never happens.
    const probe = createMatch({ duration: 30 });
    probe.dispatch({ kind: 'start' });
    scriptAGoal(probe);
    const atGoal = probe.readout().clock ?? 0;

    const m = createMatch({ duration: 30 - atGoal + 0.3 });
    m.dispatch({ kind: 'start' });
    scriptAGoal(m);
    expect(stateOf(m).kind).toBe('GOAL');
    expect(m.readout().scoring.hold).toBe(144);
    stepUntil(m, (state) => state.kind === 'GAME_OVER');
    expect(m.readout().clock).toBe(0);
    expect(m.readout().scoring.player, 'the goal counted before the whistle').toBe(1);
    expect(
      m.readout().scoring.hold,
      'the celebration had steps still to run',
    ).toBeGreaterThan(0);
    expect(m.readout().scoring.hold).toBeLessThan(144);
    expect(m.readout().scoring.nextTurn, 'no kickoff followed').toBe('player');
  });

  it('never times out a match built with no duration', () => {
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    spendOpeningTurn(m);
    for (let second = 0; second < 10; second += 1) {
      for (let tick = 0; tick < 120; tick += 1) {
        m.update(STEP);
      }
      expect(m.readout().clock, `second ${String(second)}`).toBeUndefined();
      expect(stateOf(m).kind, `second ${String(second)}`).toBe('OPPONENT_TURN');
    }
  });
});

describe('PF-7 PAUSED, SPEC sections 7 and 2.2', () => {
  it('is entered from each in-play state and resumes to exactly that state', () => {
    // PLAYER_TURN.
    const waiting = createMatch({ duration: 30 });
    waiting.dispatch({ kind: 'start' });
    waiting.dispatch({ kind: 'pause' });
    expect(waiting.readout().state.kind).toBe('PAUSED');
    waiting.dispatch({ kind: 'resume' });
    expect(waiting.readout().state).toEqual({ kind: 'PLAYER_TURN' });

    // OPPONENT_TURN, part way through the wait.
    const opponent = createMatch({ duration: 30 });
    opponent.dispatch({ kind: 'start' });
    spendOpeningTurn(opponent);
    for (let tick = 0; tick < 20; tick += 1) {
      opponent.update(STEP);
    }
    opponent.dispatch({ kind: 'pause' });
    expect(opponent.readout().state.kind).toBe('PAUSED');
    opponent.dispatch({ kind: 'resume' });
    expect(opponent.readout().state.kind).toBe('OPPONENT_TURN');

    // MOVING, with a body in flight.
    const moving = createMatch({ duration: 30 });
    moving.dispatch({ kind: 'start' });
    moving.dispatch({ kind: 'launch', angle: 0, power: 1 });
    moving.update(STEP);
    moving.update(STEP);
    moving.dispatch({ kind: 'pause' });
    expect(moving.readout().state.kind).toBe('PAUSED');
    moving.dispatch({ kind: 'resume' });
    expect(moving.readout().state).toEqual({ kind: 'MOVING', launchedBy: 'player' });

    // GOAL, part way through the celebration hold.
    const celebrating = createMatch({ duration: 30 });
    celebrating.dispatch({ kind: 'start' });
    scriptAGoal(celebrating);
    for (let held = 0; held < 30; held += 1) {
      celebrating.update(STEP);
    }
    celebrating.dispatch({ kind: 'pause' });
    expect(celebrating.readout().state.kind).toBe('PAUSED');
    celebrating.dispatch({ kind: 'resume' });
    expect(celebrating.readout().state.kind).toBe('GOAL');
  });

  it('steps nothing and charges no time while it is paused', () => {
    // Two identical matches, one of them paused mid-flight for fifty updates.
    // Driven to rest they agree bit for bit, which is the whole of "entering
    // it zeroes nothing and steps no simulation".
    const free = createMatch({ duration: 30 });
    const held = createMatch({ duration: 30 });
    free.dispatch({ kind: 'start' });
    held.dispatch({ kind: 'start' });
    free.dispatch({ kind: 'launch', angle: 0.3, power: 0.8 });
    held.dispatch({ kind: 'launch', angle: 0.3, power: 0.8 });
    free.update(STEP);
    free.update(STEP);
    held.update(STEP);
    held.update(STEP);
    held.dispatch({ kind: 'pause' });
    const clockAtPause = held.readout().clock;
    for (let tick = 0; tick < 50; tick += 1) {
      held.update(STEP);
    }
    expect(held.readout().clock).toBe(clockAtPause);
    held.dispatch({ kind: 'resume' });
    while (stateOf(free).kind === 'MOVING' || stateOf(held).kind === 'MOVING') {
      free.update(STEP);
      held.update(STEP);
    }
    expect(stateOf(free).kind).not.toBe('MOVING');
    expect(digest(held.world)).toBe(digest(free.world));
    expect(held.readout().clock).toBe(free.readout().clock);
    expect(stateOf(held)).toEqual(stateOf(free));
  });

  it('refuses a pause where the chart has no edge, and keeps the interrupted state', () => {
    const m = createMatch({ duration: 30 });
    m.dispatch({ kind: 'pause' });
    expect(stateOf(m)).toEqual({ kind: 'MENU' });

    m.dispatch({ kind: 'start' });
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    m.dispatch({ kind: 'pause' });
    const interrupted = stateOf(m);
    expect(interrupted.kind).toBe('PAUSED');
    // A second pause has no edge: the interrupted state is not wrapped again.
    m.dispatch({ kind: 'pause' });
    expect(stateOf(m)).toEqual(interrupted);
    m.dispatch({ kind: 'resume' });
    // A resume with nothing left to resume is refused, state for state.
    m.dispatch({ kind: 'resume' });
    expect(stateOf(m).kind).toBe('MOVING');

    const spent = createMatch({ duration: 0.05 });
    spent.dispatch({ kind: 'start' });
    spent.dispatch({ kind: 'launch', angle: 0, power: 1 });
    stepUntil(spent, (state) => state.kind === 'GAME_OVER');
    spent.dispatch({ kind: 'pause' });
    expect(stateOf(spent)).toEqual({ kind: 'GAME_OVER' });
  });

  it('leaves PAUSED for MENU on quit, and from PAUSED alone', () => {
    const m = createMatch({ duration: 30 });
    m.dispatch({ kind: 'quit' });
    expect(stateOf(m)).toEqual({ kind: 'MENU' });

    m.dispatch({ kind: 'start' });
    m.dispatch({ kind: 'quit' });
    expect(stateOf(m).kind).toBe('PLAYER_TURN');

    m.dispatch({ kind: 'pause' });
    m.dispatch({ kind: 'quit' });
    expect(stateOf(m)).toEqual({ kind: 'MENU' });
  });
});

describe('PF-7 restart mutates a fresh match out of every state, SPEC section 13', () => {
  // snapshot() reads each body in the order player, opponent, ball, and each
  // body as position x, y then velocity x, y.
  const FRESH: readonly number[] = [
    PLAYER_START_X,
    MIDLINE_Y,
    0,
    0,
    OPPONENT_START_X,
    MIDLINE_Y,
    0,
    0,
    BALL_START_X,
    BALL_START_Y,
    0,
    0,
  ];

  function assertFresh(m: Match): void {
    expect(snapshot(m.world)).toEqual(FRESH);
    expect(m.readout().clock).toBe(30);
    expect(m.readout().scoring.player).toBe(0);
    expect(m.readout().scoring.opponent).toBe(0);
    expect(m.readout().scoring.goals).toBe(0);
    expect(m.readout().opponentReady).toBe(false);
  }

  it('restarts from each in-play state into the opening kickoff', () => {
    const setups: ReadonlyArray<(m: Match) => void> = [
      (m) => {
        m.dispatch({ kind: 'launch', angle: 0, power: 1 });
      },
      (m) => {
        spendOpeningTurn(m);
      },
      (m) => {
        spendOpeningTurn(m);
        waitOutTheOpponent(m);
      },
      (m) => {
        m.dispatch({ kind: 'launch', angle: 0, power: 1 });
        m.update(STEP);
        m.update(STEP);
      },
      (m) => {
        scriptAGoal(m);
      },
      (m) => {
        m.dispatch({ kind: 'launch', angle: 0, power: 1 });
        m.dispatch({ kind: 'pause' });
      },
    ];
    for (const setup of setups) {
      const m = createMatch({ duration: 30 });
      m.dispatch({ kind: 'start' });
      setup(m);
      m.restart();
      expect(stateOf(m), 'a begun match restarts into play').toEqual({ kind: 'PLAYER_TURN' });
      assertFresh(m);
    }
    expect(setups).toHaveLength(6);
  });

  it('restarts repeatedly into the identical state, and stays in MENU before a start', () => {
    const m = createMatch({ duration: 30 });
    m.restart();
    expect(stateOf(m)).toEqual({ kind: 'MENU' });
    m.dispatch({ kind: 'start' });
    m.dispatch({ kind: 'launch', angle: 0, power: 1 });
    m.update(STEP);
    m.restart();
    const first = {
      world: snapshot(m.world),
      clock: m.readout().clock,
      player: m.readout().scoring.player,
      state: stateOf(m),
    };
    for (let again = 0; again < 3; again += 1) {
      m.restart();
      expect(snapshot(m.world), `restart ${String(again)}`).toEqual(first.world);
      expect(m.readout().clock, `restart ${String(again)}`).toBe(first.clock);
      expect(m.readout().scoring.player, `restart ${String(again)}`).toBe(first.player);
      expect(stateOf(m), `restart ${String(again)}`).toEqual(first.state);
    }
  });
});

describe('PF-7 the match layer draws from no stream, SPEC sections 6 and 7', () => {
  it('plays a seeded script to a byte-identical transcript, twice over', () => {
    // The script carries the seed, not the match: six rounds of draws choose
    // each shot's angle and power, the match consumes none of it, and two runs
    // through the whole state machine agree to the last full-precision digit.
    const transcript = (): string => {
      const shots = createRng('pf-7-turn-flow').split('launch');
      const m = createMatch({ duration: 120 });
      m.dispatch({ kind: 'start' });
      const lines: string[] = [];
      for (let round = 0; round < 6; round += 1) {
        const angle = shots.nextFloat() * Math.PI * 2;
        const power = shots.nextFloat();
        if (stateOf(m).kind === 'OPPONENT_TURN') {
          waitOutTheOpponent(m);
        }
        m.dispatch({ kind: 'launch', angle, power });
        stepUntil(m, (state) => state.kind !== 'MOVING');
        if (stateOf(m).kind === 'GOAL') {
          stepUntil(m, (state) => state.kind !== 'GOAL');
        }
        lines.push(`${String(round)} ${digest(m.world)} ${String(m.readout().clock)}`);
      }
      return lines.join('\n');
    };

    const first = transcript();
    const second = transcript();
    expect(second).toBe(first);
    expect(first.split('\n')).toHaveLength(6);
    expect(first.length).toBeGreaterThan(200);
  });
});
