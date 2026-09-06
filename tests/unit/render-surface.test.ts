import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from '../../src/core/config';
import {
  applySurfaceTransform,
  attachSurface,
  createSurface,
  cssHeightFor,
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
