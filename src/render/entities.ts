/**
 * The three bodies, drawn as primitives.
 *
 * SPEC section 4 gives each body its identity carriers: a team fill for the
 * two circles, a facing marker and a glyph, and a panel pattern for the ball.
 * None of them may rest on colour alone, which is why the marker and the
 * glyph are drawn even though the fills already differ in luminance, and why
 * every body also carries the `--pf-line` boundary ring that SPEC section 18
 * gives every meaningful object on the pitch.
 *
 * Everything here is drawn in SPEC design coordinates, under the surface's
 * one transform, and every proportion is a ratio of the body's own radius.
 * A ratio is a shape, not a size: it scales with the body it belongs to and
 * resolves no dimension of its own. Colours resolve through the palette
 * record and line widths through the border scale, and nothing else is
 * chosen here.
 */

import { BORDER } from './tokens';
import type { PitchPalette } from './tokens';
import type { Body, World } from '../core/bodies';

/** A full turn, which every arc in this file closes. */
export const TAU = Math.PI * 2;

/** Where each circle is looking, in radians of design space. */
export interface Facing {
  readonly player: number;
  readonly opponent: number;
}

/** The text each circle carries. SPEC section 4 names the player's glyph. */
export interface Glyphs {
  readonly player: string;
  readonly opponent: string;
}

/**
 * The kickoff glyphs. The player's is named by SPEC section 4; the opponent
 * carries "an initial", and before the ladder parts supply a name to take it
 * from, the initial is the entity's own.
 */
export const DEFAULT_GLYPHS: Glyphs = { player: 'P', opponent: 'O' };

/**
 * SPEC section 4's opponent identity is the initial of the mode's name. The
 * renderer keeps the two glyphs as data; the composition root supplies this
 * value when a match configuration changes, so the ladder name reaches the
 * canvas without making rendering import the mode layer.
 */
export function glyphsForOpponent(opponentName: string): Glyphs {
  const initial = [...opponentName.trim()][0]?.toUpperCase();
  return {
    player: DEFAULT_GLYPHS.player,
    opponent: initial ?? DEFAULT_GLYPHS.opponent,
  };
}

/** The direction from one point to another, in design space. */
export function facingToward(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  return Math.atan2(toY - fromY, toX - fromX);
}

/**
 * The facing at kickoff: each circle looks at the ball, which points the
 * player upfield and the opponent back across the centre. Derived, not
 * stored, because core carries no facing state until aiming gives it one.
 */
export function kickoffFacing(world: World): Facing {
  const ball = world.ball.position;
  return {
    player: facingToward(
      world.player.position.x,
      world.player.position.y,
      ball.x,
      ball.y,
    ),
    opponent: facingToward(
      world.opponent.position.x,
      world.opponent.position.y,
      ball.x,
      ball.y,
    ),
  };
}

/**
 * The facing marker: a wedge on the circle's midline, from just under half
 * the radius out to the rim. SPEC section 4 pairs it with the glyph so that
 * identity and direction each survive the loss of the other.
 */
const MARKER_TIP = 0.95;
const MARKER_BASE = 0.45;
const MARKER_SPREAD = Math.PI / 5;

function drawMarker(
  context: CanvasRenderingContext2D,
  body: Body,
  facing: number,
  colour: string,
): void {
  const { x, y } = body.position;
  const radius = body.radius;
  context.fillStyle = colour;
  context.beginPath();
  context.moveTo(
    x + Math.cos(facing) * radius * MARKER_TIP,
    y + Math.sin(facing) * radius * MARKER_TIP,
  );
  context.lineTo(
    x + Math.cos(facing + MARKER_SPREAD) * radius * MARKER_BASE,
    y + Math.sin(facing + MARKER_SPREAD) * radius * MARKER_BASE,
  );
  context.lineTo(
    x + Math.cos(facing - MARKER_SPREAD) * radius * MARKER_BASE,
    y + Math.sin(facing - MARKER_SPREAD) * radius * MARKER_BASE,
  );
  context.closePath();
  context.fill();
}

