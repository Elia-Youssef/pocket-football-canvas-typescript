import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import { LOGICAL_HEIGHT } from '../../src/core/config';
import { drawFrame } from '../../src/render/pitch';
import type { PitchCacheCell, PitchLayer } from '../../src/render/pitch';
import { attachSurface } from '../../src/render/surface';
import { PLAY_SURFACE } from '../../src/render/tokens';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';

/**
 * Armour for the frame composition.
 *
 * ARMOUR, NOT CLOSURE: E3 closes by the scripted capture at the
 * demonstration session. What automation can reach, this file pins: the
 * cached pitch being blitted rather than regenerated, in device space, with
 * the design transform put straight back so the entity pass draws in SPEC
 * coordinates; and the layer being rebuilt only when its facts change. The
 * defect class here is a renderer that quietly redraws the whole pitch every
 * frame and still looks right, which is exactly what QUALITY-BAR section 6's
 * static-layer rule exists to prevent.
 */

/** A surface at one scale, and a layer that is current for it. */
function freshFixture(): {
  recorder: CanvasRecorder;
  surface: ReturnType<typeof attachSurface>;
  layer: PitchLayer;
  layerRecorder: CanvasRecorder;
} {
  const recorder = new CanvasRecorder();
  const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
  surface.scale = 1;
  surface.canvas.width = 1280;
  const layerRecorder = new CanvasRecorder();
  const layerCanvas = fakeCanvas(layerRecorder);
  layerCanvas.width = 1280;
  const layer: PitchLayer = {
    canvas: asCanvas(layerCanvas),
    scale: 1,
    palette: PLAY_SURFACE.floodlit,
  };
  return { recorder, surface, layer, layerRecorder };
}

describe('PF-11 the frame composition', () => {
  it('blits the cached pitch, then draws the entities in design space', () => {
    const { recorder, surface, layer } = freshFixture();
    const cache: PitchCacheCell = { current: layer };
    drawFrame(surface, cache, createWorld(), PLAY_SURFACE.floodlit);
    // The blit leaves device space and comes straight back: identity
    // transform, one drawImage, the surface transform reapplied.
    expect(recorder.ops[0]?.name).toBe('setTransform');
    expect(recorder.ops[0]?.args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(recorder.ops[1]?.name).toBe('drawImage');
    expect(recorder.ops[1]?.args[0]).toBe(layer.canvas);
    expect(recorder.ops[2]?.name).toBe('setTransform');
    expect(recorder.ops[2]?.args).toEqual([1, 0, 0, -1, 0, LOGICAL_HEIGHT]);
    // The entity pass opens on the player fill, in design units, after the
    // transform is back: the state set, then the path.
    expect(recorder.ops[3]?.name).toBe('fillStyle');
    expect(recorder.ops[4]?.name).toBe('beginPath');
    expect(recorder.values('fillStyle')[0]).toBe(PLAY_SURFACE.floodlit.teamPlayer);
  });

  it('regenerates nothing static on the next frame', () => {
    const { recorder, surface, layer, layerRecorder } = freshFixture();
    const cache: PitchCacheCell = { current: layer };
    const world = createWorld();
    drawFrame(surface, cache, world, PLAY_SURFACE.floodlit);
    const afterFirst = layerRecorder.ops.length;
    const blitsAfterFirst = recorder.calls('drawImage').length;
    drawFrame(surface, cache, world, PLAY_SURFACE.floodlit);
    // One more blit, of the same layer object, and no further mark on the
    // layer's own context: the cache is blitted, never redrawn.
    expect(recorder.calls('drawImage')).toHaveLength(blitsAfterFirst + 1);
    expect(recorder.calls('drawImage').at(-1)?.args[0]).toBe(layer.canvas);
    expect(layerRecorder.ops).toHaveLength(afterFirst);
    // And no stripe ever reached the visible context.
    expect(recorder.calls('fillRect')).toHaveLength(0);
    expect(cache.current).toBe(layer);
  });

  it('rebuilds once when the palette changes, and blits the new layer', () => {
    const { recorder, surface } = freshFixture();
    const layerRecorders: CanvasRecorder[] = [];
    const cache: PitchCacheCell = {
      current: {
        // Daylight baked into the layer while the frame is asked for
        // floodlit: the palette identity is the fact that changed.
        canvas: asCanvas(fakeCanvas(new CanvasRecorder())),
        scale: 1,
        palette: PLAY_SURFACE.daylight,
      },
    };
    drawFrame(surface, cache, createWorld(), PLAY_SURFACE.floodlit, {
      createLayer: () => {
        const layerRecorder = new CanvasRecorder();
        layerRecorders.push(layerRecorder);
        const canvas = fakeCanvas(layerRecorder);
        canvas.width = 1280;
        return asCanvas(canvas);
      },
    });
    expect(layerRecorders).toHaveLength(1);
    expect(cache.current?.palette).toBe(PLAY_SURFACE.floodlit);
    expect(recorder.calls('drawImage').at(-1)?.args[0]).toBe(cache.current?.canvas);
  });
});
