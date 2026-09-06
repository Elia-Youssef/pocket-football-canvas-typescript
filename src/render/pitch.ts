/**
 * The pitch and its static layers, and the frame that composes the passes.
 *
 * SPEC section 3 owns the pitch's contents and section 18 its look: mown
 * stripes, white centre markings, enclosing walls with a raised rail, and a
 * goal frame on each edge tinted to the side that defends it. Every number
 * the drawing needs is a config constant or a token; nothing is measured in
 * this file, because a dimension chosen here is a dimension the documents no
 * longer own.
 *
 * THE STATIC LAYER. QUALITY-BAR section 1: static layers are cached. Nothing
 * the pitch draws changes between frames - not the stripes, not the markings,
 * not the walls, and not the goal tints - so the pitch and the goal frames
 * render once into an offscreen canvas at the current backing-store scale and
 * every frame afterwards is one drawImage. The cache is invalidated by the
 * things that can actually change it, the backing-store size and the palette
 * identity, checked in `pitchLayerIsCurrent` rather than by a timestamp or a
 * generation counter, because a size and a palette are the facts themselves.
 *
 * THE VIGNETTE. SPEC section 18 asks for a subtle one and the palette has no
 * vignette token, which is the point: the vignette is not a colour, it is the
 * pitch's own darker stripe fading the mown bands out toward the rails. The
 * stops are `transparent` and `stripeA`, so the worst colour any pixel can
 * become at the rail line is stripe A itself, and the section's contrast
 * table is quoted against stripe A: the floor the vignette can reach is the
 * floor the table already measured. It is drawn under the markings and the
 * rail, so nothing that carries a contrast guarantee is tinted by it.
 *
 * THE PASS ORDER is DESIGN section 7's: pitch, goal frames, effects behind,
 * entities, aim arrow, effects in front. All six live in `drawFrame` below.
 * The aim pass and the per-frame clear sat at the composition root from PF-5
 * until PF-12, because this file was off that part's surface; they moved in
 * here the moment a pass had to land IN FRONT of the arrow, which is the first
 * moment the difference between "after the frame" and "after the entities"
 * exists at all.
 *
 * THE FRAME STARTS EMPTY, and the clear belongs to this composition rather
 * than to its caller. The cached pitch layer is opaque over the pitch and
 * transparent everywhere else, so blitting it leaves whatever was outside the
 * pitch on the previous frame exactly where it was: a circle resting against a
 * wall aims up to a hundred and eighty units past it, and every one of those
 * pixels would otherwise stay on the surface for the rest of the session. The
 * clear runs in device space over the whole backing store and BEFORE the shake
 * offset is applied, because a shifted clear leaves the strip the shift
 * uncovers carrying the previous frame.
 */

import {
  BALL_START_X,
  BALL_START_Y,
  CENTRE_CIRCLE_RADIUS,
  FIELD_BOTTOM,
  FIELD_HEIGHT,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIELD_WIDTH,
  GOAL_FRAME_DEPTH,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_LOW,
  WALL_THICKNESS,
} from '../core/config';
import type { AimPreview } from '../core/aiming';
import type { World } from '../core/bodies';
import { BORDER, RADIUS, SPACE } from './tokens';
import type { PitchPalette } from './tokens';
import { applySurfaceTransform, backingRatio, type Surface } from './surface';
import { TAU, drawEntities } from './entities';
import type { Facing, Glyphs } from './entities';
import { drawAimArrow } from './arrow';
import type { EffectsFrame, ShakeOffset } from './effects';

/** A rect in design space: the corner and the extent, y up. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Mown stripes. The band count is derived from the spacing scale, not chosen:
 * the largest spacing step decides how many bands a field of this width is
 * cut into, and the bands are then exactly even. The first band is stripe A,
 * the darker of the pair, because SPEC section 18 quotes the markings'
 * contrast against it first.
 */
const STRIPE_WIDTH = SPACE[8];

