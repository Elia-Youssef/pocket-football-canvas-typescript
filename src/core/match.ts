/**
 * The match wrapped around the simulation: SPEC section 7's state chart, the
 * turn flow around it, the match clock and the opponent's pre-launch delay.
 *
 * TIME IS STILL AN INPUT. Nothing here reads a clock or schedules a callback:
 * `update` takes the delta its caller measured and every other change of state
 * arrives as an explicit intent, so a whole match plays out headlessly exactly
 * the way the simulation under it does.
 *
 * THE CHART, AND THE CLOCK READING THIS PART IS BOUND TO. The eight states are
 * exactly SPEC section 7's. The clock ticks in PLAYER_TURN, OPPONENT_TURN,
 * MOVING and GOAL; it is frozen in PAUSED, MENU and GAME_OVER; reaching zero
 * moves any ticking state to GAME_OVER. KICKOFF is in neither list because it
 * holds no time at all: it is the chart's routing state, naming the side that
 * acts next, and the machine passes through it inside the update that entered
 * it. A portrait viewport is not a state and never a pause trigger; core has
 * no viewport concept at all (SPEC sections 2.1 and 7).
 *
 * THE TURN-END RULE, BOTH HALVES LOAD-BEARING. A turn ends only when
 * `everyBodyStopped(world) && !scoring.frozen()` holds. The rest half is the
 * direction item D1 states in both ways; the frozen half is the trap: a ball
 * creeping over the line under the stop threshold is zeroed in the scoring
 * step, so the world can be at rest while the celebration is running, and rest
 * alone would end the turn mid-celebration. The goal itself is not the
 * conjunction's to report: MOVING enters GOAL the step scoring freezes, and
 * the conjunction governs only the handoff to the other side's turn.
 *
 * THE RESTART ORDER IS A RULE, NOT A STYLE. A fresh match is `sim.reset()`
 * THEN `scoring.reset()`. The scoreboard reset clears a celebration hold but
 * touches no body, so taking it while the ball still lies in the net hands the
 * next step a phantom goal into the new match; putting the world back first
 * cannot. tests/unit/goal-detection.test.ts pins the defect the order
 * prevents, and tests/unit/goal-reset.test.ts pins the order at this level.
 *
 * THE OPPONENT SEAM. The AI itself is PF-8. What the match owns is the wait:
 * OPPONENT_TURN accumulates the deltas it is driven with, and when the
 * accumulated simulation time reaches OPPONENT_PRELAUNCH_DELAY the readout
 * raises `opponentReady` and keeps it raised until the launch intent arrives.
 * A flag rather than a callback, so the match stays a pure state machine a
 * frame driver polls; whatever answers the flag drives the seam with an
 * ordinary launch intent, which is how tests stub the launch today and how
 * PF-8 will drive it tomorrow.
 *
 * AN INTENT THE STATE CANNOT SERVE IS REFUSED, not an error. Intents arrive
 * from input and chrome between frames; refusing leaves the state the readout
 * already showed, which is the honest outcome, and the chart's edges stay
 * exactly the ones SPEC section 7 draws. The one way out of PAUSED besides
 * resuming is the chart's quit to MENU.
 *
 * THE CLOCK CHARGES WHAT THE CALLER SAYS ELAPSED. SPEC section 6.2: time
 * discarded by the delta clamp is lost from the simulation and from nothing
 * else, so the clock reads the raw delta with no ceiling of its own. A delta
 * that is negative or not finite is no time at all, the same reading the
 * simulation takes. The remaining seconds are stored exact; the MM:SS ceiling
 * display is PF-13's. A match built with no duration has no clock and never
 * times out (SPEC section 9's First-to-N and Hotseat).
 *
 * WITHIN AN UPDATE the world moves first and time is charged after, so a goal
 * scored in the last step of the match counts before the whistle moves the
 * match to GAME_OVER.
 */

