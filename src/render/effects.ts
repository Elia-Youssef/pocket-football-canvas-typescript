/**
 * SPEC section 14's motion set, and the one place reduced motion removes it.
 *
 * WHAT THIS LAYER IS. Every motion the section lists is a consequence of the
 * simulation rather than something a caller schedules: the ball trails because
 * it is moving, a flash happens because two bodies met, the surface shakes
 * because the meeting was hard. So this module OBSERVES the world once a frame
 * and derives its own events from what changed, and it never writes a body, a
 * velocity or a scoreboard. That is what makes SPEC section 14's "none of it
 * changes simulation timing" a property of the architecture instead of a
 * promise: `core/` cannot see this file, and this file cannot reach into it.
 *
 * REDUCED MOTION IS ONE FUNCTION. `effectSeconds` below is the renderer's
 * `duration` for game feel, and it takes the same shape for the same reason:
 * every lifetime resolves to zero and NOTHING skips a step or takes a branch.
 * The detection runs identically in both modes, the same events are recorded in
 * the same order, and the same draws come off the same seeded streams; what
 * changes is that every effect is already expired at the moment it is born, so
 * nothing is drawn and the shake is exactly zero. QUALITY-BAR section 4 asks
 * for the animation to be removed ENTIRELY while the sequence of states and the
 * outcome stay identical, and a blanket cancel is the implementation it
 * forbids: it also stops whatever was sequenced on the end of an animation from
 * ever arriving, which changes the order of states rather than the pacing.
 *
 * TIME ARRIVES THE WAY THE SIMULATION READS IT. `elapsedFor` applies
 * QUALITY-BAR section 7's readings exactly as `core/physics.ts` does, so the
 * effects clock advances by the same seconds the world did. Without that a
 * quarter-second hitch would age a trail by a whole second while the ball moved
 * a quarter of one, and a tab resume would expire the scene twice.
 *
 * DECAY IS PER SECOND. The one decaying quantity here is the shake, and it
 * decays as `energy *= SHAKE_DECAY_PER_SECOND ** dt`. A per-frame multiplier is
 * the defect class QUALITY-BAR section 7 records, and the negative control in
 * tests/unit/render-effects.test.ts implements the wrong form and requires the
 * check to detect it. Everything else here fades on the age it actually has,
 * which is frame-rate independent for the same reason and is an envelope rather
 * than a decay.
 *
 * ALL RANDOMNESS IS SEEDED. SPEC section 6 and STACK section 3 put every draw
 * on `core/rng.ts`, one `split()` stream per independent consumer. The shake's
 * direction and the goal burst's scatter take one stream each, so changing the
 * particle count cannot move the shake. `Math.random` appears nowhere; the lint
 * boundary does not police `render/`, so the discipline is stated here and
 * pinned by a test that scans this file.
 *
 * WHAT IS DELIBERATELY NOT HERE, and where each belongs. SPEC section 14's
 * block also names a kickoff hold of 0.6 s and a settle ease of 0.10 s, and its
 * bullet list also asks for the turn hand-off halo. The kickoff hold is
 * simulation pacing and belongs beside `GOAL_HOLD` in `core/config.ts`, which
 * this part does not own. The settle ease would have to draw a body somewhere
 * other than where the world says it is, and `entities.ts` gives no seam for
 * that. The hand-off halo is a state indicator rather than motion, so it must
 * survive reduced motion and cannot live in a layer whose whole policy is to
 * vanish under it. None of the three is named by the item this part closes;
 * all three are parked in the part's report rather than half-built here.
 */

import type { AimPreview } from '../core/aiming';
import type { Body, BodyKind, World } from '../core/bodies';
import {
  DELTA_CEILING,
  FIELD_BOTTOM,
  FIELD_HEIGHT,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIELD_WIDTH,
  FIXED_STEP,
  GOAL_FRAME_DEPTH,
  GOAL_HOLD,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_LOW,
  MIN_LAUNCH_SPEED,
  RESUME_GAP,
  WALL_THICKNESS,
} from '../core/config';
import { ballFitsOpening } from '../core/goals';
import type { GoalMouth, ScoringReadout } from '../core/goals';
import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import { arrowGeometry, arrowPath } from './arrow';
import { TAU } from './entities';
import { BORDER, RADIUS, SPACE, duration } from './tokens';
import type { PitchPalette } from './tokens';

/** The frame driver measures milliseconds; SPEC section 14 states seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * SPEC section 14's tunable block, in seconds, in one place exactly as the
 * section keeps it. The goal celebration is `GOAL_HOLD` rather than a second
 * spelling of 1.2: the celebration this layer draws is the hold the simulation
 * is already frozen for, and two constants for one duration is two places for
 * it to drift.
 */
export const EFFECT_SECONDS = {
  ballTrail: 0.18,
  impactFlash: 0.12,
  wallFlash: 0.15,
  screenShake: 0.2,
  goalCelebration: GOAL_HOLD,
} as const;

export type EffectStep = keyof typeof EFFECT_SECONDS;

/**
 * A game-feel duration in seconds, resolved against the reduced-motion policy.
 * The renderer's `duration` for the chrome scale and this are the same rule
 * written for the two sets QUALITY-BAR section 15 separates, and the zero is a
 * duration rather than a skipped step in both.
 *
 * The flag is a parameter and never a media query read: this layer states the
 * value and the composition root decides the policy.
 */
export function effectSeconds(step: EffectStep, reducedMotion: boolean): number {
  return reducedMotion ? 0 : EFFECT_SECONDS[step];
}