export function drawStripes(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
): void {
  const count = Math.ceil(FIELD_WIDTH / STRIPE_WIDTH);
  const band = FIELD_WIDTH / count;
  for (let index = 0; index < count; index += 1) {
    context.fillStyle = index % 2 === 0 ? palette.stripeA : palette.stripeB;
    context.fillRect(
      FIELD_LEFT + index * band,
      FIELD_BOTTOM,
      band,
      FIELD_HEIGHT,
    );
  }
}

/**
 * The vignette's one draw parameter. Alpha is not a colour, a size, a radius
 * or a duration, so it has no token to resolve through; it is pinned by the
 * armour tests instead, at both ends, so it cannot quietly become a fill.
 */
const VIGNETTE_EDGE_ALPHA = 0.35;

export function drawVignette(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
): void {
  const centreX = BALL_START_X;
  const centreY = BALL_START_Y;
  const inner = FIELD_HEIGHT / 2;
  const outer = Math.hypot(FIELD_WIDTH, FIELD_HEIGHT) / 2;
  const gradient = context.createRadialGradient(
    centreX,
    centreY,
    inner,
    centreX,
    centreY,
    outer,
  );
  gradient.addColorStop(0, 'transparent');
  gradient.addColorStop(1, palette.stripeA);
  context.globalAlpha = VIGNETTE_EDGE_ALPHA;
  context.fillStyle = gradient;
  context.fillRect(FIELD_LEFT, FIELD_BOTTOM, FIELD_WIDTH, FIELD_HEIGHT);
  context.globalAlpha = 1;
}

export function drawCentreMarkings(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
): void {
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.beginPath();
  context.moveTo(BALL_START_X, FIELD_BOTTOM);
  context.lineTo(BALL_START_X, FIELD_TOP);
  context.stroke();
  context.strokeStyle = palette.line;
  context.beginPath();
  context.arc(BALL_START_X, BALL_START_Y, CENTRE_CIRCLE_RADIUS, 0, TAU);
  context.stroke();
  context.fillStyle = palette.line;
  context.beginPath();
  context.arc(BALL_START_X, BALL_START_Y, RADIUS.sm, 0, TAU);
  context.fill();
}

/**
 * The wall band, one rect per piece, with the goal openings cut out of the
 * side walls: a circle is contained by the field bounds and the ball alone
 * passes through, so the drawing shows a wall everywhere but the opening.
 * The corners belong to the end walls, which span the full band width, so
 * the side pieces run their outer stretch underneath them; both paint the
 * same rail colour, so the doubled corner is invisible and the six pieces
 * together cover the enclosure exactly once in appearance.
 */
function wallRects(): readonly [Rect, Rect, Rect, Rect, Rect, Rect] {
  const left = FIELD_LEFT - WALL_THICKNESS;
  const top = FIELD_TOP;
  const bottom = FIELD_BOTTOM - WALL_THICKNESS;
  const width = FIELD_WIDTH + WALL_THICKNESS * 2;
  return [
    // The two end walls, full width including the corners.
    { x: left, y: top, width, height: WALL_THICKNESS },
    { x: left, y: bottom, width, height: WALL_THICKNESS },
    // The side walls, in two pieces each, between the corners and the
    // opening. The opening's ends are exactly GOAL_OPENING_LOW and HIGH.
    { x: left, y: bottom, width: WALL_THICKNESS, height: GOAL_OPENING_LOW - bottom },
    {
      x: left,
      y: GOAL_OPENING_HIGH,
      width: WALL_THICKNESS,
      height: FIELD_TOP + WALL_THICKNESS - GOAL_OPENING_HIGH,
    },
    {
      x: FIELD_RIGHT,
      y: bottom,
      width: WALL_THICKNESS,
      height: GOAL_OPENING_LOW - bottom,
    },
    {
      x: FIELD_RIGHT,
      y: GOAL_OPENING_HIGH,
      width: WALL_THICKNESS,
      height: FIELD_TOP + WALL_THICKNESS - GOAL_OPENING_HIGH,
    },
  ];
}

