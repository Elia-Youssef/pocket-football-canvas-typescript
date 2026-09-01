/**
 * SPEC section 11's aim guide, drawn.
 *
 * IT COMPUTES NO PREDICTION. The path is `core/guide.ts`'s and arrives here as
 * a finished polyline and one optional marker; this module turns that into
 * dashes and a ring and has no opinion about where either goes. That is the
 * same division `arrow.ts` keeps with `core/aiming.ts`, and it is what lets
 * the whole of SPEC section 11's reading be graded headlessly.
 *
 * DOTTED IS THE SECTION'S OWN WORD, and the dashes are laid out here rather
 * than handed to the context's dash setting. Two reasons, and the second is
 * the one that matters: a dash pattern is context state that outlives the pass
 * that set it, so the aim arrow and every effect drawn in front of the guide
 * would come out dotted unless this pass remembered to put it back, and a pass
 * that has to remember something is a pass that will one day forget. Laying
 * the dashes out also makes the pattern a value a test can read.
 *
 * THE PATTERN CARRIES ACROSS THE BOUNCE. The phase is not reset at the corner,
 * so the prediction reads as one dotted line with a turn in it rather than as
 * two lines that happen to meet.
 *
 * Every length is a token: the dash and the gap come from the spacing scale
 * and the stroke from the border scale. The colour is the pitch's `line`
 * token, which SPEC section 18 already measures against every ground the pitch
 * can put under it.
 */

import type { AimGuide, GuidePoint } from '../core/guide';
import { TAU } from './entities';
import { BORDER, SPACE } from './tokens';
import type { PitchPalette } from './tokens';

/** The dash and the gap, from the spacing scale. */
export const GUIDE_DASH = SPACE[2];
export const GUIDE_GAP = SPACE[3];
export const GUIDE_PERIOD = GUIDE_DASH + GUIDE_GAP;

/** The contact marker's radius, from the spacing scale. */
export const GUIDE_MARKER_RADIUS = SPACE[3];

/** One drawn stretch of the dotted line, in design units. */
export interface GuideDash {
  readonly from: GuidePoint;
  readonly to: GuidePoint;
}

/**
 * The polyline as dashes. Walks every leg in order, carrying the phase across
 * the corner, and answers with the stretches that are drawn rather than with
 * the gaps between them.
 */
export function guideDashes(path: readonly GuidePoint[]): readonly GuideDash[] {
  const dashes: GuideDash[] = [];
  if (path.length < 2) {
    return dashes;
  }
  let phase = 0;
  for (let leg = 1; leg < path.length; leg += 1) {
    const from = path[leg - 1];
    const to = path[leg];
    if (from === undefined || to === undefined) {
      continue;
    }
    const spanX = to.x - from.x;
    const spanY = to.y - from.y;
    const length = Math.hypot(spanX, spanY);
    if (!(length > 0)) {
      continue;
    }
    const unitX = spanX / length;
    const unitY = spanY / length;
    let along = 0;
    while (along < length) {
      const into = phase % GUIDE_PERIOD;
      const drawing = into < GUIDE_DASH;
      const untilChange = drawing ? GUIDE_DASH - into : GUIDE_PERIOD - into;
      const step = Math.min(untilChange, length - along);
      if (drawing) {
        dashes.push({
          from: { x: from.x + unitX * along, y: from.y + unitY * along },
          to: { x: from.x + unitX * (along + step), y: from.y + unitY * (along + step) },
        });
      }
      along += step;
      phase += step;
    }
  }
  return dashes;
}

/**
 * The guide pass: the predicted path as a dotted polyline, and a ring where
 * the launching circle would first touch the ball. A path with fewer than two
 * points is not a path and draws nothing, which is the honest answer for an
 * aim that has no direction at all.
 */
export function drawAimGuide(
  context: CanvasRenderingContext2D,
  palette: PitchPalette,
  guide: AimGuide,
): void {
  const dashes = guideDashes(guide.path);
  if (dashes.length > 0) {
    context.strokeStyle = palette.line;
    context.lineWidth = BORDER.thin;
    context.beginPath();
    for (const dash of dashes) {
      context.moveTo(dash.from.x, dash.from.y);
      context.lineTo(dash.to.x, dash.to.y);
    }
    context.stroke();
  }
  const contact = guide.contact;
  if (contact !== undefined) {
    // The marker is a ring rather than a disc: the ball is behind it, and a
    // filled marker would hide the thing the marker is about.
    context.strokeStyle = palette.line;
    context.lineWidth = BORDER.thin;
    context.beginPath();
    context.arc(contact.x, contact.y, GUIDE_MARKER_RADIUS, 0, TAU);
    context.stroke();
  }
}
