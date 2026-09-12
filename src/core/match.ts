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
 * THE CLOCK CHARGES THE DELTA THE GAME ACCEPTS. SPEC section 6.2: an invalid
 * value and a resume gap consume no time, while a visible hitch is limited by
 * the same ceiling the simulation uses. The remaining seconds are stored
 * exact; the MM:SS ceiling display is PF-13's. A match built with no duration
 * has no clock and never times out (SPEC section 9's First-to-N and Hotseat).
 *
 * WITHIN AN UPDATE the world moves first and time is charged after, so a goal
 * scored in the last step of the match counts before the whistle moves the
 * match to GAME_OVER.
 *
 * THE MODE SEAM, AND WHY IT REBUILDS RATHER THAN MUTATES. SPEC section 9's
 * modes differ only in the clock, the goal target and the opening side, and
 * SPEC section 7 configures a match in MENU. The `configure` intent applies
 * those three from MENU and nowhere else. The goal target is fixed at the
 * scoreboard's construction, so a new configuration builds a new scoreboard
 * and a new simulation around it; both are handed THE SAME WORLD the match was
 * built with, so `match.world` is one object for the life of the game and the
 * pointer input, the renderer and the effects layer keep the reference they
 * took at mount. A second way to set the target on a live scoreboard would be
 * a second place for SPEC section 9's number to be wrong.
 */

import type { World } from './bodies';
import { createWorld, everyBodyStopped, launch } from './bodies';
import { OPPONENT_PRELAUNCH_DELAY, acceptedFrameDelta, launchSpeed } from './config';
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
  | { readonly kind: 'quit' }
  | { readonly kind: 'configure'; readonly configuration: MatchConfiguration };

/**
 * The numbers a mode gives a match, which is everything SPEC section 9 varies
 * between the four of them. Separated from the construction options because a
 * mode menu changes them between matches and the finiteness policy is a
 * property of the build rather than of the mode.
 */
export interface MatchConfiguration {
  /**
   * The full match length in seconds. Omitted, the match has no clock and
   * never times out, which is SPEC section 9's First-to-N and Hotseat case.
   */
  readonly duration?: number;
  /** SPEC section 7: the side a match opens with, forwarded to the scoreboard. */
  readonly first?: Side;
  /**
   * SPEC section 9's First to N, forwarded to the scoreboard whose `over`
   * carries it. The modes that choose a value are `core/modes.ts`'s.
   */
  readonly target?: number;
}

export interface MatchOptions extends MatchConfiguration {
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
  /**
   * SPEC section 9's First-to-N target in force, absent in a match with no
   * target. It rides the readout because SPEC section 12's centre slot is
   * derived from the readout and from nothing else, so a mode change reaches
   * the HUD by the one route every other match fact already takes.
   */
  readonly target?: number;
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
function forwardedScoring(configuration: MatchConfiguration): ScoringOptions {
  const chosen: { first?: Side; target?: number } = {};
  if (configuration.first !== undefined) {
    chosen.first = configuration.first;
  }
  if (configuration.target !== undefined) {
    chosen.target = configuration.target;
  }
  return chosen;
}

/**
 * The simulation options a match owns besides its own scoreboard.
 *
 * THE WORLD IS PASSED IN, AND IT IS THE SAME ONE EVERY TIME. A mode change
 * rebuilds the scoreboard, because SPEC section 9's First-to-N target is
 * fixed at the scoreboard's construction, and rebuilding the scoreboard means
 * rebuilding the simulation around it. Handing both the world the match was
 * built with keeps `match.world` one object for the life of the game, which is
 * what lets the pointer input, the renderer and the effects layer hold their
 * reference from mount to teardown (DESIGN section 8).
 */
function forwardedSimulation(
  world: World,
  scoring: Scoring,
  options: MatchOptions,
): SimulationOptions {
  const chosen: { world: World; scoring: Scoring; onNonFinite?: NonFinitePolicy } = {
    world,
    scoring,
  };
  if (options.onNonFinite !== undefined) {
    chosen.onNonFinite = options.onNonFinite;
  }
  return chosen;
}

/** A configuration copy with absent fields absent, never undefined. */
function configurationOf(source: MatchConfiguration): MatchConfiguration {
  const chosen: { duration?: number; first?: Side; target?: number } = {};
  if (source.duration !== undefined) {
    chosen.duration = source.duration;
  }
  if (source.first !== undefined) {
    chosen.first = source.first;
  }
  if (source.target !== undefined) {
    chosen.target = source.target;
  }
  return chosen;
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
  // The one world this match plays on, whatever it is later configured to be.
  const world = createWorld();
  let configured = configurationOf(options);
  let scoring = createScoring(forwardedScoring(configured));
  let sim = createSimulation(forwardedSimulation(world, scoring, options));

  // The match clock: exact seconds remaining, or no clock at all, which is
  // what `undefined` means and what the update below tests for.
  let remaining = configured.duration;
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
    const elapsed = acceptedFrameDelta(dt);

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
      opponentDelay += elapsed;
      if (!opponentReady && opponentDelay >= OPPONENT_PRELAUNCH_DELAY) {
        opponentReady = true;
      }
    }

    // ... then time is charged for the world's moving. Ticking states only,
    // and reaching zero moves any of them to GAME_OVER, mid-flight or
    // mid-celebration alike.
    if (isTicking(entry.kind) && remaining !== undefined) {
      remaining = Math.max(0, remaining - elapsed);
      if (remaining === 0) {
        opponentReady = false;
        state = { kind: 'GAME_OVER' };
      }
    }
  }

  function dispatch(intent: MatchIntent): void {
    if (intent.kind === 'configure') {
      // SPEC section 9: the mode's numbers, applied from MENU, which is where
      // SPEC section 7 says a match is configured. The scoreboard is rebuilt
      // rather than mutated because its target is fixed at construction and a
      // second way to set it would be a second place for it to be wrong; the
      // world is the same object either way, so nothing that holds a
      // reference to it is invalidated by a mode change.
      if (state.kind === 'MENU') {
        configured = configurationOf(intent.configuration);
        scoring = createScoring(forwardedScoring(configured));
        sim = createSimulation(forwardedSimulation(world, scoring, options));
        putBack();
        remaining = configured.duration;
        opponentDelay = 0;
        opponentReady = false;
      }
      return;
    }
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
    // quit, SPEC section 7's other way out of PAUSED, and SPEC section 13's
    // Change mode out of GAME_OVER. The second edge is the one PF-13 named
    // and deliberately left unwired: its panel offers Change mode, and a
    // button whose intent no state accepts is the dishonesty that part
    // refused to ship. Nothing is reset here; the configuration that follows
    // in MENU is what puts the match back.
    if (state.kind === 'PAUSED' || state.kind === 'GAME_OVER') {
      state = { kind: 'MENU' };
    }
  }

  /**
   * THE RESTART ORDER, in the one place both callers take it: the world goes
   * back first, so that the scoreboard reset can never hand the next step a
   * ball still lying in the net. A restart and a mode change are the two ways
   * a match is put back, and one order serves both.
   */
  function putBack(): void {
    sim.reset();
    scoring.reset();
  }

  function restart(): void {
    putBack();
    // A fresh match: the full clock of the mode in force, no opponent wait,
    // and the turn order back to the opening side. Nothing is rebuilt; every
    // object above is the one the match is currently configured with (SPEC
    // section 13).
    remaining = configured.duration;
    opponentDelay = 0;
    opponentReady = false;
    if (state.kind !== 'MENU') {
      // A match that has begun restarts into play at the opening kickoff.
      // MENU is pre-match configuration and stays where it is.
      enterKickoff(sim.scoring.readout().nextTurn);
    }
  }

  function readout(): MatchReadout {
    const reading: {
      state: MatchState;
      clock: number | undefined;
      opponentReady: boolean;
      scoring: ScoringReadout;
      target?: number;
    } = {
      state,
      clock: remaining,
      opponentReady,
      scoring: sim.scoring.readout(),
    };
    if (configured.target !== undefined) {
      reading.target = configured.target;
    }
    return reading;
  }

  return {
    world,
    update,
    dispatch,
    restart,
    readout,
  };
}
