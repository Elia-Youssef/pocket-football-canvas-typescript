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
   */
  cssHeight: number;
}

/**
 * The CSS height that keeps the logical 1280 x 720 ratio for a CSS width.
 * The letterbox policy is PF-14's; until that part lands this ratio is the
 * whole sizing rule, applied here so no caller recomputes it.
 */
export function cssHeightFor(cssWidth: number): number {
  return (cssWidth * LOGICAL_HEIGHT) / LOGICAL_WIDTH;
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
