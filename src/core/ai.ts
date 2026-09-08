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
 * THE LAUNCH AIMS AT THE TOUCHING DISTANCE, which is the point section 8.1's
 * own reachability test is written for. Aim the striker's CENTRE at
 * `ball + TOUCHING * side`. The centre path meets the contact disc where
 * `|offset + t * step| = TOUCHING`, and the two roots of that quadratic
 * multiply to `gap^2 - TOUCHING^2`, so the aim point is the FIRST of them
 * exactly when `dot(offset, side) >= TOUCHING` - the reachable test above,
 * derivable at no other aim distance. Reaching it, the contact normal is
 * -side exactly and the ball departs along -side as section 8.1 states. The
 * ball's own surface point, 18 px along the side, enters the disc earlier and
 * at a normal pulled toward the striker's approach. Both readings are
 * measured over the same population in tests/unit/ai-aim.test.ts, the 96
 * layouts of its playfield grid: the departure sits 1.89 degrees off the
 * chosen side on average aimed here, and 36.44 off aimed at the surface
 * point, which the harness entry named for that aim distance restores in one
 * edit. Section 8.1 forbids a margin the other way as well, and the entry
 * beside it takes the 2 px the section names.
 *
 * STRIKE SOLIDITY IS THE SPEED TRANSFER OF THAT LAUNCH. Section 8.1 reads it
 * as dot(n, -side) at the moment of contact, with n the unit normal from the
 * striker's centre to the ball's, and names its two ends: 1.0 for a
 * dead-centre strike along the ideal line, 0 for a tangential graze. Aimed at
 * the touching point the normal is -side identically, so the quantity that
 * carries those two ends is the share of the arrival speed the equal-mass
 * elastic exchange of section 6.3 hands the ball,
 * `(a - TOUCHING) / sqrt(gap^2 - 2 * TOUCHING * a + TOUCHING^2)` with
 * `a = dot(offset, side)`: 1 when the striker stands on the side's own axis,
 * 0 at `a = TOUCHING`, and positive exactly on the reachable sides. Holding
 * it at or above MIN_STRIKE_SOLIDITY is one bound on the approach cosine,
 * `coneBound` below, and that bound exceeds the bare reachability cosine at
 * every gap past the touching distance, so one test carries both rules.
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

/**
 * SPEC section 8: a whiff offsets the aim by this multiple of the touching
 * distance. Exported because a constant the specification states by value is
 * pinned against that literal, in tests/unit/ai-difficulty.test.ts.
 */
export const WHIFF_OFFSET = 1.15;

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
  /** True when the ideal side was inadmissible and the cone clamp chose. */
  readonly clamped: boolean;
  /** The launch's speed transfer, at or above MIN_STRIKE_SOLIDITY for every choice. */
  readonly solidity: number;
}

/**
 * The share of its arrival speed a launch aimed at the touching point of a
 * side hands the ball, for a striker `gap` away whose offset projects `along
 * * gap` onto that side. The one degenerate input is a striker standing on
 * the touching point already, which has no path left to arrive along and is
 * dead centre by construction; every other input is a plain cosine.
 */
function strikeSolidity(gap: number, along: number): number {
  const reach = along * gap;
  // The path length squared, written as a sum of two non-negative terms
  // rather than as `gap^2 - 2 * TOUCHING * reach + TOUCHING^2`. The two are
  // the same quantity, expanded either way, but the difference form cancels
  // to nothing as the gap approaches the touching distance and takes every
  // digit of the answer with it: at a gap of 52.00000000001 it reports a
  // dead-centre strike as a graze. This form keeps the two ends exact - a
  // dead-centre strike divides the same subtraction by itself and is 1 - and
  // never subtracts one large quantity from another.
  const leg = (gap - TOUCHING) * (gap - TOUCHING) + 2 * TOUCHING * gap * (1 - along);
  if (!(leg > 0)) {
    return 1;
  }
  return (reach - TOUCHING) / Math.sqrt(leg);
}

/**
 * The lower bound MIN_STRIKE_SOLIDITY puts on dot(approach, side), inverted
 * from the transfer above: `a >= TOUCHING (1 - f^2) + f sqrt(gap^2 -
 * TOUCHING^2 (1 - f^2))`, divided by the gap to read as a cosine. It is 1 at
 * the touching distance and falls toward MIN_STRIKE_SOLIDITY as the gap
 * grows, and it is above TOUCHING / gap at every gap past the touching
 * distance, so a side that clears this bound is reachable in section 8.1's
 * sense as well as solid.
 */
function coneBound(gap: number): number {
  const spread = 1 - MIN_STRIKE_SOLIDITY * MIN_STRIKE_SOLIDITY;
  const inner = gap * gap - TOUCHING * TOUCHING * spread;
  return (TOUCHING * spread + MIN_STRIKE_SOLIDITY * Math.sqrt(inner)) / gap;
}

