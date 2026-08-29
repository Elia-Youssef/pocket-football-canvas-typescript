/**
 * Two-dimensional vector maths for the fixed-step hot path.
 *
 * QUALITY-BAR section 1: the fixed-step hot path allocates nothing, so every
 * operation here mutates a vector the caller already owns and returns it for
 * chaining. `vec2` is the one function that allocates, and it belongs to setup
 * rather than to a step.
 *
 * DESIGN section 1: this module is under `core/`, so it imports nothing outside
 * core, names no platform surface and reads no clock.
 */

import { COINCIDENT_EPSILON } from './config';

export interface Vec2 {
  x: number;
  y: number;
}

/** The one allocating call, for setup rather than for a step. */
export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, from: Vec2): Vec2 {
  out.x = from.x;
  out.y = from.y;
  return out;
}

/**
 * Positive zero in both components, written as a literal rather than reached by
 * arithmetic: a multiplication can produce negative zero, and a stopped body
 * whose velocity reads as negative zero compares unequal under Object.is to the
 * zero every test and every readout expects.
 */
export function zero(out: Vec2): Vec2 {
  out.x = 0;
  out.y = 0;
  return out;
}

/** `out -= other`, which is how a contact normal and a relative velocity start. */
export function subtract(out: Vec2, other: Vec2): Vec2 {
  out.x -= other.x;
  out.y -= other.y;
  return out;
}

/** `out += other * factor`, which is integration and separation both. */
export function addScaled(out: Vec2, other: Vec2, factor: number): Vec2 {
  out.x += other.x * factor;
  out.y += other.y * factor;
  return out;
}

export function scale(out: Vec2, factor: number): Vec2 {
  out.x *= factor;
  out.y *= factor;
  return out;
}

/**
 * The touching test SPEC section 6.3 asks of every pair, every pass, without a
 * square root: two bodies are apart when this is over the square of the sum of
 * their radii. `distance` below is for the cases that want the number itself.
 */
export function distanceSquared(from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return dx * dx + dy * dy;
}

export function distance(from: Vec2, to: Vec2): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** SPEC section 6.3's approach gate reads this against the contact normal. */
export function dot(one: Vec2, other: Vec2): number {
  return one.x * other.x + one.y * other.y;
}

export function fromAngle(out: Vec2, radians: number, magnitude: number): Vec2 {
  out.x = Math.cos(radians) * magnitude;
  out.y = Math.sin(radians) * magnitude;
  return out;
}

/**
 * Normalise in place, with the fallback stated by the caller rather than chosen
 * here, and the original length returned so a caller that also needs the
 * distance does not measure it twice.
 *
 * SPEC section 6.3 fixes the fallback for the case this exists for: when two
 * centres are coincident the contact normal is `(1, 0)`, chosen rather than
 * random so that the case stays deterministic. A length that is not finite
 * takes the same fallback, because there is no direction in it either.
 *
 * THE ONE CALLER IS `core/collisions.ts`, which passes that `(1, 0)` and is
 * where item B5 grades the coincident case: two bodies dropped on one point
 * come apart along the positive x axis by the sum of their radii, in the same
 * direction on every run. The fallback is stated by the caller rather than
 * chosen here so that this module owes nothing to SPEC section 6.3.
 */
export function normalise(out: Vec2, fallbackX: number, fallbackY: number): number {
  const measured = Math.hypot(out.x, out.y);
  if (!Number.isFinite(measured) || measured < COINCIDENT_EPSILON) {
    out.x = fallbackX;
    out.y = fallbackY;
    return Number.isFinite(measured) ? measured : 0;
  }
  out.x /= measured;
  out.y /= measured;
  return measured;
}

/**
 * Clamp the magnitude to a ceiling, in place. Returns true when the ceiling
 * bound the vector, so a caller can report the clamp rather than infer it.
 *
 * A non-finite component has no magnitude to compare, so it is not this
 * function's to repair: `core/physics.ts` sanitises those against SPEC section
 * 20 before anything reads them.
 */
export function limit(out: Vec2, ceiling: number): boolean {
  const measured = Math.hypot(out.x, out.y);
  if (!Number.isFinite(measured) || measured <= ceiling) {
    return false;
  }
  const factor = ceiling / measured;
  out.x *= factor;
  out.y *= factor;
  return true;
}

/** SPEC section 20: the question a physics step asks of every body it touches. */
export function isFiniteVec2(of: Vec2): boolean {
  return Number.isFinite(of.x) && Number.isFinite(of.y);
}