/**
 * SPEC section 14's shake, both terms, IN CSS PIXELS.
 *
 * The cap is a fraction of the play surface's rendered height, so a small
 * display is never shaken by a larger share of itself than a big one; the
 * energy term is a count of pixels, so the same stimulus does not grow on a
 * larger display, which is the sentence the section states the pair for.
 *
 * BOTH TERMS ARE IN THE SAME UNIT, and the unit is the CSS pixel. That is not
 * a detail: the height a surface renders at is a CSS height, and a term stated
 * in backing-store pixels would carry the device pixel ratio against a cap that
 * does not, so the same impact would shake half as far on a display at twice
 * the density. QUALITY-BAR section 7's third recorded failure mode is exactly a
 * ratio that fails to cancel; `pitch.ts` multiplies the offset by the backing
 * ratio once, in the one module that owns it, and nothing here sees a device
 * pixel.
 */
export const SHAKE_ENERGY_SCALE = 0.004;
export const SHAKE_HEIGHT_FRACTION = 0.015;

/**
 * The shake's per-second decay, in the one form QUALITY-BAR section 7 allows.
 * The constant is derived from the window rather than chosen: a tenth to the
 * tenth power, raised to SPEC section 14's 0.20 s, is exactly one hundredth, so
 * a hundredth of the peak survives the window and the cut at the end of it is
 * invisible rather than a step.
 */
export const SHAKE_DECAY_PER_SECOND = 1e-10;

/**
 * THE THREE OSCILLATION PERIODS, all off the chrome motion scale, because a
 * period is a duration and QUALITY-BAR section 15 owns every duration. Nothing
 * here invents one, and none of the three is a cycles-per-second figure chosen
 * in this file.
 *
 * TWO CONSTRAINTS DECIDE WHICH STEP EACH TAKES. SC 2.3.1 bounds anything that
 * reads as a flash at three a second, so the two that brighten and dim take two
 * of the longest step, 640 ms, which is 1.56 a second. The shake brightens
 * nothing and is bounded from the other side instead: sampled once a frame, a
 * period under twice the frame interval aliases, and at the 30 frames a second
 * QUALITY-BAR section 6 budgets for, that turns the shake into full-amplitude
 * alternation, which is the worst possible profile for the player the reduced
 * motion setting exists for. The 140 ms step gives four samples a cycle at 30
 * frames a second and nineteen at 144.
 *
 * The reduced-motion argument is deliberately `false` in the two resolved here:
 * an effect whose lifetime is already zero is never drawn, so zeroing its
 * period as well would only divide by zero on the way to drawing nothing.
 */
const SHAKE_PERIOD_SECONDS = duration(2, false) / MILLISECONDS_PER_SECOND;
const SLOW_PULSE_STEPS = 2;
const CELEBRATION_PERIOD_SECONDS =
  (duration(4, false) * SLOW_PULSE_STEPS) / MILLISECONDS_PER_SECOND;

/**
 * SPEC section 14 shakes on a HARD collision. The weakest legal shot is the
 * minimum launch speed, so a meeting that changes a velocity by less than that
 * is softer than the softest shot a player can take and is not a hard one.
 */
export const HARD_IMPACT_ENERGY = MIN_LAUNCH_SPEED;

/**
 * QUALITY-BAR section 4, SC 2.3.1: nothing flashes more than three times in any
 * one second, measured on a rolling window, and where the flashes are emergent
 * from a simulation the effects layer enforces the limit rather than the
 * physics.
 *
 * PER REGION, WHICH IS THE MECHANISM THE SECTION NAMES, and deliberately not
 * also across the whole surface. A whole-surface budget of the same size was
 * built first and measured: two hundred collisions spread over fifty region
 * slots admitted three flashes and refused a hundred and ninety-seven, so the
 * per-region rule the section states became dead text and most of the motion
 * item E5 grades disappeared with it. The criterion is about a THING flashing
 * repeatedly, and each flash here is a small local object well under the
 * general threshold's large-area rule, so the region is the right unit and the
 * grid below is what makes it one.
 */
export const FLASHES_PER_WINDOW = 3;
export const FLASH_WINDOW_SECONDS = 1;

/** The grid the limiter counts in. A count is not a dimension and has no token. */
const REGION_COLUMNS = 8;
const REGION_ROWS = 4;

/** Every size resolves through the scales; every ratio is a shape, not a size. */
const FLASH_RADIUS = SPACE[5];
const WALL_SEGMENT_SPAN = SPACE[8];
const PARTICLE_RADIUS = RADIUS.sm;

/**
 * Alphas. Not a colour, a size, a radius or a duration, so none of them has a
 * token to resolve through; they are pinned by the armour tests instead, the
 * way `pitch.ts` pins the vignette's, so none can quietly become a fill.
 */
const TRAIL_PEAK_ALPHA = 0.45;
const FLASH_PEAK_ALPHA = 0.7;
const CELEBRATION_PEAK_ALPHA = 0.8;
const PULSE_PEAK_ALPHA = 0.55;

/** The burst, from primitives: a count and a share of the weakest legal shot. */
const BURST_PARTICLES = 12;
const BURST_SLOWEST_RATIO = 0.5;

/**
 * A floating-point tolerance, not a dimension: two positions this close are one
 * position, the same reading `COINCIDENT_EPSILON` takes in `core/config.ts`.
 */
const CONTACT_SLACK = 1e-6;

/** The events this layer derives, for the readout and for a capture script. */
export type EffectEventKind = 'impact' | 'wall' | 'goal';

export interface EffectEvent {
  readonly kind: EffectEventKind;
  /** Seconds on the effects clock, which advances with simulation time. */
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** The velocity change the meeting produced, in design units per second. */
  readonly energy: number;
  /** False when no flash was drawn: too soft to be hard, or rate limited. */
  readonly admitted: boolean;
}

/** The shake, in rendered pixels, as the frame composition applies it. */
export interface ShakeOffset {
  readonly x: number;
  readonly y: number;
}

const NO_SHAKE: ShakeOffset = Object.freeze({ x: 0, y: 0 });

