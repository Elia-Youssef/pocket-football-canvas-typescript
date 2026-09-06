/**
 * The opponent: SPEC section 8's three difficulties, section 10's ladder, and
 * the reachable-cone rule of section 8.1 that DESIGN section 4 calls the one
 * piece of opponent logic that is easy to get wrong and expensive to leave
 * wrong. One aim routine, parameterised by a difficulty profile; the ladder
 * opponents are profiles on that routine, never separate code paths.
 *
 * THE REACHABLE CONE, AND WHY THE OBVIOUS AIM IS WRONG. To send the ball
 * toward the target goal, the striker has to hit the point on the ball's far
 * surface, the one on the opposite side from the goal. That strike point is
 * reachable by a straight launch exactly when the striker arrives from
 * outside it:
 *
 *   reachable(side) = dot(striker - ball, side) >= strikerRadius + ballRadius
 *
 * The left-hand side is a LENGTH IN PIXELS, the striker's offset projected on
 * the strike side, compared against the touching distance in pixels; it is
 * never normalised (SPEC section 8.1). When the striker stands between the
 * ball and the goal it attacks, the ideal side fails the test, and aiming at
 * it anyway clips the near side and drives the ball backwards, which in the
 * prior build put the ball into its own net in 10 of 300 simulated matches.
 * The routine clamps the desired side into the reachable cone, choosing the
 * reachable side closest to the ideal one, and holds every choice at or above
 * MIN_STRIKE_SOLIDITY so the fallback cannot degrade into a graze.
 *
 * STRIKE SOLIDITY IS THE SPEC'S FORMULA, READ AT THE APPROACH. SPEC section
 * 8.1 defines it as dot(n, -side) at the moment of contact, with n the unit
 * normal from the striker's centre to the ball's. A striker that barely moves
 * before contact has n along its own approach, so solidity(side) is
 * dot(approach, side): 1 for a dead-centre strike on the ideal line, 0 at a
 * tangential graze. Aiming at the contact point bends the arrival toward the
 * strike axis, so the reading below is the conservative end of what the
 * physics produces, which is what a floor is for.
 *
 * THE LAUNCH AIMS AT THE CONTACT POINT ITSELF, the point on the ball's
 * surface the chosen side names, with no safety margin: at a near-tangential
 * clamp, aiming 2 px past the touching distance turns the strike into a
 * whiff, while the surface point sits well inside the contact disc, so the
 * launch cannot skip past it.
 *
 * THE SEAM. Nothing here steps the match or reads a clock. A frame driver
 * polls `readout().opponentReady`, and when the seam is raised, calls
 * `respond`, which plans one shot against the world as it stands and answers
 * with an ordinary launch intent. The Ace candidate scoring runs the real
 * physics forward on a cloned world, so the routine cannot disagree with the
 * simulation about what a shot does, and it runs at the seam, between frames,
 * never inside a step. The caller seats the stream: `createRng(seed)
 * .split(OPPONENT_STREAM)` is the opponent's own consumer, derived rather
 * than drawn, so how much this module draws cannot shift any other.
 *
 * THE DRAW PATTERN IS FIXED AT FOUR DRAWS PER SHOT, every profile, in one
 * order: the defensive roll, the whiff roll, the angular error, the power
 * draw. Behaviour parameters change how the draws are used, never how many
 * are taken, and the candidate scoring takes none at all, so changing the
 * candidate count shifts no other consumer. Even the difficulty that derives
 * its power from the shot takes the power draw, and leaves it unused, so the
 * pattern stays one pattern.
 *
 * DESIGN section 1 puts this module under `core/`: it imports nothing outside
 * core, names no platform surface and reads no clock.
 */

import type { World } from './bodies';
import { createWorld, everyBodyStopped, launch, setVelocity } from './bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
  DAMPING,
  FIELD_BOTTOM,
  FIELD_TOP,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_LOW,
  LEFT_GOAL_LINE,
  MAX_LAUNCH_SPEED,
  MIN_LAUNCH_SPEED,
  RIGHT_GOAL_LINE,
  STOP_SPEED,
  launchSpeed,
} from './config';
import type { Side } from './goals';
import type { Match } from './match';
import { createSimulation } from './physics';
import type { Rng } from './rng';
import type { Vec2 } from './vec2';
import { distance, set } from './vec2';

