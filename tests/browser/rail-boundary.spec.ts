import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { LOGICAL_HEIGHT, LOGICAL_WIDTH, nextFrames, openGame } from './support/game';

/**
 * SPEC section 18's rail row, measured where it is stated: in RENDERED pixels.
 *
 *   "Rail boundary on stripe A / stripe B | 5.38 / 4.70:1 | 3.71 / 3.27:1 | 3:1"
 *   "The approved rail record reads the boundary off the live canvas at
 *    backing scales 0.336, 0.672, 0.820, 1.230 and 1.641 ... with a whole
 *    device pixel of pure `--pf-line` from backing scale 1/3 upward, where
 *    three design units cover one. Below 1/3 the band covers part of a device
 *    pixel over the rail and the best pixel is a line-over-rail blend."
 *
 * WHICH GATE CARRIES WHAT. The band's PLACEMENT is a unit assertion:
 * `tests/unit/render-pitch.test.ts` takes the recorded path coordinates at six
 * backing scales and holds the pitch-facing side of the band to a whole device
 * pixel within half a pixel of the field bound, on the rail's side of it. That
 * is the guard, it runs in milliseconds, and it is what the mutation harness
 * fires at. What THIS file adds is the thing no recorded coordinate can show:
 * the pixel the browser actually rasterised, its bytes, and its contrast
 * against the stripe beside it.
 *
 * WHY A HEX PAIR IS NOT THE MEASUREMENT EITHER. Two colours have one contrast
 * ratio, and `tests/unit/tokens.test.ts` re-derives all four of this row's
 * cells from the hexes. What it cannot see is whether any pixel on the surface
 * is either colour: a band one design unit wide is a third of a device pixel
 * at a backing scale of a third, and an antialiased third of a pixel is a
 * blend of the boundary and the rail behind it. The 2026-09-08 audit read the
 * live canvas back and measured 2.59:1 on a daylight 430 CSS pixel portrait
 * viewport where the table asks for 3, with the note that the hairline never
 * resolves. This file is that reading, kept.
 *
 * WHAT IS MEASURED, AND WHAT EACH SAMPLE HAS TO SHOW. Along every pitch-facing
 * edge, at a column or a row in a stripe A band and in a stripe B band: the
 * best device pixel across the boundary's own width against the stripe pixel
 * four device pixels inward. Every sample clears the floor. Where the band
 * covers a whole device pixel - at a backing scale of one third and above, so
 * on a surface whose CSS width times the device ratio is at least 426.7 - that
 * pixel must BE the `--pf-line` token, byte for byte, and never the
 * `--pf-rail` token: a ratio alone can be carried by the rail fill and by the
 * vignette, and was, so a ratio alone does not say the boundary is there.
 * Below one third the band covers part of a pixel over the rail, the best
 * pixel is a line-over-rail blend, and the ratio is what is asserted; the blend
 * itself is printed rather than pinned.
 *
 * THE BANDS ARE DERIVED, not chosen. The stripe count comes from the spacing
 * scale against the field width the way the drawing derives it, so the two
 * columns below are the centres of two adjacent bands rather than two numbers
 * that happened to work; the audit's own vignette-free column, x = 670, is the
 * stripe B one. The side edges take the midpoints of the two solid stretches
 * of each side wall, which is as far from the goal opening and from the
 * corners as that wall goes.
 *
 * THE EDGE ALPHA IS ACCOUNTED FOR RATHER THAN ASSUMED AWAY. Below a backing
 * scale of one third the pixel the band is laid against is not fully covered
 * by anything: the wall fill ends part way through it and the stripe fill
 * begins there, and two abutting fills that each cover part of a pixel leave a
 * seam, because source-over composites them rather than adding their coverage
 * (measured: 0.91 of a pixel where the two halves are 0.9 and 0.1). The band
 * on top lifts it to 0.99 at a 375 CSS pixel surface and to 0.93 at a 320 one.
 * A ratio taken off the raw bytes of such a pixel is a ratio of a colour
 * nobody sees, so every sampled pixel is composited over the page's own
 * background colour first, read from the document rather than named here, and
 * the coverage is reported beside the ratio. At a backing scale of one third
 * and above the coverage is 1 and the composite is the identity.
 *
 * THE VIGNETTE ONLY EVER HELPS HERE, which is why a sample near a corner is
 * not a weaker reading. Its stops are `transparent` and stripe A, so the worst
 * a sampled stripe pixel can become is stripe A, and stripe A is the DARKER of
 * the pair: a tinted stripe B raises the ratio against a light boundary rather
 * than lowering it. The floor is therefore carried by the horizontal edges,
 * whose sampled columns are past the gradient's inner stop.
 *
 * NOTHING HERE DRIVES A MATCH, and nothing here installs the page clock. The
 * boundary belongs to the cached static pitch layer, which is built at the
 * first fit and blitted every frame afterwards, so the menu's own first frames
 * carry exactly the pixels a match would; a journey through the mode menu
 * would buy four more round trips per context and the same bytes. The reading
 * is taken after the frames below, with the backing store's own width checked
 * against the scale the arithmetic used.
 *
 * ONE ENGINE, by the vehicle's contract: this is a measurement of what the 2D
 * context rasterises from one set of coordinates, not of an engine difference.
 */

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'the rendered-pixel reading runs on one engine',
);