export interface EffectsReadout {
  /** Seconds of simulation time the effects layer has seen. */
  readonly now: number;
  /** The trail's length in design units, which a speed makes long or short. */
  readonly trailLength: number;
  /** Trail samples still inside the window. */
  readonly trailSamples: number;
  /** The shake's decayed energy, before the cap the display applies. */
  readonly shakeEnergy: number;
  readonly impactFlashes: number;
  readonly wallFlashes: number;
  readonly particles: number;
  /** Seconds of celebration still to run, zero when none is running. */
  readonly celebration: number;
  /** Draws taken from the seeded streams, which reduced motion may not change. */
  readonly draws: number;
  /** Flashes the rate limiter refused, which SC 2.3.1 requires it to. */
  readonly refusals: number;
}

/** What the frame composition asks of this layer, and all it may ask. */
export interface EffectsFrame {
  /** SPEC section 14's shake for a surface of this rendered height. */
  shake(renderedHeight: number): ShakeOffset;
  /** DESIGN section 7's effects-behind-entities pass. */
  drawBehind(context: CanvasRenderingContext2D, palette: PitchPalette): void;
  /** DESIGN section 7's effects-in-front pass, after the aim arrow. */
  drawInFront(
    context: CanvasRenderingContext2D,
    palette: PitchPalette,
    world: World,
    aim: AimPreview | null,
  ): void;
}

/** One frame of the world, as this layer is allowed to see it: read only. */
export interface EffectsObservation {
  readonly world: World;
  readonly scoring: ScoringReadout;
  /** The frame's own elapsed seconds, as the frame driver measured them. */
  readonly elapsed: number;
  /** The policy, decided outside `render/` and passed in. */
  readonly reducedMotion: boolean;
}

export interface Effects extends EffectsFrame {
  observe(observation: EffectsObservation): void;
  readout(): EffectsReadout;
  /** The derived events, newest last, bounded so a long match cannot grow. */
  events(): readonly EffectEvent[];
}

export interface EffectsOptions {
  /**
   * The seed every stream here is derived from. The match seed is PF-9's, and
   * arrives as this option the day the modes own one; until then the effects
   * are seeded by their own name, which is still a seeded stream and still
   * reproduces exactly.
   */
  readonly seed?: string | number;
}

/** The default seed, and the two stream names nothing else may reuse. */
export const EFFECTS_SEED = 'pocket-football-effects';
const SHAKE_STREAM = 'shake';
const BURST_STREAM = 'goal-burst';

/** The longest event log kept, so a long match cannot grow without bound. */
const EVENT_LOG_LIMIT = 64;

/**
 * QUALITY-BAR section 7, in the order `core/physics.ts` reads it: a delta that
 * is negative or not a number is no time, a gap longer than the resume bound is
 * a resume and consumes none, and anything above the ceiling is the ceiling.
 * The effects clock therefore advances by the seconds the world advanced by,
 * which is what keeps a lifetime measured in simulation time.
 */
export function elapsedFor(delta: number): number {
  if (!Number.isFinite(delta) || delta <= 0) {
    return 0;
  }
  if (delta > RESUME_GAP) {
    return 0;
  }
  return Math.min(delta, DELTA_CEILING);
}

/**
 * SPEC section 14's magnitude: the smaller of the cap and the energy term, in
 * CSS pixels, for a surface of this rendered CSS height. Both bounds are
 * floored at zero so a collapsed surface or a nonsense energy is no shake
 * rather than a negative one.
 */
export function shakeMagnitude(energy: number, renderedHeight: number): number {
  const fromEnergy = Number.isFinite(energy) ? Math.max(0, energy) * SHAKE_ENERGY_SCALE : 0;
  const cap = Number.isFinite(renderedHeight)
    ? Math.max(0, renderedHeight) * SHAKE_HEIGHT_FRACTION
    : 0;
  return Math.min(cap, fromEnergy);
}

/**
 * The energy a meeting released, read as the velocity change it produced. All
 * three bodies weigh the same (SPEC section 6.1), so the change in velocity and
 * the impulse are the same number, and it is measured between two frames rather
 * than inside a step because a frame is the finest grain this layer has. One
 * frame of damping is folded into it, which flatters a meeting by under two
 * percent at sixty frames a second and is a feel constant either way.
 */
export function impactEnergy(
  beforeX: number,
  beforeY: number,
  afterX: number,
  afterY: number,
): number {
  return Math.hypot(afterX - beforeX, afterY - beforeY);
}

/**
 * The rate limiter's region for a point on the pitch. The grid covers the field
 * and a point outside it is clamped into the edge region, because a flash just
 * outside the bound is a flash in the region it touches.
 */
export function regionOf(x: number, y: number): number {
  const column = gridIndex((x - FIELD_LEFT) / FIELD_WIDTH, REGION_COLUMNS);
  const row = gridIndex((y - FIELD_BOTTOM) / FIELD_HEIGHT, REGION_ROWS);
  return row * REGION_COLUMNS + column;
}

function gridIndex(fraction: number, count: number): number {
  if (!Number.isFinite(fraction)) {
    return 0;
  }
  return Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
}

/**
 * How much SIMULATION time a frame of this length can have advanced the world
 * by, which is not the frame's own delta.
 *
 * DESIGN section 2's three-layer model accumulates the delta and consumes it in
 * whole fixed steps, carrying the remainder into the next frame, so a frame can
 * run one more step than its own length pays for. At a sixtieth of a second the
 * difference is a seventh; at the four milliseconds a two-hundred-and-forty
 * hertz display gives, the world advances by a whole step on every other frame
 * and by nothing on the rest, so a bound taken from the frame delta is half the
 * distance the bodies actually covered and every real meeting is refused. This
 * was found by a browser test on an engine that runs its frames at that rate.
 */
function spanOf(seconds: number): number {
  return seconds + FIXED_STEP;
}

/** How far a body moving at this speed could have travelled since last frame. */
function reach(speed: number, seconds: number): number {
  return Math.abs(speed) * spanOf(seconds) + CONTACT_SLACK;
}

