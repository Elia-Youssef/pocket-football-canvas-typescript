import { describe, expect, it } from 'vitest';

import { aimFromDrag, pressLandsOn } from '../../src/core/aiming';
import { createWorld, kickoff } from '../../src/core/bodies';
import { arrowGeometry, arrowPath } from '../../src/render/arrow';

/**
 * Item C2, method T, evidence `unit/aim-vector`:
 *
 *   "The aiming arrow points opposite to the drag direction from the circle
 *    centre, with length proportional to the clamped drag distance, in all
 *    four quadrants."
 *
 * The sentence has four clauses and each is asserted separately, because
 * three of them are true of an implementation that gets the fourth wrong.
 *
 * ALL FOUR QUADRANTS IS THE CLAUSE THAT NEEDS A CONTROL. An arrow that
 * negates only one component of the drag is opposite in two quadrants and
 * wrong in the other two, and a test written on the x axis alone agrees with
 * it everywhere. The mirrored reading is implemented below as a negative
 * control, and the test asserts both that it passes the weaker check and that
 * it fails this one; without that, "in all four quadrants" is a phrase in a
 * test name rather than a property.
 *
 * The numbers here are pinned by literal. SPEC section 5's 180 px maximum is
 * written as 180 and never as the symbol that defines it, because asserting a
 * bound against its own definition passes for whatever value the definition
 * takes.
 */

/** The drag deltas, one per quadrant, with unequal components on purpose. */
const QUADRANTS: ReadonlyArray<readonly [string, number, number]> = [
  ['up and to the right', 60, 80],
  ['up and to the left', -60, 80],
  ['down and to the left', -60, -80],
  ['down and to the right', 60, -80],
];

/** The direction the aim points, as a unit vector in design space. */
function direction(angleRad: number): { x: number; y: number } {
  return { x: Math.cos(angleRad), y: Math.sin(angleRad) };
}

/**
 * The negative control the fourth clause names: an aim that negates the x
 * component and leaves y alone. It is opposite the drag on the x axis and in
 * no quadrant, which is exactly the shape of defect a two-quadrant test
 * cannot see.
 */
function mirroredAngle(dragX: number, dragY: number): number {
  return Math.atan2(dragY, -dragX);
}

describe('PF-5 the aim vector, item C2', () => {
  it('points opposite the drag in all four quadrants', () => {
    for (const [name, dragX, dragY] of QUADRANTS) {
      const preview = aimFromDrag(dragX, dragY);
      const unit = direction(preview.aim.angleRad);
      const length = Math.hypot(dragX, dragY);
      // Opposite means the projection onto the drag is the drag's whole
      // length, negated: parallel and backwards, not merely "not forwards".
      expect(unit.x * dragX + unit.y * dragY, name).toBeCloseTo(-length, 12);
      // And collinear, so there is no sideways component to argue about.
      expect(unit.x * dragY - unit.y * dragX, name).toBeCloseTo(0, 12);
    }
    expect(QUADRANTS).toHaveLength(4);
  });

  it('is not merely opposite on one axis: the mirrored reading fails here', () => {
    // The control agrees with the shipped reading along the x axis, which is
    // what makes a test written there blind to it.
    const alongX = aimFromDrag(100, 0);
    expect(Math.cos(mirroredAngle(100, 0))).toBeCloseTo(Math.cos(alongX.aim.angleRad), 12);
    expect(Math.sin(mirroredAngle(100, 0))).toBeCloseTo(Math.sin(alongX.aim.angleRad), 12);

    // And disagrees in every quadrant, where the shipped reading is opposite
    // and the control is not.
    let wrong = 0;
    for (const [, dragX, dragY] of QUADRANTS) {
      const unit = direction(mirroredAngle(dragX, dragY));
      const projection = unit.x * dragX + unit.y * dragY;
      if (Math.abs(projection + Math.hypot(dragX, dragY)) > 1e-9) {
        wrong += 1;
      }
    }
    expect(wrong).toBe(4);
  });

  it('starts at the circle centre, in all four quadrants', () => {
    const centreX = 300;
    const centreY = 360;
    for (const [name, dragX, dragY] of QUADRANTS) {
      const preview = aimFromDrag(dragX, dragY);
      const path = arrowPath(
        centreX,
        centreY,
        preview.aim.angleRad,
        arrowGeometry(preview.reach),
      );
      const first = path[0];
      const last = path[path.length - 1];
      expect(first, name).toBeDefined();
      expect(last, name).toBeDefined();
      // The two base points straddle the centre, so their midpoint is it.
      expect((Number(first?.x) + Number(last?.x)) / 2, name).toBeCloseTo(centreX, 12);
      expect((Number(first?.y) + Number(last?.y)) / 2, name).toBeCloseTo(centreY, 12);
      // And the tip is on the far side of the centre from the drag.
      const tip = path[3];
      expect(
        (Number(tip?.x) - centreX) * dragX + (Number(tip?.y) - centreY) * dragY,
        name,
      ).toBeLessThan(0);
    }
  });

  it('takes its length from the clamped drag distance', () => {
    // Below the maximum the reach is the drag itself, in every quadrant.
    for (const [name, dragX, dragY] of QUADRANTS) {
      expect(aimFromDrag(dragX, dragY).reach, name).toBeCloseTo(100, 12);
    }
    // The clamp is SPEC section 5's 180, written out.
    expect(aimFromDrag(179, 0).reach).toBeCloseTo(179, 12);
    expect(aimFromDrag(180, 0).reach).toBe(180);
    expect(aimFromDrag(181, 0).reach).toBe(180);
    expect(aimFromDrag(600, 800).reach).toBe(180);
    // In every quadrant, so the clamp is on the distance and not on a
    // component.
    for (const [name, dragX, dragY] of QUADRANTS) {
      expect(aimFromDrag(dragX * 5, dragY * 5).reach, name).toBe(180);
    }
  });

  it('is proportional to the clamped drag distance, not merely monotonic', () => {
    // Proportional: doubling the pull doubles the arrow, and the constant of
    // proportionality is one, which is what makes the 180 clamp legible as
    // the moment the arrow stops growing.
    const single = aimFromDrag(36, 48).reach;
    const double = aimFromDrag(72, 96).reach;
    const triple = aimFromDrag(108, 144).reach;
    expect(single).toBeCloseTo(60, 12);
    expect(double).toBeCloseTo(120, 12);
    expect(triple).toBeCloseTo(180, 12);
    expect(double / single).toBeCloseTo(2, 12);
    expect(triple / single).toBeCloseTo(3, 12);
    // The arrow the geometry draws is that reach, so the proportionality
    // reaches the drawing rather than stopping at the state.
    expect(arrowGeometry(double).shaftLength).toBe(double);
  });

  it('reads a drag that is not a number, and a drag of nothing, as no drag', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) {
      const preview = aimFromDrag(bad, bad);
      expect(preview.reach).toBe(0);
      expect(preview.launchable).toBe(false);
      expect(preview.aim.power01).toBe(0);
      // The angle it reports is finite, and it is also arbitrary: a drag of
      // no length has no direction, and `Math.atan2(-0, -0)` answers with one
      // anyway. Nothing may act on it, which is why the arrow draws nothing
      // at a reach of zero and the composition root leaves the circle's
      // facing where it was rather than turning it to this value.
      expect(Number.isFinite(preview.aim.angleRad)).toBe(true);
      expect(arrowGeometry(preview.reach).shaftLength).toBe(0);
    }
  });
});

