import { describe, expect, it } from 'vitest';

import { createWorld, kickoff } from '../../src/core/bodies';
import { predictGuide } from '../../src/core/guide';
import type { AimGuide } from '../../src/core/guide';
import { aimPreviewFor, normalisedAim } from '../../src/core/aiming';
import { drawFrame } from '../../src/render/pitch';
import type { PitchCacheCell, PitchLayer } from '../../src/render/pitch';
import {
  GUIDE_DASH,
  GUIDE_GAP,
  GUIDE_MARKER_RADIUS,
  GUIDE_PERIOD,
  drawAimGuide,
  guideDashes,
} from '../../src/render/guide';
import { attachSurface } from '../../src/render/surface';
import { BORDER, PLAY_SURFACE, SPACE } from '../../src/render/tokens';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';

/**
 * The guide pass: what it draws, what it does NOT draw, and where it sits in
 * the frame.
 *
 * NOTHING HERE COMPUTES A PREDICTION, which is the point of the split: the
 * paths below are handed in as data, so a pass that decided anything for
 * itself would have nowhere to get it from. The one arithmetic this file does
 * check is the dash layout, because the pattern carrying across the bounce is
 * a property of the drawing rather than of the prediction.
 *
 * THE DASH LENGTHS ARE ASSERTED AGAINST THE SPACING SCALE, and the scale
 * against literals, so neither can drift without the other being named.
 */

function surfaceFor(recorder: CanvasRecorder): ReturnType<typeof attachSurface> {
  const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
  surface.scale = 1;
  surface.canvas.width = 1280;
  surface.canvas.height = 720;
  surface.cssHeight = 720;
  return surface;
}

function guideOf(
  path: readonly { x: number; y: number }[],
  contact?: { x: number; y: number },
): AimGuide {
  return { path, contact, bounce: undefined };
}

describe('PF-9 the guide pass', () => {
  it('takes every length it draws from the token scales', () => {
    expect(GUIDE_DASH).toBe(SPACE[2]);
    expect(GUIDE_GAP).toBe(SPACE[3]);
    expect(GUIDE_MARKER_RADIUS).toBe(SPACE[3]);
    expect(GUIDE_PERIOD).toBe(GUIDE_DASH + GUIDE_GAP);
    // And the scale itself, against QUALITY-BAR section 15's own numbers.
    expect(SPACE[2]).toBe(8);
    expect(SPACE[3]).toBe(12);
  });

  it('lays a straight leg out as dashes of the scale length', () => {
    const dashes = guideDashes([
      { x: 100, y: 200 },
      { x: 200, y: 200 },
    ]);
    expect(dashes.length).toBe(Math.ceil(100 / GUIDE_PERIOD));
    // The first dash starts where the path does and is exactly one dash long.
    expect(dashes[0]).toEqual({
      from: { x: 100, y: 200 },
      to: { x: 100 + GUIDE_DASH, y: 200 },
    });
    // The second starts a whole period later, so the gap is the scale's.
    expect(dashes[1]?.from.x).toBeCloseTo(100 + GUIDE_PERIOD, 9);
    // Nothing is drawn past the end of the leg.
    for (const dash of dashes) {
      expect(dash.to.x).toBeLessThanOrEqual(200 + 1e-9);
      expect(dash.from.y).toBe(200);
      expect(dash.to.y).toBe(200);
    }
  });

  it('carries the pattern across the bounce rather than restarting it', () => {
    // A leg of 10 units, which is longer than a dash and shorter than a
    // period, so the corner falls INSIDE a gap: the next dash has to start
    // part way along the second leg rather than at the corner.
    const dashes = guideDashes([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 100 },
    ]);
    expect(dashes[0]).toEqual({ from: { x: 0, y: 0 }, to: { x: GUIDE_DASH, y: 0 } });
    const second = dashes[1];
    expect(second).toBeDefined();
    // 10 units used on the first leg, so the period turns over 10 units up the
    // second one rather than at the corner.
    expect(second?.from).toEqual({ x: 10, y: GUIDE_PERIOD - 10 });
  });

  it('draws nothing at all for a path that is not one', () => {
    expect(guideDashes([])).toEqual([]);
    expect(guideDashes([{ x: 10, y: 10 }])).toEqual([]);
    expect(
      guideDashes([
        { x: 10, y: 10 },
        { x: 10, y: 10 },
      ]),
    ).toEqual([]);
    const recorder = new CanvasRecorder();
    drawAimGuide(recorder.context, PLAY_SURFACE.floodlit, guideOf([]));
    expect(recorder.ops).toEqual([]);
  });

  it('strokes the dashes in the line token, at the border scale', () => {
    const recorder = new CanvasRecorder();
    drawAimGuide(
      recorder.context,
      PLAY_SURFACE.floodlit,
      guideOf([
        { x: 100, y: 200 },
        { x: 200, y: 200 },
      ]),
    );
    expect(recorder.values('strokeStyle')).toEqual([PLAY_SURFACE.floodlit.line]);
    expect(recorder.values('lineWidth')).toEqual([BORDER.thin]);
    // One path, one stroke, and a move and a line per dash.
    expect(recorder.calls('beginPath')).toHaveLength(1);
    expect(recorder.calls('stroke')).toHaveLength(1);
    const dashes = guideDashes([
      { x: 100, y: 200 },
      { x: 200, y: 200 },
    ]);
    expect(recorder.calls('moveTo')).toHaveLength(dashes.length);
    expect(recorder.calls('lineTo')).toHaveLength(dashes.length);
    // Nothing is filled: a prediction is a line and never a solid.
    expect(recorder.calls('fill')).toHaveLength(0);
    expect(recorder.calls('fillRect')).toHaveLength(0);
  });

  it('rings the contact point, and only when there is one', () => {
    const withContact = new CanvasRecorder();
    drawAimGuide(
      withContact.context,
      PLAY_SURFACE.floodlit,
      guideOf(
        [
          { x: 100, y: 200 },
          { x: 588, y: 200 },
        ],
        { x: 588, y: 200 },
      ),
    );
    const rings = withContact.calls('arc');
    expect(rings).toHaveLength(1);
    expect(rings[0]?.args).toEqual([588, 200, GUIDE_MARKER_RADIUS, 0, Math.PI * 2]);
    // A ring, not a disc: stroked and never filled.
    expect(withContact.calls('fill')).toHaveLength(0);

    const without = new CanvasRecorder();
    drawAimGuide(
      without.context,
      PLAY_SURFACE.floodlit,
      guideOf([
        { x: 100, y: 200 },
        { x: 200, y: 200 },
      ]),
    );
    expect(without.calls('arc')).toHaveLength(0);
  });

  it('never touches the context dash state', () => {
    // The reason the dashes are laid out rather than set: a pattern left on
    // the context comes out of the passes after this one. The stand-in has no
    // `setLineDash` at all, so a pass that reached for it would throw here.
    const recorder = new CanvasRecorder();
    expect(
      (recorder.context as unknown as Record<string, unknown>)['setLineDash'],
    ).toBeUndefined();
    expect(() => {
      drawAimGuide(
        recorder.context,
        PLAY_SURFACE.floodlit,
        guideOf([
          { x: 0, y: 0 },
          { x: 500, y: 300 },
        ]),
      );
    }).not.toThrow();
  });
});