/**
 * SPEC section 8.1: the minimum strike solidity, so a clamped side cannot
 * degrade into a graze. Pinned by literal in tests/unit/ai-aim.test.ts.
 */
export const MIN_STRIKE_SOLIDITY = 0.25;

/**
 * The stream name this module is seated on. One split per independent
 * consumer: the opponent draws from `root.split(OPPONENT_STREAM)` and nothing
 * else may reuse that name.
 */
export const OPPONENT_STREAM = 'opponent';

/** SPEC section 8: a whiff offsets the aim by this multiple of the touching distance. */
const WHIFF_OFFSET = 1.15;

/**
 * A derived shot asks for this multiple of the travel it needs, so the
 * striker arrives with speed in hand instead of dying on the ball. At 1.4
 * the striker still carries roughly forty percent of the trip's budget when
 * it makes contact, which scores as a strike rather than a nudge.
 */
const POWER_MARGIN = 1.4;

/** The fixed-step budget for one scored candidate, so a rogue shot cannot spin. */
const CANDIDATE_BUDGET = 5000;

/** The touching distance of the striker and the ball, in pixels. */
const TOUCHING = CIRCLE_RADIUS + BALL_RADIUS;

/** Pixels of speed lost per pixel travelled, from the per-second damping. */
const DECAY = -Math.log(DAMPING);

/** The centre of either goal mouth, which the config bounds own. */
const MOUTH_CENTRE_Y = (GOAL_OPENING_LOW + GOAL_OPENING_HIGH) / 2;

/** Radians in a degree, for a profile that states its error in degrees. */
const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * DESIGN section 4's profile, exactly: the seven parameters the whole
 * routine reads, and the only thing the difficulties and the ladder
 * opponents differ in.
 */
export interface OpponentProfile {
  /** The bound of the uniform angular error, in degrees. */
  readonly angularErrorDeg: number;
  /** The power01 band the draw or the derived shot is held to. */
  readonly powerBand: readonly [number, number];
  /** Whether wall-bounce candidates are scored at all. */
  readonly useWallShots: boolean;
  /** How many candidates are scored, 1 for a direct shot alone. */
  readonly candidateCount: number;
  /** The probability of a whiffed turn. */
  readonly whiffChance: number;
  /** Biases the power draw toward the top of the band. */
  readonly aggression: number;
  /** The probability of substituting the blocking target for the strike. */
  readonly defensiveBias: number;
}

/** SPEC section 8's table, as profiles. */
export const CASUAL: OpponentProfile = {
  angularErrorDeg: 12,
  powerBand: [0.4, 0.7],
  useWallShots: false,
  candidateCount: 1,
  whiffChance: 0.18,
  aggression: 0.2,
  defensiveBias: 0,
};

export const PRO: OpponentProfile = {
  angularErrorDeg: 4,
  powerBand: [0.5, 1],
  useWallShots: false,
  candidateCount: 1,
  whiffChance: 0,
  aggression: 0.5,
  defensiveBias: 0.15,
};

export const ACE: OpponentProfile = {
  angularErrorDeg: 1,
  powerBand: [0.55, 1],
  useWallShots: true,
  candidateCount: 3,
  whiffChance: 0,
  aggression: 0.85,
  defensiveBias: 0.3,
};

/** SPEC section 10: a named rung of the ladder, which is a profile and a name. */
export interface LadderOpponent {
  readonly name: string;
  readonly profile: OpponentProfile;
}

/**
 * SPEC section 10's six, in ladder order. Each quirk is a parameter on the
 * shared routine: Sparks always draws the top of its band, Bolt is given a
 * wider error and a hotter draw, Anchor substitutes the block most turns,
 * Vector buys precision and pays for it with wall candidates, Cinder lifts
 * the floor off its band, and Meridian narrows the error to half a degree
 * and caps the band so it never overhits.
 */
