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
 * Viewport height at and above which the two chrome bars stay stuck.
 *
 * QUALITY-BAR section 5 states the rule as a floor: sticky top and bottom bars
 * must collapse or unstick BELOW a 400 px viewport height. At exactly 400 they
 * may stay stuck, and they do, because the threshold is the document's and
 * this is the one place it is written down.
 */
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

/** Whether the two chrome bars stay stuck to the viewport at this height. */
export function barsStick(height: number): boolean {
  return height >= STICKY_MIN_HEIGHT;
}
