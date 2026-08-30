import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import { CIRCLE_RADIUS } from '../../src/core/config';
import { drawEntities, kickoffFacing } from '../../src/render/entities';
import { PLAY_SURFACE } from '../../src/render/tokens';
import { CanvasRecorder } from './support/canvas-recorder';

/**
 * Armour for the entity pass, item E3's three bodies.
 *
 * ARMOUR, NOT CLOSURE: E3 closes by the scripted capture at the
 * demonstration session. What automation can reach, this file pins: the
 * drawn quantities per body, the boundary ring on every body in the light
 * line colour, the identity carriers SPEC section 4 names (fill, facing
 * marker, glyph, panel pattern) each in its own palette token, and the
 * kickoff facing derived from the world rather than assumed. The counts and
 * positions are literals: a census that reads its own loop back freezes
 * nothing.
 */

describe('PF-11 the three bodies', () => {
  it('draws a known number of shapes per body, ball last', () => {
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, createWorld());
    // Each circle: fill, ring stroke, facing marker fill, glyph. The ball:
    // body fill, six panel fills under one clip, ring stroke.
    expect(recorder.calls('fill')).toHaveLength(11);
    expect(recorder.calls('stroke')).toHaveLength(3);
    expect(recorder.calls('fillText')).toHaveLength(2);
    expect(recorder.calls('clip')).toHaveLength(1);
    // The ball's panels are the only clip in the pass, and the clip is
    // released, so nothing after it is painted inside the ball. Three
    // save/restore pairs: two glyphs and one panel clip.
    expect(recorder.calls('restore')).toHaveLength(3);
  });

  it('carries the light boundary ring on all three bodies', () => {
    for (const variant of ['floodlit', 'daylight'] as const) {
      const recorder = new CanvasRecorder();
      drawEntities(recorder.context, PLAY_SURFACE[variant], createWorld());
      expect(recorder.values('strokeStyle')).toEqual([
        PLAY_SURFACE[variant].line,
        PLAY_SURFACE[variant].line,
        PLAY_SURFACE[variant].line,
      ]);
      // Pinned as the literal the border scale defines: a ring drawn at any
      // other width fails here even if the scale itself moves.
      expect(recorder.values('lineWidth')).toEqual([3, 3, 3]);
    }
  });

  it('takes every identity colour from the palette of the variant', () => {
    for (const variant of ['floodlit', 'daylight'] as const) {
      const palette = PLAY_SURFACE[variant];
      const recorder = new CanvasRecorder();
      drawEntities(recorder.context, palette, createWorld());
      expect(new Set(recorder.values('fillStyle'))).toEqual(
        new Set([
          palette.teamPlayer,
          palette.glyphOnPlayer,
          palette.teamOpponent,
          palette.glyphOnOpponent,
          palette.ballBody,
          palette.ballPanel,
        ]),
      );
    }
  });

  it('derives the kickoff facing from the world: both circles face the ball', () => {
    const world = createWorld();
    const facing = kickoffFacing(world);
    expect(facing.player).toBe(0);
    expect(facing.opponent).toBeCloseTo(Math.PI, 12);
  });

  it('points the facing marker along the facing, at body scale', () => {
    const world = createWorld();
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, world);
    const tips = recorder.calls('moveTo').map((op) => op.args);
    // The wedge tip sits at 0.95 radii along the facing direction: upfield
    // for the player at (300, 360), back across the centre for the opponent.
    expect(tips[0]?.[0]).toBeCloseTo(300 + CIRCLE_RADIUS * 0.95, 9);
    expect(tips[0]?.[1]).toBe(360);
    expect(tips[1]?.[0]).toBeCloseTo(980 - CIRCLE_RADIUS * 0.95, 9);
    expect(tips[1]?.[1]).toBe(360);
  });

  it('redraws the marker when the facing is overridden', () => {
    const world = createWorld();
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, world, {
      player: -Math.PI / 2,
      opponent: 0,
    });
    const tips = recorder.calls('moveTo').map((op) => op.args);
    expect(tips[0]?.[0]).toBeCloseTo(300, 9);
    expect(tips[0]?.[1]).toBeCloseTo(360 - CIRCLE_RADIUS * 0.95, 9);
    expect(tips[1]?.[0]).toBeCloseTo(980 + CIRCLE_RADIUS * 0.95, 9);
  });

  it('writes the glyphs upright, under a local counter-flip, and nothing else', () => {
    const world = createWorld();
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, world);
    // The counter-flip: each glyph scales by (1, -1) inside a save/restore,
    // so the surface transform stays y-up everywhere else.
    expect(recorder.calls('scale').map((op) => op.args)).toEqual([
      [1, -1],
      [1, -1],
    ]);
    expect(recorder.calls('save')).toHaveLength(3);
    expect(recorder.calls('restore')).toHaveLength(3);
    // The glyph size is the circle's own radius, so no type size is chosen
    // here; the string is pinned as written.
    expect(recorder.values('font')).toEqual([
      `bold ${String(CIRCLE_RADIUS)}px sans-serif`,
      `bold ${String(CIRCLE_RADIUS)}px sans-serif`,
    ]);
    expect(recorder.calls('fillText').map((op) => op.args[0])).toEqual(['P', 'O']);
  });

  it('takes a glyph override, because the ladder supplies initials', () => {
    const world = createWorld();
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, world, undefined, {
      player: 'X',
      opponent: 'Z',
    });
    expect(recorder.calls('fillText').map((op) => op.args[0])).toEqual(['X', 'Z']);
  });

  it('panels the ball: a central pentagon and five clipped rim patches', () => {
    const world = createWorld();
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, world);
    // The pentagon opens at the ball's top, at 0.42 of the radius. Its path
    // is the first path begun after the clip, so the marker wedges upstream
    // of the ball cannot be mistaken for it.
    const clipIndex = recorder.indexOf('call', 'clip');
    const panelStart = recorder.ops.findIndex(
      (op, at) => op.kind === 'call' && op.name === 'moveTo' && at > clipIndex,
    );
    const panelPath = recorder.ops.slice(panelStart, panelStart + 6);
    expect(panelPath[0]?.args[0]).toBeCloseTo(640, 9);
    expect(panelPath[0]?.args[1]).toBeCloseTo(360 - 18 * 0.42, 9);
    // The two marker wedges and the pentagon each close their own path.
    expect(recorder.calls('closePath')).toHaveLength(3);
    // Five rim discs at 0.3 radii, centred 1.05 radii out so the clip turns
    // them into crescents. They sit between the clip arc and the ring stroke
    // arc, which are both the full radius, so the window is exact.
    const arcs = recorder.calls('arc');
    const patches = arcs.slice(arcs.length - 6, arcs.length - 1);
    expect(patches).toHaveLength(5);
    for (const patch of patches) {
      expect(patch.args[2]).toBeCloseTo(18 * 0.3, 9);
    }
    const centres = patches.map((op) => [
      Math.hypot((op.args[0] as number) - 640, (op.args[1] as number) - 360),
    ]);
    for (const distance of centres) {
      expect(distance[0]).toBeCloseTo(18 * 1.05, 9);
    }
  });
});