export function drawWalls(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
): void {
  context.fillStyle = palette.rail;
  for (const rect of wallRects()) {
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  // The raised rail's boundary: one light hairline along every pitch-facing
  // edge. SPEC section 18 lists the rail among the objects that carry the
  // --pf-line outline, and the edge it sits on is against the pitch, which is
  // the pair the section measures it at.
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.hair;
  context.beginPath();
  context.moveTo(FIELD_LEFT - WALL_THICKNESS, FIELD_TOP);
  context.lineTo(FIELD_RIGHT + WALL_THICKNESS, FIELD_TOP);
  context.moveTo(FIELD_LEFT - WALL_THICKNESS, FIELD_BOTTOM);
  context.lineTo(FIELD_RIGHT + WALL_THICKNESS, FIELD_BOTTOM);
  context.moveTo(FIELD_LEFT, FIELD_BOTTOM - WALL_THICKNESS);
  context.lineTo(FIELD_LEFT, GOAL_OPENING_LOW);
  context.moveTo(FIELD_LEFT, GOAL_OPENING_HIGH);
  context.lineTo(FIELD_LEFT, FIELD_TOP + WALL_THICKNESS);
  context.moveTo(FIELD_RIGHT, FIELD_BOTTOM - WALL_THICKNESS);
  context.lineTo(FIELD_RIGHT, GOAL_OPENING_LOW);
  context.moveTo(FIELD_RIGHT, GOAL_OPENING_HIGH);
  context.lineTo(FIELD_RIGHT, FIELD_TOP + WALL_THICKNESS);
  context.stroke();
}

/**
 * The goal frames, outside the field edge with the rail between them and the
 * pitch (SPEC section 18). The player defends the left goal and attacks the
 * right, so the left frame takes the player tint and the right the opponent
 * tint. The outline strokes the whole rectangle: its field-side edge is the
 * goal line the ball scores across, and it is drawn because a mouth with no
 * line is not a goal, it is a gap.
 */
export function drawGoalFrames(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
): void {
  const opening = GOAL_OPENING_HIGH - GOAL_OPENING_LOW;
  const frames: readonly Rect[] = [
    { x: FIELD_LEFT - GOAL_FRAME_DEPTH, y: GOAL_OPENING_LOW, width: GOAL_FRAME_DEPTH, height: opening },
    { x: FIELD_RIGHT, y: GOAL_OPENING_LOW, width: GOAL_FRAME_DEPTH, height: opening },
  ];
  for (const [index, frame] of frames.entries()) {
    context.fillStyle = index === 0 ? palette.teamPlayer : palette.teamOpponent;
    context.fillRect(frame.x, frame.y, frame.width, frame.height);
    context.strokeStyle = palette.line;
    context.lineWidth = BORDER.thick;
    context.strokeRect(frame.x, frame.y, frame.width, frame.height);
  }
}

/**
 * One pitch layer: an offscreen canvas at one backing-store scale, in one
 * palette. Everything the frame needs to know about it is in those facts.
 */
export interface PitchLayer {
  readonly canvas: HTMLCanvasElement;
  readonly scale: number;
  readonly palette: PitchPalette;
}

/** A cell the frame composition keeps its layer in. */
export interface PitchCacheCell {
  current: PitchLayer | null;
}

/**
 * Whether a layer can still be blitted. The palette test is identity, not
 * equality of hexes: `pitchFor` hands out the two palette constants, so a
 * brightness change is a different object and a rebuild, while the same
 * palette every frame is the same object and no rebuild.
 */
export function pitchLayerIsCurrent(
  layer: PitchLayer,
  surface: Surface,
  palette: PitchPalette,
): boolean {
  return (
    layer.scale === surface.scale &&
    layer.palette === palette &&
    layer.canvas.width === surface.canvas.width &&
    layer.canvas.height === surface.canvas.height
  );
}

/**
 * Render the static layers once, in pass order, into an offscreen canvas at
 * the surface's backing-store scale. Called by the frame composition only
 * when `pitchLayerIsCurrent` has said the cache is stale. The canvas comes
 * from the factory parameter, whose default is the document: a headless test
 * drives the rebuild with its own factory rather than by faking a DOM.
 */
export function renderStaticPitch(
  surface: Surface,
  palette: PitchPalette,
  createCanvas: () => HTMLCanvasElement = defaultLayerCanvas,
): PitchLayer {
  const canvas = createCanvas();
  canvas.width = surface.canvas.width;
  canvas.height = surface.canvas.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('the offscreen pitch could not get a 2d context');
  }
  applySurfaceTransform(context, surface.scale);
  drawStripes(context, palette);
  drawVignette(context, palette);
  drawCentreMarkings(context, palette);
  drawWalls(context, palette);
  // The goal-frames pass, last of the static layers, exactly as it sits in
  // DESIGN section 7's order.
  drawGoalFrames(context, palette);
  return { canvas, scale: surface.scale, palette };
}

