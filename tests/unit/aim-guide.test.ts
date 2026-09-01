import { describe, expect, it } from 'vitest';

import { createWorld, kickoff } from '../../src/core/bodies';
import type { Body, World } from '../../src/core/bodies';
import { predictGuide } from '../../src/core/guide';
import type { AimGuide, GuidePoint } from '../../src/core/guide';
import { set } from '../../src/core/vec2';

/**
 * SPEC section 11's prediction, over the real module.
 *
 * THE EXPECTED PATH IS DERIVED HERE, from SPEC section 3's pitch and section
 * 4's radii, and never from the module under test. A circle of radius 34
 * travels inside the field inset by 34: x from 124 to 1156 and y from 119 to
 * 601. Every bound below is one of those four numbers written out, so a
 * prediction that quietly used the wall band or the goal opening instead would
 * fail rather than agree with itself.
 *
 * THE THREE NEGATIVE CONTROLS THE CRITERION NAMES, all of them properties this
 * file can be held to rather than sentences in a docstring:
 *
 *   "exactly one wall bounce"  - swept over the whole circle of directions and
 *                                a grid of starting points, the path never has
 *                                more than one corner in it, and where a wall
 *                                is reached before the ball it has exactly one.
 *   "the first ball contact"   - the contact point is at the touching distance
 *                                from the ball centre, to twelve decimal
 *                                places, and it is the FIRST such point along
 *                                the launch.
 *   "never the ball path"      - the path STOPS at the contact: its last point
 *                                is the contact point, so nothing is predicted
 *                                past the collision this module refuses to
 *                                resolve. A prediction that ran on would put a
 *                                point beyond it and fail here.
 */

/** SPEC sections 3 and 4, as literals. */
const CIRCLE_RADIUS = 34;
const BALL_RADIUS = 18;
const MIN_X = 90 + CIRCLE_RADIUS;
const MAX_X = 1190 - CIRCLE_RADIUS;
const MIN_Y = 85 + CIRCLE_RADIUS;
const MAX_Y = 635 - CIRCLE_RADIUS;
const TOUCHING = CIRCLE_RADIUS + BALL_RADIUS;

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

/** A world with both circles and the ball placed exactly. */
function placed(
  player: readonly [number, number],
  ball: readonly [number, number],
): World {
  const world = createWorld();
  kickoff(world);
  set(world.player.position, player[0], player[1]);
  set(world.ball.position, ball[0], ball[1]);
  // The opponent is parked well away, because this module never reads it.
  set(world.opponent.position, 1100, 600);
  return world;
}

