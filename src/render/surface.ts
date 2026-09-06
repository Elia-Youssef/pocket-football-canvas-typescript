/**
 * The play surface wrapper: one canvas, one backing store, one coordinate
 * transform.
 *
 * DESIGN section 7 gives this module its two jobs and its two prohibitions.
 * The jobs: the device pixel ratio is handled ONCE, here, by sizing the
 * backing store at resize time rather than per frame; and the one coordinate
 * transform lives here, so no draw call anywhere else converts a coordinate.
 * The prohibitions follow from the same sentence: nothing below the wrapper
 * sees a device ratio, and nothing above it sees a design coordinate turned
 * into canvas pixels by hand.
 *
 * THE FLIP. SPEC section 3 puts the origin at the bottom left and y up; a
 * canvas puts it at the top left and y down. The base transform maps design
 * units straight onto device pixels, flip included, so every renderer below
 * this file draws in SPEC coordinates and reads like SPEC section 3. Text is
 * the one thing that cannot live under a flip, and entities.ts counter-flips
 * locally for its glyphs rather than introducing a second transform.
 *
 * This module is DOM glue by designation and is therefore never imported by
 * anything under core/, which is the boundary the lint already enforces.
 */

import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from '../core/config';

/** A canvas, its 2d context, and the scale the last resize left behind. */
export interface Surface {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  /** Logical design units to device pixels, from the last resize. */
  scale: number;
  /**
   * The height the surface RENDERS at, in CSS pixels, from the last resize.
   *
   * Carried because SPEC section 14 states the screen shake against the
   * rendered height and a CSS height is what a player sees; the backing store
   * is that height times the device pixel ratio, and a magnitude stated
   * against one and applied in the other would carry the ratio into a chain
   * QUALITY-BAR section 7 keeps it out of.
   *
   * THE SHAKE CAP RIDES THIS NUMBER, and QUALITY-BAR section 4's size setting
   * moves it. The cap is one and a half percent of the rendered height, which
   * is 10.8 CSS pixels at the full-size fit and 21.6 at 200 percent; it stays
   * a constant fraction of what the player sees, which is what the effects
   * layer intends, and it stays harmless to the pointer mapping for the same
   * reason it always was: the input lock refuses an aim while bodies move.
   */
  cssHeight: number;
}

/**
 * The CSS height that keeps the logical 1280 x 720 ratio for a CSS width.
 * The whole sizing rule is this ratio plus the fit below: a surface is only
 * ever described by its CSS WIDTH, and its height follows, so no caller can
 * size the two axes independently and squash the pitch.
 */
export function cssHeightFor(cssWidth: number): number {
  return (cssWidth * LOGICAL_HEIGHT) / LOGICAL_WIDTH;
}

/**
 * SPEC section 17's play-surface size, as the multiplier it names.
 *
 * The setting is stated in percent and applied as a factor, and it is applied
 * to the CSS box alone: QUALITY-BAR section 4 asks it to raise the
 * logical-to-CSS scale, which `logicalScale` below computes from that box, and
 * the logical space stays 1280 x 720 whatever it is set to. That is what keeps
 * SPEC section 6.1's 30 px and 180 px drag constants meaning the same thing at
 * every size: they are design units, and nothing here touches design units.
 */
export function surfaceFactor(sizePercent: number): number {
  return sizePercent / 100;
}

/**
 * The CSS width the play surface takes inside an available box.
 *
 * THE LETTERBOX IS THIS ONE MINIMUM. SPEC section 2.1 scales the SAME
 * landscape pitch to fit and centres it, so the fit is the smaller of what the
 * width allows and what the height allows, and the axis that did not bind is
 * where the empty bands appear. A width-driven fit that ignored the height is
 * what makes a pitch taller than the viewport it is drawn in, and it is why
 * the height is a parameter here rather than a consequence.
 *
 * THE BASE IS FLOORED TO A WHOLE CSS PIXEL BEFORE THE FACTOR IS APPLIED, and
 * the order matters twice. A box measured as an integer can be a fraction
 * narrower than it reports, so a surface sized to the reported number can
 * overflow its container by a fraction and raise a scrollbar over nothing;
 * flooring first puts the surface inside the box it was measured against.
 * Flooring BEFORE the factor rather than after is what makes the size setting
 * exact: 200 percent is exactly twice 100 percent, where a floor taken
 * afterwards would land a pixel either side of it and the criterion asks for
 * the factor.
 *
 * The one-pixel floor is the same refusal `resizeSurface` makes: a collapsed
 * host draws a one-pixel surface rather than a zero-sized backing store that
 * silently loses everything drawn into it.
 */