describe('PF-5 the press that begins an aim, item C1', () => {
  /**
   * `pressLandsOn` is the hit test item C1's whole sentence rests on, and until
   * this block it was graded only through `aimingBegins`, which asks it about
   * one body in one state. Its own three properties are the disc it uses, the
   * rim it includes and the coordinate it refuses, and each of them is a
   * separate way to be wrong: a radius read from the wrong body makes the ball
   * a handle, a strict comparison makes the rim itself dead, and a comparison
   * written the other way round makes a press nobody can locate a press on
   * everything.
   *
   * THE RADII ARE SPEC SECTIONS 4's, WRITTEN OUT. A circle is 34 and the ball
   * is 18, so the offsets below are literals rather than expressions over the
   * body under test.
   */
  it('is the body own disc, rim included, and refuses a coordinate that is not one', () => {
    const world = createWorld();
    kickoff(world);
    const circle = world.player;
    const ball = world.ball;
    expect(circle.radius).toBe(34);
    expect(ball.radius).toBe(18);
    const at = circle.position;

    // The centre, and every direction out to the rim.
    expect(pressLandsOn(circle, at.x, at.y)).toBe(true);
    expect(pressLandsOn(circle, at.x + 33.9, at.y)).toBe(true);
    expect(pressLandsOn(circle, at.x, at.y - 33.9)).toBe(true);
    // THE RIM ITSELF COUNTS, in both axes and on the diagonal: the comparison
    // is `<=` and a strict one would leave the outermost ring of a 44 px
    // target unusable. 34 = hypot(30.6, 14.8) to twelve places is not exact in
    // binary, so the diagonal case is taken at an exact Pythagorean triple
    // scaled to the radius instead.
    expect(pressLandsOn(circle, at.x + 34, at.y)).toBe(true);
    expect(pressLandsOn(circle, at.x - 34, at.y)).toBe(true);
    expect(pressLandsOn(circle, at.x, at.y + 34)).toBe(true);
    expect(pressLandsOn(circle, at.x + 20.4, at.y + 27.2)).toBe(true);
    expect(Math.hypot(20.4, 27.2)).toBeCloseTo(34, 12);
    // And a hair outside it, which is the control that keeps the four above
    // from passing for a predicate that answers true to everything.
    expect(pressLandsOn(circle, at.x + 34.001, at.y)).toBe(false);
    expect(pressLandsOn(circle, at.x + 25, at.y + 25)).toBe(false);
    expect(pressLandsOn(circle, at.x + 200, at.y)).toBe(false);

    // THE RADIUS IS THE BODY'S OWN. The ball is half the circle, so a press
    // 25 px from a centre lands on one and misses the other; a hit test that
    // had fixed on the circle radius would answer true to both.
    expect(pressLandsOn(ball, ball.position.x + 25, ball.position.y)).toBe(false);
    expect(pressLandsOn(ball, ball.position.x + 18, ball.position.y)).toBe(true);

    // A PRESS NOBODY CAN LOCATE IS NOT A PRESS ON ANYTHING, which is what the
    // comparison being written round this way buys: every comparison against a
    // NaN is false, so the answer is no rather than yes.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(pressLandsOn(circle, bad, at.y), String(bad)).toBe(false);
      expect(pressLandsOn(circle, at.x, bad), String(bad)).toBe(false);
      expect(pressLandsOn(circle, bad, bad), String(bad)).toBe(false);
    }
  });
});
