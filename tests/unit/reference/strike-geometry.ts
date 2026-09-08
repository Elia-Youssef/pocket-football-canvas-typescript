/**
 * A second implementation of SPEC section 8.1's strike geometry, written from
 * the specification alone.
 *
 * NOT A TEST FILE, AND NOT A COPY OF ANYTHING UNDER src/. The workspace's
 * verification rule reserves `tests/unit/reference/` for second implementations
 * written from `SPEC.md` and importing nothing from the game, so that the
 * expected value for a rule which is easy to misread comes from the document
 * rather than from the code being graded. Nothing here imports from
 * `src/`, and the constants below are read off the specification rather than
 * from the configuration module; the test that consumes this module ties each
 * one back to the shipped constant, so a restatement cannot drift silently.
 *
 * THE SOURCES, clause by clause.
 *   SPEC section 4    the radii: a circle is 34, the ball is 18, so the two
 *                     touch when their centres are 52 apart.
 *   SPEC section 6.1  equal masses and an elastic circle restitution of 1.
 *   SPEC section 6.3  the contact response exchanges the normal components of
 *                     the two velocities and leaves the tangential ones
 *                     untouched, with `n = normalize(b.pos - a.pos)`.
 *   SPEC section 8.1  `side` is the unit vector from the ball centre toward the
 *                     point on the ball's surface to be struck, and the ball
 *                     departs along -side; a straight launch reaches that point
 *                     exactly when `dot(striker - ball, side) > 34 + 18`, a
 *                     length in pixels and never a cosine; strike solidity is
 *                     1.0 for a dead-centre strike along the ideal line and 0
 *                     for a tangential graze; the rule clamps the desired side
 *                     into the reachable cone, takes the reachable side closest
 *                     to the ideal one, and holds every choice at or above 0.25
 *                     so the fallback cannot degrade into a graze; the aim is
 *                     the exact contact point, and 2 px past the touching
 *                     distance turns a solid hit into a whiff.
 *
 * THE AIM POINT IS THE TOUCHING DISTANCE, and section 8.1's own reachability
 * test is what fixes it. Write the striker offset `d = striker - ball`,
 * `gap = |d|`, `a = dot(d, side)`, and aim the striker's CENTRE at
 * `A = ball + 52 * side`. With `w = A - striker`, the centre path meets the
 * contact disc where `|d + t * w / |w|| = 52`, whose two roots multiply to
 * `gap^2 - 52^2`; one of them is `|w|`, so `A` is the FIRST of the two when
 * `|w|^2 <= gap^2 - 52^2`, which reduces to `a >= 52`. That is section 8.1's
 * condition, and it is derivable for no other aim distance: an aim at the ball
 * surface, 18 px along the side, enters the disc earlier and at a normal pulled
 * toward the striker's own approach, so "the ball departs along -side" fails.
 *
 * SOLIDITY IS THE SPEED TRANSFER, which is what section 8.1's two endpoints
 * describe. At `A` the contact normal from the striker's centre to the ball's
 * is exactly -side, so the equal-mass elastic exchange of section 6.3 hands the
 * ball the component of the arrival velocity along that normal, a fraction
 * `dot(w / |w|, -side) = (a - 52) / sqrt(gap^2 - 104 a + 2704)` of the arrival
 * speed. It is 1 when the striker stands on the side's own axis (`a = gap`, the
 * dead-centre strike) and 0 when `a = 52` (the tangential graze), and it is
 * positive exactly on the sides section 8.1 calls reachable.
 *
 * THIS IS A READING, AND HERE IS WHAT IT REPLACES. Section 8.1 names the
 * quantity as `dot(n, -side)` at the moment of contact; aimed at `A` the
 * contact normal IS -side, so that expression is identically 1 and the floor
 * the same sentence states could never bind. The quantity above is the one
 * that carries the two endpoints the section gives it, so it is what the floor
 * is applied to here and in the routine this module grades.
 *
 * THE FLOOR IS ONE BOUND ON THE APPROACH COSINE. Requiring that transfer to be
 * at least `f` squares to `a^2 - 2 * 52 * a * (1 - f^2) + 52^2 * (1 - f^2) -
 * f^2 * gap^2 >= 0`, whose relevant root is
 * `a* = 52 (1 - f^2) + f sqrt(gap^2 - 2704 (1 - f^2))`, so a side is admissible
 * exactly when `dot(approach, side) >= a* / gap`. At f = 0.25 that bound is 1.0
 * at gap 52 and falls toward 0.25 as the gap grows, and it exceeds `52 / gap`
 * at every gap beyond the touching distance, so the one bound carries both
 * section 8.1's reachability and its floor.
 */

