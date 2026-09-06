/**
 * SPEC section 11's aim guide: the path the LAUNCHING CIRCLE would take, with
 * exactly one wall bounce in it, and the point where it would first touch the
 * ball.
 *
 * IT PREDICTS THE CIRCLE AND NOTHING ELSE, which is the whole point of the
 * section: the guide teaches angles without playing the shot. There is no
 * field in `AimGuide` for what the ball would do, no field for a second bounce
 * and no field for a rebound, because a shape that cannot carry the ball's
 * path cannot leak it. The path also STOPS at the first contact: past that
 * point the circle's own trajectory is decided by a collision this module
 * deliberately does not resolve, so continuing the line would be predicting
 * the shot rather than the aim.
 *
 * ONE BOUNCE IS A CAP AND A FLOOR. The prediction carries exactly one bounce:
 * two would be predicting a rally, and none would leave the section's own word
 * unhonoured. The only path with no bounce in it is one that reaches the ball
 * first, which is the case the section gives its own marker to.
 *
 * IT IS GEOMETRY, NOT A SIMULATION. The path is the straight line the launch
 * would follow and its one reflection, at full extent, rather than the
 * distance a given strength would actually carry. SPEC section 11 asks for the
 * angle the shot leaves at, the wall it would come off and where it would meet
 * the ball; the strength is what the aim arrow already draws, and a guide that
 * shortened with the power slider would answer a question the section does not
 * ask while making "including one wall bounce" false for every soft shot.
 *
 * THE WALLS ARE THE CIRCLE'S OWN BOUNDS. A circle is contained by all four
 * field edges, opening or no opening (`core/goals.ts`'s type rule), so the
 * centre of a circle of radius r travels inside the field inset by r, which is
 * exactly what `contain` in `core/physics.ts` clamps it to. The two modules
 * read the same four constants rather than one restating the other's bound.
 *
 * DESIGN section 1 puts this module under `core/`: it imports nothing outside
 * core, names no platform surface, reads no clock and draws no random number.
 */

import type { Body } from './bodies';
import {
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
} from './config';

/** A point on the predicted path, in the design space SPEC section 3 defines. */
export interface GuidePoint {
  readonly x: number;
  readonly y: number;
}

/** The wall a bounce came off, named as SPEC section 3 names the edges. */
export type GuideWall = 'left' | 'right' | 'bottom' | 'top';

/**
 * One prediction. `path` is the launching circle's CENTRE, in order: where it
 * starts, where it bounces if it bounces, and where the prediction ends. Two
 * points for a path that meets the ball first, three for a path that comes off
 * a wall, and never more, because there is never more than one bounce.
 */
export interface AimGuide {
  readonly path: readonly GuidePoint[];
  /** Where the circle would first touch the ball, or nothing if it never does. */
  readonly contact: GuidePoint | undefined;
  /** The wall the one bounce used, or nothing when the ball came first. */
  readonly bounce: GuideWall | undefined;
}

/** Nothing to predict: the direction, or the point it starts from, is not a number. */
const NO_GUIDE: AimGuide = Object.freeze({
  path: Object.freeze([]),
  contact: undefined,
  bounce: undefined,
});

/** The rectangle a circle's CENTRE is contained in, which is the field inset. */
interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function boundsFor(radius: number): Bounds {
  return {
    minX: FIELD_LEFT + radius,
    maxX: FIELD_RIGHT - radius,
    minY: FIELD_BOTTOM + radius,
    maxY: FIELD_TOP - radius,
  };
}

/** How far along a direction a bound lies, or nothing when it never does. */
function distanceToBound(from: number, direction: number, low: number, high: number): number {
  if (direction > 0) {
    return (high - from) / direction;
  }
  if (direction < 0) {
    return (low - from) / direction;
  }
  return Number.POSITIVE_INFINITY;
}

interface WallHit {
  readonly at: number;
  readonly wall: GuideWall;
}

/**
 * The first wall the centre reaches from here, and how far away it is.
 *
 * The x axis is tested first, so a path that arrives exactly at a corner takes
 * the side wall rather than depending on which comparison happened to round
 * first: a tie has to be broken somewhere and breaking it by a fixed rule is
 * what keeps one aim drawing one guide.
 *
 * THERE IS ALWAYS A WALL AHEAD, which is why this answers a hit rather than
 * perhaps-a-hit. A direction here is a cosine and a sine of one angle, so the
 * two components are never both zero, and `predictGuide` refuses a direction
 * or a starting point that is not a number before either reaches this. Only
 * those two cases could make both distances non-finite, so a second refusal
 * here would be a branch nothing can enter.
 */