export const LADDER: readonly LadderOpponent[] = [
  { name: 'Sparks', profile: { ...CASUAL, aggression: 1 } },
  { name: 'Bolt', profile: { ...CASUAL, angularErrorDeg: 16, aggression: 0.75 } },
  { name: 'Anchor', profile: { ...PRO, defensiveBias: 0.85 } },
  {
    name: 'Vector',
    profile: { ...PRO, angularErrorDeg: 1.5, useWallShots: true, candidateCount: 3 },
  },
  { name: 'Cinder', profile: { ...ACE, powerBand: [0.7, 1], aggression: 1 } },
  { name: 'Meridian', profile: { ...ACE, angularErrorDeg: 0.5, powerBand: [0.55, 0.85] } },
];

/** A chosen strike side: the unit vector from the ball centre to the strike point. */
export interface StrikeChoice {
  readonly x: number;
  readonly y: number;
  /** True when the ideal side failed the reachable test and was clamped. */
  readonly clamped: boolean;
  /** dot(approach, side), at or above MIN_STRIKE_SOLIDITY for every choice. */
  readonly solidity: number;
}

/**
 * SPEC section 8.1's rule, on its own for the sweep to walk the playfield
 * with. `target` is the point the ball is being sent toward, which makes the
 * ideal side the unit vector from the target to the ball: the ball departs
 * along minus the side, so the strike point sits on the far side from the
 * goal.
 *
 * The clamp is the projection the geometry gives: the reachable sides are
 * those within arccos(max(TOUCHING / gap, MIN_STRIKE_SOLIDITY)) of the
 * approach, so the closest reachable side to an unreachable ideal is the cone
 * boundary point along the ideal's own perpendicular, which is what falls out
 * below. A striker already inside the contact distance has no cone at all; it
 * pushes straight out along its approach, which sends the ball away from it
 * and never backward through it.
 */
export function chooseStrikeSide(
  striker: Vec2,
  ball: Vec2,
  target: Vec2,
): StrikeChoice {
  const idealX = ball.x - target.x;
  const idealY = ball.y - target.y;
  const idealLength = Math.hypot(idealX, idealY);
  const ix = idealX / idealLength;
  const iy = idealY / idealLength;

  const offsetX = striker.x - ball.x;
  const offsetY = striker.y - ball.y;
  const gap = Math.hypot(offsetX, offsetY);
  const ux = offsetX / gap;
  const uy = offsetY / gap;

  if (!(gap >= TOUCHING)) {
    // Inside the contact disc there is no reachable side; the straight-out
    // push is the only strike that cannot drive the ball back through the
    // striker, and it is dead centre by construction.
    const x = gap > 0 ? ux : ix;
    const y = gap > 0 ? uy : iy;
    return { x, y, clamped: true, solidity: 1 };
  }

  // Both bounds are lower bounds on dot(approach, side): the reachable test
  // in pixels reads as the cosine TOUCHING / gap, and the solidity floor is
  // the cosine it is named for.
  const floor = Math.max(TOUCHING / gap, MIN_STRIKE_SOLIDITY);
  const along = ux * ix + uy * iy;

  if (along >= floor) {
    return { x: ix, y: iy, clamped: false, solidity: along };
  }

  // The unit perpendicular component of the ideal, which points from the
  // approach axis toward the ideal side; the degenerate case is the striker
  // exactly opposite the strike point, where either wall of the cone is
  // equally close and the fixed rotation keeps the choice deterministic.
  let perpX = ix - ux * along;
  let perpY = iy - uy * along;
  const perpLength = Math.hypot(perpX, perpY);
  if (perpLength < 1e-9) {
    perpX = -uy;
    perpY = ux;
  } else {
    perpX /= perpLength;
    perpY /= perpLength;
  }
  const spread = Math.sqrt(1 - floor * floor);
  return {
    x: ux * floor + perpX * spread,
    y: uy * floor + perpY * spread,
    clamped: true,
    solidity: floor,
  };
}

/** SPEC section 3: the player defends the left goal and attacks the right. */
function targetOf(side: Side): Vec2 {
  return side === 'opponent'
    ? { x: LEFT_GOAL_LINE, y: MOUTH_CENTRE_Y }
    : { x: RIGHT_GOAL_LINE, y: MOUTH_CENTRE_Y };
}

