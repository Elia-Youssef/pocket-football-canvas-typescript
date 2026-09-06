import { describe, expect, it } from 'vitest';

import {
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  MAX_DRAG,
  MIN_DRAG,
  power01,
} from '../../src/core/config';
import {
  attachSurface,
  cssHeightFor,
  fitCssWidth,
  logicalScale,
  resizeSurface,
  scrollToCentre,
  surfaceFactor,
  surfaceOverflow,
} from '../../src/render/surface';
import { CanvasRecorder, asCanvas, fakeCanvas } from './support/canvas-recorder';

/**
 * Items F3 and F6, the half automation can reach without a browser: the fit
 * arithmetic behind SPEC section 2.1's letterbox and QUALITY-BAR section 4's
 * play-surface size.
 *
 * THE FIT TAKES BOTH AXES, AND THAT IS THE WHOLE OF THE LETTERBOX. The surface
 * keeps its 1280 x 720 shape, so the box it goes into decides it twice over
 * and the smaller answer wins; the axis that did not bind is where the empty
 * bands appear. A width-driven fit is the wrong answer that looks right on a
 * desktop, so it is written out below as a control and the tests say where the
 * two differ.
 *
 * THE SIZE SETTING IS ASSERTED AS A FACTOR AND AS A NON-EVENT. It multiplies
 * the CSS box exactly, and it leaves the logical space alone: the same press,
 * taken as a fraction of the surface, is the same design coordinate at every
 * setting, which is what keeps SPEC section 6.1's 30 px and 180 px drag
 * constants meaning what they meant. That second half is the one an
 * implementation gets wrong.
 */

/** The rule this part replaced, kept so the tests can say where it fails. */
function widthDriven(availableWidth: number, sizePercent: number): number {
  return Math.max(1, Math.floor(availableWidth)) * (sizePercent / 100);
}

/**
 * A css offset inside the surface, in design units: the inverse of the draw
 * transform, written from the same sentence render/input.ts is written from
 * rather than imported from it, because a test that borrowed the mapping could
 * not tell a wrong mapping from a wrong fit.
 */
function designFromCss(cssOffset: number, cssWidth: number): number {
  return (cssOffset / cssWidth) * LOGICAL_WIDTH;
}