/** The floor SPEC section 18 states for this row, as the literal it is. */
const FLOOR = 3;

/**
 * The backing scale at which three design units first cover a whole device
 * pixel, which is where the section's pure-`--pf-line` guarantee starts.
 */
const WHOLE_PIXEL_SCALE = 1 / 3;

/** SPEC section 18's two tokens, as the bytes they are read back as. */
const LINE = [242, 247, 243];
const RAIL = { floodlit: [200, 207, 203], daylight: [221, 227, 223] };

/** SPEC section 3's field bounds, read by nothing the game exports. */
const FIELD = { left: 90, right: 1190, bottom: 85, top: 635 } as const;

/** SPEC section 3's goal opening, which the rail and its boundary stop at. */
const OPENING = { low: 265, high: 455 } as const;

/**
 * SPEC section 18's mown stripes, as QUALITY-BAR section 15's largest spacing
 * step cuts the field width: the count is derived and the bands are even, so
 * band 0 is stripe A and the last band is stripe B while the count is even.
 */
const STRIPE_STEP = 64;
const BAND_COUNT = Math.ceil((FIELD.right - FIELD.left) / STRIPE_STEP);
const BAND_WIDTH = (FIELD.right - FIELD.left) / BAND_COUNT;

function bandCentre(index: number): number {
  return FIELD.left + (index + 0.5) * BAND_WIDTH;
}

/** Where a sample sits along an edge, and which stripe it is against. */
interface Along {
  readonly stripe: 'A' | 'B';
  readonly at: number;
}

/**
 * One pitch-facing edge: the bound it lies on, the axis the transform measures
 * that bound on, which way the rail lies from it IN DEVICE PIXELS (the
 * transform flips y, so the rail above the pitch is at a smaller device row),
 * and where along it the stripes are sampled.
 */
interface Edge {
  readonly name: string;
  readonly axis: 'across' | 'down';
  readonly bound: number;
  readonly outward: -1 | 1;
  readonly alongs: readonly Along[];
}

/**
 * Two adjacent bands either side of the halfway line, far enough into the
 * field for the vignette's inner stop to have reached zero, for the two
 * horizontal edges; and the middle of each solid stretch of side wall for the
 * two vertical ones, which is where a side edge is furthest from both the
 * opening and a corner.
 */
const MID_BAND = BAND_COUNT / 2 - 1;
const ACROSS_ALONGS: readonly Along[] = [
  { stripe: 'A', at: bandCentre(MID_BAND) },
  { stripe: 'B', at: bandCentre(MID_BAND + 1) },
];
const DOWN_ALONGS: readonly Along[] = [
  { stripe: 'A', at: (FIELD.bottom + OPENING.low) / 2 },
  { stripe: 'B', at: (OPENING.high + FIELD.top) / 2 },
];

const EDGES: readonly Edge[] = [
  { name: 'top', axis: 'down', bound: FIELD.top, outward: -1, alongs: ACROSS_ALONGS },
  { name: 'bottom', axis: 'down', bound: FIELD.bottom, outward: 1, alongs: ACROSS_ALONGS },
  // A side wall runs against one band for its whole length: band 0 on the
  // left, the last band on the right. The stripe a sample is against is the
  // band the edge abuts, so the two rows below are two places on ONE stripe.
  {
    name: 'left',
    axis: 'across',
    bound: FIELD.left,
    outward: -1,
    alongs: DOWN_ALONGS.map((along) => ({ stripe: 'A' as const, at: along.at })),
  },
  {
    name: 'right',
    axis: 'across',
    bound: FIELD.right,
    outward: 1,
    alongs: DOWN_ALONGS.map((along) => ({ stripe: 'B' as const, at: along.at })),
  },
];