describe('PF-9 the guide inside the frame', () => {
  function fixture(): {
    recorder: CanvasRecorder;
    surface: ReturnType<typeof attachSurface>;
    cache: PitchCacheCell;
  } {
    const recorder = new CanvasRecorder();
    const surface = surfaceFor(recorder);
    const layerRecorder = new CanvasRecorder();
    const layerCanvas = fakeCanvas(layerRecorder);
    layerCanvas.width = 1280;
    layerCanvas.height = 720;
    const layer: PitchLayer = {
      canvas: asCanvas(layerCanvas),
      scale: 1,
      palette: PLAY_SURFACE.floodlit,
    };
    return { recorder, surface, cache: { current: layer } };
  }

  it('draws the guide after the entities and UNDER the arrow', () => {
    const { recorder, surface, cache } = fixture();
    const world = createWorld();
    kickoff(world);
    const preview = aimPreviewFor(normalisedAim(0, 1));
    const guide = predictGuide(world.player, world.ball, 0);
    drawFrame(surface, cache, world, PLAY_SURFACE.floodlit, { aim: preview, guide });
    // The guide's ring is its own signature in the op list, and the arrow's
    // fill comes after it: DESIGN section 7's aim pass, with the advice under
    // the shot it is about.
    const ring = recorder.ops.findIndex(
      (op) => op.name === 'arc' && op.args[2] === GUIDE_MARKER_RADIUS,
    );
    expect(ring).toBeGreaterThan(-1);
    const arrowFill = recorder.ops.findIndex(
      (op, index) => op.name === 'fill' && index > ring,
    );
    expect(arrowFill).toBeGreaterThan(ring);
  });

  it('draws no guide at all when the frame is given none', () => {
    const { recorder, surface, cache } = fixture();
    const world = createWorld();
    kickoff(world);
    drawFrame(surface, cache, world, PLAY_SURFACE.floodlit, {
      aim: aimPreviewFor(normalisedAim(0, 1)),
    });
    expect(
      recorder.ops.filter((op) => op.name === 'arc' && op.args[2] === GUIDE_MARKER_RADIUS),
    ).toHaveLength(0);
  });

  it('starts the arrow at the circle the frame names as launching', () => {
    // SPEC section 9's Hotseat aims the opponent's circle on the second turn.
    // The arrow's own path starts at the launching body, so the first moveTo
    // after the entity pass is what says which circle it belongs to.
    const world = createWorld();
    kickoff(world);
    const preview = aimPreviewFor(normalisedAim(0, 1));

    const asPlayer = fixture();
    drawFrame(asPlayer.surface, asPlayer.cache, world, PLAY_SURFACE.floodlit, {
      aim: preview,
    });
    const asOpponent = fixture();
    drawFrame(asOpponent.surface, asOpponent.cache, world, PLAY_SURFACE.floodlit, {
      aim: preview,
      launcher: world.opponent,
    });

    const reach = (recorder: CanvasRecorder): number => {
      const moves = recorder.calls('moveTo');
      return Number(moves.at(-1)?.args[0] ?? 0);
    };
    // The two arrows are the same arrow drawn from two different circles, so
    // the one anchored on the opponent starts further down the pitch.
    expect(reach(asOpponent.recorder)).toBeGreaterThan(reach(asPlayer.recorder));
    expect(reach(asOpponent.recorder) - reach(asPlayer.recorder)).toBeCloseTo(
      world.opponent.position.x - world.player.position.x,
      6,
    );
  });
});