import type { World } from './bodies';
import { everyBodyStopped, launch } from './bodies';
import { OPPONENT_PRELAUNCH_DELAY, launchSpeed } from './config';
import type { Goal, Scoring, ScoringOptions, ScoringReadout, Side } from './goals';
import { createScoring } from './goals';
import type { NonFinitePolicy, SimulationOptions } from './physics';
import { createSimulation } from './physics';

/** SPEC section 7's chart, exactly: the eight states a match is ever in. */
export type MatchState =
  | { readonly kind: 'MENU' }
  | { readonly kind: 'KICKOFF'; readonly side: Side }
  | { readonly kind: 'PLAYER_TURN' }
  | { readonly kind: 'OPPONENT_TURN' }
  | { readonly kind: 'MOVING'; readonly launchedBy: Side }
  | { readonly kind: 'GOAL'; readonly goal: Goal }
  | { readonly kind: 'PAUSED'; readonly interrupted: MatchState }
  | { readonly kind: 'GAME_OVER' };

/** Everything a caller can ask a match to do besides advancing it. */
export type MatchIntent =
  | { readonly kind: 'start' }
  | { readonly kind: 'launch'; readonly angle: number; readonly power: number }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'quit' };

export interface MatchOptions {
  /**
   * The full match length in seconds. Omitted, the match has no clock and
   * never times out, which is SPEC section 9's First-to-N and Hotseat case.
   */
  readonly duration?: number;
  /** SPEC section 7: the side a match opens with, forwarded to the scoreboard. */
  readonly first?: Side;
  /**
   * SPEC section 9's First to N, forwarded to the scoreboard whose `over`
   * carries it. The modes that would choose a value are PF-9's.
   */
  readonly target?: number;
  /**
   * The finiteness policy, forwarded to the simulation this match builds.
   * Defaults to `throw`; only a composition root passes `repair`.
   */
  readonly onNonFinite?: NonFinitePolicy;
}

export interface MatchReadout {
  readonly state: MatchState;
  /** Exact seconds remaining, or no clock at all when the match has none. */
  readonly clock: number | undefined;
  /**
   * The opponent launch seam: raised once OPPONENT_TURN has accumulated
   * OPPONENT_PRELAUNCH_DELAY of simulation time, cleared by the launch that
   * answers it, by a goal, or by any new match.
   */
  readonly opponentReady: boolean;
  /** The scoreboard: both scores, the goals, the last goal, `over`. */
  readonly scoring: ScoringReadout;
}

export interface Match {
  /** The world the match plays on, at kickoff until the match is started. */
  readonly world: World;
  /** One frame of the caller's time, in the state the match is in. */
  update(dt: number): void;
  /** An intent from input or chrome. Refused where the chart has no edge. */
  dispatch(intent: MatchIntent): void;
  /**
   * SPEC section 13's Play Again, mutated in place: clock, scores, positions,
   * velocities and turn order back to a fresh match, never a rebuilt one.
   */
  restart(): void;
  readout(): MatchReadout;
}

/**
 * SPEC section 9's opening side and First-to-N target pass through to the
 * scoreboard that owns them, and only when the caller named them: an omitted
 * option is absent rather than undefined, which is what the scoreboard's own
 * defaults are for and what `exactOptionalPropertyTypes` asks of a pass-through.
 */
function forwardedScoring(options: MatchOptions): ScoringOptions {
  const chosen: { first?: Side; target?: number } = {};
  if (options.first !== undefined) {
    chosen.first = options.first;
  }
  if (options.target !== undefined) {
    chosen.target = options.target;
  }
  return chosen;
}

/** The one simulation option a match owns besides its own scoreboard. */
function forwardedSimulation(scoring: Scoring, options: MatchOptions): SimulationOptions {
  const chosen: { scoring: Scoring; onNonFinite?: NonFinitePolicy } = { scoring };
  if (options.onNonFinite !== undefined) {
    chosen.onNonFinite = options.onNonFinite;
  }
  return chosen;
}

/**
 * The delta as time to charge. A delta that is negative or not finite is no
 * time at all, the same reading the simulation takes; the ceiling clamp is
 * deliberately absent, because time the clamp discards is lost from the
 * simulation and from nothing else (SPEC section 6.2).
 */