/**
 * A unit vector along (x, y), or the fallback direction when the input has
 * none to give: a zero length, or a coordinate that is not a number. Every
 * direction this module normalises goes through here, so a degenerate input
 * leaves with a stated direction rather than with NaN.
 */
function unitOr(x: number, y: number, fallback: Vec2): Vec2 {
  const length = Math.hypot(x, y);
  if (!(length > 0) || !Number.isFinite(length)) {
    return { x: fallback.x, y: fallback.y };
  }
  return { x: x / length, y: y / length };
}

/**
 * SPEC section 6.3's own answer for a normal that cannot be computed: the
 * coincident case falls back to (1, 0), fixed rather than random so the case
 * stays deterministic. The same constant serves every degenerate direction
 * here, for the same reason.
 */
const FIXED_FALLBACK: Vec2 = { x: 1, y: 0 };

/**
 * SPEC section 8.1's rule, on its own for the sweep to walk the playfield
 * with. `target` is the point the ball is being sent toward, which makes the
 * ideal side the unit vector from the target to the ball: the ball departs
 * along minus the side, so the strike point sits on the far side from the
 * goal.
 *
 * The clamp is the projection the geometry gives: the admissible sides are
 * those within arccos(coneBound(gap)) of the approach, so the closest
 * admissible side to an inadmissible ideal is the cone boundary point along
 * the ideal's own perpendicular, which is what falls out below.
 *
 * THE FLOOR BINDS EVERY CHOSEN SIDE, not the clamped ones alone. Section
 * 8.1's sentence puts the 0.25 on the fallback, "so the fallback cannot
 * degrade into a graze", and item D3's criterion puts it on the outcome:
 * every chosen direction reaches the ball with meaningful speed transfer. A
 * reachable ideal whose transfer is under the floor is a graze by the same
 * measurement, so it is clamped like an unreachable one and the criterion's
 * "every" is honoured; the two readings differ only for a glancing ideal, and
 * tests/unit/ai-aim.test.ts pins the difference by literal coordinates.
 *
 * A striker already inside the contact distance has no cone at all; it pushes
 * straight out along its approach, which sends the ball away from it and
 * never backward through it.
 */