/**
 * The glyph, drawn upright. The surface transform runs y up, and text runs y
 * down, so the glyph is drawn under a local counter-flip and no second
 * coordinate transform is introduced: the flip is undone for the length of
 * one text call and the surface's transform is what everything else sees.
 * The glyph size is the circle's own radius, so it scales with the body it
 * identifies and no type size is chosen here.
 */
function drawGlyph(
  context: CanvasRenderingContext2D,
  body: Body,
  word: string,
  colour: string,
): void {
  const { x, y } = body.position;
  context.save();
  context.translate(x, y);
  context.scale(1, -1);
  context.fillStyle = colour;
  context.font = `bold ${String(body.radius)}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(word, 0, 0);
  context.restore();
}

function drawCircle(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  body: Body,
  facing: number,
  fill: string,
  glyphColour: string,
  word: string,
): void {
  const { x, y } = body.position;
  context.fillStyle = fill;
  context.beginPath();
  context.arc(x, y, body.radius, 0, TAU);
  context.fill();
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.beginPath();
  context.arc(x, y, body.radius, 0, TAU);
  context.stroke();
  drawMarker(context, body, facing, glyphColour);
  drawGlyph(context, body, word, glyphColour);
}

/**
 * The ball's panel pattern, drawn inside the ball and clipped to it: a
 * central pentagon and five discs far enough out that the clip leaves
 * crescents on the rim. The proportions are the pattern's shape, taken from
 * the ball's own radius, which is why the pattern reads as the same ball at
 * every size the physics can give it.
 */
const PANEL_RADIUS = 0.42;
const PATCH_DISTANCE = 1.05;
const PATCH_RADIUS = 0.3;

function drawPanels(context: CanvasRenderingContext2D, body: Body): void {
  const { x, y } = body.position;
  const radius = body.radius;
  context.save();
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.clip();
  context.beginPath();
  for (let point = 0; point < 5; point += 1) {
    const angle = -Math.PI / 2 + (point * TAU) / 5;
    const px = x + Math.cos(angle) * radius * PANEL_RADIUS;
    const py = y + Math.sin(angle) * radius * PANEL_RADIUS;
    if (point === 0) {
      context.moveTo(px, py);
    } else {
      context.lineTo(px, py);
    }
  }
  context.closePath();
  context.fill();
  for (let point = 0; point < 5; point += 1) {
    const angle = -Math.PI / 2 + ((point + 0.5) * TAU) / 5;
    context.beginPath();
    context.arc(
      x + Math.cos(angle) * radius * PATCH_DISTANCE,
      y + Math.sin(angle) * radius * PATCH_DISTANCE,
      radius * PATCH_RADIUS,
      0,
      TAU,
    );
    context.fill();
  }
  context.restore();
}

function drawBall(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  body: Body,
): void {
  const { x, y } = body.position;
  context.fillStyle = palette.ballBody;
  context.beginPath();
  context.arc(x, y, body.radius, 0, TAU);
  context.fill();
  context.fillStyle = palette.ballPanel;
  drawPanels(context, body);
  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.beginPath();
  context.arc(x, y, body.radius, 0, TAU);
  context.stroke();
}

/**
 * The entity pass: both circles, then the ball, so a ball that has come to
 * rest against a circle draws on top of it and stays visible. The facing and
 * the glyphs are parameters because aim and ladder supply them later; the
 * defaults are the kickoff's, which is the only state this part owns.
 */
export function drawEntities(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  world: World,
  facing?: Facing,
  glyphs?: Glyphs,
): void {
  const where = facing ?? kickoffFacing(world);
  const words = glyphs ?? DEFAULT_GLYPHS;
  drawCircle(
    context,
    palette,
    world.player,
    where.player,
    palette.teamPlayer,
    palette.glyphOnPlayer,
    words.player,
  );
  drawCircle(
    context,
    palette,
    world.opponent,
    where.opponent,
    palette.teamOpponent,
    palette.glyphOnOpponent,
    words.opponent,
  );
  drawBall(context, palette, world.ball);
}