function elapsedOf(delta: number): number {
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

/**
 * The clock reading this part is bound to: the four states it ticks in.
 * PAUSED, MENU and GAME_OVER freeze it, and KICKOFF never holds it.
 */
function isTicking(kind: MatchState['kind']): boolean {
  return (
    kind === 'PLAYER_TURN' || kind === 'OPPONENT_TURN' || kind === 'MOVING' || kind === 'GOAL'
  );
}

function other(side: Side): Side {
  return side === 'player' ? 'opponent' : 'player';
}

export function createMatch(options: MatchOptions = {}): Match {
  const scoring = createScoring(forwardedScoring(options));
  const sim = createSimulation(forwardedSimulation(scoring, options));

  // The match clock: exact seconds remaining, or no clock at all, which is
  // what `undefined` means and what the update below tests for.
  let remaining = options.duration;
  let state: MatchState = { kind: 'MENU' };
  let opponentDelay = 0;
  let opponentReady = false;

  function enterTurn(side: Side): void {
    if (side === 'player') {
      state = { kind: 'PLAYER_TURN' };
    } else {
      // A fresh OPPONENT_TURN is a fresh wait; the delay is state, not a
      // callback, and it belongs to this turn alone.
      opponentDelay = 0;
      opponentReady = false;
      state = { kind: 'OPPONENT_TURN' };
    }
  }

  function enterKickoff(side: Side): void {
    // KICKOFF holds no time (the clock reading in the header): it names the
    // side that acts and routes at once, inside the update that entered it.
    state = { kind: 'KICKOFF', side };
    enterTurn(side);
  }

  function enterGoal(record: Goal | undefined): void {
    if (record !== undefined) {
      // Whatever the opponent was waiting to do is not waiting any more.
      opponentReady = false;
      state = { kind: 'GOAL', goal: record };
    }
  }

  function update(dt: number): void {
    const entry = state;
    // The clock's frozen states: no simulation and no time. SPEC section 2.2
    // is why PAUSED is one of them, and entering PAUSED stepped nothing: the
    // state is all that changed.
    if (entry.kind === 'MENU' || entry.kind === 'PAUSED' || entry.kind === 'GAME_OVER') {
      return;
    }
    if (entry.kind === 'KICKOFF') {
      // No public path rests here; routed rather than stepped so a KICKOFF can
      // never sit and hold time whatever a caller does.
      enterTurn(entry.side);
      return;
    }

    // The world moves first, and the goal test runs inside the step, so every
    // reading below is of the world as this update left it.
    sim.update(dt);
    const scoringNow = sim.scoring.readout();

    if (entry.kind === 'MOVING') {
      // THE TURN-END RULE, in the order the conjunction is stated. A turn ends
      // only when every body has stopped AND no celebration is running; the
      // frozen half is what keeps a world that came to rest under a falling
      // celebration from handing the turn out mid-goal.
      const turnOver = everyBodyStopped(sim.world) && !scoringNow.frozen;
      if (turnOver) {
        enterTurn(other(entry.launchedBy));
      } else if (scoringNow.frozen) {
        // GOAL is entered when scoring freezes, not when the world happens to
        // be at rest: the celebration hold, and the reset its last step fires,
        // belong to the GOAL state below.
        enterGoal(scoringNow.last);
      }
    } else if (entry.kind === 'PLAYER_TURN' || entry.kind === 'OPPONENT_TURN') {
      // The same freeze rule from a turn state. No public path reaches it,
      // because the world only moves through a launch, but the chart stays
      // honest if a goal ever freezes play outside MOVING.
      if (scoringNow.frozen) {
        enterGoal(scoringNow.last);
      }
    }

    if (state.kind === 'GOAL') {
      if (scoringNow.over) {
        // SPEC section 6.4: the celebration still runs, and then the match is
        // over rather than kicking off. The pitch stays as the goal left it.
        if (scoringNow.hold <= 0) {
          opponentReady = false;
          state = { kind: 'GAME_OVER' };
        }
      } else if (!scoringNow.frozen) {
        // The hold has lifted. The scoreboard's own last hold step has already
        // put the world back at kickoff and cleared every velocity, so what is
        // left is the routing, and the Goal record this state carries names
        // the side that conceded.
        enterKickoff(state.goal.conceded);
      }
    }

    // The opponent's pre-launch delay: a state timer, accumulated from the
    // deltas this turn is driven with. Frame-rate independent by construction,
    // and nothing to tear down: the flag is the whole seam.
    if (entry.kind === 'OPPONENT_TURN' && state.kind === 'OPPONENT_TURN') {
      opponentDelay += elapsedOf(dt);
      if (!opponentReady && opponentDelay >= OPPONENT_PRELAUNCH_DELAY) {
        opponentReady = true;
      }
    }

    // ... then time is charged for the world's moving. Ticking states only,
    // and reaching zero moves any of them to GAME_OVER, mid-flight or
    // mid-celebration alike.
    if (isTicking(entry.kind) && remaining !== undefined) {
      remaining = Math.max(0, remaining - elapsedOf(dt));
      if (remaining === 0) {
        opponentReady = false;
        state = { kind: 'GAME_OVER' };
      }
    }
  }

  function dispatch(intent: MatchIntent): void {
    if (intent.kind === 'start') {
      // MENU is where a match is configured (SPEC section 7); starting applies
      // the configuration to a fresh match, which is a restart plus the
      // opening kickoff.
      if (state.kind === 'MENU') {
        restart();
        enterKickoff(sim.scoring.readout().nextTurn);
      }
      return;
    }
    if (intent.kind === 'launch') {
      // SPEC section 5: a launch is a direction and a strength on the one
      // power scale, applied to the side whose turn this is. SPEC section 7:
      // MOVING is entered always, even for a short shot that contacts nothing,
      // so the state machine has no special case.
      if (state.kind === 'PLAYER_TURN') {
        launch(sim.world.player, intent.angle, launchSpeed(intent.power));
        state = { kind: 'MOVING', launchedBy: 'player' };
      } else if (state.kind === 'OPPONENT_TURN') {
        launch(sim.world.opponent, intent.angle, launchSpeed(intent.power));
        opponentReady = false;
        state = { kind: 'MOVING', launchedBy: 'opponent' };
      }
      return;
    }
    if (intent.kind === 'pause') {
      // The pause control and the hidden tab both arrive as this intent from
      // later parts. Entering it zeroes nothing and steps no simulation; the
      // update above refuses to step a paused match, and resuming returns to
      // the exact state that was interrupted.
      if (
        state.kind === 'PLAYER_TURN' ||
        state.kind === 'OPPONENT_TURN' ||
        state.kind === 'MOVING' ||
        state.kind === 'GOAL'
      ) {
        state = { kind: 'PAUSED', interrupted: state };
      }
      return;
    }
    if (intent.kind === 'resume') {
      if (state.kind === 'PAUSED') {
        state = state.interrupted;
      }
      return;
    }
    // quit, SPEC section 7's other way out of PAUSED.
    if (state.kind === 'PAUSED') {
      state = { kind: 'MENU' };
    }
  }

  function restart(): void {
    // THE RESTART ORDER: the world goes back first, so that the scoreboard
    // reset below can never hand the next step a ball still lying in the net.
    sim.reset();
    scoring.reset();
    // A fresh match: the full clock, no opponent wait, and the turn order back
    // to the opening side. Nothing is rebuilt; every object above is the one
    // the match was constructed with (SPEC section 13).
    remaining = options.duration;
    opponentDelay = 0;
    opponentReady = false;
    if (state.kind !== 'MENU') {
      // A match that has begun restarts into play at the opening kickoff.
      // MENU is pre-match configuration and stays where it is.
      enterKickoff(sim.scoring.readout().nextTurn);
    }
  }

  function readout(): MatchReadout {
    return {
      state,
      clock: remaining,
      opponentReady,
      scoring: sim.scoring.readout(),
    };
  }

  return {
    world: sim.world,
    update,
    dispatch,
    restart,
    readout,
  };
}
