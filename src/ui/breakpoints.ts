/**
 * QUALITY-BAR section 5's four breakpoints, resolved in code rather than in
 * media queries.
 *
 * WHY IN CODE. A media query carries its numbers as unpinned literals: nothing
 * can read `(min-width: 1024px)` back out of a stylesheet and compare it with
 * the document that owns the number, so a breakpoint that drifted would drift
 * silently. Here the numbers are exported values, `tests/unit/layout-
 * breakpoints.test.ts` reads them against the copy of QUALITY-BAR section 5's
 * own table in `tests/reference/design-contract.json`, and the composition root
 * writes the answer onto the root element where the stylesheet can select on
 * it. The stylesheet then carries arrangement and no thresholds at all.
 *
 * BY WIDTH FIRST, AND THE ORDER IS THE RULE. Section 5 makes the four
 * exhaustive and mutually exclusive and resolves them by width; orientation
 * distinguishes only the two cases below 768 px. A 1024 x 1366 tablet held in
 * its natural portrait orientation is `wide`, and an earlier form of that
 * table left exactly that viewport matching no row at all.
 *
 * PORTRAIT IS THE PLATFORM'S OWN DEFINITION. CSS resolves `orientation:
 * portrait` when the height is greater than OR EQUAL TO the width, so a square
 * viewport is portrait, and this function answers the same question the same
 * way rather than inventing a second answer a device would disagree with.
 *
 * DOM-FREE ON PURPOSE. Nothing here reads a window, an element or a media
 * query: the two numbers arrive as arguments, which is what lets a unit test
 * sweep both sides of every boundary without a browser.
 */

/** The four names, exhaustive and mutually exclusive (QUALITY-BAR section 5). */
export type Breakpoint = 'wide' | 'medium' | 'compact' | 'portrait';

/** In the table's own order, widest first, so a test can walk them. */
export const BREAKPOINTS: readonly Breakpoint[] = ['wide', 'medium', 'compact', 'portrait'];

/** Width at and above which the layout is the design-space reference one. */
export const WIDE_MIN_WIDTH = 1024;

/** Width at and above which orientation stops distinguishing anything. */
export const MEDIUM_MIN_WIDTH = 768;

/**
 * Viewport height at and above which the two chrome bars stay stuck, IN REM.
 *
 * QUALITY-BAR section 5 states the rule as a floor: sticky top and bottom bars
 * must collapse or unstick BELOW a viewport height of 25 rem. At exactly the
 * threshold they may stay stuck, and they do, because the floor is the
 * document's and this is the one place it is written down.
 *
 * IN REM BECAUSE THE BARS ARE. The rule was written as 400 CSS px, which covers
 * browser ZOOM (zoom scales CSS pixels, so a zoomed viewport is smaller in them
 * and the threshold moves with it) and misses a TEXT-SIZE setting entirely: text
 * scaling grows every bar without changing the viewport's CSS pixels, so the
 * bars kept sticking to a viewport they no longer fit. Measured at 200 percent
 * text on three engines: 205 and 403 CSS px of bar against a 500 px viewport,
 * the later painted over the earlier, the pause control wholly covered and the
 * scroll padding declaring a region of negative height. At 25 rem the threshold
 * follows the text: 400 px at the default size, 800 px at 200 percent, so a
 * viewport the two bars cannot both fit is never one they are stuck to.
 */
export const STICKY_MIN_REM = 25;

/** The root font size a browser lays a page out at before any text-size setting. */
export const DEFAULT_ROOT_FONT_SIZE = 16;

/** The same floor in CSS pixels at the default root size, which is what QUALITY-BAR
 * section 5 states beside the rem rule and what the design contract carries. */
export const STICKY_MIN_HEIGHT = 400;

/**
 * The breakpoint a viewport resolves to.
 *
 * A width that is not a number falls through both comparisons and lands on the
 * orientation test, where it compares false and answers `compact`. That is a
 * total answer for an impossible input rather than a fifth state: every caller
 * gets one of the four names whatever it hands in.
 */
export function breakpointFor(width: number, height: number): Breakpoint {
  if (width >= WIDE_MIN_WIDTH) {
    return 'wide';
  }
  if (width >= MEDIUM_MIN_WIDTH) {
    return 'medium';
  }
  return height >= width ? 'portrait' : 'compact';
}

/**
 * Whether the two chrome bars stay stuck to the viewport at this height.
 *
 * THE ROOT SIZE IS AN ARGUMENT, like the width and the height above: this module
 * reads no document, and the size the page is laid out at is the caller's to
 * find. A root size that is not a positive number cannot resolve a rem at all,
 * so the answer falls back to the default one QUALITY-BAR section 5 states,
 * which is a total answer for an impossible input rather than a refusal.
 */
export function barsStick(height: number, rootFontSize: number): boolean {
  const resolved = rootFontSize > 0 ? rootFontSize : DEFAULT_ROOT_FONT_SIZE;
  return height >= STICKY_MIN_REM * resolved;
}