/** The mouth the side defends, whose midpoint with the ball is the block. */
function ownGoalOf(side: Side): Vec2 {
  return side === 'opponent'
    ? { x: RIGHT_GOAL_LINE, y: MOUTH_CENTRE_Y }
    : { x: LEFT_GOAL_LINE, y: MOUTH_CENTRE_Y };
}

/** The point on the ball's surface the chosen side names, which the launch aims at. */
function contactPoint(ball: Vec2, side: StrikeChoice): Vec2 {
  return { x: ball.x + side.x * BALL_RADIUS, y: ball.y + side.y * BALL_RADIUS };
}

/**
 * The power01 that carries the striker exactly POWER_MARGIN times the trip,
 * held inside the band. Inverting the travel of an exponentially damped body
 * gives the launch speed, and the one power scale of SPEC 6.1 gives the
 * strength, so a derived shot reads the same scale a drawn one does.
 */
function derivedPower(pathLength: number, band: readonly [number, number]): number {
  const speed = STOP_SPEED + POWER_MARGIN * pathLength * DECAY;
  const raw = (speed - MIN_LAUNCH_SPEED) / (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED);
  return Math.min(Math.max(raw, band[0]), band[1]);
}

/**
 * True when the straight path from the striker to the block point cannot
 * touch the ball. Every step endpoint of a launch lies on its own segment,
 * so the segment's distance from the ball centre deciding it is exact: at or
 * beyond the touching distance, no step can overlap, whatever the step size.
 */
function pathClearsBall(
  striker: Vec2,
  ball: Vec2,
  blockX: number,
  blockY: number,
): boolean {
  const legX = blockX - striker.x;
  const legY = blockY - striker.y;
  const lengthSquared = legX * legX + legY * legY;
  const raw =
    lengthSquared === 0
      ? 0
      : ((ball.x - striker.x) * legX + (ball.y - striker.y) * legY) / lengthSquared;
  const at = Math.min(Math.max(raw, 0), 1);
  const nearestX = striker.x + legX * at;
  const nearestY = striker.y + legY * at;
  return Math.hypot(nearestX - ball.x, nearestY - ball.y) >= TOUCHING;
}

/** One scored direction: the angle to launch, the power to launch it with. */
interface Candidate {
  readonly angle: number;
  readonly power: number;
  readonly wall: boolean;
}

/**
 * The candidates a shot is scored between: the direct clamped strike first,
 * then one candidate per wall, aimed by mirroring the striker across the wall
 * so the bounce arrives along the mirrored approach. Direct first is also the
 * tie-break, because a candidate only displaces the incumbent on a strictly
 * better score.
 */
function candidatesFor(
  world: World,
  side: Side,
  profile: OpponentProfile,
  choice: StrikeChoice,
): [Candidate, ...Candidate[]] {
  const striker = side === 'opponent' ? world.opponent : world.player;
  const ball = world.ball;
  const contact = contactPoint(ball.position, choice);
  const direct: Candidate = {
    angle: Math.atan2(contact.y - striker.position.y, contact.x - striker.position.x),
    power: derivedPower(
      distance(striker.position, contact),
      profile.powerBand,
    ),
    wall: false,
  };
  const list: [Candidate, ...Candidate[]] = [direct];
  if (profile.useWallShots) {
    for (const wallY of [FIELD_TOP, FIELD_BOTTOM]) {
      // The mirrored striker's own cone clamp picks the side the bounce
      // approach can actually deliver, and the aim is that approach's contact
      // point reflected back across the wall, which the straight launch meets
      // at the bounce.
      const mirrored = { x: striker.position.x, y: 2 * wallY - striker.position.y };
      const bounce = chooseStrikeSide(mirrored, ball.position, targetOf(side));
      const bounceContact = contactPoint(ball.position, bounce);
      const aimY = 2 * wallY - bounceContact.y;
      const path = Math.hypot(
        bounceContact.x - striker.position.x,
        aimY - striker.position.y,
      );
      list.push({
        angle: Math.atan2(aimY - striker.position.y, bounceContact.x - striker.position.x),
        power: derivedPower(path, profile.powerBand),
        wall: true,
      });
    }
  }
  return list;
}