/** No shake, which is every frame that is not answering a hard collision. */
const STILL: ShakeOffset = Object.freeze({ x: 0, y: 0 });

/**
 * The frame's first pass: the whole backing store cleared, then the cached
 * pitch and goal frames, one drawImage. Both run in device space, because the
 * cache is already at backing-store scale, and the surface transform goes
 * straight back so the passes after it draw in design units without knowing
 * the blit happened.
 *
 * SPEC section 14's shake enters HERE and nowhere else: it offsets the blit
 * and the design transform together, so the whole scene moves as one on the
 * backing store while the canvas element, the frame around it and the DOM
 * chrome stay exactly where they were (DESIGN section 7).
 */
function blitPitch(surface: Surface, layer: PitchLayer, shake: ShakeOffset): void {
  surface.context.setTransform(1, 0, 0, 1, 0, 0);
  surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  surface.context.setTransform(1, 0, 0, 1, shake.x, shake.y);
  surface.context.drawImage(layer.canvas, 0, 0);
  applySurfaceTransform(surface.context, surface.scale, shake.x, shake.y);
}

/** Where a headless build gets no say: the layer canvas is a DOM canvas. */
function defaultLayerCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

/** What a frame needs beyond the world: the per-scene render inputs. */
export interface FrameOptions {
  readonly facing?: Facing;
  readonly glyphs?: Glyphs;
  readonly createLayer?: () => HTMLCanvasElement;
  /** SPEC section 5's aim of the moment, or absent when nobody is aiming. */
  readonly aim?: AimPreview;
  /** SPEC section 14's motion set, absent in a composition that has none. */
  readonly effects?: EffectsFrame;
}

/**
 * One frame, in DESIGN section 7's order. The cache cell is the caller's, so
 * the layer survives across frames and the composition stays a pure function
 * of the world, the aim and the effects state.
 */
export function drawFrame(
  surface: Surface,
  cache: PitchCacheCell,
  world: World,
  palette: PitchPalette,
  options?: FrameOptions,
): void {
  const effects = options?.effects;
  // SPEC section 14's shake arrives in CSS pixels, against the height the
  // surface renders at, and is converted to the backing store here: the one
  // module that owns the device pixel ratio is the one that applies it.
  const offset = effects === undefined ? STILL : effects.shake(surface.cssHeight);
  const ratio = backingRatio(surface);
  const shake: ShakeOffset = { x: offset.x * ratio, y: offset.y * ratio };
  let layer = cache.current;
  if (layer === null || !pitchLayerIsCurrent(layer, surface, palette)) {
    layer = renderStaticPitch(
      surface,
      palette,
      options?.createLayer ?? defaultLayerCanvas,
    );
    cache.current = layer;
  }
  blitPitch(surface, layer, shake);
  if (effects !== undefined) {
    effects.drawBehind(surface.context, palette);
  }
  drawEntities(surface.context, palette, world, options?.facing, options?.glyphs);
  const aim = options?.aim;
  if (aim !== undefined) {
    drawAimArrow(surface.context, palette, world.player, aim);
  }
  if (effects !== undefined) {
    effects.drawInFront(surface.context, palette, world, aim ?? null);
  }
}
