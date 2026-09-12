import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import {
  FIELD_BOTTOM,
  FIELD_HEIGHT,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FIELD_WIDTH,
  LOGICAL_HEIGHT,
} from '../../src/core/config';
import {
  drawCentreMarkings,
  drawGoalFrames,
  drawStripes,
  drawVignette,
  drawWalls,
  drawFrame,
  pitchLayerIsCurrent,
  renderStaticPitch,
} from '../../src/render/pitch';
import type { PitchCacheCell } from '../../src/render/pitch';
import { attachSurface } from '../../src/render/surface';
import { PLAY_SURFACE } from '../../src/render/tokens';
import type { PitchPalette } from '../../src/render/tokens';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';

/**
 * Armour for the pitch passes, item E3's enumeration.
 *
 * ARMOUR, NOT CLOSURE: E3 closes by the scripted capture at the
 * demonstration session. What automation can reach, this file pins: the
 * drawn quantities per pass (the census), the fact that every colour the
 * pitch draws with is a palette token of the variant in force, the outline
 * on the objects that carry one, and the static layer being built once and
 * then only ever blitted. The census counts are literals on purpose: a count
 * asserted against the loop that produces it cannot fail, and a census that
 * cannot fail freezes nothing.
 */

const VARIANTS = ['floodlit', 'daylight'] as const;

/** Run every static pass, in render order, into one recorder. */
function drawStatic(recorder: CanvasRecorder, palette: PitchPalette): void {
  drawStripes(recorder.context, palette);
  drawVignette(recorder.context, palette);
  drawCentreMarkings(recorder.context, palette);
  drawWalls(recorder.context, palette);
  drawGoalFrames(recorder.context, palette);
}

function rectArgs(recorder: CanvasRecorder): ReadonlyArray<readonly unknown[]> {
  return recorder.calls('fillRect').map((op) => op.args);
}