/** A point in the design space SPEC section 3 defines. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** SPEC section 4: either circle's radius, in design pixels. */
export const STRIKER_RADIUS = 34;

/** SPEC section 4: the ball's radius, in design pixels. */
export const BALL_RADIUS = 18;

/** SPEC section 8.1's `opponentRadius + ballRadius`: the touching distance. */
export const TOUCHING = STRIKER_RADIUS + BALL_RADIUS;

/** SPEC section 8.1: the minimum strike solidity every chosen side is held to. */
export const MIN_SOLIDITY = 0.25;

/** A unit vector, or nothing when the input has no direction to give. */
function unit(x: number, y: number): Point | undefined {
  const length = Math.hypot(x, y);
  if (!(length > 0) || !Number.isFinite(length)) {
    return undefined;
  }
  return { x: x / length, y: y / length };
}

/**
 * SPEC section 8.1's ideal side: the unit vector from the target back to the
 * ball, so that a ball departing along -side travels toward the target.
 */
export function idealSide(ball: Point, target: Point): Point | undefined {
  return unit(ball.x - target.x, ball.y - target.y);
}

/** The aim point of a strike on `side`: the striker's centre at contact. */
export function aimPointFor(ball: Point, side: Point): Point {
  return { x: ball.x + TOUCHING * side.x, y: ball.y + TOUCHING * side.y };
}

/** The launch angle that aim point names, radians, as `atan2` gives it. */
export function aimAngleFor(striker: Point, ball: Point, side: Point): number {
  const aim = aimPointFor(ball, side);
  return Math.atan2(aim.y - striker.y, aim.x - striker.x);
}

/**
 * Where a straight path of the striker's CENTRE toward `aim` first reaches the
 * contact disc, or nothing when the path never does. Solved as the quadratic
 * rather than through the identity the header derives, so that the identity is
 * something a test can check rather than something this module assumes.
 */
export function firstContact(
  striker: Point,
  ball: Point,
  aim: Point,
): Point | undefined {
  const direction = unit(aim.x - striker.x, aim.y - striker.y);
  if (direction === undefined) {
    return undefined;
  }
  const offsetX = striker.x - ball.x;
  const offsetY = striker.y - ball.y;
  const outside = offsetX * offsetX + offsetY * offsetY - TOUCHING * TOUCHING;
  if (outside <= 0) {
    // Already touching: the contact is where the striker stands.
    return { x: striker.x, y: striker.y };
  }
  const along = 2 * (offsetX * direction.x + offsetY * direction.y);
  const discriminant = along * along - 4 * outside;
  if (discriminant < 0) {
    return undefined;
  }
  const at = (-along - Math.sqrt(discriminant)) / 2;
  if (at < 0) {
    return undefined;
  }
  return { x: striker.x + at * direction.x, y: striker.y + at * direction.y };
}

/** What a contact hands the ball: the direction it leaves along, and the share. */
export interface Departure {
  /** The unit contact normal, which SPEC section 6.3 sends the ball along. */
  readonly direction: Point;
  /** The fraction of the striker's arrival speed the exchange transfers. */
  readonly transfer: number;
}

/**
 * The departure of a launch aimed at `aim`, measured at its first contact: the
 * contact normal of section 6.3, and the cosine between the arrival and that
 * normal, which for equal masses at restitution 1 is the transferred share.
 */
export function departureAt(
  striker: Point,
  ball: Point,
  aim: Point,
): Departure | undefined {
  const path = unit(aim.x - striker.x, aim.y - striker.y);
  const contact = firstContact(striker, ball, aim);
  if (path === undefined || contact === undefined) {
    return undefined;
  }
  const normal = unit(ball.x - contact.x, ball.y - contact.y);
  if (normal === undefined) {
    return undefined;
  }
  return {
    direction: normal,
    transfer: path.x * normal.x + path.y * normal.y,
  };
}

/**
 * The strike solidity of `side` in closed form: the share of the arrival speed
 * a launch aimed at that side's touching point transfers. A striker already at
 * the touching point has no path left to arrive along and is dead centre by
 * construction, which is the total answer at the one degenerate input.
 */
