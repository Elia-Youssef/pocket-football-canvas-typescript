import { describe, expect, it } from 'vitest';

import type { Goal } from '../../src/core/goals';
import type { Match, MatchState } from '../../src/core/match';
import { createMatch } from '../../src/core/match';
import {
  BALL_START_X,
  BALL_START_Y,
  FIXED_STEP,
  MIDLINE_Y,
  OPPONENT_START_X,
  PLAYER_START_X,
} from '../../src/core/config';
import { set } from '../../src/core/vec2';

/**
 * Item D6, Major: "After a goal the next turn belongs to the side that
 * conceded."
 *
 * DRIVEN AT BOTH MOUTHS IN ONE MATCH, because the rule has two readings that
 * must both hold and a rule that only alternated would pass one of them: the
 * player scoring must hand the turn to the opponent, and the opponent scoring
 * must hand it back. The side is read from the Goal record the state carries,
 * not from a parity count, and the second goal of the match is only reachable
 * because the first one kicked off correctly, so the sequence below is its own
 * control.
 *
 * THE RECORD IS THE ENGINE'S. `Goal` and its conceded side are built by
 * src/core/goals.ts at PF-4; what this part owns is the routing: the state
 * carries the record through the celebration, and the kickoff it ends with
 * names the record's conceded side. tests/unit/goal-detection.test.ts pins the
 * scoreboard's own nextTurn; this file pins the turn the match actually opens.
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

/** The same shot at the left-hand mouth, taken by the opponent's circle. */
function scoreLeft(m: Match): Goal {
  set(m.world.player.position, PLAYER_START_X, 150);
  set(m.world.opponent.position, 640 + 34 + 18 + 1, MIDLINE_Y);
  m.dispatch({ kind: 'launch', angle: Math.PI, power: 1 });
  driveUntil(m, (state) => state.kind === 'GOAL');
  const state = stateOf(m);
  if (state.kind !== 'GOAL') {
    throw new Error('unreachable');
  }
  return state.goal;
}

/** The opponent's whole pre-launch wait, driven one fixed step at a time. */
function waitOutTheOpponent(m: Match): number {
  let steps = 0;
  while (!m.readout().opponentReady) {
    m.update(STEP);
    steps += 1;
    if (steps > 200) {
      throw new Error('the seam never rose');
    }
  }
  return steps;
}

/** The kickoff placement, positions only, in body order. */
const KICKOFF: readonly number[] = [
  PLAYER_START_X,
  MIDLINE_Y,
  OPPONENT_START_X,
  MIDLINE_Y,
  BALL_START_X,
  BALL_START_Y,
];

/** The positions of the world, which is what a placement is compared with. */
function positions(m: Match): readonly number[] {
  return m.world.bodies.flatMap((body) => [body.position.x, body.position.y]);
}

describe('PF-7 the next turn belongs to the side that conceded, item D6', () => {
  it('kicks off to the opponent after a player goal, and to the player after theirs', () => {
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });

    // The player scores at the right mouth. The state carries the goal record
    // through the celebration, and the record is the one the scoreboard kept.
    const first = scoreRight(m);
    const holding = stateOf(m);
    expect(holding.kind).toBe('GOAL');
    if (holding.kind !== 'GOAL') {
      throw new Error('unreachable');
    }
    expect(holding.goal).toBe(first);
    expect(first).toEqual({
      scorer: 'player',
      conceded: 'opponent',
      mouth: 'right',
      step: first.step,
    });
    expect(holding.goal).toBe(m.readout().scoring.last);
    expect(m.readout().scoring.nextTurn, 'not until the hold ends').toBe('player');
    expect(m.readout().scoring.player).toBe(1);
    expect(m.readout().scoring.opponent).toBe(0);

    // The hold ends into the conceded side's turn, on a pitch the reset put
    // back to kickoff.
    driveUntil(m, (state) => state.kind !== 'GOAL');
    expect(stateOf(m)).toEqual({ kind: 'OPPONENT_TURN' });
    expect(m.readout().scoring.nextTurn).toBe('opponent');
    expect(positions(m)).toEqual(KICKOFF);

    // And the sequence is its own control: the second goal is only reachable
    // because the first one really did kick off to the conceded side.
    waitOutTheOpponent(m);
    const second = scoreLeft(m);
    expect(second).toEqual({
      scorer: 'opponent',
      conceded: 'player',
      mouth: 'left',
      step: second.step,
    });
    expect(second).toBe(m.readout().scoring.last);
    driveUntil(m, (state) => state.kind !== 'GOAL');
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });
    expect(m.readout().scoring.nextTurn).toBe('player');
    expect(m.readout().scoring.player).toBe(1);
    expect(m.readout().scoring.opponent).toBe(1);
    expect(m.readout().scoring.goals).toBe(2);
  });

  it('kicks off to the conceded side whatever side opened the match', () => {
    // The opening side is the configuration's, not the rule's: a match opened
    // by the opponent obeys the same concession, which is the reading a
    // "player always restarts" defect would fail.
    const m = createMatch({ first: 'opponent' });
    m.dispatch({ kind: 'start' });
    expect(stateOf(m)).toEqual({ kind: 'OPPONENT_TURN' });
    waitOutTheOpponent(m);
    scoreLeft(m);
    driveUntil(m, (state) => state.kind !== 'GOAL');
    expect(stateOf(m)).toEqual({ kind: 'PLAYER_TURN' });
    expect(m.readout().scoring.nextTurn).toBe('player');
  });

  it('never rests the state in KICKOFF: the routing happens inside one update', () => {
    // KICKOFF is the chart's routing state: it names the side that acts next
    // and the machine passes through it in the update that entered it, so no
    // caller ever observes it, at the handback or anywhere else.
    const m = createMatch();
    m.dispatch({ kind: 'start' });
    expect(stateOf(m).kind).not.toBe('KICKOFF');
    scoreRight(m);
    driveUntil(m, (state) => state.kind !== 'GOAL');
    expect(stateOf(m).kind).not.toBe('KICKOFF');
    expect(stateOf(m).kind).toBe('OPPONENT_TURN');
    m.restart();
    expect(stateOf(m).kind).not.toBe('KICKOFF');
    m.dispatch({ kind: 'quit' });
    m.dispatch({ kind: 'start' });
    expect(stateOf(m).kind).not.toBe('KICKOFF');
  });
});