export function chooseStrikeSide(
  striker: Vec2,
  ball: Vec2,
  target: Vec2,
): StrikeChoice {
  const approach = unitOr(striker.x - ball.x, striker.y - ball.y, FIXED_FALLBACK);
  const ideal = unitOr(ball.x - target.x, ball.y - target.y, approach);

  const gap = Math.hypot(striker.x - ball.x, striker.y - ball.y);
  const bound = coneBound(gap);
  if (!(gap >= TOUCHING) || !Number.isFinite(bound)) {
    // Inside the contact disc there is no reachable side; the straight-out
    // push is the only strike that cannot drive the ball back through the
    // striker, and it is dead centre by construction. Two other inputs leave
    // by this same door with the same answer: a gap that is not a number, and
    // one so large that the cone arithmetic overflows, which is 1.3e154 px
    // against a pitch whose widest separation is 1160.31.
    return { x: approach.x, y: approach.y, clamped: true, solidity: 1 };
  }

  const along = approach.x * ideal.x + approach.y * ideal.y;

  if (along >= bound) {
    return {
      x: ideal.x,
      y: ideal.y,
      clamped: false,
      solidity: strikeSolidity(gap, along),
    };
  }

  // The unit perpendicular component of the ideal, which points from the
  // approach axis toward the ideal side; the degenerate case is the striker
  // exactly opposite the strike point, where either wall of the cone is
  // equally close and the fixed rotation keeps the choice deterministic.
  const perpendicular = unitOr(
    ideal.x - approach.x * along,
    ideal.y - approach.y * along,
    { x: -approach.y, y: approach.x },
  );
  const spread = Math.sqrt(Math.max(0, 1 - bound * bound));
  return {
    x: approach.x * bound + perpendicular.x * spread,
    y: approach.y * bound + perpendicular.y * spread,
    clamped: true,
    // The floor itself, which is what the bound was inverted from, rather
    // than the transfer recomputed from it: the two agree to fifteen places
    // at every gap the pitch produces and the recomputation loses all of them
    // as the gap approaches the touching distance, where `gap^2 - 104 a +
    // 2704` and `a - TOUCHING` both go to zero. The test in
    // tests/unit/ai-aim.test.ts measures the constructed side's transfer
    // against the reference instead, which is the check this line would
    // otherwise be pretending to be.
    solidity: MIN_STRIKE_SOLIDITY,
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

/**
 * SPEC section 8.1's contact point: where the striker's CENTRE stands at the
 * moment it touches the chosen side, which is the touching distance along that
 * side and is the point the launch aims at.
 */
function contactPoint(ball: Vec2, side: StrikeChoice): Vec2 {
  return { x: ball.x + side.x * TOUCHING, y: ball.y + side.y * TOUCHING };
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
  /**
   * True when the whiff roll fired, which SPEC section 8 counts over turns.
   * The whiff transform belongs to strikes: a turn that rolled the whiff and
   * the block together carries this flag and the block's own aim.
   */
  readonly whiffed: boolean;
  /** True when the ideal side was inadmissible and the cone clamp chose. */
  readonly clamped: boolean;
  /** True when the winning candidate arrived by a wall bounce. */
  readonly wallShot: boolean;
  /**
   * The drawn angular error, radians, applied to the angle on every path but
   * the whiff. SPEC section 8 gives the whiff a stated purpose - the launch
   * passes the ball cleanly - and an error of up to 12 degrees laid on top of
   * the offset defeats it at most gaps, so on a whiffed turn the draw chooses
   * which side of the ball the launch passes and the offset carries the miss.
   * The difficulty table's error clause is graded on this value, which is
   * drawn identically on every turn.
   */
  readonly errorRad: number;
  /**
   * True when the defensive roll fired, whether or not the block was taken.
   * SPEC section 8 states `defensiveBias` as a probability, so the roll is
   * what a test measures that probability against; `defensive` is the outcome,
   * which the refused-lane fall-through can differ from.
   */
  readonly rolled: boolean;
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
 * THE BLOCK IS THE PROFILE'S ROLL AND NOTHING ELSE. SPEC section 8 defines
 * `defensiveBias` as THE probability of substituting the blocking target for
 * the strike, and gives it as 0.0, 0.15 and 0.30; a second, geometric reason
 * to substitute would make the effective probability the sum of the two and
 * would give Casual, whose stated probability is zero, a block on about a
 * third of its turns. The layouts section 8.1 names - the striker standing
 * between the ball and the goal it attacks - are answered by the clamp, which
 * is what section 8.1 states the remedy to be: the departure is held within
 * arccos(coneBound) of the axis away from the striker, so the closest
 * admissible side is the most goal-ward strike that layout has. The earlier
 * reading here, that no side the cone can offer helps, is false wherever the
 * angle from the axis away from the striker to the target is inside
 * arccos(coneBound) of it, which is most of the class once the aim sits at
 * the touching distance. What genuinely cannot be answered is the rest: the
 * layouts whose whole admissible fan reaches the mouth the striker defends,
 * which the soak in tests/unit/ai-aim.test.ts counts as a class and holds
 * every own goal it concedes inside.
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

  const towardX = ball.position.x - striker.position.x;
  const towardY = ball.position.y - striker.position.y;

  if (defensiveRoll) {
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
        rolled: true,
        solidity: 1,
      };
    }
    // A rolled block whose lane trip would play the ball is refused: the
    // striker is square behind the ball, every straight line to the block
    // point runs through it, and the strike below is what remains. The share
    // of rolls this takes is measured and pinned in
    // tests/unit/ai-difficulty.test.ts, because a refusal nobody counts is a
    // second substitution rule in disguise.
  }

  if (whiffed) {
    // SPEC section 8: a whiff offsets the aim point by 1.15 of the touching
    // distance along the tangent, SO THE LAUNCH PASSES THE BALL CLEANLY
    // rather than grazing it. The quantity that purpose names is the launch
    // LINE's distance from the ball centre, which is what the launch either
    // clears the ball by or does not; an aim point laid off the ball centre
    // carries the offset only in the far field and collapses to
    // offset * gap / hypot(gap, offset) close in, which is under the touching
    // distance for a gap below 105.3 px, so that reading struck the ball at
    // every gap up to 104, measured 2026-09-08. So the launch leaves at the
    // angle whose LINE stands the offset off the ball centre: a line at
    // asin(clearance / gap) from the direction to the ball clears it by
    // exactly `clearance`, and that is the offset itself wherever the gap
    // admits the tangent, which is the same aim point the far field gave.
    // A striker inside the offset circle has no such tangent and no line
    // through it can clear more than the gap, so the clearance is
    // the gap and the launch is the perpendicular. The sign rides on the
    // error draw, which keeps the pattern at four draws and the choice
    // deterministic.
    const reach = Math.max(Math.hypot(towardX, towardY), 1e-9);
    const sign = errorRad < 0 ? -1 : 1;
    const offset = WHIFF_OFFSET * TOUCHING;
    const clearance = Math.min(offset, reach);
    return {
      angle: Math.atan2(towardY, towardX) + sign * Math.asin(clearance / reach),
      power: drawnPower,
      defensive: false,
      whiffed: true,
      clamped: choice.clamped,
      wallShot: false,
      errorRad,
      rolled: defensiveRoll,
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
      rolled: defensiveRoll,
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
    rolled: defensiveRoll,
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