export function solidityOf(striker: Point, ball: Point, side: Point): number {
  const offsetX = striker.x - ball.x;
  const offsetY = striker.y - ball.y;
  const gap = Math.hypot(offsetX, offsetY);
  const along = offsetX * side.x + offsetY * side.y;
  // `gap^2 - 2 * TOUCHING * along + TOUCHING^2`, grouped as two non-negative
  // terms. The expansion is the same quantity either way, but written as a
  // difference it cancels to nothing as the gap approaches the touching
  // distance, which is where a resting contact leaves the bodies.
  const leg = (gap - TOUCHING) * (gap - TOUCHING) + 2 * TOUCHING * (gap - along);
  if (!(leg > 0)) {
    return 1;
  }
  return (along - TOUCHING) / Math.sqrt(leg);
}

/** SPEC section 8.1's admissibility: reachable, and no weaker than the floor. */
export function admits(
  striker: Point,
  ball: Point,
  side: Point,
  floor: number,
): boolean {
  return solidityOf(striker, ball, side) >= floor;
}

/**
 * The lower bound on `dot(approach, side)` that admissibility at `floor`
 * imposes, for a striker at `gap` from the ball centre. Defined for a gap at or
 * beyond the touching distance, which is where a cone exists at all.
 */
export function coneBound(gap: number, floor: number): number {
  const spread = 1 - floor * floor;
  const inner = gap * gap - TOUCHING * TOUCHING * spread;
  if (!(inner >= 0) || !Number.isFinite(inner)) {
    // No side clears the floor at this gap, or the gap is so large that the
    // square overflows. Either way the widest bound is the whole answer, and
    // a bound of 1 admits the approach alone.
    return 1;
  }
  return (TOUCHING * spread + floor * Math.sqrt(inner)) / gap;
}

/** A chosen side: the unit strike direction, whether it was clamped, its share. */
export interface ChosenSide {
  readonly x: number;
  readonly y: number;
  readonly clamped: boolean;
  readonly solidity: number;
}

/**
 * SPEC section 8.1's rule: the ideal side when it is admissible, otherwise the
 * admissible side closest to it, which is the ideal rotated toward the approach
 * until the bound holds and therefore lies in the plane the two span. A striker
 * inside the contact disc has no cone; section 8.1's geometry does not reach
 * that case and the straight-out push is the answer this reference gives it.
 */
export function clampToCone(
  striker: Point,
  ball: Point,
  target: Point,
  floor: number,
): ChosenSide {
  // SPEC section 6.3's own answer where a direction cannot be computed: the
  // coincident case falls back to (1, 0), fixed rather than random. A target
  // on the ball leaves no ideal, and the approach is the strike that names.
  const approach = unit(striker.x - ball.x, striker.y - ball.y) ?? { x: 1, y: 0 };
  const ideal = idealSide(ball, target) ?? approach;
  const gap = Math.hypot(striker.x - ball.x, striker.y - ball.y);
  const bound = coneBound(gap, floor);
  if (!(gap >= TOUCHING) || !Number.isFinite(bound)) {
    return { x: approach.x, y: approach.y, clamped: true, solidity: 1 };
  }
  const along = approach.x * ideal.x + approach.y * ideal.y;
  if (along >= bound) {
    return {
      x: ideal.x,
      y: ideal.y,
      clamped: false,
      solidity: solidityOf(striker, ball, ideal),
    };
  }
  const perpendicular = unit(
    ideal.x - approach.x * along,
    ideal.y - approach.y * along,
  ) ?? { x: -approach.y, y: approach.x };
  const spread = Math.sqrt(Math.max(0, 1 - bound * bound));
  const side = {
    x: approach.x * bound + perpendicular.x * spread,
    y: approach.y * bound + perpendicular.y * spread,
  };
  return {
    x: side.x,
    y: side.y,
    clamped: true,
    solidity: solidityOf(striker, ball, side),
  };
}

/**
 * SPEC section 8's whiff, read as its stated purpose: the launch line passes
 * the ball cleanly rather than grazing it, laid off the ball centre by 1.15 of
 * the touching distance. The clearance a line through the striker can carry is
 * the gap itself at most, so this is the offset where the gap admits it and the
 * gap where it does not.
 */
export function whiffClearance(gap: number, offset: number): number {
  return Math.min(offset * TOUCHING, gap);
}