/** SPEC section 18's weight for the boundary, in design units. */
const WEIGHT = 3;

/** How far inside the pitch the stripe is read, in device pixels. */
const INWARD = 4;

/**
 * How much of a sampled pixel has to be the surface's own for the reading to
 * be of the surface. The seam described in the header costs at most a
 * fourteenth of a pixel at the smallest surface measured, so nine tenths is a
 * floor that the fill seam clears and a pixel outside the drawing does not.
 */
const MIN_COVERAGE = 0.9;

interface Sample {
  readonly edge: string;
  readonly stripe: string;
  readonly ratio: number;
  /** The best pixel across the band's width, and the one against the stripe. */
  readonly boundary: readonly number[];
  readonly against: readonly number[];
  readonly ground: readonly number[];
  /** How much of the two sampled pixels the surface itself painted. */
  readonly coverage: number;
}

interface Reading {
  readonly scale: number;
  readonly cssWidth: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly dark: boolean;
  readonly behind: readonly number[];
  readonly samples: readonly Sample[];
}

/**
 * Read the live surface back and measure every sample in one page task.
 *
 * The scale is the surface's own: the module that owns the transform writes
 * the CSS width onto the canvas and multiplies it by the device ratio, so the
 * same two numbers give the device pixels per design unit here without the
 * page being asked for a number the game does not display. It is cross-checked
 * against the backing store's own width on the way out.
 */