/** Which wall was struck, which is what decides the band the flash is drawn in. */
export type WallSide = 'left' | 'right' | 'bottom' | 'top';

/** A contact, in design space, and the wall it happened on where there is one. */
interface Contact {
  readonly x: number;
  readonly y: number;
  readonly wall: WallSide;
}

/** One body as the previous frame left it. Mutated in place; nothing allocates. */
export interface BodySample {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Fade {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly life: number;
}

interface WallFade extends Fade {
  readonly wall: WallSide;
}

interface TrailSample {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly at: number;
  readonly life: number;
}

interface Particle {
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  readonly at: number;
  readonly life: number;
}

interface Celebration {
  readonly mouth: GoalMouth;
  readonly at: number;
  readonly life: number;
}

/**
 * The wall a body has just bounced off, as the contact point on that wall, or
 * null. The test is the reversal of the normal component plus the body being
 * within one frame's travel of the bound, which is exact for a body the clamp
 * put on the bound and still right for one that has already rebounded away.
 *
 * A ball on its way through a goal opening is not contained by the side walls
 * (SPEC section 6.4), so it is never a bounce off one; `ballFitsOpening` is the
 * same predicate the containment uses, asked rather than restated.
 *
 * One wall per body per frame. A corner takes the first of the four in the bit
 * order `core/physics.ts` fixes, which makes the choice deterministic instead
 * of a race between two equally true answers.
 */
export function wallContact(body: Body, before: BodySample, seconds: number): Contact | null {
  const at = body.position;
  const moving = body.velocity;
  const throughTheOpening = ballFitsOpening(body);
  if (
    !throughTheOpening &&
    before.vx < 0 &&
    moving.x >= 0 &&
    at.x - body.radius - FIELD_LEFT <= reach(before.vx, seconds)
  ) {
    return { x: FIELD_LEFT, y: at.y, wall: 'left' };
  }
  if (
    !throughTheOpening &&
    before.vx > 0 &&
    moving.x <= 0 &&
    FIELD_RIGHT - (at.x + body.radius) <= reach(before.vx, seconds)
  ) {
    return { x: FIELD_RIGHT, y: at.y, wall: 'right' };
  }
  if (
    before.vy < 0 &&
    moving.y >= 0 &&
    at.y - body.radius - FIELD_BOTTOM <= reach(before.vy, seconds)
  ) {
    return { x: at.x, y: FIELD_BOTTOM, wall: 'bottom' };
  }
  if (
    before.vy > 0 &&
    moving.y <= 0 &&
    FIELD_TOP - (at.y + body.radius) <= reach(before.vy, seconds)
  ) {
    return { x: at.x, y: FIELD_TOP, wall: 'top' };
  }
  return null;
}

/**
 * The contact point of a pair that met since the previous frame, or null.
 *
 * TWO GATES, and each refuses a case the other admits. The pair was closing at
 * the previous sample and is separating now; and the CLOSEST the pair came
 * between the two samples was inside the sum of the radii.
 *
 * The second gate is not belt and braces. Two bodies passing each other always
 * cross from closing to separating at their closest approach, so the signature
 * alone calls a clean miss a meeting: measured on the shipped constants, a miss
 * with eighteen units of clear air flashed and shook under a clamped
 * quarter-second frame, where damping alone changes a velocity by more than the
 * hard-collision floor. The first gate refuses what the second admits: a pair
 * already overlapping and still closing is mid-collision, one frame before the
 * solver has pushed it apart, and has not finished meeting yet.
 *
 * A THIRD GATE WAS BUILT AND REMOVED. It refused a pair whose remaining gap was
 * wider than one frame of their own separation, and it cannot be reached: a gap
 * that wide means a body covered more ground than its own speed allows, which
 * is the placement `placed` already vetoes for the whole frame. A gate no input
 * can reach is a gate no mutation can prove, so it is gone rather than carried
 * as an entry nothing detects.
 */
export function pairContact(
  one: Body,
  other: Body,
  beforeOne: BodySample,
  beforeOther: BodySample,
  seconds: number,
): { readonly x: number; readonly y: number } | null {
  const wasX = beforeOther.x - beforeOne.x;
  const wasY = beforeOther.y - beforeOne.y;
  const wasApart = Math.hypot(wasX, wasY);
  if (wasApart <= CONTACT_SLACK) {
    return null;
  }
  const closing = -(
    ((beforeOther.vx - beforeOne.vx) * wasX + (beforeOther.vy - beforeOne.vy) * wasY) /
    wasApart
  );
  if (closing <= 0) {
    return null;
  }
  const nowX = other.position.x - one.position.x;
  const nowY = other.position.y - one.position.y;
  const apart = Math.hypot(nowX, nowY);
  if (apart <= CONTACT_SLACK) {
    return null;
  }
  const separating =
    ((other.velocity.x - one.velocity.x) * nowX + (other.velocity.y - one.velocity.y) * nowY) /
    apart;
  if (separating <= 0) {
    return null;
  }
  const relativeX = beforeOther.vx - beforeOne.vx;
  const relativeY = beforeOther.vy - beforeOne.vy;
  const relativeSpeed = Math.hypot(relativeX, relativeY);
  if (relativeSpeed > 0) {
    const when = Math.min(
      Math.max(-((wasX * relativeX + wasY * relativeY) / (relativeSpeed * relativeSpeed)), 0),
      spanOf(seconds),
    );
    const nearest = Math.hypot(wasX + relativeX * when, wasY + relativeY * when);
    if (nearest > one.radius + other.radius + CONTACT_SLACK) {
      return null;
    }
  }
  return {
    x: one.position.x + (nowX / apart) * one.radius,
    y: one.position.y + (nowY / apart) * one.radius,
  };
}

/** SPEC section 6.3's fixed pair order, so two runs of a match log one list. */
const PAIR_ORDER: readonly (readonly [BodyKind, BodyKind])[] = [
  ['player', 'opponent'],
  ['player', 'ball'],
  ['opponent', 'ball'],
];

/** The goal frame the celebration pulses, which is the mouth that was scored in. */
export function goalFrameOf(mouth: GoalMouth): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    x: mouth === 'left' ? FIELD_LEFT - GOAL_FRAME_DEPTH : FIELD_RIGHT,
    y: GOAL_OPENING_LOW,
    width: GOAL_FRAME_DEPTH,
    height: GOAL_OPENING_HIGH - GOAL_OPENING_LOW,
  };
}

