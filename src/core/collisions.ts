/**
 * SPEC section 6.3, body against body: elastic, frictionless, with positional
 * separation applied before the impulse.
 *
 * THE THREE PARTS OF A PAIR, in the order the section states them, each one
 * load-bearing rather than a step in a recipe:
 *
 *   1. Separate.  `pen = (a.r + b.r) - |b.pos - a.pos|`, each body moved by
 *                 `(pen / 2) * n` in opposite directions. Without it a pair
 *                 sinks into itself and the impulse fires again next step on
 *                 an overlap that never came apart.
 *   2. Gate.      `dot(vRel, n) >= 0` means the pair is already separating, so
 *                 no impulse. Without this gate an overlapping pair has its
 *                 normal velocity reversed inward every step and the two lock
 *                 together and vibrate.
 *   3. Impulse.   `j = -(1 + e) * dot(vRel, n) / (1 / ma + 1 / mb)` applied
 *                 along `n` alone, with `e = 1`. The tangential component is
 *                 neither read nor written, which is what frictionless means
 *                 here. All three bodies weigh the same (SPEC section 6.1), so
 *                 the general form above reduces to exchanging the normal
 *                 components, and item B4 grades both statements.
 *
 * THE COINCIDENT CASE, and the reading taken. SPEC section 6.3: "When the
 * centres are coincident (|b.pos - a.pos| < 1e-6) the normal falls back to
 * (1, 0) and the separation is the full a.r + b.r." Read as the separation the
 * pair ends up holding rather than as a distance each body travels, which is
 * what the general rule already produces: at a distance of zero `pen` IS the
 * full `a.r + b.r`, so each body moves half of it and the two finish exactly
 * touching. The other reading, each body moving the full sum, would fling a
 * circle and the ball 104 px apart from a standing start and no sentence in
 * the section asks for that. The fallback direction is fixed rather than
 * random so the case stays deterministic, which is the half item B5 names.
 *
 * DESIGN section 3 position 2 calls `resolveContacts` once per fixed step.
 * Position 3, the walls, stays in `core/physics.ts` beside the containment it
 * extends.
 *
 * DESIGN section 1 puts this module under `core/`: it imports nothing outside
 * core, names no platform surface and reads no clock.
 */

import type { Body, World } from './bodies';
import { CIRCLE_RESTITUTION, SOLVER_ITERATIONS } from './config';
import type { Vec2 } from './vec2';
import { addScaled, copy, distanceSquared, dot, normalise, subtract, vec2 } from './vec2';

/**
 * The two vectors a pair needs, allocated once at module load.
 *
 * QUALITY-BAR section 1: the fixed-step hot path allocates nothing. A step
 * resolves three pairs four times over, so a pair-local pair of vectors would
 * be twenty-four objects per step and two thousand eight hundred and eighty
 * per second of play.
 *
 * Module scope is safe here because `core/` is single-threaded by construction
 * and `resolvePair` neither yields nor re-enters: both values are written and
 * read inside one call and mean nothing between calls.
 */
const contactNormal: Vec2 = vec2();
const closingVelocity: Vec2 = vec2();

/**
 * One pair, resolved by SPEC section 6.3. Returns true when the two were in
 * contact, so a caller can count contacts rather than infer them.
 *
 * Mutates both bodies in place. The order of the arguments is the order of the
 * normal, which points from `a` to `b`, and it is not free: `resolveContacts`
 * below fixes it for the three pairs the game has.
 */
export function resolvePair(a: Body, b: Body): boolean {
  const reach = a.radius + b.radius;

  // The cheap question first, and a total one. Most pairs are apart in most
  // steps and the square of the distance answers that without a square root.
  // Written as the refusal of a proven contact rather than as `> reach * reach`
  // so that a position which is not a number is not a contact either: SPEC
  // section 20 wants a poisoned value caught by the guard at the tail of the
  // step, not separated along a normal nobody can measure.
  if (!(distanceSquared(a.position, b.position) <= reach * reach)) {
    return false;
  }

  // 1. Separate first, along the contact normal.
  copy(contactNormal, b.position);
  subtract(contactNormal, a.position);
  const between = normalise(contactNormal, 1, 0);
  const penetration = reach - between;
  if (penetration > 0) {
    const half = penetration / 2;
    addScaled(a.position, contactNormal, -half);
    addScaled(b.position, contactNormal, half);
  }

  // 2. Gate on approach.
  copy(closingVelocity, b.velocity);
  subtract(closingVelocity, a.velocity);
  const approach = dot(closingVelocity, contactNormal);
  // SPEC section 6.3 states this as `dot(vRel, n) >= 0`. Written as the refusal
  // of a proven approach for the same reason as the test above: a relative
  // velocity that is not a number is not evidence the pair is closing, and
  // multiplying it into the other body's velocity would spread one poisoned
  // value across the world before SPEC section 20's guard ever saw it.
  if (!(approach < 0)) {
    return true;
  }

  // 3. Apply the impulse, along the normal alone.
  const impulse = (-(1 + CIRCLE_RESTITUTION) * approach) / (1 / a.mass + 1 / b.mass);
  addScaled(a.velocity, contactNormal, -(impulse / a.mass));
  addScaled(b.velocity, contactNormal, impulse / b.mass);
  return true;
}

/**
 * SPEC section 6.3: "All three pairs (player-ball, opponent-ball,
 * player-opponent) use the same resolution path, resolved in the fixed order
 * player-opponent, player-ball, opponent-ball, iterated 4 times per step so
 * that three bodies meeting at one point settle to under 1 px of residual
 * penetration."
 *
 * The order is fixed rather than incidental. Each pair is resolved against the
 * positions the pairs before it left, so a different order is a different
 * answer for any pile of three, and a seeded match would replay differently
 * after a reordering that looked like tidying. Item B5's three-body case pins
 * the order and the iteration count together, by the exact positions the four
 * passes produce.
 */
export function resolveContacts(world: World): void {
  for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {
    resolvePair(world.player, world.opponent);
    resolvePair(world.player, world.ball);
    resolvePair(world.opponent, world.ball);
  }
}