/**
 * SPEC section 8: the candidate is scored by predicted ball displacement
 * toward the target, measured by running the real physics forward on a
 * cloned world, so the score cannot disagree with the simulation. A goal the
 * candidate would score or concede is carried by the displacement on its
 * own: the ball in either net is where the physics put it.
 */
function scoreCandidate(
  world: World,
  side: Side,
  candidate: Candidate,
  target: Vec2,
): number {
  const clone = createWorld();
  for (const body of world.bodies) {
    const twin = clone[body.kind];
    set(twin.position, body.position.x, body.position.y);
    setVelocity(twin, body.velocity.x, body.velocity.y);
  }
  const striker = side === 'opponent' ? clone.opponent : clone.player;
  launch(striker, candidate.angle, launchSpeed(candidate.power));
  const sim = createSimulation({ world: clone });
  const before = distance(clone.ball.position, target);
  for (let steps = 0; steps < CANDIDATE_BUDGET; steps += 1) {
    if (everyBodyStopped(clone) || sim.scoring.frozen()) {
      break;
    }
    sim.step();
  }
  return before - distance(clone.ball.position, target);
}

/** Everything one shot decided, which is what the tests and the seam read. */
export interface ShotPlan {
  /** The launch direction, radians, ready for a launch intent. */
  readonly angle: number;
  /** The launch strength on the one power01 scale of SPEC 6.1. */
  readonly power: number;
  /** True when the blocking target replaced the strike. */
  readonly defensive: boolean;
  /** True when the whiff roll fired and the aim was offset off the ball. */
  readonly whiffed: boolean;
  /** True when the ideal side was unreachable and the cone clamp chose. */
  readonly clamped: boolean;
  /** True when the winning candidate arrived by a wall bounce. */
  readonly wallShot: boolean;
  /** The drawn angular error, radians, already applied to the angle. */
  readonly errorRad: number;
  /** The chosen strike's solidity, 1 for a shot that strikes nothing. */
  readonly solidity: number;
}

/**
 * One opponent turn, from the world as it stands. The four draws are taken
 * unconditionally in the documented order, so the draw pattern is the same
 * for every profile; what a parameter changes is how its draw is used, never
 * that it is taken. The whiff flag is the roll, on every action; the whiff
 * transform, which lays the aim off the ball, belongs to strikes.
 *
 * THE BACKWARDS DISCIPLINE, which is the goal this part exists for. A launch
 * departs the ball along the contact normal, and for an approaching striker
 * that normal points from the striker to the ball. When it carries no
 * component toward the target - the striker stands between the ball and the
 * goal it attacks - no side the reachable cone can offer changes it: the
 * strike is a solid drive toward the striker's own goal, and no clamp, floor
 * or contact point repairs that, because the geometry of the contact fixes
 * the direction whatever the side says. Those turns are played as defensive
 * ones instead: the body takes the blocking target and the ball is left
 * alone. The drive that section 8.1 measured at 41.3 percent of layouts is
 * not re-aimed away from the net; it is not taken at all.
 */