async function readBoundary(page: Page, edges: readonly Edge[]): Promise<Reading> {
  return page.evaluate(
    (input) => {
      const canvas = document.querySelector('[data-pf="play-surface"]');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('the play surface is not in the document');
      }
      const context = canvas.getContext('2d');
      if (context === null) {
        throw new Error('the play surface has no 2d context');
      }
      const cssWidth = Number.parseFloat(canvas.style.width);
      const scale = (cssWidth / input.width) * window.devicePixelRatio;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const pixelAt = (column: number, row: number): number[] => {
        const slot = (row * canvas.width + column) * 4;
        return [0, 1, 2, 3].map((part) => Number(pixels[slot + part]));
      };
      // What the canvas is composited over, taken from the document rather
      // than named here: the ground is a token and this file owns no colour.
      const painted = getComputedStyle(document.body).backgroundColor;
      const behind = (painted.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      if (behind.length !== 3) {
        throw new Error(`the page's ground is not a colour: ${painted}`);
      }
      /** A sampled pixel as it is SEEN: its own colour over the ground. */
      const seen = (pixel: readonly number[]): number[] => {
        const alpha = Number(pixel[3]) / 255;
        return [0, 1, 2].map(
          (part) => Number(pixel[part]) * alpha + Number(behind[part]) * (1 - alpha),
        );
      };
      const channel = (byte: number): number => {
        const value = byte / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (rgb: readonly number[]): number =>
        0.2126 * channel(Number(rgb[0])) +
        0.7152 * channel(Number(rgb[1])) +
        0.0722 * channel(Number(rgb[2]));
      const contrast = (one: readonly number[], other: readonly number[]): number => {
        const first = luminance(one);
        const second = luminance(other);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      // THE TRANSFORM'S OWN ORIGIN, which is the backing store's height: the
      // module that owns the transform translates by `Math.round(720 * scale)`
      // and the store is given that number of rows, so a design row sits at
      // `origin - y * scale`. Counting down from an unrounded `720 * scale`
      // instead misses the grid by the rounding residue - 0.08 of a device
      // pixel at a backing scale of 0.336 - and reads the pixel beside the one
      // the band was laid on.
      const originY = Math.round(input.height * scale);
      const samples = [];
      for (const edge of input.edges) {
        // The edge, and the whole device pixel the boundary's pitch-facing
        // side is laid on: the same rounding the drawing takes.
        const bound =
          edge.axis === 'across' ? edge.bound * scale : originY - edge.bound * scale;
        const laid = Math.round(bound);
        const band = input.weight * scale;
        const from = edge.outward < 0 ? laid - band : laid;
        const to = edge.outward < 0 ? laid : laid + band;
        // The pixel the band's pitch-facing side is laid against, which is the
        // one the stripe is next to. Where the band covers a whole pixel this
        // is that pixel; where it does not, it is the blend.
        const abutting = edge.outward < 0 ? laid - 1 : laid;
        for (const along of edge.alongs) {
          const other =
            edge.axis === 'across'
              ? Math.round(originY - along.at * scale)
              : Math.round(along.at * scale);
          const read = (index: number): number[] =>
            edge.axis === 'across' ? pixelAt(index, other) : pixelAt(other, index);
          const ground = read(laid + edge.outward * -1 * input.inward);
          let best = read(Math.floor(from));
          let ratio = contrast(seen(best), seen(ground));
          for (let index = Math.floor(from); index <= Math.ceil(to); index += 1) {
            const here = read(index);
            const found = contrast(seen(here), seen(ground));
            if (found > ratio) {
              best = here;
              ratio = found;
            }
          }
          samples.push({
            edge: edge.name,
            stripe: along.stripe,
            ratio,
            boundary: best,
            against: read(abutting),
            ground,
            coverage: Math.min(Number(best[3]), Number(ground[3])) / 255,
          });
        }
      }
      return {
        scale,
        cssWidth,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        behind,
        samples,
      };
    },
    {
      edges,
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
      weight: WEIGHT,
      inward: INWARD,
    },
  );
}

/** The two brightness variants, as the media feature that selects them. */
const VARIANTS = [
  { name: 'floodlit', scheme: 'dark' as const },
  { name: 'daylight', scheme: 'light' as const },
];

/** The viewports each backing ratio is measured at. */
const WIDE = { width: 1280, height: 720 };
const PORTRAIT = { width: 430, height: 700 };
/** QUALITY-BAR section 5's viewport floor, and the phone width above it. */
const FLOOR_WIDTH = { width: 320, height: 568 };
const NARROW = { width: 375, height: 667 };

const CONTEXTS = [
  { ratio: 1, viewports: [WIDE, PORTRAIT, NARROW, FLOOR_WIDTH] },
  { ratio: 1.5, viewports: [WIDE] },
  { ratio: 2, viewports: [WIDE, PORTRAIT] },
];

/** Whether two pixels are the same colour, alpha included. */
function sameColour(one: readonly number[], other: readonly number[]): boolean {
  return one.slice(0, 3).join(',') === other.slice(0, 3).join(',');
}

/** A pixel as the three bytes a token is quoted in. */
function bytes(pixel: readonly number[]): string {
  return pixel.slice(0, 3).join(',');
}

test.describe('the rail boundary, in rendered pixels', () => {
  test('derives the stripe bands from the pitch rather than naming them', () => {
    // The sampled columns are only stripe A and stripe B if the field is cut
    // the way the drawing cuts it: eighteen even bands, an even count, so band
    // 0 is stripe A and the last is stripe B, and the two sampled bands are
    // adjacent and therefore one of each.
    expect(BAND_COUNT).toBe(18);
    expect(BAND_COUNT % 2).toBe(0);
    expect(MID_BAND % 2).toBe(0);
    expect(BAND_WIDTH).toBeCloseTo(61.111, 3);
    // The audit's own vignette-free stripe B column, x = 670, lies in the
    // band this samples: the same stripe, read at its centre.
    expect(Math.abs(bandCentre(MID_BAND + 1) - 670)).toBeLessThan(BAND_WIDTH / 2);
    expect(bandCentre(MID_BAND + 1)).toBeCloseTo(670.556, 3);
    // And the side samples are clear of the goal opening the rail stops at.
    for (const along of DOWN_ALONGS) {
      expect(along.at < OPENING.low || along.at > OPENING.high).toBe(true);
    }
  });

  for (const context of CONTEXTS) {
    test.describe(`at a device ratio of ${String(context.ratio)}`, () => {
      test.use({ deviceScaleFactor: context.ratio });

      test('clears 3:1 on both stripes, in both variants', async ({ page }) => {
        test.setTimeout(180_000);
        const rows: string[] = [];
        const thin: string[] = [];
        const blind: string[] = [];
        const blended: string[] = [];
        for (const viewport of context.viewports) {
          for (const variant of VARIANTS) {
            // The viewport and the variant are set BEFORE the page is opened,
            // so the surface is fitted once, to this size, at mount: there is
            // no earlier fit for a reading to catch on its way out.
            await page.setViewportSize(viewport);
            await page.emulateMedia({ colorScheme: variant.scheme });
            await openGame(page);
            await nextFrames(page, 5);
            const reading = await readBoundary(page, EDGES);
            const where =
              `${String(viewport.width)}x${String(viewport.height)} at ` +
              `${String(context.ratio)}x, ${variant.name}`;
            // The context really is the variant it says it is, and the scale
            // the reading used really is the backing store's.
            expect(reading.dark, where).toBe(variant.scheme === 'dark');
            expect(reading.backingWidth / LOGICAL_WIDTH, where).toBeCloseTo(reading.scale, 2);
            // AND THE ORIGIN THIS READING COUNTS FROM IS THE STORE'S OWN
            // HEIGHT, which is the whole of the arithmetic above: if the page
            // ever translated by something other than the rounded product, the
            // rows sampled here would be the rows beside the band.
            expect(reading.backingHeight, `${where} backing height`).toBe(
              Math.round(reading.scale * LOGICAL_HEIGHT),
            );
            const whole = reading.scale >= WHOLE_PIXEL_SCALE;
            rows.push(
              `${where}: scale ${reading.scale.toFixed(3)}, ` +
                `css ${reading.cssWidth.toFixed(1)}, backing ${String(reading.backingWidth)}, ` +
                `over ${bytes(reading.behind)}, ` +
                `${whole ? 'a whole device pixel of band' : 'part of a device pixel of band'}`,
            );
            for (const sample of reading.samples) {
              rows.push(
                `  ${sample.edge.padEnd(6)} stripe ${sample.stripe}  ` +
                  `${sample.ratio.toFixed(2)}:1  boundary ${bytes(sample.boundary)}  ` +
                  `abutting ${bytes(sample.against)}  stripe ${bytes(sample.ground)}  ` +
                  `covering ${sample.coverage.toFixed(3)}`,
              );
              const which = `${where} ${sample.edge} stripe ${sample.stripe}`;
              // THE PREMISES OF THE READING. Both pixels are mostly the
              // surface's own, and neither is the other: a pixel the surface
              // barely painted is a reading of the page behind the canvas, and
              // a boundary pixel equal to the stripe pixel is a reading of the
              // stripe twice. What the surface did NOT paint of a sampled
              // pixel is composited above rather than ignored.
              if (sample.coverage < MIN_COVERAGE) {
                blind.push(`${which}: the surface painted ${sample.coverage.toFixed(3)} of it`);
              }
              if (sameColour(sample.boundary, sample.ground)) {
                blind.push(`${which}: the boundary pixel is the stripe pixel`);
              }
              if (!(sample.ratio >= FLOOR)) {
                thin.push(`${which}: ${sample.ratio.toFixed(2)}`);
              }
              if (!whole) {
                continue;
              }
              // AND THE DISCRIMINATION, wherever the band covers a whole pixel.
              // The rail fill clears 3:1 against stripe A on its own and the
              // vignette lifts a stripe B reading near a corner over the floor,
              // so a ratio alone can be carried by a surface with no boundary
              // on it at all. What cannot be is the token's own bytes.
              if (!sameColour(sample.boundary, LINE)) {
                blended.push(`${which}: best pixel ${bytes(sample.boundary)}, not --pf-line`);
              }
              if (sameColour(sample.boundary, RAIL[variant.name as 'floodlit' | 'daylight'])) {
                blended.push(`${which}: best pixel is --pf-rail`);
              }
              // The snap is what puts a whole pixel of the band against the
              // stripe rather than a blend straddling two, so the pixel the
              // band is laid against is the token as well.
              if (!sameColour(sample.against, LINE)) {
                blended.push(`${which}: abutting pixel ${bytes(sample.against)}, not --pf-line`);
              }
            }
            // The two horizontal edges are read against two DIFFERENT bands,
            // which is what makes "both stripes" a measurement rather than one
            // stripe read twice.
            for (const edge of ['top', 'bottom']) {
              const pair = reading.samples.filter((sample) => sample.edge === edge);
              expect(pair, `${where} ${edge}`).toHaveLength(2);
              expect(
                pair[0]?.ground.join(','),
                `${where} ${edge} bands`,
              ).not.toBe(pair[1]?.ground.join(','));
            }
          }
        }
        // THE TABLE FIRST, then the verdict: a run with the boundary put back
        // to a hairline, and a run with the boundary removed, are the controls
        // this vehicle records, and a control that stops at its first failed
        // assertion measures one cell.
        console.log(rows.join('\n'));
        // ONE ASSERTION OVER ALL THREE LISTS, because a control is only worth
        // running if it reports every cell it breaks: three assertions in a
        // row stop at the first, and a build with no boundary on it at all
        // would be recorded as one failing sample instead of all of them.
        expect({ blind, blended, thin }).toEqual({ blind: [], blended: [], thin: [] });
        expect(rows.length).toBe(context.viewports.length * VARIANTS.length * 9);
      });
    });
  }
});