describe('PF-11 the pitch, pass by pass', () => {
  it('cuts the field into an even number of mown stripes, starting dark', () => {
    for (const variant of VARIANTS) {
      const recorder = new CanvasRecorder();
      drawStripes(recorder.context, PLAY_SURFACE[variant]);
      // The largest spacing step (64) against the 1100 px field fixes the
      // count at 18; the census freezes it so a second stripe knob cannot
      // arrive unreviewed.
      const rects = rectArgs(recorder);
      expect(rects).toHaveLength(18);
      const band = FIELD_WIDTH / 18;
      rects.forEach((args, index) => {
        expect(args[0]).toBeCloseTo(FIELD_LEFT + index * band, 9);
        expect(args[1]).toBe(FIELD_BOTTOM);
        expect(args[2]).toBeCloseTo(band, 9);
        expect(args[3]).toBe(FIELD_HEIGHT);
      });
      // Alternating, opening on stripe A, the darker pair member the
      // contrast table quotes against.
      const fills = recorder.values('fillStyle');
      expect(fills[0]).toBe(PLAY_SURFACE[variant].stripeA);
      expect(fills[1]).toBe(PLAY_SURFACE[variant].stripeB);
      expect(fills[2]).toBe(PLAY_SURFACE[variant].stripeA);
    }
  });

  it('draws the white centre line, circle and spot at the field centre', () => {
    const recorder = new CanvasRecorder();
    drawCentreMarkings(recorder.context, PLAY_SURFACE.floodlit);
    expect(recorder.calls('stroke')).toHaveLength(2);
    expect(recorder.calls('fill')).toHaveLength(1);
    expect(recorder.values('strokeStyle')).toEqual([
      PLAY_SURFACE.floodlit.line,
      PLAY_SURFACE.floodlit.line,
    ]);
    expect(recorder.values('fillStyle')).toEqual([PLAY_SURFACE.floodlit.line]);
    // The line runs the full height of the field at x 640.
    expect(recorder.calls('moveTo')[0]?.args).toEqual([640, FIELD_BOTTOM]);
    expect(recorder.calls('lineTo')[0]?.args).toEqual([640, FIELD_TOP]);
    // The circle is SPEC 3's radius 70; the spot is the radius scale's small
    // step, 4, pinned as a literal because nothing else may resize it.
    const circles = recorder.calls('arc');
    expect(circles[0]?.args.slice(0, 3)).toEqual([640, 360, 70]);
    expect(circles[1]?.args.slice(0, 3)).toEqual([640, 360, 4]);
  });

  it('tiles the enclosure with six wall pieces and cuts out the openings', () => {
    const recorder = new CanvasRecorder();
    drawWalls(recorder.context, PLAY_SURFACE.floodlit);
    const rects = rectArgs(recorder);
    expect(rects).toHaveLength(6);
    // The two end walls span the enclosure including its corners.
    const spanning = rects.filter((args) => args[2] === FIELD_WIDTH + 24);
    expect(spanning).toHaveLength(2);
    for (const args of spanning) {
      expect(args[0]).toBe(FIELD_LEFT - 12);
      expect(args[3]).toBe(12);
    }
    // The four side pieces stop short of the opening: every one is either
    // wholly below y 265 or wholly above y 455, which is what "the ball
    // passes through and nothing else does" looks like in fill rects.
    const sides = rects.filter((args) => args[2] === 12);
    expect(sides).toHaveLength(4);
    for (const args of sides) {
      const bottom = args[1] as number;
      const top = bottom + (args[3] as number);
      expect(bottom <= 265 || bottom >= 455).toBe(true);
      expect(top <= 265 || top >= 455).toBe(true);
    }
    // The raised rail's boundary: one light hairline stroke along the
    // pitch-facing edges, drawn once.
    expect(recorder.calls('stroke')).toHaveLength(1);
    expect(recorder.values('strokeStyle')).toEqual([PLAY_SURFACE.floodlit.line]);
    expect(recorder.values('lineWidth')).toEqual([1]);
    expect(recorder.calls('moveTo')).toHaveLength(6);
  });

  it('tints each goal frame to the side that defends it, outlined', () => {
    const recorder = new CanvasRecorder();
    drawGoalFrames(recorder.context, PLAY_SURFACE.floodlit);
    expect(recorder.calls('fillRect')).toHaveLength(2);
    expect(recorder.calls('strokeRect')).toHaveLength(2);
    // Depth 64 outside each field edge, 190 tall: the frame rectangles
    // exactly, and the tint order follows the field: player left.
    expect(rectArgs(recorder)[0]).toEqual([FIELD_LEFT - 64, 265, 64, 190]);
    expect(rectArgs(recorder)[1]).toEqual([FIELD_RIGHT, 265, 64, 190]);
    expect(recorder.values('fillStyle')).toEqual([
      PLAY_SURFACE.floodlit.teamPlayer,
      PLAY_SURFACE.floodlit.teamOpponent,
    ]);
    expect(recorder.values('strokeStyle')).toEqual([
      PLAY_SURFACE.floodlit.line,
      PLAY_SURFACE.floodlit.line,
    ]);
    expect(recorder.values('lineWidth')).toEqual([3, 3]);
  });

  it('fades the stripes toward stripe A at the edges and nowhere else', () => {
    const recorder = new CanvasRecorder();
    drawVignette(recorder.context, PLAY_SURFACE.floodlit);
    expect(recorder.calls('createRadialGradient')).toHaveLength(1);
    const gradient = recorder.calls('createRadialGradient')[0]?.args ?? [];
    // Centred on the spot the ball starts on; tint-free to the edge of the
    // centre circle's neighbourhood (275, half the field height) and total
    // past the field diagonal.
    expect(gradient[0]).toBe(640);
    expect(gradient[1]).toBe(360);
    expect(gradient[2]).toBe(275);
    expect(gradient[5]).toBeCloseTo(615, 0);
    expect(recorder.calls('addColorStop').map((op) => op.args)).toEqual([
      [0, 'transparent'],
      [1, PLAY_SURFACE.floodlit.stripeA],
    ]);
    // The alpha is the vignette's one free parameter, pinned at both ends:
    // present enough to fade, and reset so nothing after it inherits it.
    expect(recorder.values('globalAlpha')).toEqual([0.35, 1]);
    expect(rectArgs(recorder)[0]).toEqual([
      FIELD_LEFT,
      FIELD_BOTTOM,
      FIELD_WIDTH,
      FIELD_HEIGHT,
    ]);
  });

  it('draws both variants with exactly the palette of that variant, in order', () => {
    // ORDERED BY FIRST USE, NOT A SET. A set says which colours were used and
    // nothing about which pass used them, so a rail painted in the boundary
    // colour, or markings in the rail's, produce the same six-element set. The
    // sequence below is the order the static passes first reach for a colour,
    // which is a fact about the drawing rather than about its palette, and the
    // stripe alternation itself is frozen by the census in the first test
    // rather than restated here as a loop this assertion could agree with.
    for (const variant of VARIANTS) {
      const palette = PLAY_SURFACE[variant];
      const recorder = new CanvasRecorder();
      drawStatic(recorder, palette);
      const strings = [
        ...recorder.values('fillStyle'),
        ...recorder.values('strokeStyle'),
      ].filter((value): value is string => typeof value === 'string');
      const firstUse = strings.filter((value, at) => strings.indexOf(value) === at);
      expect(firstUse, variant).toEqual([
        palette.stripeA,
        palette.stripeB,
        palette.line,
        palette.rail,
        palette.teamPlayer,
        palette.teamOpponent,
      ]);
    }
  });

  it('renders the static layer once, at backing-store scale, in pass order', () => {
    const surfaceRecorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(surfaceRecorder)));
    surface.scale = 2;
    surface.canvas.width = 2000;
    const layerRecorder = new CanvasRecorder();
    let built = 0;
    const layer = renderStaticPitch(surface, PLAY_SURFACE.floodlit, () => {
      built += 1;
      return asCanvas(fakeCanvas(layerRecorder));
    });
    expect(built).toBe(1);
    expect(layer.scale).toBe(2);
    expect(layer.palette).toBe(PLAY_SURFACE.floodlit);
    expect(layer.canvas.width).toBe(2000);
    // The layer draws in design space: the flip transform, then the passes,
    // ending with the goal frames, which are the last static pass.
    expect(layerRecorder.ops[0]?.name).toBe('setTransform');
    expect(layerRecorder.ops[0]?.args).toEqual([2, 0, 0, -2, 0, LOGICAL_HEIGHT * 2]);
    expect(layerRecorder.ops[1]?.name).toBe('fillStyle');
    expect(layerRecorder.ops[2]?.name).toBe('fillRect');
    expect(layerRecorder.ops.at(-1)?.name).toBe('strokeRect');

    // ALL FIVE PASSES, IN THE ORDER THEY RUN. Pinning the first three ops and
    // the name of the last leaves the middle of the layer unpinned: moving the
    // vignette from second to fourth leaves op 0 a setTransform, op 1 a fill
    // colour, op 2 a fillRect and the last op a strokeRect, all unchanged, and
    // the module's own guarantee at its head ("drawn under the markings and
    // the rail, so nothing that carries a contrast guarantee is tinted by it")
    // silently stops holding: the audit measured the rail falling from 3.09 to
    // 2.44 floodlit and 2.14 daylight at the corners with the vignette last.
    // Each pass is found by an op only it makes, and the ORDER of those is the
    // assertion.
    const witness = (pass: string, at: number): { pass: string; at: number } => {
      expect(at, pass).toBeGreaterThan(0);
      return { pass, at };
    };
    const rail = PLAY_SURFACE.floodlit.rail;
    const railAt = layerRecorder.ops.findIndex(
      (op) => op.kind === 'set' && op.name === 'fillStyle' && op.args[0] === rail,
    );
    const found = [
      witness('stripes', layerRecorder.indexOf('call', 'fillRect')),
      witness('vignette', layerRecorder.indexOf('call', 'createRadialGradient')),
      witness('markings', layerRecorder.indexOf('call', 'arc')),
      witness('walls', railAt),
      witness('goal frames', layerRecorder.indexOf('call', 'strokeRect')),
    ];
    expect([...found].sort((one, other) => one.at - other.at).map((entry) => entry.pass)).toEqual([
      'stripes',
      'vignette',
      'markings',
      'walls',
      'goal frames',
    ]);
    // And the vignette is wholly behind the markings: its alpha is restored to
    // 1 before the first stroke the layer makes, so nothing carrying a
    // contrast guarantee is drawn under it.
    expect(layerRecorder.values('globalAlpha').slice(0, 2)).toEqual([0.35, 1]);
    expect(layerRecorder.indexOf('set', 'globalAlpha')).toBeLessThan(
      layerRecorder.indexOf('call', 'stroke'),
    );
  });

  it('knows when a layer is stale, in the only three ways it can be', () => {
    const surfaceRecorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(surfaceRecorder)));
    surface.scale = 2;
    surface.canvas.width = 2000;
    const layer = renderStaticPitch(surface, PLAY_SURFACE.floodlit, () =>
      asCanvas(fakeCanvas(new CanvasRecorder())),
    );
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(true);
    // A resize moved the scale.
    surface.scale = 1.5;
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(false);
    surface.scale = 2;
    // The variant changed, which is a different palette object.
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.daylight)).toBe(false);
    surface.scale = 2;
    // A backing-store dimension moved, which a resize always carries.
    surface.canvas.width = 1000;
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(false);
    surface.canvas.width = 2000;
    surface.canvas.height = 500;
    expect(pitchLayerIsCurrent(layer, surface, PLAY_SURFACE.floodlit)).toBe(false);
  });

  it('rebuilds the cache through the frame, headlessly, when it is stale', () => {
    const surfaceRecorder = new CanvasRecorder();
    const surface = attachSurface(asCanvas(fakeCanvas(surfaceRecorder)));
    surface.scale = 1;
    surface.canvas.width = 1280;
    const cache: PitchCacheCell = {
      current: {
        canvas: asCanvas(fakeCanvas(new CanvasRecorder())),
        scale: 2,
        palette: PLAY_SURFACE.floodlit,
      },
    };
    let built = 0;
    drawFrame(surface, cache, createWorld(), PLAY_SURFACE.floodlit, {
      createLayer: () => {
        built += 1;
        return asCanvas(fakeCanvas(new CanvasRecorder()));
      },
    });
    expect(built).toBe(1);
    expect(cache.current?.scale).toBe(1);
  });
});
