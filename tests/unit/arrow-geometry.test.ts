import { describe, expect, it } from 'vitest';

import { aimFromDrag } from '../../src/core/aiming';
import { createWorld } from '../../src/core/bodies';
import { arrowGeometry, arrowPath, drawAimArrow, rampColour } from '../../src/render/arrow';
import { PLAY_SURFACE } from '../../src/render/tokens';
import { CanvasRecorder } from './support/canvas-recorder';

/**
 * Item C7, method T, evidence `unit/arrow-geometry`:
 *
 *   "The arrowhead is clamped to at most half the shaft length, so a very
 *    short drag never draws an arrow running backwards through the circle."
 *
 * THE NEGATIVE CONTROL IS THE DELIVERABLE HERE. The criterion names the
 * defect it exists to prevent, and DESIGN section 5 records that the prior
 * build shipped it. `unclampedGeometry` below is that build's arrowhead: the
 * head at its full size whatever the shaft is. The tests assert both halves,
 * that the control reproduces the defect at the reaches the criterion cares
 * about and that the shipped geometry does not at the same reaches. Without
 * the first half, a clamp that had quietly stopped clamping would look
 * exactly like a clamp that is working.
 *
 * "RUNS BACKWARDS THROUGH THE CIRCLE" IS MEASURED, not paraphrased. Every
 * VERTEX of the polygon is projected onto the aim axis with the circle centre
 * as the origin, and the smallest of those projections is the answer: zero
 * means the arrow starts at the centre, and anything below zero is the arrow
 * poking out of the back of the body it belongs to. The measurement is of the
 * vertices and not of the stroked outline, which is stated rather than
 * implied: the boundary stroke is centred on the path, so it reaches half a
 * line width behind the two base corners whatever the head does. That is a
 * hairline under the circle's own fill and it is not the defect the criterion
 * names, which is a head longer than its shaft.
 *
 * The head's full length is pinned as 24 rather than as the symbol that
 * defines it, per the same rule every other threshold in this suite follows.
 *
 * The last two tests are armour beyond C7 rather than C7 itself: the colour
 * ramp SPEC section 14 asks for, whose two ends are the two cells the design
 * contract measured, and the sub-minimum presentation SPEC section 5 asks for
 * a clear signal from. They live here because they are the arrow's, and they
 * are labelled so the evidence map stays honest.
 */

/** The head at full size, from the spacing scale, written out. */
const HEAD_LENGTH = 24;

/** The prior build's head: full size at every shaft length. */
function unclampedGeometry(reach: number): ReturnType<typeof arrowGeometry> {
  const shipped = arrowGeometry(reach);
  return {
    shaftLength: shipped.shaftLength,
    headLength: HEAD_LENGTH,
    headHalfWidth: HEAD_LENGTH * 0.6,
    shaftHalfWidth: shipped.shaftHalfWidth,
    headBase: shipped.shaftLength - HEAD_LENGTH,
  };
}

/** How far behind the circle centre the arrow reaches, along its own axis. */
function furthestBehind(angleRad: number, geometry: ReturnType<typeof arrowGeometry>): number {
  const alongX = Math.cos(angleRad);
  const alongY = Math.sin(angleRad);
  let least = Number.POSITIVE_INFINITY;
  for (const point of arrowPath(300, 360, angleRad, geometry)) {
    const along = (point.x - 300) * alongX + (point.y - 360) * alongY;
    least = Math.min(least, along);
  }
  return least;
}

