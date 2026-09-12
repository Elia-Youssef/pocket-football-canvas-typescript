import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from '../../src/core/config';
import { toDesignPoint } from '../../src/render/input';
import {
  applySurfaceTransform,
  attachSurface,
  createSurface,
  cssHeightFor,
  deviceOriginY,
  logicalScale,
  resizeSurface,
  watchDeviceRatio,
} from '../../src/render/surface';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

/**
 * Armour for the play surface wrapper, item E3's frame and backing store.
 *
 * ARMOUR, NOT CLOSURE: E3 closes by the scripted capture at the
 * demonstration session. What this file pins is what automation can reach:
 * the wrapper owns the device pixel ratio once, the coordinate transform is
 * the one transform in the renderer and it carries the y flip, and a resize
 * sizes the backing store and reapplies the transform together, because a
 * backing store resized under an old transform draws the scene at the wrong
 * scale until something happens to redraw it.
 */

describe('PF-11 the play surface wrapper', () => {
  it('turns a css width and a device ratio into one scale', () => {
    // The logical space is 1280 wide, so these are the whole rule at both
    // common ratios, pinned against literals rather than against the symbols
    // that compute them.
    expect(LOGICAL_WIDTH).toBe(1280);
    expect(LOGICAL_HEIGHT).toBe(720);
    expect(logicalScale(1280, 1)).toBe(1);
    expect(logicalScale(640, 2)).toBe(1);
    expect(logicalScale(1264, 1)).toBeCloseTo(0.9875, 12);
  });

  it('keeps the logical ratio in css space', () => {
    expect(cssHeightFor(1280)).toBe(720);
    expect(cssHeightFor(1024)).toBe(576);
  });

  it('applies the one transform, y flipped, scaled and translated', () => {
    const recorder = new CanvasRecorder();
    applySurfaceTransform(recorder.context, 1.5);
    const call = recorder.calls('setTransform')[0];
    if (call === undefined) {
      throw new Error('the transform was never set');
    }
    // x' = 1.5x, y' = -1.5y + 1.5 * 720: design up, canvas down, one matrix.
    expect(call.args).toEqual([1.5, 0, 0, -1.5, 0, 1080]);
  });

  it('translates by the backing store own height, at widths that round both ways', () => {
    // ONE NUMBER, ASKED TWICE. The transform's y translation and the backing
    // store's height are the same quantity: design y = 0 is the bottom of the
    // design space and the store's last row is the bottom of the surface. The
    // two used to be computed by two expressions - `LOGICAL_HEIGHT * scale`
    // rounded here, `cssHeightFor(cssWidth) * deviceRatio` rounded there - and
    // two expressions for one number is what this asserts away.
    //
    // THE FAMILY ROUNDS BOTH WAYS ON PURPOSE. A family that only ever rounded
    // UP is passed by `Math.ceil` as happily as by `Math.round`, which is
    // exactly what the first version of this test did: 1265 CSS pixels gives
    // 711.5625 and 1264 at 1.5 gives 1066.5, and both go up. 1266 gives 712.125
    // and goes DOWN, and it is the case that tells the three roundings apart.
    const family: ReadonlyArray<readonly [number, number]> = [
      [1264, 1], // 711 exactly: nothing to round
      [1265, 1], // 711.5625, up
      [1266, 1], // 712.125, down
      [1267, 1], // 712.6875, up
      [1268, 1], // 713.25, down
      [1271, 1], // 714.9375, up
      [1264, 1.5], // 1066.5, the half itself
      [696, 1], // 391.5 one way and 391.49999999999994 the other
      [430, 1], // 241.875, the portrait viewport the rail is measured at
      [375, 1], // 210.9375
      [320, 1], // 180 exactly, QUALITY-BAR section 5's floor
    ];
    for (const [cssWidth, ratio] of family) {
      const recorder = new CanvasRecorder();
      const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
      resizeSurface(surface, cssWidth, ratio);
      const at = recorder.calls('setTransform').at(-1)?.args ?? [];
      const where = `${String(cssWidth)} at ${String(ratio)}`;
      // THE PROPERTY: the translation IS the store's height.
      expect(at[5], where).toBe(surface.canvas.height);
      // A whole number of device rows, because a store is a whole number of
      // rows and a translation between two of them belongs to neither.
      expect(Number.isInteger(at[5]), where).toBe(true);
      // AND IT IS THE NEAREST ROW: within half a device pixel of the rendered
      // height in device pixels, which `Math.ceil` misses at 1266 (713 against
      // 712.125) and `Math.floor` misses at 1265 (711 against 711.5625).
      const rendered = cssHeightFor(cssWidth) * ratio;
      expect(Math.abs(Number(at[5]) - rendered), where).toBeLessThanOrEqual(0.5);
      // The scale itself is untouched: only the translation is quantised, so a
      // design unit is still exactly `cssWidth / 1280` device pixels wide.
      expect(at[0], where).toBeCloseTo((cssWidth / LOGICAL_WIDTH) * ratio, 12);
      expect(at[3], where).toBeCloseTo(-(cssWidth / LOGICAL_WIDTH) * ratio, 12);
    }

    // THE TWO DIRECTIONS, PINNED BY LITERAL, because a bound that holds in both
    // directions is not a rounding rule until the rule is named: 711.5625 goes
    // to 712 and 712.125 goes to 712 as well.
    const up = new CanvasRecorder();
    const upward = attachSurface(asCanvas(fakeCanvas(up)));
    resizeSurface(upward, 1265, 1);
    expect(cssHeightFor(1265)).toBe(711.5625);
    expect(upward.canvas.height).toBe(712);
    expect((up.calls('setTransform').at(-1)?.args ?? [])[5]).toBe(712);
    const down = new CanvasRecorder();
    const downward = attachSurface(asCanvas(fakeCanvas(down)));
    resizeSurface(downward, 1266, 1);
    expect(cssHeightFor(1266)).toBe(712.125);
    expect(downward.canvas.height).toBe(712);
    expect((down.calls('setTransform').at(-1)?.args ?? [])[5]).toBe(712);

    // AND THE CASE THAT SAYS "ONE EXPRESSION" RATHER THAN "TWO THAT AGREE".
    // `cssHeightFor(696) * 1` is 391.5 and `LOGICAL_HEIGHT * logicalScale(696,
    // 1)` is 391.49999999999994: the same quantity, associated two ways,
    // straddling the half. A store rounded from its own product takes 392 rows
    // while the transform's origin lands on 391, and the store's bottom row
    // becomes a row the scene never reaches. 525 of 32,000 width-and-ratio
    // pairs do this; 696 CSS pixels at ratio 1 is an ordinary surface width.
    expect(cssHeightFor(696) * 1).toBe(391.5);
    expect(LOGICAL_HEIGHT * ((696 / LOGICAL_WIDTH) * 1)).toBeLessThan(391.5);
    expect(deviceOriginY((696 / LOGICAL_WIDTH) * 1)).toBe(391);
    expect(Math.round(cssHeightFor(696) * 1)).toBe(392);

    // THE WHOLE-PIXEL CASES ARE UNCHANGED, which is what says the rounding is a
    // quantisation of a half pixel and not a shift of the scene.
    const whole = new CanvasRecorder();
    applySurfaceTransform(whole.context, 1);
    expect((whole.calls('setTransform')[0]?.args ?? [])[5]).toBe(LOGICAL_HEIGHT);
    const double = new CanvasRecorder();
    applySurfaceTransform(double.context, 2);
    expect((double.calls('setTransform')[0]?.args ?? [])[5]).toBe(LOGICAL_HEIGHT * 2);
    expect(deviceOriginY(1)).toBe(LOGICAL_HEIGHT);
    expect(deviceOriginY(2)).toBe(LOGICAL_HEIGHT * 2);

    // The shake stays continuous: it is a displacement of the whole scene and
    // is added after the quantisation rather than rounded with it.
    const shaken = new CanvasRecorder();
    applySurfaceTransform(shaken.context, 1265 / 1280, 0.25, -0.75);
    expect((shaken.calls('setTransform')[0]?.args ?? [])[5]).toBe(712 - 0.75);
  });

  it('leaves the pointer mapping within half a device pixel of the drawn scene', () => {
    // WHAT THE ROUNDING COSTS, AS A BOUND RATHER THAN AS A SENTENCE. The
    // rounding does not remove the sub-pixel residue, it moves it: the scene is
    // drawn at the exact scale from a rounded origin, so the whole of it sits
    // up to half a device pixel from where the unrounded arithmetic would have
    // put it, and the residue that used to sit at design y = 0 now sits at
    // design y = 720. `render/input.ts` maps a viewport point through the
    // canvas's CSS box, which carries no rounding at all, so drawn scene and
    // pressed point differ by that residue - the same offset at every y, in y
    // alone, and never more than half a device pixel.
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [1265, 1, 0.4375], // rounded up: the origin is above the exact product
      [1266, 1, 0.125], // rounded down
      [1264, 1, 0], // nothing to round, so nothing apart
      [430, 1, 0.125], // the portrait viewport the rail boundary is measured at
    ];
    for (const [cssWidth, ratio, residue] of cases) {
      const cssHeight = cssHeightFor(cssWidth);
      const rect = { left: 0, top: 0, width: cssWidth, height: cssHeight };
      const scale = (cssWidth / LOGICAL_WIDTH) * ratio;
      const originY = deviceOriginY(scale);
      for (const designY of [0, 85, 360, 635, LOGICAL_HEIGHT]) {
        const where = `${String(cssWidth)} at ${String(ratio)}, y ${String(designY)}`;
        // Where the scene draws this design row, in device pixels from the top
        // of the backing store, and the same place in CSS pixels.
        const drawn = originY - designY * scale;
        // Where the pointer mapping says that CSS point is, back in design
        // units, and the gap between the two in device pixels.
        const read = toDesignPoint(rect, 0, drawn / ratio).y;
        const apart = Math.abs(read - designY) * scale;
        expect(apart, where).toBeLessThanOrEqual(0.5);
        expect(apart, where).toBeCloseTo(residue, 9);
      }
    }
    // AND THE BOUND IS ABOUT SOMETHING: at 1265 the two really do differ, so
    // the assertions above are not a mapping compared with itself.
    expect(deviceOriginY((1265 / LOGICAL_WIDTH) * 1) - 711.5625).toBe(0.4375);
    // Half a device pixel is 0.44 design units at that scale, against SPEC
    // section 5's 34-unit hit test: the mapping and the drawing disagree by
    // less than a seventieth of the smallest thing a press has to land on.
    expect(0.5 / ((1265 / LOGICAL_WIDTH) * 1)).toBeCloseTo(0.5059, 4);
  });

  it('reads one rendered height per resize, and asks for it exactly once', () => {
    // Three call sites asked `cssHeightFor` the same question, which is three
    // chances to hand one of them a different width. Two halves grade that.
    //
    // THE OBSERVABLE HALF: all three answers still have to agree, which is what
    // a width handed to one of them and not the others would break.
    const recorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
    resizeSurface(surface, 1265, 2);
    expect(surface.cssHeight).toBe(cssHeightFor(1265));
    expect(surface.canvas.style['height']).toBe(`${String(cssHeightFor(1265))}px`);
    expect(surface.canvas.height).toBe(Math.round(cssHeightFor(1265) * 2));

    // THE HALF THAT SAYS "ONCE", which agreement cannot: three calls that
    // happen to agree pass every assertion above, so the count is read out of
    // the source. `resizeSurface`'s body, from its own signature to the closing
    // brace at column one, must ask exactly once.
    const source = readFileSync(
      path.join(PROJECT_ROOT, 'src', 'render', 'surface.ts'),
      'utf8',
    );
    const bodyOf = (text: string, name: string): string => {
      const from = text.indexOf(`export function ${name}(`);
      const end = text.indexOf('\n}\n', from);
      return from === -1 || end === -1 ? '' : text.slice(from, end);
    };
    const asked = (text: string): number =>
      [...text.matchAll(/\bcssHeightFor\s*\(/g)].length;
    const body = bodyOf(source, 'resizeSurface');
    expect(body).toContain('surface.canvas.width = width;');
    expect(asked(body)).toBe(1);
    // The counter is shown the shape this replaced, so it is not a count that
    // answers one whatever it is handed.
    expect(
      asked(`export function resizeSurface(surface, cssWidth, deviceRatio) {
  const height = Math.round(cssHeightFor(cssWidth) * deviceRatio);
  surface.canvas.style.height = \`\${cssHeightFor(cssWidth)}px\`;
  surface.cssHeight = cssHeightFor(cssWidth);
`),
    ).toBe(3);
    expect(bodyOf('export function other() {\n  return 1;\n}\n', 'resizeSurface')).toBe('');
  });

  it('sizes the backing store once per resize and reapplies the transform', () => {
    const recorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
    resizeSurface(surface, 1264, 1);
    expect(surface.canvas.width).toBe(1264);
    expect(surface.canvas.height).toBe(711);
    // The css size is set from the same numbers, interpolated, so the element
    // fills its box exactly.
    expect(surface.canvas.style['width']).toBe('1264px');
    expect(surface.canvas.style['height']).toBe('711px');
    expect(surface.scale).toBeCloseTo(1264 / 1280, 12);
    // Exactly one transform for one resize: the wrapper's own.
    const transforms = recorder.calls('setTransform');
    expect(transforms).toHaveLength(1);
    const at = transforms[0]?.args ?? [];
    expect(at[0]).toBeCloseTo(1264 / 1280, 12);
    expect(at[3]).toBeLessThan(0);
  });

  it('refuses to run a zero-sized backing store', () => {
    const recorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
    resizeSurface(surface, 0, 1);
    expect(surface.canvas.width).toBe(1);
    expect(surface.canvas.height).toBe(1);
  });

  it('creates the canvas hidden from the accessibility tree and named for selection', () => {
    // A stand-in document, because this assertion is about the attributes the
    // surface stamps on the element it creates, and the unit suite has none.
    const recorder = new CanvasRecorder();
    const host = {
      appended: [] as unknown[],
      appendChild(node: unknown): void {
        this.appended.push(node);
      },
    };
    const original = globalThis.document;
    globalThis.document = {
      createElement(): HTMLCanvasElement {
        return asCanvas(fakeCanvas(recorder));
      },
    } as unknown as typeof document;
    try {
      const surface = createSurface(host as unknown as HTMLElement);
      expect(host.appended).toHaveLength(1);
      const fake = surface.canvas as unknown as ReturnType<typeof fakeCanvas>;
      expect(fake.attrs.get('aria-hidden')).toBe('true');
      expect(fake.dataset['pf']).toBe('play-surface');
    } finally {
      globalThis.document = original;
    }
  });

  it('re-arms the density watch on every fire, disarming the stale query', () => {
    // A device pixel ratio change with a constant css box fires no resize
    // observer: dragging the window to another monitor moves the ratio and
    // nothing else. The watch answers a query built from the ratio it armed
    // with, so each fire re-arms against the new ratio and disarms the old.
    const created: { text: string; listeners: (() => void)[] }[] = [];
    let density = 1;
    const win = {
      get devicePixelRatio(): number {
        return density;
      },
      matchMedia(text: string): MediaQueryList {
        const query = { text, listeners: [] as (() => void)[] };
        created.push(query);
        return {
          addEventListener(_kind: string, fn: () => void): void {
            query.listeners.push(fn);
          },
          removeEventListener(_kind: string, fn: () => void): void {
            query.listeners = query.listeners.filter((entry) => entry !== fn);
          },
        } as unknown as MediaQueryList;
      },
    } as unknown as Window;
    const fired: number[] = [];
    watchDeviceRatio(win, (ratio) => fired.push(ratio));
    expect(created).toHaveLength(1);
    expect(created[0]?.text).toBe('(resolution: 1dppx)');
    density = 2;
    created[0]?.listeners[0]?.();
    expect(fired).toEqual([2]);
    expect(created).toHaveLength(2);
    expect(created[1]?.text).toBe('(resolution: 2dppx)');
    expect(created[0]?.listeners).toHaveLength(0);
    // And the watch keeps working for however many changes a session takes.
    density = 1;
    created[1]?.listeners[0]?.();
    expect(fired).toEqual([2, 1]);
    expect(created[2]?.text).toBe('(resolution: 1dppx)');
  });

  it('reads the theme with the query the stylesheet answers', () => {
    // The composition root and the stylesheet decide the same fact in two
    // places, media queries being strings the canvas cannot read; this is
    // the tie between them, so a rename in either file cannot split the
    // pitch variant from the chrome theme.
    const main = readFileSync(
      path.join(PROJECT_ROOT, 'src', 'main.ts'),
      'utf8',
    );
    const css = readFileSync(
      path.join(PROJECT_ROOT, 'src', 'ui', 'tokens.css'),
      'utf8',
    );
    const match = /const THEME_QUERY = '\((.*)\)';/.exec(main);
    expect(match).not.toBeNull();
    const query = match?.[1] ?? '';
    expect(query.length).toBeGreaterThan(0);
    expect(css).toContain(`@media (${query})`);
  });
});