/** A rectangle of the wall band, in design space, as `pitch.ts` fills it. */
export interface WallBand {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The pieces of the struck wall the flash covers, which are pieces of the wall
 * `pitch.ts` actually DREW.
 *
 * The side walls are drawn in two pieces each with the goal opening between
 * them deliberately empty, and a circle is contained by the side wall along its
 * whole length, the mouth included. So a circle bouncing off a side wall inside
 * the opening is a real bounce with no wall drawn at it, and a band centred on
 * that contact would paint a solid bar across an open goal, over the goal frame
 * rather than over any wall. The span is therefore intersected with the two
 * drawn pieces, and a contact deep inside the mouth flashes nothing, because
 * there is no wall segment there to flash.
 */
export function wallBandsOf(flash: WallFade): readonly WallBand[] {
  if (flash.wall === 'bottom' || flash.wall === 'top') {
    return [
      {
        x: flash.x - WALL_SEGMENT_SPAN / 2,
        y: flash.wall === 'top' ? FIELD_TOP : FIELD_BOTTOM - WALL_THICKNESS,
        width: WALL_SEGMENT_SPAN,
        height: WALL_THICKNESS,
      },
    ];
  }
  const low = flash.y - WALL_SEGMENT_SPAN / 2;
  const high = flash.y + WALL_SEGMENT_SPAN / 2;
  const x = flash.wall === 'right' ? FIELD_RIGHT : FIELD_LEFT - WALL_THICKNESS;
  const pieces: WallBand[] = [];
  for (const [pieceLow, pieceHigh] of [
    [FIELD_BOTTOM - WALL_THICKNESS, GOAL_OPENING_LOW],
    [GOAL_OPENING_HIGH, FIELD_TOP + WALL_THICKNESS],
  ] as const) {
    const from = Math.max(low, pieceLow);
    const to = Math.min(high, pieceHigh);
    if (to > from) {
      pieces.push({ x, y: from, width: WALL_THICKNESS, height: to - from });
    }
  }
  return pieces;
}

export function createEffects(options: EffectsOptions = {}): Effects {
  const root = createRng(options.seed ?? EFFECTS_SEED);
  const shakeStream: Rng = root.split(SHAKE_STREAM);
  const burstStream: Rng = root.split(BURST_STREAM);

  const samples: BodySample[] = [];
  const trail: TrailSample[] = [];
  const impacts: Fade[] = [];
  const wallFlashes: WallFade[] = [];
  const particles: Particle[] = [];
  const log: EffectEvent[] = [];
  const regionTimes = new Map<number, number[]>();

  let now = 0;
  let draws = 0;
  let refusals = 0;
  let seenGoals = 0;
  let celebration: Celebration | null = null;
  let shakeEnergy = 0;
  let shakeAt = 0;
  let shakeLife = 0;
  let shakeX = 0;
  let shakeY = 0;
  let pulsePeriod = 0;

  function draw(stream: Rng): number {
    draws += 1;
    return stream.nextFloat();
  }

  /**
   * The window is a CLOSED period: an onset exactly one second old is still
   * inside "any one second period", so it is kept rather than dropped. Under
   * the other reading, onsets at 0, 0.1, 0.2 and 1.0 are all admitted and the
   * period from 0 to 1.0 carries four flashes.
   */
  function prune(times: number[]): void {
    while (times.length > 0 && now - (times[0] ?? 0) > FLASH_WINDOW_SECONDS) {
      times.shift();
    }
  }

  /**
   * SC 2.3.1's rolling window, asked once per flash. A refusal is counted
   * rather than swallowed, because a limiter nobody can count is a limiter
   * nobody can test.
   */
  function admits(x: number, y: number): boolean {
    const region = regionOf(x, y);
    const times = regionTimes.get(region) ?? [];
    prune(times);
    if (times.length >= FLASHES_PER_WINDOW) {
      refusals += 1;
      return false;
    }
    times.push(now);
    regionTimes.set(region, times);
    return true;
  }

  function record(event: EffectEvent): void {
    log.push(event);
    if (log.length > EVENT_LOG_LIMIT) {
      log.shift();
    }
  }

  function startShake(energy: number, reducedMotion: boolean): void {
    // The direction is one draw per impact, so a particle count cannot move it.
    const angle = draw(shakeStream) * TAU;
    shakeX = Math.cos(angle);
    shakeY = Math.sin(angle);
    shakeEnergy = Math.max(shakeEnergy, energy);
    shakeAt = now;
    shakeLife = effectSeconds('screenShake', reducedMotion);
  }

  function startCelebration(mouth: GoalMouth, reducedMotion: boolean): void {
    const life = effectSeconds('goalCelebration', reducedMotion);
    celebration = { mouth, at: now, life };
    const frame = goalFrameOf(mouth);
    const fromX = frame.x + frame.width / 2;
    const fromY = frame.y + frame.height / 2;
    for (let made = 0; made < BURST_PARTICLES; made += 1) {
      // Two draws per particle, both from the burst stream: a direction over
      // the full turn and a speed between half the weakest legal shot and all
      // of it. Taken whatever the motion mode, so the stream stands in the same
      // place after a goal either way.
      const angle = draw(burstStream) * TAU;
      const speed =
        MIN_LAUNCH_SPEED * (BURST_SLOWEST_RATIO + draw(burstStream) * (1 - BURST_SLOWEST_RATIO));
      particles.push({
        x: fromX,
        y: fromY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        at: now,
        life,
      });
    }
  }

  function expire<T extends { readonly at: number; readonly life: number }>(list: T[]): void {
    for (let at = list.length - 1; at >= 0; at -= 1) {
      const entry = list[at];
      if (entry !== undefined && now - entry.at >= entry.life) {
        list.splice(at, 1);
      }
    }
  }

  function ageOut(): void {
    expire(trail);
    expire(impacts);
    expire(wallFlashes);
    expire(particles);
    if (celebration !== null && now - celebration.at >= celebration.life) {
      celebration = null;
    }
    // A shake born with no life is over on the frame it started, which is
    // what reduced motion makes of every one of them, so the reading of the
    // window is unconditional: a lifetime of zero is a duration and not a
    // branch anything skips.
    if (now - shakeAt >= shakeLife) {
      shakeLife = 0;
      shakeEnergy = 0;
    }
  }

  function sampleWorld(world: World): void {
    for (let slot = 0; slot < world.bodies.length; slot += 1) {
      const body = world.bodies[slot];
      if (body === undefined) {
        continue;
      }
      const sample = samples[slot];
      if (sample === undefined) {
        samples[slot] = {
          x: body.position.x,
          y: body.position.y,
          vx: body.velocity.x,
          vy: body.velocity.y,
        };
        continue;
      }
      sample.x = body.position.x;
      sample.y = body.position.y;
      sample.vx = body.velocity.x;
      sample.vy = body.velocity.y;
    }
  }

  function sampleFor(world: World, body: Body): BodySample | undefined {
    return samples[world.bodies.indexOf(body)];
  }

  /**
   * True when a body did not move but was PLACED. SPEC section 6.4's kickoff
   * puts all three back on their marks between two frames after a goal, and
   * SPEC section 13's Play Again does the same; a body that travelled further
   * than its own speed at either end of the frame could carry it went one of
   * those ways rather than by integration.
   *
   * Two things follow from it, and both are defects without it: a placement
   * compared against the sample before it derives contacts and wall bounces
   * that never happened, and the ball's trail draws a streak from the net to
   * the centre spot, which is the one place on the pitch it certainly did not
   * travel through.
   */
  function placed(world: World, seconds: number): boolean {
    for (const body of world.bodies) {
      const before = sampleFor(world, body);
      if (before === undefined) {
        continue;
      }
      const moved = Math.hypot(body.position.x - before.x, body.position.y - before.y);
      const could =
        (Math.hypot(before.vx, before.vy) + Math.hypot(body.velocity.x, body.velocity.y)) *
          spanOf(seconds) +
        CONTACT_SLACK;
      if (moved > could) {
        return true;
      }
    }
    return false;
  }

  function observeWalls(world: World, seconds: number, reducedMotion: boolean): void {
    for (const body of world.bodies) {
      const before = sampleFor(world, body);
      if (before === undefined) {
        continue;
      }
      const hit = wallContact(body, before, seconds);
      if (hit === null) {
        continue;
      }
      const energy = impactEnergy(before.vx, before.vy, body.velocity.x, body.velocity.y);
      const admitted = admits(hit.x, hit.y);
      if (admitted) {
        wallFlashes.push({
          x: hit.x,
          y: hit.y,
          at: now,
          life: effectSeconds('wallFlash', reducedMotion),
          wall: hit.wall,
        });
      }
      record({ kind: 'wall', at: now, x: hit.x, y: hit.y, energy, admitted });
    }
  }

  function observePairs(world: World, seconds: number, reducedMotion: boolean): void {
    for (const [oneKind, otherKind] of PAIR_ORDER) {
      const one = world[oneKind];
      const other = world[otherKind];
      const beforeOne = sampleFor(world, one);
      const beforeOther = sampleFor(world, other);
      if (beforeOne === undefined || beforeOther === undefined) {
        continue;
      }
      const hit = pairContact(one, other, beforeOne, beforeOther, seconds);
      if (hit === null) {
        continue;
      }
      const energy = Math.max(
        impactEnergy(beforeOne.vx, beforeOne.vy, one.velocity.x, one.velocity.y),
        impactEnergy(beforeOther.vx, beforeOther.vy, other.velocity.x, other.velocity.y),
      );
      if (energy < HARD_IMPACT_ENERGY) {
        // Softer than the weakest legal shot, so not a hard collision: no
        // flash, no shake, and no budget spent on the limiter either.
        record({ kind: 'impact', at: now, x: hit.x, y: hit.y, energy, admitted: false });
        continue;
      }
      const admitted = admits(hit.x, hit.y);
      if (admitted) {
        impacts.push({
          x: hit.x,
          y: hit.y,
          at: now,
          life: effectSeconds('impactFlash', reducedMotion),
        });
      }
      // The shake answers the collision rather than the flash: a limiter that
      // refuses a fourth flash in a second is a photosensitivity rule, not a
      // reason for the surface to stop answering a hard hit.
      startShake(energy, reducedMotion);
      record({ kind: 'impact', at: now, x: hit.x, y: hit.y, energy, admitted });
    }
  }

  function observeGoal(scoring: ScoringReadout, reducedMotion: boolean): void {
    if (scoring.goals > seenGoals) {
      const last = scoring.last;
      if (last !== undefined) {
        startCelebration(last.mouth, reducedMotion);
        const frame = goalFrameOf(last.mouth);
        record({
          kind: 'goal',
          at: now,
          x: frame.x + frame.width / 2,
          y: frame.y + frame.height / 2,
          energy: 0,
          admitted: true,
        });
      }
    }
    seenGoals = scoring.goals;
  }

  return {
    observe(observation: EffectsObservation): void {
      const seconds = elapsedFor(observation.elapsed);
      now += seconds;
      const reducedMotion = observation.reducedMotion;
      const world = observation.world;
      pulsePeriod =
        (duration(4, reducedMotion) * SLOW_PULSE_STEPS) / MILLISECONDS_PER_SECOND;

      // The shake's decay, per second and never per frame.
      if (shakeLife > 0) {
        shakeEnergy *= SHAKE_DECAY_PER_SECOND ** seconds;
      }

      // Walls first, in the body order the world fixes, then the pairs in SPEC
      // section 6.3's resolution order, then the goal. Nothing is derived from
      // a frame with no previous sample to compare against, nothing from a
      // frame that consumed no time, and nothing from a frame a body was placed
      // in rather than moved through.
      const teleported = samples.length > 0 && placed(world, seconds);
      if (teleported) {
        trail.length = 0;
      }
      if (samples.length > 0 && seconds > 0 && !teleported) {
        observeWalls(world, seconds, reducedMotion);
        observePairs(world, seconds, reducedMotion);
      }
      observeGoal(observation.scoring, reducedMotion);

      for (const particle of particles) {
        particle.x += particle.vx * seconds;
        particle.y += particle.vy * seconds;
      }

      // The trail samples the ball wherever it is, every frame, and the window
      // in force at the moment of the sample decides whether it survives. A
      // ball at rest leaves every sample on one point, so the trail has no
      // length rather than a special case that hides it.
      trail.push({
        x: world.ball.position.x,
        y: world.ball.position.y,
        radius: world.ball.radius,
        at: now,
        life: effectSeconds('ballTrail', reducedMotion),
      });
      ageOut();
      sampleWorld(world);
    },

    shake(renderedHeight: number): ShakeOffset {
      if (shakeLife <= 0) {
        return NO_SHAKE;
      }
      const age = now - shakeAt;
      if (age >= shakeLife) {
        return NO_SHAKE;
      }
      const magnitude =
        shakeMagnitude(shakeEnergy, renderedHeight) *
        Math.cos((TAU * age) / SHAKE_PERIOD_SECONDS);
      if (magnitude === 0) {
        return NO_SHAKE;
      }
      return { x: shakeX * magnitude, y: shakeY * magnitude };
    },

    drawBehind(context: CanvasRenderingContext2D, palette: PitchPalette): void {
      drawTrail(context, palette, trail, now);
      drawWallFlashes(context, palette, wallFlashes, now);
    },

    drawInFront(
      context: CanvasRenderingContext2D,
      palette: PitchPalette,
      world: World,
      aim: AimPreview | null,
    ): void {
      drawImpactFlashes(context, palette, impacts, now);
      if (celebration !== null) {
        drawCelebration(context, palette, celebration, now);
      }
      drawParticles(context, palette, particles, now);
      drawMaximumPulse(context, palette, world.player, aim, now, pulsePeriod);
    },

    readout(): EffectsReadout {
      const running = celebration;
      return {
        now,
        trailLength: trailLengthOf(trail),
        trailSamples: trail.length,
        shakeEnergy,
        impactFlashes: impacts.length,
        wallFlashes: wallFlashes.length,
        particles: particles.length,
        celebration: running === null ? 0 : Math.max(0, running.life - (now - running.at)),
        draws,
        refusals,
      };
    },

    events(): readonly EffectEvent[] {
      return log;
    },
  };
}

/** The trail's length in design units, which is what makes it proportional. */
function trailLengthOf(trail: readonly TrailSample[]): number {
  let total = 0;
  for (let at = 1; at < trail.length; at += 1) {
    const from = trail[at - 1];
    const to = trail[at];
    if (from === undefined || to === undefined) {
      continue;
    }
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

/** The share of a fade still to run, from one at its start to zero at its end. */
function remaining(at: number, life: number, now: number): number {
  if (life <= 0) {
    return 0;
  }
  return Math.max(0, 1 - (now - at) / life);
}

/**
 * SPEC section 14's ball trail, drawn behind the entities so the ball covers
 * the head of its own trail. Each segment carries the age of the sample that
 * starts it, so the taper and the fade are the same at every frame rate, and
 * the width is the ball's own diameter narrowing to nothing rather than a size
 * chosen here.
 */
function drawTrail(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  trail: readonly TrailSample[],
  now: number,
): void {
  if (trail.length < 2) {
    return;
  }
  context.strokeStyle = palette.ballBody;
  for (let at = 1; at < trail.length; at += 1) {
    const from = trail[at - 1];
    const to = trail[at];
    if (from === undefined || to === undefined) {
      continue;
    }
    const left = remaining(from.at, from.life, now);
    if (left <= 0) {
      continue;
    }
    // A ball at rest leaves every sample on one point, so every segment has no
    // length and no stroke of it can mark the surface. Skipping them is not an
    // optimisation of the drawing, it is the drawing: a turn spent aiming is
    // most of a match, and a stroke that paints nothing still costs a path.
    if (from.x === to.x && from.y === to.y) {
      continue;
    }
    context.globalAlpha = TRAIL_PEAK_ALPHA * left;
    context.lineWidth = from.radius * 2 * left;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
  context.globalAlpha = 1;
}

/**
 * SPEC section 14's wall-segment flash: the struck piece of the wall band, one
 * spacing step of it across the contact, in the boundary token that every other
 * line on the pitch is drawn in.
 */
function drawWallFlashes(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  flashes: readonly WallFade[],
  now: number,
): void {
  context.fillStyle = palette.line;
  for (const flash of flashes) {
    const left = remaining(flash.at, flash.life, now);
    if (left <= 0) {
      continue;
    }
    context.globalAlpha = FLASH_PEAK_ALPHA * left;
    for (const band of wallBandsOf(flash)) {
      context.fillRect(band.x, band.y, band.width, band.height);
    }
  }
  context.globalAlpha = 1;
}

/**
 * SPEC section 14's impact flash at the contact point, in front of the entities
 * so a flash between two touching bodies is not drawn underneath them. It grows
 * as it fades, which reads as a release of energy rather than as a dot.
 */
function drawImpactFlashes(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  flashes: readonly Fade[],
  now: number,
): void {
  context.fillStyle = palette.line;
  for (const flash of flashes) {
    const left = remaining(flash.at, flash.life, now);
    if (left <= 0) {
      continue;
    }
    context.globalAlpha = FLASH_PEAK_ALPHA * left;
    context.beginPath();
    context.arc(flash.x, flash.y, FLASH_RADIUS * (1 - left), 0, TAU);
    context.fill();
  }
  context.globalAlpha = 1;
}

/**
 * SPEC section 14's celebration, first half: the scoring goal frame pulses. The
 * pulse is a stroke over the frame the static layer already drew, in the
 * boundary token and at the boundary weight, so the frame brightens rather than
 * changing shape.
 */
function drawCelebration(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  running: Celebration,
  now: number,
): void {
  const left = remaining(running.at, running.life, now);
  if (left <= 0) {
    return;
  }
  const frame = goalFrameOf(running.mouth);
  const wave = 0.5 + 0.5 * Math.cos((TAU * (now - running.at)) / CELEBRATION_PERIOD_SECONDS);
  context.globalAlpha = CELEBRATION_PEAK_ALPHA * left * wave;
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.strokeRect(frame.x, frame.y, frame.width, frame.height);
  context.globalAlpha = 1;
}

/** SPEC section 14's celebration, second half: the burst, from primitives. */
function drawParticles(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  particles: readonly Particle[],
  now: number,
): void {
  context.fillStyle = palette.accent;
  for (const particle of particles) {
    const left = remaining(particle.at, particle.life, now);
    if (left <= 0) {
      continue;
    }
    context.globalAlpha = left;
    context.beginPath();
    context.arc(particle.x, particle.y, PARTICLE_RADIUS * left, 0, TAU);
    context.fill();
  }
  context.globalAlpha = 1;
}

/**
 * SPEC section 14's other half of the arrow: it ramps colour with strength,
 * which `arrow.ts` draws, and it pulses gently at MAXIMUM, which is here.
 *
 * The two halves are split on purpose. The ramp carries information, so it
 * survives reduced motion; the pulse is animation and must not, and putting it
 * in the layer whose whole policy is to vanish is what makes that automatic
 * rather than remembered. The pulse is a second stroke along the arrow's own
 * path, from the arrow's own geometry, so it is the arrow pulsing and not a
 * decoration beside it.
 *
 * The period is two of the longest step of the chrome motion scale, because
 * SPEC section 14 states no period of its own and a number invented here would
 * be a duration outside the token layer. Two rather than one: a single step is
 * 3.1 cycles a second, over SC 2.3.1's three, and the celebration a few
 * hundred lines above is held to the same bound. It also means the one function
 * that already resolves reduced motion for the chrome resolves it for this too.
 */
function drawMaximumPulse(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  body: Body,
  aim: AimPreview | null,
  now: number,
  period: number,
): void {
  if (aim === null || period <= 0 || !aim.launchable || aim.aim.power01 < 1) {
    return;
  }
  const geometry = arrowGeometry(aim.reach);
  if (geometry.shaftLength <= 0) {
    return;
  }
  const wave = 0.5 + 0.5 * Math.cos((TAU * now) / period);
  context.globalAlpha = PULSE_PEAK_ALPHA * wave;
  context.strokeStyle = palette.accent;
  context.lineWidth = BORDER.thick;
  context.beginPath();
  const path = arrowPath(body.position.x, body.position.y, aim.aim.angleRad, geometry);
  for (const [index, point] of path.entries()) {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  }
  context.closePath();
  context.stroke();
  context.globalAlpha = 1;
}

/** The key a capture script reads the motion state under. */
export const MOTION_CAPTURE_KEY = '__pfMotion';

export interface MotionCaptureHooks {
  readout(): EffectsReadout;
  events(): readonly EffectEvent[];
  shake(renderedHeight: number): ShakeOffset;
  /** The lifetimes in force, so a capture can label the mode it recorded in. */
  settings(reducedMotion: boolean): Record<EffectStep, number>;
}

/**
 * Capture hooks for the demonstration session, item E5.
 *
 * ARMOUR, NOT CLOSURE. Installing these proves nothing about E5: only the
 * scripted capture produced at the demonstration session closes it. They exist
 * so the session can tell, frame by frame, which motion is live and when it
 * ended, which is what a recording of an emergent effect needs and cannot get
 * by looking at the canvas.
 *
 * THEY OBSERVE AND NEVER INJECT, which is the honest shape for this item. The
 * motion here is produced by the simulation, so the way to capture an impact is
 * to produce the impact, and the composition root already takes an exact angle
 * and an exact strength through SPEC section 5.0's controls. A hook that
 * fabricated a shake would record a shake nobody can reach by playing.
 *
 * THIS FUNCTION IS TEST TIME ONLY AND THE TREE PROVES IT. Nothing in the
 * shipping graph names it, so the bundler drops it, and a build of the tree
 * with it stubbed out is byte-identical to a build with it present. The armour
 * test asserts both halves.
 */
export function installMotionHooks(
  effects: Effects,
  target: Record<string, unknown> = globalThis,
): MotionCaptureHooks {
  const hooks: MotionCaptureHooks = {
    readout: (): EffectsReadout => effects.readout(),
    events: (): readonly EffectEvent[] => effects.events(),
    shake: (renderedHeight: number): ShakeOffset => effects.shake(renderedHeight),
    settings: (reducedMotion: boolean): Record<EffectStep, number> => ({
      ballTrail: effectSeconds('ballTrail', reducedMotion),
      impactFlash: effectSeconds('impactFlash', reducedMotion),
      wallFlash: effectSeconds('wallFlash', reducedMotion),
      screenShake: effectSeconds('screenShake', reducedMotion),
      goalCelebration: effectSeconds('goalCelebration', reducedMotion),
    }),
  };
  target[MOTION_CAPTURE_KEY] = hooks;
  return hooks;
}