export function fitCssWidth(
  availableWidth: number,
  availableHeight: number,
  sizePercent: number,
): number {
  const byHeight = (availableHeight * LOGICAL_WIDTH) / LOGICAL_HEIGHT;
  const base = Math.min(availableWidth, byHeight);
  const whole = Number.isFinite(base) ? Math.floor(base) : 0;
  return Math.max(1, whole) * surfaceFactor(sizePercent);
}

/** Which axes a surface of this CSS width is larger than its box in. */
export interface SurfaceOverflow {
  readonly across: boolean;
  readonly down: boolean;
}

/**
 * Whether a surface of this CSS width is larger than the box it sits in,
 * PER AXIS. For every box at least one CSS pixel in each axis the answer at
 * 100 percent is false in both, because the fit is the box's own minimum;
 * above it the answer is what tells the frame to stop centring the surface,
 * since a centred overflow puts its own start edge out of reach of every
 * scroll position.
 *
 * TWO ANSWERS AND NOT ONE, because the two axes overflow separately: a 125
 * percent surface in a portrait box is wider than its box and shorter than
 * it, and pinning both axes on one boolean would collapse the band in the
 * axis that still fits and jam the pitch against an edge. That is the common
 * case rather than an edge case: every portrait viewport above 100 percent
 * overflows exactly one axis.
 */
export function surfaceOverflow(
  availableWidth: number,
  availableHeight: number,
  cssWidth: number,
): SurfaceOverflow {
  return {
    across: cssWidth > availableWidth,
    down: cssHeightFor(cssWidth) > availableHeight,
  };
}

/**
 * The scroll offsets that put a design point in the middle of a viewport of
 * `viewWidth` by `viewHeight` CSS pixels over this surface.
 *
 * THE CONVERSION LIVES HERE BECAUSE EVERY CONVERSION DOES. DESIGN section 7
 * gives this module the one coordinate transform, and a caller that turned a
 * design point into a CSS offset by hand would be a second one. The y term
 * carries the same flip the draw transform does: the design space has its
 * origin at the bottom left and a scroll offset is measured from the top.
 *
 * It answers an offset that may be outside the scrollable range, and that is
 * deliberate: a scroll container clamps what it is given, so the caller hands
 * over the ideal and the platform decides what is reachable, which is exactly
 * what happens at the four edges of the pitch.
 */
export function scrollToCentre(
  surface: Surface,
  designX: number,
  designY: number,
  viewWidth: number,
  viewHeight: number,
): { left: number; top: number } {
  const cssPerUnit = surface.cssHeight / LOGICAL_HEIGHT;
  return {
    left: designX * cssPerUnit - viewWidth / 2,
    top: (LOGICAL_HEIGHT - designY) * cssPerUnit - viewHeight / 2,
  };
}

/**
 * Device pixels per logical design unit: the CSS size ratio times the device
 * pixel ratio. The device ratio enters HERE and nowhere else, which is what
 * "handled once" means; a draw call that multiplies by it again would draw
 * the scene twice as large on a retina screen.
 */
export function logicalScale(cssWidth: number, deviceRatio: number): number {
  return (cssWidth / LOGICAL_WIDTH) * deviceRatio;
}

/**
 * The one coordinate transform, from SPEC design units to device pixels, y
 * flipped. Nothing else in the renderer calls setTransform with these numbers
 * except the blit, which leaves device space for one call and comes straight
 * back.
 *
 * THE OFFSET IS SPEC SECTION 14'S SCREEN SHAKE AND NOTHING ELSE, in device
 * pixels, and it is a parameter of this transform rather than a transform of
 * its own. DESIGN section 7 puts the shake on the play surface only: it moves
 * the backing store's contents and never the canvas element, because a CSS
 * transform on the element is what QUALITY-BAR section 7 forbids outright and
 * what would break the pointer mapping and the frame's focus ring together.
 * Both offsets default to zero, so every caller that has no shake to apply
 * asks for the same matrix it always did.
 */