describe('PF-5 the arrowhead clamp, item C7', () => {
  it('clamps the head to at most half the shaft at every reach', () => {
    let clamped = 0;
    for (let reach = 0; reach <= 400; reach += 0.25) {
      const geometry = arrowGeometry(reach);
      expect(geometry.headLength, `reach ${String(reach)}`).toBeLessThanOrEqual(
        geometry.shaftLength / 2,
      );
      expect(geometry.headLength, `reach ${String(reach)}`).toBe(
        Math.min(HEAD_LENGTH, reach / 2),
      );
      if (geometry.headLength < HEAD_LENGTH) {
        clamped += 1;
      }
    }
    // The clamp actually bites over the sweep, so the assertion above is not
    // passing because it never had anything to clamp.
    expect(clamped).toBeGreaterThan(0);
    // And it stops biting exactly where the two readings meet, at twice the
    // head's full length.
    expect(arrowGeometry(48).headLength).toBe(HEAD_LENGTH);
    expect(arrowGeometry(47).headLength).toBe(23.5);
  });

  it('puts no vertex of the arrow behind the circle centre', () => {
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, 2.4, -1.9]) {
      for (const reach of [0.5, 1, 5, 12, 23, 29.9, 30, 47, 48, 100, 180]) {
        expect(
          furthestBehind(angle, arrowGeometry(reach)),
          `angle ${String(angle)} reach ${String(reach)}`,
        ).toBeCloseTo(0, 9);
      }
    }
  });

  it('detects the unclamped head as an arrow running backwards', () => {
    // The control, at the reaches the sub-minimum drag actually produces.
    let backwards = 0;
    for (const reach of [1, 5, 12, 23, 29.9]) {
      const behind = furthestBehind(0.7, unclampedGeometry(reach));
      expect(behind, `reach ${String(reach)}`).toBeLessThan(0);
      // And it is behind by enough to be inside the 34 px circle it started
      // in, which is where DESIGN section 5 says the defect was visible.
      expect(behind, `reach ${String(reach)}`).toBeGreaterThan(-34);
      backwards += 1;
      // The shipped geometry, at the same reach, is not.
      expect(furthestBehind(0.7, arrowGeometry(reach))).toBeCloseTo(0, 9);
    }
    expect(backwards).toBe(5);
    // Above twice the head's length the control and the shipped geometry
    // agree, which is why a test written at a long drag cannot see this.
    expect(furthestBehind(0.7, unclampedGeometry(100))).toBeCloseTo(0, 9);
  });

  it('keeps the shaft no wider than the head that feeds it', () => {
    for (let reach = 0; reach <= 60; reach += 0.25) {
      const geometry = arrowGeometry(reach);
      expect(geometry.shaftHalfWidth, `reach ${String(reach)}`).toBeLessThanOrEqual(
        geometry.headHalfWidth,
      );
    }
    // At full size the shaft is the spacing scale's own step and the head is
    // wider than it, so the clamp above is the exception and not the rule.
    expect(arrowGeometry(180).shaftHalfWidth).toBe(4);
    expect(arrowGeometry(180).headHalfWidth).toBeCloseTo(14.4, 12);
  });

  it('reads a reach that is not a number as no arrow at all', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(arrowGeometry(bad).shaftLength).toBe(0);
      expect(arrowGeometry(bad).headLength).toBe(0);
      expect(furthestBehind(0.7, arrowGeometry(bad))).toBe(0);
    }
  });
});

describe('PF-5 the arrow presentation, armour beyond C7', () => {
  it('ramps from the boundary token to the accent, and lands on both ends', () => {
    for (const palette of [PLAY_SURFACE.floodlit, PLAY_SURFACE.daylight]) {
      expect(rampColour(palette, 0)).toBe(palette.line);
      expect(rampColour(palette, 1)).toBe(palette.accent);
      // Monotone between them, per channel, so the ramp reads as one scale.
      const half = rampColour(palette, 0.5);
      expect(half).not.toBe(palette.line);
      expect(half).not.toBe(palette.accent);
      const channel = (hex: string, at: number): number =>
        Number.parseInt(hex.slice(at, at + 2), 16);
      for (const at of [1, 3, 5]) {
        const low = Math.min(channel(palette.line, at), channel(palette.accent, at));
        const high = Math.max(channel(palette.line, at), channel(palette.accent, at));
        expect(channel(half, at)).toBeGreaterThanOrEqual(low);
        expect(channel(half, at)).toBeLessThanOrEqual(high);
      }
    }
    // A strength outside the scale is the nearest end of it, never a colour
    // off the ramp entirely.
    expect(rampColour(PLAY_SURFACE.floodlit, -1)).toBe(PLAY_SURFACE.floodlit.line);
    expect(rampColour(PLAY_SURFACE.floodlit, 2)).toBe(PLAY_SURFACE.floodlit.accent);
    expect(rampColour(PLAY_SURFACE.floodlit, Number.NaN)).toBe(PLAY_SURFACE.floodlit.line);
  });

  it('draws the sub-minimum signal as a shape and the launchable arrow as a fill', () => {
    const world = createWorld();
    const palette = PLAY_SURFACE.floodlit;

    const tooShort = new CanvasRecorder();
    drawAimArrow(tooShort.context, palette, world.player, aimFromDrag(20, 0));
    // No fill at all: the arrow is an outline and the ring is a stroke, so
    // the signal survives a reader who cannot tell the two colours apart.
    expect(tooShort.calls('fill')).toHaveLength(0);
    expect(tooShort.calls('stroke').length).toBeGreaterThan(0);
    // The ring sits outside the rim, because the minimum drag is shorter than
    // the circle's own radius and an arrow that short is inside the body.
    const ring = tooShort.calls('arc')[0]?.args ?? [];
    expect(ring[0]).toBe(300);
    expect(ring[1]).toBe(360);
    expect(ring[2]).toBe(42);
    expect(tooShort.values('strokeStyle')).toContain(palette.line);

    const launchable = new CanvasRecorder();
    drawAimArrow(launchable.context, palette, world.player, aimFromDrag(180, 0));
    expect(launchable.calls('arc')).toHaveLength(0);
    expect(launchable.calls('fill')).toHaveLength(1);
    expect(launchable.values('fillStyle')).toEqual([palette.accent]);
    expect(launchable.values('strokeStyle')).toEqual([palette.line]);
    // Seven points: one moveTo and six lineTo, closed.
    expect(launchable.calls('moveTo')).toHaveLength(1);
    expect(launchable.calls('lineTo')).toHaveLength(6);
    expect(launchable.calls('closePath')).toHaveLength(1);
  });
});
