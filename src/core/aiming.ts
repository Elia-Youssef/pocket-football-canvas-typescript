/**
 * Aiming: what a drag means, and the one place a drag becomes an aim.
 *
 * SPEC section 5 states all of it. The arrow points OPPOSITE the drag from
 * the circle centre with its length proportional to the clamped drag
 * distance; 30 logical pixels is the minimum below which a release cancels;
 * 180 is the maximum above which strength stops growing; and none of it
 * happens outside the player's own turn. DESIGN section 5 adds the shape:
 * both input models produce the same `AimState`, so there is exactly one
 * thing to draw and exactly one thing to launch.
 *
 * THE DRAG ARRIVES IN DESIGN SPACE ALREADY. Nothing here knows a pointer, a
 * rectangle or a device ratio: the numbers are logical design units by the
 * time they reach this module. SPEC section 5 calls that the single most
 * important coordinate decision in the game, because it is what makes the
 * two constants above mean the same thing on a phone and on a desktop. The
 * mapping that gets them here is `src/render/input.ts`, on the other side of
 * the core boundary.
 *
 * TWO CLAMPS, AND THEY ARE NOT THE SAME CLAMP. Strength is `power01`, which
 * SPEC section 6.1 defines against `clamp(drag, 30, 180)` and which
 * `config.ts` owns; this module calls it and restates nothing. The arrow's
 * REACH is clamped at the maximum only, so a sub-minimum drag draws the short
 * arrow it earned rather than one floored at the minimum. DESIGN section 5 is
 * explicit that the arrowhead defect it records was visible precisely in the
 * sub-minimum-drag case, and a floored reach would hide it.
 *
 * TOTAL BY CONSTRUCTION. A drag component that is not a finite number is no
 * drag at all, which is the reading the simulation already takes of a delta
 * it cannot use, so every function here answers for every input it can be
 * given rather than for the ones a caller is trusted to send.
 */

import type { Body, World } from './bodies';
import { everyBodyStopped } from './bodies';
import { MAX_DRAG, MIN_DRAG, power01 } from './config';
import type { MatchState } from './match';

/** DESIGN section 5: what both input models produce and one launch consumes. */
export interface AimState {
  /** The launch direction, in radians of design space with y up. */
  readonly angleRad: number;
  /** SPEC section 6.1's one power scale, in [0, 1]. */
  readonly power01: number;
}

/** An aim in progress: the aim itself, plus what the arrow needs to draw it. */
export interface AimPreview {
  readonly aim: AimState;
  /** The drag distance clamped at the maximum, in design units. */
  readonly reach: number;
  /** Whether releasing now launches. False below the minimum drag. */
  readonly launchable: boolean;
}

/** A finite drag component, or no drag at all. */
function usable(component: number): number {
  return Number.isFinite(component) ? component : 0;
}

/**
 * The aim a drag produces, taking the drag delta in design units: the current
 * pointer minus the point that was pressed.
 *
 * The direction is the NEGATED delta, which is the slingshot SPEC section 5
 * describes: pull back to shoot forward. Negating both components is what
 * makes it hold in all four quadrants rather than in the two that a mirrored
 * reading happens to agree with.
 */
export function aimFromDrag(dragX: number, dragY: number): AimPreview {
  const x = usable(dragX);
  const y = usable(dragY);
  const dragged = Math.hypot(x, y);
  return {
    aim: { angleRad: Math.atan2(-y, -x), power01: power01(dragged) },
    reach: Math.min(dragged, MAX_DRAG),
    launchable: dragged >= MIN_DRAG,
  };
}

/**
 * SPEC section 5's four refusals, as one predicate. PLAYER_TURN is the only
 * state that aims: OPPONENT_TURN, MOVING, PAUSED and GAME_OVER are the four
 * the criterion names, and MENU, KICKOFF and GOAL refuse under the same rule
 * rather than under a second one. PAUSED carries the state it interrupted and
 * is deliberately not unwrapped: a paused player turn is a pause.
 *
 * The rest half is stated separately from the state half on purpose. A world
 * still carrying a moving body is not a world to aim in whatever the chart
 * says, and PF-7's turn-end conjunction reads the same way for the same
 * reason.
 */
export function aimingAllowed(state: MatchState, world: World): boolean {
  return state.kind === 'PLAYER_TURN' && everyBodyStopped(world);
}

/**
 * Whether a press in design space landed on a body's own disc. The radius is
 * the body's, so nothing here chooses a target size, and the comparison is
 * written the way round that refuses a coordinate which is not a number: a
 * press nobody can locate is not a press on anything.
 */
export function pressLandsOn(body: Body, x: number, y: number): boolean {
  const dx = x - body.position.x;
  const dy = y - body.position.y;
  return dx * dx + dy * dy <= body.radius * body.radius;
}

/**
 * Item C1's whole sentence in one place: a press that lands on your own
 * circle, during your own turn. The circle is `world.player` and never the
 * other one, which is the half of the sentence a hit test written against
 * "a circle" would quietly drop.
 */
export function aimingBegins(
  state: MatchState,
  world: World,
  x: number,
  y: number,
): boolean {
  return aimingAllowed(state, world) && pressLandsOn(world.player, x, y);
}