export function planShot(
  world: World,
  profile: OpponentProfile,
  rng: Rng,
  side: Side = 'opponent',
): ShotPlan {
  const striker = side === 'opponent' ? world.opponent : world.player;
  const ball = world.ball;
  const target = targetOf(side);

  const defensiveRoll = rng.nextFloat() < profile.defensiveBias;
  const whiffed = rng.nextFloat() < profile.whiffChance;
  const spanRad = profile.angularErrorDeg * RADIANS_PER_DEGREE;
  const errorRad = (2 * rng.nextFloat() - 1) * spanRad;
  const [low, high] = profile.powerBand;
  const drawnPower = low + (high - low) * rng.nextFloat() ** (1 - profile.aggression);

  const choice = chooseStrikeSide(striker.position, ball.position, target);

  // The strike's departure, the contact normal of an approaching striker,
  // read against the target direction: negative, and the strike drives the
  // ball away from the goal it is meant to reach. Both lengths are positive,
  // so the sign of the plain product is the sign of the cosine.
  const towardX = ball.position.x - striker.position.x;
  const towardY = ball.position.y - striker.position.y;
  const targetX = target.x - ball.position.x;
  const targetY = target.y - ball.position.y;
  const backwards = towardX * targetX + towardY * targetY < 0;

  if (defensiveRoll || backwards) {
    // SPEC section 8: the blocking target, the midpoint of the ball-to-own-
    // goal line, is substituted for the strike, and the striker's body is
    // what travels. The substitution is honest only while the trip cannot
    // run the striker into the ball from an uncontrolled side; a trip that
    // would is refused below, and a rolled defensive turn on a forward
    // layout falls through to the ordinary strike, which is safe there.
    const goal = ownGoalOf(side);
    const blockX = (ball.position.x + goal.x) / 2;
    const blockY = (ball.position.y + goal.y) / 2;
    if (pathClearsBall(striker.position, ball.position, blockX, blockY)) {
      return {
        angle:
          Math.atan2(blockY - striker.position.y, blockX - striker.position.x) + errorRad,
        power: drawnPower,
        defensive: true,
        whiffed,
        clamped: false,
        wallShot: false,
        errorRad,
        solidity: 1,
      };
    }
    // A backwards turn whose lane trip is blocked is the residue this
    // routine cannot decline: the striker is square behind the ball, every
    // straight line to the block point plays it, and the clamped strike
    // below is what remains. The soak measures what the class costs.
  }


  if (whiffed) {
    // SPEC section 8: a whiff offsets the aim point by 1.15 of the touching
    // distance along the tangent, so the launch passes the ball cleanly
    // rather than grazing it. The tangent that delivers that is the one to
    // the approach axis, and the anchor is the ball itself: laid off the
    // ball, the launch clears it whichever side of it the striker is on,
    // which an anchor on the contact point cannot guarantee once the side
    // has been clamped. The sign rides on the error draw, which keeps the
    // pattern at four draws and the choice deterministic.
    const reach = Math.max(Math.hypot(towardX, towardY), 1e-9);
    const sign = errorRad < 0 ? -1 : 1;
    const offset = WHIFF_OFFSET * TOUCHING;
    const aimX = ball.position.x + (sign * -towardY * offset) / reach;
    const aimY = ball.position.y + (sign * towardX * offset) / reach;
    return {
      angle: Math.atan2(aimY - striker.position.y, aimX - striker.position.x),
      power: drawnPower,
      defensive: false,
      whiffed: true,
      clamped: choice.clamped,
      wallShot: false,
      errorRad,
      solidity: choice.solidity,
    };
  }

  if (profile.candidateCount > 1) {
    // Ace, and any profile that buys candidates: score each direction by
    // running the real physics forward, and take the best. This is the work
    // the pre-launch delay exists to hide, and it runs here, at the seam,
    // never inside a step.
    const list = candidatesFor(world, side, profile, choice);
    let best = list[0];
    let bestScore = -Infinity;
    for (const candidate of list) {
      const score = scoreCandidate(world, side, candidate, target);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return {
      angle: best.angle + errorRad,
      power: best.power,
      defensive: false,
      whiffed: false,
      clamped: choice.clamped,
      wallShot: best.wall,
      errorRad,
      solidity: choice.solidity,
    };
  }

  // The single-candidate shot: aim at the exact contact point of the chosen
  // side, with no safety margin, and draw the power from the band.
  const contact = contactPoint(ball.position, choice);
  return {
    angle:
      Math.atan2(contact.y - striker.position.y, contact.x - striker.position.x) +
      errorRad,
    power: drawnPower,
    defensive: false,
    whiffed: false,
    clamped: choice.clamped,
    wallShot: false,
    errorRad,
    solidity: choice.solidity,
  };
}

/**
 * The seam PF-7 exposed, answered. True when this call answered a raised
 * seam with the ordinary launch intent, false when the match was not waiting:
 * a driver polls, calls, and drives the match with the deltas it measures,
 * and nothing here steps anything or schedules anything.
 */
export function respond(match: Match, profile: OpponentProfile, rng: Rng): boolean {
  const readout = match.readout();
  if (readout.state.kind !== 'OPPONENT_TURN' || !readout.opponentReady) {
    return false;
  }
  const plan = planShot(match.world, profile, rng);
  match.dispatch({ kind: 'launch', angle: plan.angle, power: plan.power });
  return true;
}
