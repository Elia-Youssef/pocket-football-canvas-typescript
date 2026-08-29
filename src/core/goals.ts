/**
 * The goal test and the GOAL state, SPEC section 6.4.
 *
 * ONE PREDICATE, TWO JOBS. `ballFitsOpening` is half of the goal condition and
 * is also what makes the left and right walls transparent to the ball and solid
 * to the circles, which is why DESIGN section 3 calls it a type rule: it asks
 * WHICH BODY IT IS and never how big the body is. A circle fits the opening
 * geometrically, 68 px against 190 px, so a predicate generalised to every body
 * would let the circles leave the pitch through a 122 px band of centre
 * positions. The kind check below is that rule and is the whole of it.
 *
 * THE OTHER HALF OF TRANSPARENCY COMES FREE. `contain` in `core/physics.ts`
 * does not clamp a ball that fits, so it sets no wall bit, and the reflection
 * that reads the mask turns nothing. There is deliberately no second reading of
 * the opening inside the reflection: a second reading is a second place for the
 * rule to be wrong.
 *
 * DESIGN section 1 puts this module under `core/`: it imports nothing outside
 * core, names no platform surface and reads no clock. SPEC section 6.4's 1.2 s
 * celebration hold is counted in fixed steps, so it is simulation time like
 * everything else here rather than a duration measured against a timer.
 */

import type { Body, World } from './bodies';
import { kickoff } from './bodies';
import {
  FIXED_STEP,
  GOAL_HOLD,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_HYSTERESIS,
  GOAL_OPENING_LOW,
  LEFT_GOAL_LINE,
  RIGHT_GOAL_LINE,
} from './config';

/** SPEC section 3: the player defends the left goal and attacks the right. */
export type GoalMouth = 'left' | 'right';

/** SPEC section 7: the two sides a turn can belong to. */
export type Side = 'player' | 'opponent';

export interface Goal {
  readonly scorer: Side;
  /** SPEC section 6.4: the side that takes the next turn. */
  readonly conceded: Side;
  readonly mouth: GoalMouth;
  /** The fixed step, counted from construction, the line was crossed in. */
  readonly step: number;
}

export interface ScoringReadout {
  readonly player: number;
  readonly opponent: number;
  /** Both goals together, so a test can say a second one was not awarded. */
  readonly goals: number;
  /** SPEC section 6.4: fixed steps of the celebration hold still to run. */
  readonly hold: number;
  /** True while the hold, or a finished match, has the simulation frozen. */
  readonly frozen: boolean;
  readonly nextTurn: Side;
  readonly last: Goal | undefined;
  /** SPEC section 9's First to N, reached. See `ScoringOptions.target`. */
  readonly over: boolean;
}

/**
 * SPEC section 6.4's 1.2 s hold, in fixed steps.
 *
 * COUNTED IN STEPS RATHER THAN ACCUMULATED IN SECONDS. Neither 1.2 nor one
 * hundred and twentieth is exact in binary floating point, so a countdown that
 * subtracted one from the other would end one step early or one step late
 * depending on which way the accumulated error happened to land. The fixed step
 * is the unit of simulation time, so a whole number of them is the duration
 * rather than an approximation of it.
 */
export const GOAL_HOLD_STEPS = Math.round(GOAL_HOLD / FIXED_STEP);

/** SPEC section 3: the mouth the ball entered names the side that scored. */
const SCORER: Readonly<Record<GoalMouth, Side>> = { left: 'opponent', right: 'player' };

function opposite(side: Side): Side {
  return side === 'player' ? 'opponent' : 'player';
}

/**
 * SPEC section 6.4's "a ball currently outside the field", which is the state
 * the 0.5 px of hysteresis is attached to.
 *
 * A DOCUMENTED READING, because the section states the phrase rather than
 * defining it for a body that has a radius. It is read here as the ball's
 * centre being past a goal line, and that is what makes the sentence do the job
 * it states: the decision to let a ball THROUGH is taken at the exact bound
 * condition 2 gives, `y - r >= 265`, and only a ball that is already through
 * keeps its transparency down to 264.5. Read instead as "the leading edge has
 * touched the line", the widened bound would apply on the entry step too, the
 * exact bound would never be the binding one, and the hysteresis would have
 * nothing to switch between.
 */
function centrePastAGoalLine(body: Body): boolean {
  return body.position.x < LEFT_GOAL_LINE || body.position.x > RIGHT_GOAL_LINE;
}

/**
 * SPEC section 6.4, condition 2: the WHOLE ball is within the opening, plus the
 * 0.5 px of hysteresis for a ball that is already outside, so a ball skimming a
 * post cannot alternate between transparent and solid on successive steps under
 * floating-point jitter.
 *
 * THE KIND CHECK IS THE RULE. Every other body answers false, so a circle is
 * never asked whether it fits and is contained by all four walls whatever its
 * radius becomes.
 */
export function ballFitsOpening(body: Body): boolean {
  if (body.kind !== 'ball') {
    return false;
  }
  const slack = centrePastAGoalLine(body) ? GOAL_OPENING_HYSTERESIS : 0;
  const at = body.position;
  return (
    at.y - body.radius >= GOAL_OPENING_LOW - slack &&
    at.y + body.radius <= GOAL_OPENING_HIGH + slack
  );
}