describe('PF-14 the play surface fit', () => {
  describe('the box, both axes', () => {
    it('takes the width when the width is what binds', () => {
      // A tall box: 1280 across needs 720 down, and 900 is more than that.
      expect(fitCssWidth(1280, 900, 100)).toBe(1280);
      expect(cssHeightFor(1280)).toBe(720);
    });

    it('takes the height when the height is what binds', () => {
      // 1280 across would need 720 down and only 360 is offered, so the fit is
      // the width that 360 allows: 360 * 1280 / 720.
      expect(fitCssWidth(1280, 360, 100)).toBe(640);
      expect(cssHeightFor(640)).toBe(360);
    });

    it('never returns a surface larger than the box in either axis', () => {
      for (const width of [320, 375, 700, 768, 1024, 1280, 1920]) {
        for (const height of [180, 256, 400, 591, 720, 900, 1200]) {
          const fitted = fitCssWidth(width, height, 100);
          const label = `${String(width)}x${String(height)}`;
          expect(fitted, label).toBeLessThanOrEqual(width);
          expect(cssHeightFor(fitted), label).toBeLessThanOrEqual(height);
          expect(surfaceOverflow(width, height, fitted).across, label).toBe(false);
          expect(surfaceOverflow(width, height, fitted).down, label).toBe(false);
        }
      }
    });

    it('letterboxes rather than cropping: the shape is the same shape', () => {
      // SPEC section 2.1: the SAME landscape pitch, scaled to fit. A portrait
      // box gets a wide surface with bands above and below it, and the ratio
      // is the logical one at every viewport.
      for (const [width, height] of [
        [375, 480],
        [320, 500],
        [412, 700],
      ] as const) {
        const fitted = fitCssWidth(width, height, 100);
        expect(fitted / cssHeightFor(fitted)).toBeCloseTo(LOGICAL_WIDTH / LOGICAL_HEIGHT, 12);
        // Width-bound in every portrait box, so the bands are the vertical
        // ones and the pitch spans the screen.
        expect(fitted).toBe(Math.floor(width));
        expect(cssHeightFor(fitted)).toBeLessThan(height);
      }
    });

    it('differs from a width-driven fit exactly where the height binds', () => {
      // The control. At 320 x 256 with the bars unstuck, the width-driven rule
      // fits inside the viewport too, so the two agree; in a short landscape
      // box it overflows and this is the case that makes the height matter.
      expect(widthDriven(320, 100)).toBe(fitCssWidth(320, 256, 100));
      expect(widthDriven(844, 100)).toBe(844);
      expect(surfaceOverflow(844, 360, widthDriven(844, 100)).down).toBe(true);
      expect(fitCssWidth(844, 360, 100)).toBe(640);
      expect(surfaceOverflow(844, 360, fitCssWidth(844, 360, 100)).down).toBe(false);
    });

    it('floors the base to a whole css pixel before anything else', () => {
      // A box measured as an integer can be a fraction narrower than it
      // reports, and a surface sized to the reported number would overflow it.
      expect(fitCssWidth(320.6, 4000, 100)).toBe(320);
      expect(fitCssWidth(319.999, 4000, 100)).toBe(319);
    });

    it('refuses a zero-sized surface the way the resize does', () => {
      expect(fitCssWidth(0, 0, 100)).toBe(1);
      expect(fitCssWidth(-40, 900, 100)).toBe(1);
      expect(fitCssWidth(Number.NaN, 900, 100)).toBe(1);
    });
  });

  describe('the size setting, QUALITY-BAR section 4', () => {
    it('is the percent it names, as a factor', () => {
      expect(surfaceFactor(100)).toBe(1);
      expect(surfaceFactor(125)).toBe(1.25);
      expect(surfaceFactor(150)).toBe(1.5);
      expect(surfaceFactor(200)).toBe(2);
    });

    it('raises the css box by exactly that factor, at every viewport', () => {
      // Exactly, and not to within a pixel: the base is floored BEFORE the
      // factor is applied, which is what makes 200 percent twice 100 percent
      // rather than a pixel either side of it.
      for (const [width, height] of [
        [1280, 900],
        [1280, 360],
        [375, 480],
        [320, 256],
        [700, 219],
      ] as const) {
        const base = fitCssWidth(width, height, 100);
        for (const percent of [125, 150, 200]) {
          const label = `${String(width)}x${String(height)} at ${String(percent)}`;
          expect(fitCssWidth(width, height, percent), label).toBe(
            base * (percent / 100),
          );
        }
      }
    });

    it('raises the logical-to-css scale by the same factor', () => {
      // The criterion's own words. The scale is what one design unit is drawn
      // across, and the device pixel ratio is held constant here because it is
      // not part of this question.
      const base = fitCssWidth(1280, 900, 100);
      for (const percent of [100, 125, 150, 200]) {
        expect(logicalScale(fitCssWidth(1280, 900, percent), 1)).toBeCloseTo(
          logicalScale(base, 1) * (percent / 100),
          12,
        );
      }
      expect(logicalScale(fitCssWidth(1280, 900, 200), 1)).toBe(2);
    });

    it('leaves the logical space alone, so the drag constants keep their meaning', () => {
      // THE HALF AN IMPLEMENTATION GETS WRONG, and the assertions have to be
      // able to see it. Every claim below is made against the box the factor
      // SAYS the fit should have returned, so a fit that ignored the setting,
      // or that answered a constant, fails here; the same claim made against
      // the returned box alone is an identity of the mapping and would pass
      // against any fit at all. The test beneath this one is that control.
      const base = fitCssWidth(1280, 900, 100);
      for (const percent of [100, 125, 150, 200]) {
        const box = fitCssWidth(1280, 900, percent);
        const label = `at ${String(percent)}`;
        const expected = base * (percent / 100);
        expect(box, label).toBe(expected);
        // A press four tenths of the way across the surface the factor names
        // is the same place on the pitch at every setting, and the far edge is
        // still 1280 design units away.
        expect(designFromCss(0.4 * box, expected), label).toBeCloseTo(512, 9);
        expect(designFromCss(box, expected), label).toBeCloseTo(LOGICAL_WIDTH, 9);
        // The drag constants are design units and nothing here is allowed to
        // move them. Pinned by literal beside the fit that does not touch them.
        expect(MIN_DRAG, label).toBe(30);
        expect(MAX_DRAG, label).toBe(180);
        // And the strength curve those two define answers the same at every
        // setting, because it is asked in design units on both sides.
        expect(power01(MIN_DRAG), label).toBe(0);
        expect(power01(MAX_DRAG), label).toBe(1);
        expect(power01((MIN_DRAG + MAX_DRAG) / 2), label).toBeCloseTo(0.5, 12);
        // What DOES change is the magnification, and these two measure it: the
        // same design distance is that many more css pixels of travel, and a
        // css distance fixed at the 100 percent size is worth that many fewer
        // design units. Both are statements about the box, and neither is a
        // statement about the space.
        const cssForMinimumDrag = (MIN_DRAG * box) / LOGICAL_WIDTH;
        expect(cssForMinimumDrag, label).toBeCloseTo(
          ((MIN_DRAG * base) / LOGICAL_WIDTH) * (percent / 100),
          9,
        );
        const cssAtOneHundred = (MIN_DRAG * base) / LOGICAL_WIDTH;
        expect(designFromCss(cssAtOneHundred, box), label).toBeCloseTo(
          MIN_DRAG / (percent / 100),
          9,
        );
      }
      expect(LOGICAL_WIDTH).toBe(1280);
      expect(LOGICAL_HEIGHT).toBe(720);
    });

    it('would fail against a fit that answered a constant or ignored the setting', () => {
      // The control for the test above, which is the one assertion in this
      // file that most needs one: three of its claims were once identities of
      // the mapping and passed against both of the wrong fits below.
      const base = fitCssWidth(1280, 900, 100);
      const constant = (): number => 777;
      const ignoresTheSetting = (): number => base;
      for (const percent of [125, 150, 200]) {
        const expected = base * (percent / 100);
        const label = String(percent);
        expect(constant(), label).not.toBe(expected);
        expect(ignoresTheSetting(), label).not.toBe(expected);
        // And the magnification claim tells them apart as well, which is what
        // makes it evidence rather than arithmetic.
        const cssAtOneHundred = (MIN_DRAG * base) / LOGICAL_WIDTH;
        expect(designFromCss(cssAtOneHundred, ignoresTheSetting()), label).not.toBeCloseTo(
          MIN_DRAG / (percent / 100),
          9,
        );
        expect(designFromCss(cssAtOneHundred, constant()), label).not.toBeCloseTo(
          MIN_DRAG / (percent / 100),
          9,
        );
      }
    });

    it('overflows its box above 100 percent and never at it', () => {
      for (const [width, height] of [
        [1280, 900],
        [375, 480],
        [320, 256],
      ] as const) {
        const fitted = surfaceOverflow(width, height, fitCssWidth(width, height, 100));
        expect(fitted.across).toBe(false);
        expect(fitted.down).toBe(false);
        for (const percent of [125, 150, 200]) {
          const label = `${String(width)}x${String(height)} at ${String(percent)}`;
          const over = surfaceOverflow(width, height, fitCssWidth(width, height, percent));
          expect(over.across || over.down, label).toBe(true);
        }
      }
    });

    it('answers each axis separately, because the two overflow separately', () => {
      // THE COMMON CASE AND NOT AN EDGE ONE: a magnified surface in a portrait
      // box is wider than its box and shorter than it, and one answer for two
      // axes would jam the pitch against an edge in the axis that still fits.
      const wide = surfaceOverflow(390, 644, fitCssWidth(390, 644, 125));
      expect(wide.across).toBe(true);
      expect(wide.down).toBe(false);
      // And the other way round in a box wider than 16 by 9, where the height
      // is what bound the fit in the first place.
      const fitted = fitCssWidth(2000, 400, 125);
      const tall = surfaceOverflow(2000, 400, fitted);
      expect(tall.across).toBe(false);
      expect(tall.down).toBe(true);
      expect(fitted).toBeLessThan(2000);
      expect(cssHeightFor(fitted)).toBeGreaterThan(400);
    });

    it('centres a design point in the frame, with the y axis flipped', () => {
      // The scroll offsets that keep the play in view while the surface is
      // larger than the frame. The conversion is the draw transform's own, so
      // the flip is here too: design y counts up and a scroll offset counts
      // down from the top.
      const recorder = new CanvasRecorder();
      const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
      resizeSurface(surface, 2560, 1);
      // One design unit is two css pixels at this size, and the centre of the
      // pitch is 640 by 360 design units.
      expect(surface.cssHeight).toBe(1440);
      expect(scrollToCentre(surface, 640, 360, 1280, 720)).toEqual({ left: 640, top: 360 });
      // The bottom left corner of the design space is the FURTHEST DOWN the
      // scrolled box goes, which is the whole of the flip.
      expect(scrollToCentre(surface, 0, 0, 1280, 720)).toEqual({ left: -640, top: 1080 });
      expect(scrollToCentre(surface, 1280, 720, 1280, 720)).toEqual({ left: 1920, top: -360 });
      // An offset outside the range is answered rather than clamped: a scroll
      // container clamps what it is given, and the caller hands over the ideal.
      expect(scrollToCentre(surface, 0, 0, 1280, 720).left).toBeLessThan(0);
    });
  });
});