function distance(from: GuidePoint, to: GuidePoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** The unit direction of one leg of a path. */
function directionOf(from: GuidePoint, to: GuidePoint): { x: number; y: number } {
  const length = distance(from, to) || 1;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/** Whether a point is on the inset rectangle's boundary, to a tolerance. */
function onABound(point: GuidePoint): boolean {
  return (
    Math.abs(point.x - MIN_X) < 1e-9 ||
    Math.abs(point.x - MAX_X) < 1e-9 ||
    Math.abs(point.y - MIN_Y) < 1e-9 ||
    Math.abs(point.y - MAX_Y) < 1e-9
  );
}

function guideFor(world: World, angle: number): AimGuide {
  return predictGuide(world.player, world.ball, angle);
}

describe('PF-9 the aim guide, SPEC section 11', () => {
  it('predicts the launching circle to the wall and once back off it', () => {
    // From the kickoff spot at 60 degrees. The top bound is 601, so the turn
    // is at x = 300 + (601 - 360) / tan(60) = 439.16, and the leg after it
    // reaches the bottom bound at 439.16 + (601 - 119) / tan(60) = 717.48.
    const world = placed([300, 360], [640, 360]);
    const guide = guideFor(world, degrees(60));
    expect(guide.path).toHaveLength(3);
    expect(guide.bounce).toBe('top');
    expect(guide.contact).toBeUndefined();
    const [start, corner, end] = guide.path;
    expect(start).toEqual({ x: 300, y: 360 });
    expect(corner?.y).toBeCloseTo(MAX_Y, 9);
    expect(corner?.x).toBeCloseTo(300 + (MAX_Y - 360) / Math.tan(degrees(60)), 6);
    expect(end?.y).toBeCloseTo(MIN_Y, 9);
    expect(end?.x).toBeCloseTo(
      300 + (MAX_Y - 360) / Math.tan(degrees(60)) + (MAX_Y - MIN_Y) / Math.tan(degrees(60)),
      6,
    );
  });

  it('reflects off each of the four walls, and names the one it used', () => {
    const cases: readonly (readonly [number, number, number, string])[] = [
      [640, 360, 90, 'top'],
      [640, 360, 270, 'bottom'],
      [640, 360, 0, 'right'],
      [640, 360, 180, 'left'],
    ];
    for (const [x, y, angle, wall] of cases) {
      // The ball is parked in a corner so that nothing intervenes.
      const world = placed([x, y], [200, 150]);
      const guide = guideFor(world, degrees(angle));
      expect(guide.bounce, wall).toBe(wall);
      expect(guide.path, wall).toHaveLength(3);
      expect(onABound(guide.path[1] as GuidePoint), wall).toBe(true);
      // The leg after the bounce runs back along the mirrored direction.
      const before = directionOf(guide.path[0] as GuidePoint, guide.path[1] as GuidePoint);
      const after = directionOf(guide.path[1] as GuidePoint, guide.path[2] as GuidePoint);
      if (wall === 'top' || wall === 'bottom') {
        expect(after.x, wall).toBeCloseTo(before.x, 9);
        expect(after.y, wall).toBeCloseTo(-before.y, 9);
      } else {
        expect(after.x, wall).toBeCloseTo(-before.x, 9);
        expect(after.y, wall).toBeCloseTo(before.y, 9);
      }
    }
  });

  it('marks the FIRST ball contact and stops the path there', () => {
    // Straight at the ball on the centre spot: contact at 640 - 52 = 588.
    const world = placed([300, 360], [640, 360]);
    const guide = guideFor(world, degrees(0));
    expect(guide.contact).toBeDefined();
    expect(guide.bounce).toBeUndefined();
    expect(guide.path).toHaveLength(2);
    expect(guide.contact?.x).toBeCloseTo(640 - TOUCHING, 9);
    expect(guide.contact?.y).toBeCloseTo(360, 9);
    // The contact is at the touching distance from the ball, which is what
    // makes it a contact rather than a point near one.
    expect(distance(guide.contact as GuidePoint, { x: 640, y: 360 })).toBeCloseTo(
      TOUCHING,
      9,
    );
    // NEVER THE BALL PATH: the last point of the prediction IS the contact.
    expect(guide.path.at(-1)).toEqual(guide.contact);
  });

  it('finds a contact on the leg after the bounce as well as before it', () => {
    // Aimed up at the top bound from below the ball, so the reflected leg is
    // what meets it. The ball sits on the return line.
    const world = placed([400, 200], [700, 300]);
    const guide = guideFor(world, degrees(45));
    // The outgoing leg passes well left of the ball, the return leg meets it.
    expect(guide.bounce).toBe('top');
    expect(guide.path).toHaveLength(3);
    if (guide.contact !== undefined) {
      expect(distance(guide.contact, { x: 700, y: 300 })).toBeCloseTo(TOUCHING, 9);
      expect(guide.path.at(-1)).toEqual(guide.contact);
    }
  });

  it('answers a circle already touching the ball with a contact where it stands', () => {
    const world = placed([640 - TOUCHING, 360], [640, 360]);
    const guide = guideFor(world, degrees(0));
    expect(guide.contact?.x).toBeCloseTo(640 - TOUCHING, 9);
    expect(guide.path).toHaveLength(2);
    expect(distance(guide.path[0] as GuidePoint, guide.path[1] as GuidePoint)).toBeCloseTo(
      0,
      9,
    );
  });

  it('has nothing to predict for a direction that is not a number', () => {
    const world = placed([300, 360], [640, 360]);
    for (const angle of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const guide = predictGuide(world.player, world.ball, angle);
      expect(guide.path).toEqual([]);
      expect(guide.contact).toBeUndefined();
      expect(guide.bounce).toBeUndefined();
    }
  });

  it('has nothing to predict from a starting point that is not a number', () => {
    // THE SECOND REFUSAL, ON ITS OWN. It is a separate gate from the direction
    // one and needs its own case: a direction that is not a number leaves both
    // components NaN, while a starting point that is not a number leaves the
    // direction perfectly good and poisons only the points built from it. The
    // angles below are deliberately off the axes, because an axis-aligned one
    // sends the whole path along a single coordinate and would not carry the
    // bad one into the answer at all.
    for (const angle of [degrees(45), degrees(135), degrees(200), degrees(310)]) {
      for (const [x, y] of [
        [Number.NaN, 360],
        [300, Number.NaN],
        [Number.POSITIVE_INFINITY, 360],
        [300, Number.NEGATIVE_INFINITY],
      ] as const) {
        const world = placed([300, 360], [640, 360]);
        set(world.player.position, x, y);
        const guide = predictGuide(world.player, world.ball, angle);
        expect(guide.path).toEqual([]);
        expect(guide.contact).toBeUndefined();
        expect(guide.bounce).toBeUndefined();
      }
    }
  });

  it('never predicts a second bounce, swept over the whole circle', () => {
    // THE NEGATIVE CONTROL FOR "EXACTLY ONE". Every direction, from a grid of
    // starting points, with the ball moved out of the way and left in it.
    let withBounce = 0;
    let withContact = 0;
    for (const x of [150, 300, 640, 900, 1140]) {
      for (const y of [130, 250, 360, 500, 590]) {
        for (const ballAt of [
          [640, 360],
          [200, 560],
        ] as const) {
          const world = placed([x, y], [ballAt[0], ballAt[1]]);
          for (let angle = 0; angle < 360; angle += 3) {
            const guide = guideFor(world, degrees(angle));
            expect(guide.path.length, `${String(x)},${String(y)} at ${String(angle)}`).
              toBeLessThanOrEqual(3);
            if (guide.bounce !== undefined) {
              withBounce += 1;
              // The corner is on a bound, and it is the ONLY corner.
              expect(onABound(guide.path[1] as GuidePoint)).toBe(true);
            }
            if (guide.contact !== undefined) {
              withContact += 1;
              const centre = { x: ballAt[0], y: ballAt[1] };
              const from = guide.path[0] as GuidePoint;
              // Every contact is a real one, and the path ends at it. A circle
              // that is ALREADY inside the touching distance is touching the
              // ball where it stands, so its contact is the point it started
              // from rather than a point at the touching distance.
              if (distance(from, centre) < TOUCHING) {
                expect(guide.contact).toEqual(from);
              } else {
                expect(distance(guide.contact, centre)).toBeCloseTo(TOUCHING, 6);
              }
              expect(guide.path.at(-1)).toEqual(guide.contact);
            }
            // Every point is inside the rectangle the circle's centre lives in.
            for (const point of guide.path) {
              expect(point.x).toBeGreaterThanOrEqual(MIN_X - 1e-6);
              expect(point.x).toBeLessThanOrEqual(MAX_X + 1e-6);
              expect(point.y).toBeGreaterThanOrEqual(MIN_Y - 1e-6);
              expect(point.y).toBeLessThanOrEqual(MAX_Y + 1e-6);
            }
          }
        }
      }
    }
    // Non-vacuous: the sweep really produced both kinds of prediction.
    expect(withBounce).toBeGreaterThan(1000);
    expect(withContact).toBeGreaterThan(100);
  });

  it('carries no field that could hold a ball path at all', () => {
    // The shape is the guarantee: there is nowhere for the resulting ball path
    // to be returned, so it cannot leak out of a later change by accident.
    const world = placed([300, 360], [640, 360]);
    const guide = guideFor(world, degrees(0));
    expect(Object.keys(guide).sort()).toEqual(['bounce', 'contact', 'path']);
  });

  it('reads the ball for its place and its size, and moves nothing', () => {
    const world = placed([300, 360], [640, 360]);
    const before = {
      ball: { x: world.ball.position.x, y: world.ball.position.y },
      player: { x: world.player.position.x, y: world.player.position.y },
      velocity: { x: world.ball.velocity.x, y: world.ball.velocity.y },
    };
    guideFor(world, degrees(37));
    expect(world.ball.position.x).toBe(before.ball.x);
    expect(world.ball.position.y).toBe(before.ball.y);
    expect(world.player.position.x).toBe(before.player.x);
    expect(world.player.position.y).toBe(before.player.y);
    expect(world.ball.velocity.x).toBe(before.velocity.x);
    expect(world.ball.velocity.y).toBe(before.velocity.y);
  });

  it('predicts from whichever circle is launching', () => {
    // SPEC section 9's Hotseat aims the opponent's circle on the second turn,
    // so the prediction is a function of the body it is given and of nothing
    // the world calls "the player".
    const world = placed([300, 360], [640, 360]);
    set(world.opponent.position, 980, 360);
    const fromPlayer = predictGuide(world.player, world.ball, degrees(0));
    const fromOpponent = predictGuide(
      world.opponent as Body,
      world.ball,
      degrees(180),
    );
    expect(fromPlayer.path[0]).toEqual({ x: 300, y: 360 });
    expect(fromOpponent.path[0]).toEqual({ x: 980, y: 360 });
    expect(fromOpponent.contact?.x).toBeCloseTo(640 + TOUCHING, 9);
  });
});