function firstWall(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  bounds: Bounds,
): WallHit {
  const alongX = distanceToBound(x, dirX, bounds.minX, bounds.maxX);
  const alongY = distanceToBound(y, dirY, bounds.minY, bounds.maxY);
  if (alongX <= alongY) {
    return { at: Math.max(alongX, 0), wall: dirX > 0 ? 'right' : 'left' };
  }
  return { at: Math.max(alongY, 0), wall: dirY > 0 ? 'top' : 'bottom' };
}

/**
 * How far along the direction the circle first touches the ball, or nothing
 * inside `limit`.
 *
 * The touching distance is the two radii, so this is the smaller root of
 * |start + t d - ball| = r + ballRadius with d a unit vector. A circle that is
 * already overlapping has a negative constant term and therefore a negative
 * smaller root, and answers zero: it is touching the ball where it stands.
 */
function distanceToContact(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  ball: Body,
  radius: number,
  limit: number,
): number | undefined {
  const touching = radius + ball.radius;
  const offsetX = x - ball.position.x;
  const offsetY = y - ball.position.y;
  const half = offsetX * dirX + offsetY * dirY;
  const constant = offsetX * offsetX + offsetY * offsetY - touching * touching;
  const discriminant = half * half - constant;
  if (discriminant < 0) {
    return undefined;
  }
  const root = Math.sqrt(discriminant);
  const near = -half - root;
  const far = -half + root;
  if (far < 0) {
    return undefined;
  }
  const at = near >= 0 ? near : 0;
  return at <= limit ? at : undefined;
}

function pointAt(x: number, y: number, dirX: number, dirY: number, at: number): GuidePoint {
  return { x: x + dirX * at, y: y + dirY * at };
}

/**
 * SPEC section 11's prediction for a launch of this circle in this direction.
 *
 * The strength is deliberately not a parameter: see the header. The ball is
 * read for its position and radius alone and is never moved, so calling this
 * mid-frame cannot disturb the simulation it is predicting.
 */
export function predictGuide(circle: Body, ball: Body, angleRad: number): AimGuide {
  // THE TWO REFUSALS LIVE HERE AND NOWHERE ELSE. Everything below multiplies
  // and compares these two inputs, so a value that is not a number would come
  // back out as a path made of them; refusing once, at the door, is what lets
  // every function past this point be arithmetic rather than arithmetic plus a
  // guard. Neither is decorative: without the first the whole path is built
  // from a direction of NaN, and without the second every point carries the
  // starting point's own NaN across, and `tests/unit/aim-guide.test.ts` fails
  // on each of them on its own.
  if (!Number.isFinite(angleRad)) {
    return NO_GUIDE;
  }
  const start = circle.position;
  if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) {
    return NO_GUIDE;
  }
  const dirX = Math.cos(angleRad);
  const dirY = Math.sin(angleRad);
  const bounds = boundsFor(circle.radius);

  const wall = firstWall(start.x, start.y, dirX, dirY, bounds);
  const before = distanceToContact(
    start.x,
    start.y,
    dirX,
    dirY,
    ball,
    circle.radius,
    wall.at,
  );
  if (before !== undefined) {
    // The ball comes first, so there is no bounce to predict: the section's
    // marker is the end of the path and nothing is drawn past it.
    const touch = pointAt(start.x, start.y, dirX, dirY, before);
    return { path: [{ x: start.x, y: start.y }, touch], contact: touch, bounce: undefined };
  }

  const corner = pointAt(start.x, start.y, dirX, dirY, wall.at);
  const bouncedX = wall.wall === 'left' || wall.wall === 'right' ? -dirX : dirX;
  const bouncedY = wall.wall === 'bottom' || wall.wall === 'top' ? -dirY : dirY;
  const reach = firstWall(corner.x, corner.y, bouncedX, bouncedY, bounds).at;
  const after = distanceToContact(
    corner.x,
    corner.y,
    bouncedX,
    bouncedY,
    ball,
    circle.radius,
    reach,
  );
  if (after !== undefined) {
    const touch = pointAt(corner.x, corner.y, bouncedX, bouncedY, after);
    return {
      path: [{ x: start.x, y: start.y }, corner, touch],
      contact: touch,
      bounce: wall.wall,
    };
  }
  return {
    path: [
      { x: start.x, y: start.y },
      corner,
      pointAt(corner.x, corner.y, bouncedX, bouncedY, reach),
    ],
    contact: undefined,
    bounce: wall.wall,
  };
}
