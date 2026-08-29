/**
 * The three bodies and the world that holds them.
 *
 * SPEC section 3 places them at kickoff, section 4 gives the radii, and section
 * 6.1 gives every body the same mass so that an elastic impulse between two of
 * them reduces to exchanging the normal components at PF-3.
 *
 * DESIGN section 8: a restart mutates state and never rebuilds the scene, so
 * `kickoff` writes into the world that already exists and there is deliberately
 * no second constructor for it.
 */

import {
  BALL_RADIUS,
  BALL_START_X,
  BALL_START_Y,
  BODY_MASS,
  CIRCLE_RADIUS,
  MIDLINE_Y,
  OPPONENT_START_X,
  PLAYER_START_X,
  SPEED_CAP,
} from './config';
import type { Vec2 } from './vec2';
import { fromAngle, limit, set, vec2, zero } from './vec2';

/**
 * Which body this is. SPEC section 6.4 makes the goal opening a rule about
 * which body it is rather than about how big it is, so the kind is load-bearing
 * from PF-4 onward and not merely a label for the renderer.
 */
export type BodyKind = 'player' | 'opponent' | 'ball';

export interface Body {
  readonly kind: BodyKind;
  readonly radius: number;
  readonly mass: number;
  readonly position: Vec2;
  readonly velocity: Vec2;
}

export interface World {
  readonly player: Body;
  readonly opponent: Body;
  readonly ball: Body;
  /** The same three, in a fixed order, for a step that treats them alike. */
  readonly bodies: readonly [Body, Body, Body];
}

/** SPEC section 3, read once here so no other module restates a coordinate. */
const KICKOFF: Readonly<Record<BodyKind, Readonly<Vec2>>> = {
  player: { x: PLAYER_START_X, y: MIDLINE_Y },
  opponent: { x: OPPONENT_START_X, y: MIDLINE_Y },
  ball: { x: BALL_START_X, y: BALL_START_Y },
};

const RADIUS: Readonly<Record<BodyKind, number>> = {
  player: CIRCLE_RADIUS,
  opponent: CIRCLE_RADIUS,
  ball: BALL_RADIUS,
};

function createBody(kind: BodyKind): Body {
  const start = KICKOFF[kind];
  return {
    kind,
    radius: RADIUS[kind],
    mass: BODY_MASS,
    position: vec2(start.x, start.y),
    velocity: vec2(),
  };
}

export function createWorld(): World {
  const player = createBody('player');
  const opponent = createBody('opponent');
  const ball = createBody('ball');
  return { player, opponent, ball, bodies: [player, opponent, ball] };
}

/**
 * SPEC section 6.4: the ball to the centre, both circles to their starting
 * positions, all velocities cleared. Mutates in place, per DESIGN section 8.
 */
export function kickoff(world: World): void {
  for (const body of world.bodies) {
    const start = KICKOFF[body.kind];
    set(body.position, start.x, start.y);
    zero(body.velocity);
  }
}

/**
 * The one sanctioned way to give a body velocity from outside a step, clamped
 * to SPEC section 6.1's global cap on the way in so that no launch, however it
 * was aimed, can enter the integrator over the cap.
 *
 * A component that is not finite is deliberately NOT repaired here. SPEC
 * section 20 puts that decision in exactly one place, the step, so that a
 * poisoned value is caught and reported rather than quietly becoming a zero
 * that nobody ever sees.
 */
export function setVelocity(body: Body, x: number, y: number): void {
  set(body.velocity, x, y);
  limit(body.velocity, SPEED_CAP);
}

/** SPEC section 5: a launch is a direction and a speed on the one power scale. */
export function launch(body: Body, radians: number, speed: number): void {
  fromAngle(body.velocity, radians, speed);
  limit(body.velocity, SPEED_CAP);
}

/**
 * SPEC section 6.2: exact rather than approximate, because the stop threshold
 * inside the step zeroes anything at or below it. Written as an equality on
 * both components rather than as a magnitude against an epsilon, which is the
 * approximate test the threshold exists to replace.
 *
 * The equality is the guarantee, not the arithmetic that leads to it. A body
 * carrying a millionth of a millionth of a pixel per second is not stopped and
 * this says so, even though the step cannot produce one: an epsilon here would
 * be the approximate test wearing the exact test's name.
 */
export function stopped(body: Body): boolean {
  return body.velocity.x === 0 && body.velocity.y === 0;
}

/** SPEC section 7: the condition that ends a MOVING turn. */
export function everyBodyStopped(world: World): boolean {
  return world.bodies.every(stopped);
}