/**
 * SPEC section 6.4, condition 1: the ball's TRAILING edge has crossed a goal
 * line, `x - r >= 1190` for the right goal or `x + r <= 90` for the left. A
 * centre-crossing test would score a half-in ball and is the trap the section
 * names.
 */
export function trailingEdgePast(body: Body): GoalMouth | undefined {
  const at = body.position;
  if (at.x - body.radius >= RIGHT_GOAL_LINE) {
    return 'right';
  }
  if (at.x + body.radius <= LEFT_GOAL_LINE) {
    return 'left';
  }
  return undefined;
}

/**
 * SPEC section 6.4: a goal requires BOTH conditions. Either one alone scores
 * something that is not a goal, so they are written as one expression rather
 * than as two readings a caller has to remember to combine.
 */
export function scored(body: Body): GoalMouth | undefined {
  if (!ballFitsOpening(body)) {
    return undefined;
  }
  return trailingEdgePast(body);
}

export interface ScoringOptions {
  /**
   * SPEC section 9's First to N. Reaching it routes SPEC section 6.4's GOAL to
   * GAME_OVER rather than to a kickoff, which is the one conditional that seam
   * costs. The modes themselves are item J2 at PF-9 and are not built here;
   * omitted, no target is in force and every goal leads to a kickoff.
   */
  readonly target?: number;
  /** SPEC section 7: the side a match opens with, which item D1 at PF-7 owns. */
  readonly first?: Side;
}

export interface Scoring {
  /** DESIGN section 3, position 4: the goal test, run after the walls. */
  observe(world: World, step: number): Goal | undefined;
  /** True while the simulation is frozen and a step must move nothing. */
  frozen(): boolean;
  /** One fixed step of the hold, which resets the world when it expires. */
  holdOneStep(world: World): void;
  /** Drop a running celebration, for a caller that has restarted the world. */
  clearHold(): void;
  /**
   * A new match: both scores, the hold, the verdict and the opening side.
   *
   * PAIR IT WITH `Simulation.reset()`, AND CALL THAT ONE FIRST. This clears the
   * hold but touches no body, so a scoreboard reset taken while the ball is
   * still lying in the net leaves a world whose next step meets both of SPEC
   * section 6.4's conditions again and awards a phantom goal into the fresh
   * match. Putting the world back to kickoff first cannot: the ball is on the
   * centre spot before anything is observed.
   */
  reset(): void;
  readout(): ScoringReadout;
}

/**
 * The GOAL state SPEC section 6.4 states, at the size that makes detection
 * consequential and no larger. Award one point, hold, reset, and hand the next
 * turn to the side that conceded.
 *
 * WHAT IS DELIBERATELY NOT HERE. The turn flow around it is item D1 at PF-7,
 * the match clock is the same part, and the modes that read `target` are item
 * J2 at PF-9. Scores and the clock are not reset by a goal: the scores are
 * asserted here, and the clock has nothing to assert against until it exists.
 */
export function createScoring(options: ScoringOptions = {}): Scoring {
  const target = options.target;
  const first: Side = options.first ?? 'player';

  const scores: Record<Side, number> = { player: 0, opponent: 0 };
  let goals = 0;
  let hold = 0;
  let over = false;
  let nextTurn: Side = first;
  let last: Goal | undefined;

  return {
    observe(world: World, step: number): Goal | undefined {
      const mouth = scored(world.ball);
      if (mouth === undefined) {
        return undefined;
      }
      const scorer = SCORER[mouth];
      // SPEC section 6.4: exactly one point. What keeps it one rather than one
      // per step is the hold started below, and nothing in the detection: both
      // conditions go on holding for as long as the ball lies in the net, so
      // the multiplicity is owned by the hold that item D7 grades at PF-7 and
      // only exercised here. Nothing is observed again until the reset has put
      // the ball back on the centre spot.
      scores[scorer] += 1;
      goals += 1;
      hold = GOAL_HOLD_STEPS;
      const goal: Goal = { scorer, conceded: opposite(scorer), mouth, step };
      last = goal;
      if (target !== undefined && scores[scorer] >= target) {
        over = true;
      }
      return goal;
    },

    frozen(): boolean {
      return hold > 0 || over;
    },

    holdOneStep(world: World): void {
      if (hold === 0) {
        // Reachable only once the match is over, which SPEC section 6.4 routes
        // to GAME_OVER rather than to a kickoff: the pitch stays as the goal
        // left it and no further step moves anything.
        return;
      }
      hold -= 1;
      if (hold > 0) {
        return;
      }
      if (over) {
        return;
      }
      // SPEC section 6.4, in the order the section states: the ball to the
      // centre, both circles to their starting positions, every velocity
      // cleared, and the side that conceded taking the next turn. The scores
      // are untouched on purpose.
      nextTurn = last === undefined ? nextTurn : last.conceded;
      kickoff(world);
    },

    clearHold(): void {
      hold = 0;
    },

    reset(): void {
      scores.player = 0;
      scores.opponent = 0;
      goals = 0;
      hold = 0;
      over = false;
      nextTurn = first;
      last = undefined;
    },

    readout(): ScoringReadout {
      return {
        player: scores.player,
        opponent: scores.opponent,
        goals,
        hold,
        frozen: hold > 0 || over,
        nextTurn,
        last,
        over,
      };
    },
  };
}
