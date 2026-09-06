/**
 * The aim arrow: the shot the player is about to take, drawn from the circle
 * they are dragging from.
 *
 * SPEC section 5 gives it its direction and its length. It points OPPOSITE
 * the drag, it starts at the circle centre, and it is exactly as long as the
 * clamped drag distance, so the 180 px maximum is legible as the moment the
 * arrow stops growing. SPEC section 14 gives it the colour ramp, and SPEC
 * section 18, as corrected on 2026-08-29, says which of the two carries what:
 * the `--pf-line` outline carries the arrow's 3:1 against the pitch at every
 * point of the ramp, and the ramp itself carries intensity rather than
 * contrast. Nothing here chooses a colour; both ends of the ramp are tokens.
 *
 * THE HEAD IS CLAMPED TO HALF THE SHAFT. DESIGN section 5 states the rule as
 * `min(HEAD_LENGTH, shaftLength / 2)` and records why: without it a very
 * short drag draws a head longer than its own shaft, and the arrow runs
 * backwards through the circle it belongs to. The prior build shipped that
 * defect and it was visible precisely in the sub-minimum-drag case, which is
 * why the reach this file is handed is clamped at the maximum only and never
 * floored at the minimum.
 *
 * THE SUB-MINIMUM SIGNAL IS A SHAPE, NOT A COLOUR. Below the minimum drag a
 * release cancels, and SPEC section 5 asks for a clear visual signal that it
 * will. Two carriers say so together: the arrow is drawn as an outline with
 * no fill, and a ring appears around the circle outside its rim. Both are
 * shapes, so neither depends on colour, and the ring sits outside the rim
 * because the minimum drag is shorter than the circle's own radius and an
 * arrow that short is inside the body it starts from.
 *
 * EVERYTHING IS DRAWN IN DESIGN SPACE, under the surface's one transform,
 * and every absolute size resolves through a token. The proportions that are
 * not sizes are ratios of the arrow's own parts, which is the same reading
 * `entities.ts` takes of a marker: a ratio is a shape and scales with the
 * thing it belongs to.
 */

import type { AimPreview } from '../core/aiming';
import type { Body } from '../core/bodies';
import { TAU } from './entities';
import { BORDER, SPACE } from './tokens';
import type { PitchPalette } from './tokens';

/** The head at full size, from the spacing scale. */
const HEAD_LENGTH = SPACE[5];

/** Shape, not size: the head's half width as a fraction of its own length. */
const HEAD_SPREAD = 0.6;

/** The shaft's half width, from the spacing scale. */
const SHAFT_HALF_WIDTH = SPACE[1];

/** The daylight between the circle's rim and the sub-minimum ring. */
const RING_GAP = SPACE[2];

/** A point in design space, as the path returns them. */
export interface ArrowPoint {
  readonly x: number;
  readonly y: number;
}

/** The arrow's measurements along its own axis, all in design units. */
export interface ArrowGeometry {
  readonly shaftLength: number;
  readonly headLength: number;
  readonly headHalfWidth: number;
  readonly shaftHalfWidth: number;
  /** Where the head starts, measured forward from the circle centre. */
  readonly headBase: number;
}

/**
 * The arrow's measurements for a reach.
 *
 * The head clamp is the item C7 rule. The shaft's half width takes the same
 * treatment against the head's, for the same reason one step further in: a
 * shaft wider than the head it feeds is a polygon that crosses itself, and
 * the head is already down to a fraction of its full size by the time that
 * can happen.
 */
export function arrowGeometry(reach: number): ArrowGeometry {
  const shaftLength = Number.isFinite(reach) && reach > 0 ? reach : 0;
  const headLength = Math.min(HEAD_LENGTH, shaftLength / 2);
  const headHalfWidth = headLength * HEAD_SPREAD;
  return {
    shaftLength,
    headLength,
    headHalfWidth,
    shaftHalfWidth: Math.min(SHAFT_HALF_WIDTH, headHalfWidth),
    headBase: shaftLength - headLength,
  };
}

/**
 * The arrow as a closed polygon in design space, from the circle centre
 * outward along the aim.
 *
 * Seven points: the two at the base straddle the centre exactly, so their
 * midpoint IS the circle centre and the arrow starts where SPEC section 5
 * says it starts. Nothing rotates the context to draw it, because the points
 * are the geometry and a test that can read them is testing the arrow rather
 * than a transform.
 */
export function arrowPath(
  centreX: number,
  centreY: number,
  angleRad: number,
  geometry: ArrowGeometry,
): readonly ArrowPoint[] {
  const alongX = Math.cos(angleRad);
  const alongY = Math.sin(angleRad);
  const acrossX = -alongY;
  const acrossY = alongX;
  const at = (along: number, across: number): ArrowPoint => ({
    x: centreX + alongX * along + acrossX * across,
    y: centreY + alongY * along + acrossY * across,
  });
  const base = geometry.headBase;
  const half = geometry.shaftHalfWidth;
  const wing = geometry.headHalfWidth;
  return [
    at(0, half),
    at(base, half),
    at(base, wing),
    at(geometry.shaftLength, 0),
    at(base, -wing),
    at(base, -half),
    at(0, -half),
  ];
}

function channelAt(hex: string, at: number): number {
  const value = Number.parseInt(hex.slice(at, at + 2), 16);
  return Number.isFinite(value) ? value : 0;
}

function mixed(from: string, to: string, amount: number): string {
  let out = '#';
  for (const at of [1, 3, 5]) {
    const start = channelAt(from, at);
    const end = channelAt(to, at);
    const value = Math.round(start + (end - start) * amount);
    out += value.toString(16).padStart(2, '0').toUpperCase();
  }
  return out;
}

/**
 * The ramp SPEC section 14 asks for, between the two tokens SPEC section 18
 * measured it at: the boundary colour at the weak end and the accent at the
 * strong end, mixed per channel on the one power scale. At strength zero this
 * returns the boundary token itself and at one the accent itself, so the two
 * cells the design contract records are the two ends of this function.
 */
export function rampColour(palette: PitchPalette, strength: number): string {
  const amount = Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 1) : 0;
  return mixed(palette.line, palette.accent, amount);
}

/**
 * The sub-minimum signal's ring, outside the circle's rim. Stroked in the
 * boundary token at the boundary weight, like every other outline on the
 * pitch, because it is one.
 */
function drawBelowMinimumRing(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  body: Body,
): void {
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.beginPath();
  context.arc(body.position.x, body.position.y, body.radius + RING_GAP, 0, TAU);
  context.stroke();
}

/**
 * The aim pass: the arrow for the circle it is aimed from, and the
 * sub-minimum signal when the pull is too short to launch.
 *
 * DESIGN section 7 puts this pass after the entities, so the arrow draws over
 * the circle it starts inside rather than under it.
 */
export function drawAimArrow(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  body: Body,
  preview: AimPreview,
): void {
  if (!preview.launchable) {
    drawBelowMinimumRing(context, palette, body);
  }
  const geometry = arrowGeometry(preview.reach);
  if (geometry.shaftLength <= 0) {
    return;
  }
  const path = arrowPath(
    body.position.x,
    body.position.y,
    preview.aim.angleRad,
    geometry,
  );
  context.beginPath();
  for (const [index, point] of path.entries()) {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  }
  context.closePath();
  if (preview.launchable) {
    context.fillStyle = rampColour(palette, preview.aim.power01);
    context.fill();
  }
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.stroke();
}
