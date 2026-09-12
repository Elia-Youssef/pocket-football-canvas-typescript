import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import { CIRCLE_RADIUS } from '../../src/core/config';
import { drawEntities, glyphsForOpponent, kickoffFacing } from '../../src/render/entities';
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

  it('gives every drawn shape its own identity colour, in draw order', () => {
    // ORDERED, NOT A SET, and that is the whole of this assertion. A set loses
    // both multiplicity and the pairing between a shape and the colour it was
    // drawn in, and `glyphOnOpponent` and `line` are the same string, so a
    // marker painted in the circle's own fill and a glyph painted in the
    // boundary colour both produce exactly the six-element set a set assertion
    // expects. SPEC section 4 gives each circle a fill, a facing marker and a
    // glyph and QUALITY-BAR section 4 forbids identity by colour alone, so
    // which object took which colour is the property, not which colours were
    // used. The eight are the eight assignments the pass makes, in order.
    for (const variant of ['floodlit', 'daylight'] as const) {
      const palette = PLAY_SURFACE[variant];
      const recorder = new CanvasRecorder();
      drawEntities(recorder.context, palette, createWorld());
      expect(recorder.values('fillStyle'), variant).toEqual([
        // The player circle: its fill, then its marker and its glyph, both in
        // the colour SPEC section 18 measures AGAINST that fill.
        palette.teamPlayer,
        palette.glyphOnPlayer,
        palette.glyphOnPlayer,
        // The opponent circle, the same three.
        palette.teamOpponent,
        palette.glyphOnOpponent,
        palette.glyphOnOpponent,
        // The ball: its body, then the panel pattern clipped inside it.
        palette.ballBody,
        palette.ballPanel,
      ]);
      // And the two colours the swap would confuse really are different, so
      // the ordered list above is telling the two apart rather than agreeing
      // with itself: the player's glyph colour is not its fill, and the
      // opponent's glyph colour IS the boundary colour, which is why the
      // player's slot is the one that catches a glyph drawn in the line.
      expect(palette.glyphOnPlayer, variant).not.toBe(palette.teamPlayer);
      expect(palette.glyphOnPlayer, variant).not.toBe(palette.line);
      expect(palette.glyphOnOpponent, variant).toBe(palette.line);
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

  it('opens the wedge at its base, so the marker is a shape and not a line', () => {
    // THE TIP IS NOT THE WEDGE. A marker pinned by its tip alone is still a
    // marker when its two base points collapse onto the midline: the path is
    // then three collinear points, the fill covers nothing, and SPEC section
    // 4's second identity carrier has silently gone. So the base is pinned
    // too, by the coordinates it actually has.
    //
    // The two numbers are the player's wedge at kickoff, from (300, 360) with
    // the circle facing the ball: the base sits at 0.45 radii out along the
    // facing turned by a fifth of a half turn either way, which puts both base
    // points at x 312.37796 and y 368.99311 and 351.00689. They are written as
    // measurements rather than rebuilt from the module's own trigonometry,
    // because an expected value computed the way the code computes it agrees
    // with the code whatever the code does.
    const world = createWorld();
    const recorder = new CanvasRecorder();
    drawEntities(recorder.context, PLAY_SURFACE.floodlit, world);
    const bases = recorder.calls('lineTo').map((op) => op.args);
    expect(bases[0]?.[0]).toBeCloseTo(312.377960, 6);
    expect(bases[0]?.[1]).toBeCloseTo(368.993114, 6);
    expect(bases[1]?.[0]).toBeCloseTo(312.377960, 6);
    expect(bases[1]?.[1]).toBeCloseTo(351.006886, 6);
    // The chord across the base, which is what a collapsed spread takes to
    // zero, against a tip that sits 32.3 units out on the same midline.
    const chord = Math.abs(Number(bases[0]?.[1]) - Number(bases[1]?.[1]));
    expect(chord).toBeCloseTo(17.986229, 6);
    // And the opponent's, facing the other way, so the shape is the body's
    // and not a constant the player happens to produce.
    expect(bases[2]?.[0]).toBeCloseTo(967.622040, 6);
    expect(bases[2]?.[1]).toBeCloseTo(351.006886, 6);
    expect(bases[3]?.[0]).toBeCloseTo(967.622040, 6);
    expect(bases[3]?.[1]).toBeCloseTo(368.993114, 6);
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

  it('derives the opponent glyph from its configured name, with the kickoff fallback', () => {
    expect(glyphsForOpponent('Meridian')).toEqual({ player: 'P', opponent: 'M' });
    expect(glyphsForOpponent(' Player 2 ')).toEqual({ player: 'P', opponent: 'P' });
    expect(glyphsForOpponent('')).toEqual({ player: 'P', opponent: 'O' });
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