export function applySurfaceTransform(
  context: CanvasRenderingContext2D,
  scale: number,
  offsetX = 0,
  offsetY = 0,
): void {
  context.setTransform(scale, 0, 0, -scale, offsetX, LOGICAL_HEIGHT * scale + offsetY);
}

/** Wrap a canvas that is already in the document as a play surface. */
export function attachSurface(canvas: HTMLCanvasElement): Surface {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('the play surface could not get a 2d context');
  }
  return { canvas, context, scale: 0, cssHeight: 0 };
}

/**
 * Create the surface's canvas inside a host element. The attributes are the
 * whole of the surface's accessibility contract: the canvas is aria-hidden,
 * because QUALITY-BAR section 1 keeps the scene out of the accessibility tree
 * and gives it a state mirror instead, and the data attribute is the stable
 * hook a test or a capture script selects the surface by.
 */
export function createSurface(host: HTMLElement): Surface {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset['pf'] = 'play-surface';
  host.appendChild(canvas);
  return attachSurface(canvas);
}

/**
 * Size the backing store for a CSS width and the device ratio of the moment,
 * then set the transform. The one-pixel floor is not a policy: a zero-sized
 * backing store is legal to allocate and silently loses everything drawn into
 * it, so a collapsed host draws a one-pixel surface rather than a black hole.
 * CSS size follows the backing store so the canvas element fills its box
 * exactly; the value is interpolated into the style property, never written
 * as a literal with a unit in it, which the token sweep would (and should)
 * reject.
 */
export function resizeSurface(
  surface: Surface,
  cssWidth: number,
  deviceRatio: number,
): void {
  const width = Math.max(1, Math.round(cssWidth * deviceRatio));
  const height = Math.max(1, Math.round(cssHeightFor(cssWidth) * deviceRatio));
  surface.canvas.width = width;
  surface.canvas.height = height;
  surface.canvas.style.width = `${String(cssWidth)}px`;
  surface.canvas.style.height = `${String(cssHeightFor(cssWidth))}px`;
  surface.scale = logicalScale(cssWidth, deviceRatio);
  surface.cssHeight = cssHeightFor(cssWidth);
  applySurfaceTransform(surface.context, surface.scale);
}

/**
 * Device pixels per CSS pixel for this surface, which is the device pixel ratio
 * the backing store was last sized at, recovered rather than asked for. It is
 * the ONE place anything outside this module needs it, and it exists so that a
 * magnitude stated in CSS pixels can be applied to a backing store: nothing
 * above the wrapper divides by it, which is the whole of QUALITY-BAR section
 * 7's third rule. A surface that has never been sized answers one, because a
 * scene drawn at no size needs no conversion.
 */
export function backingRatio(surface: Surface): number {
  return surface.cssHeight > 0 ? surface.canvas.height / surface.cssHeight : 1;
}

/**
 * Call the handler whenever the device pixel ratio stops being the one this
 * watch armed itself with, and rearm on every fire. The trigger exists
 * because nothing else observes the ratio: a resize observer watches the css
 * box, and dragging the window to a monitor with a different density changes
 * the ratio while the box stays exactly where it was, which is how a scene
 * ends up drawn at one density and displayed at another. The query is
 * rebuilt from the ratio of the moment on every fire, so the watch keeps
 * working for however many density changes a session takes, and the handler
 * is the caller's redraw, which reads the current ratio itself.
 */
export function watchDeviceRatio(
  win: Window,
  handler: (ratio: number) => void,
): void {
  let ratio = win.devicePixelRatio;
  let query: MediaQueryList | null = null;
  const onChange = (): void => {
    ratio = win.devicePixelRatio;
    handler(ratio);
    arm();
  };
  const arm = (): void => {
    if (query !== null) {
      query.removeEventListener('change', onChange);
    }
    query = win.matchMedia(`(resolution: ${String(ratio)}dppx)`);
    query.addEventListener('change', onChange);
  };
  arm();
}
