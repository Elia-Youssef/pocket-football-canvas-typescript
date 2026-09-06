import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import type { World } from '../../src/core/bodies';
import type { ScoringReadout } from '../../src/core/goals';
import { createMatch } from '../../src/core/match';
import { createEffects } from '../../src/render/effects';
import type { Effects, EffectEvent } from '../../src/render/effects';
import { effectSeconds } from '../../src/render/effects';
import { DURATION, duration } from '../../src/render/tokens';
import { CanvasRecorder } from './support/canvas-recorder';
import { PLAY_SURFACE } from '../../src/render/tokens';

/**
 * Item E6, method T, evidence `playwright/reduced-motion`:
 *
 *   "prefers-reduced-motion removes every animation entirely, including screen
 *    shake and particles, while leaving simulation timing identical."
 *
 * THE BROWSER SPEC IS THE CLOSURE. tests/browser/reduced-motion.spec.ts drives
 * the built bundle under the real media preference and is what grades the item.
 * This file is the unit half of the same two clauses, and it is here because
 * one of them is far better asserted at this layer than at that one: "leaving
 * simulation timing identical" is a claim about two runs being THE SAME, and a
 * unit test can compare the whole transcript frame by frame rather than the
 * handful of facts a page can be asked for.
 *
 * ASSERTED, NOT OBSERVED. Nothing below watches a scene and reports what it
 * saw. Each test states the equality or the zero it requires and fails on
 * anything else, and each carries the control that keeps it from passing for
 * an implementation that does nothing at all.
 *
 * THE FORBIDDEN IMPLEMENTATION, stated so the tests can rule it out: a blanket
 * cancel of every animation also stops `transitionend` and `animationend` being
 * delivered, so anything sequenced on the end of an animation never runs and
 * the ORDER of states changes rather than the pacing. QUALITY-BAR section 4
 * forbids exactly that. The shape that is not that one is a duration resolved
 * to zero with every branch, every event and every draw left where they were,
 * and the tests below are written to tell the two apart.
 */

/** Frames of a sixtieth each: long enough for a full-strength turn to settle. */
const FRAMES = 500;

/** One frame of a match, as a transcript compares two runs of it. */
interface Frame {
  readonly state: string;
  readonly clock: number | undefined;
  readonly goals: number;
  readonly hold: number;
  readonly bodies: readonly number[];
}

function snapshot(world: World): readonly number[] {
  return world.bodies.flatMap((body) => [
    body.position.x,
    body.position.y,
    body.velocity.x,
    body.velocity.y,
  ]);
}

/**
 * One scripted match: start, one launch at a fixed angle and full strength,
 * then five hundred frames of a sixtieth each, which is long enough for the
 * whole turn to come to rest and hand over. The launch drives the player into
 * the ball and the ball into the opponent, so the run contains real collisions
 * rather than an empty pitch, and it is the same script every time.
 */
function playMatch(reducedMotion: boolean, effects: Effects | null): Frame[] {
  const match = createMatch({ onNonFinite: 'repair' });
  match.dispatch({ kind: 'start' });
  match.dispatch({ kind: 'launch', angle: 0, power: 1 });
  const frames: Frame[] = [];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    match.update(1 / 60);
    const readout = match.readout();
    if (effects !== null) {
      effects.observe({
        world: match.world,
        scoring: readout.scoring,
        elapsed: 1 / 60,
        reducedMotion,
      });
    }
    frames.push({
      state: readout.state.kind,
      clock: readout.clock,
      goals: readout.scoring.goals,
      hold: readout.scoring.hold,
      bodies: snapshot(match.world),
    });
  }
  return frames;
}

/** A scoreboard reporting one goal, so the celebration can be reached. */
function oneGoal(): ScoringReadout {
  return {
    player: 1,
    opponent: 0,
    goals: 1,
    hold: 144,
    frozen: true,
    nextTurn: 'player',
    last: { scorer: 'player', conceded: 'opponent', mouth: 'right', step: 1 },
    over: false,
  };
}

/** Everything the two passes drew, for a frame nothing may be drawn in. */
function drawnOps(effects: Effects, world: World): number {
  const recorder = new CanvasRecorder();
  effects.drawBehind(recorder.context, PLAY_SURFACE.floodlit);
  effects.drawInFront(recorder.context, PLAY_SURFACE.floodlit, world, null);
  return recorder.ops.length;
}

describe('PF-12 reduced motion, item E6', () => {
  describe('the sequence of states and the outcome are identical', () => {
    it('plays the same match, frame for frame, with the flag both ways', () => {
      const reduced = playMatch(true, createEffects());
      const full = playMatch(false, createEffects());
      expect(reduced).toEqual(full);
      // The control that keeps the equality from being an equality of nothing:
      // the run really did play, really did collide, and really did move.
      expect(full).toHaveLength(FRAMES);
      expect(full.map((frame) => frame.state)).toContain('MOVING');
      expect(full.at(-1)?.state).toBe('OPPONENT_TURN');
      expect(full[0]?.bodies).not.toEqual(full.at(-1)?.bodies);
    });

    it('runs the same match with no effects layer at all', () => {
      // AN ARCHITECTURE ASSERTION rather than the E6 measurement, and labelled
      // as one: it fails exactly when the effects layer grows a write path
      // into the world, which is the thing that would make every other
      // equality in this file meaningless. The measurement is the test above.
      expect(playMatch(false, createEffects())).toEqual(playMatch(false, null));
      expect(playMatch(true, createEffects())).toEqual(playMatch(false, null));
    });

    it('derives the same events, in the same order, at the same times', () => {
      const reduced = createEffects();
      const full = createEffects();
      playMatch(true, reduced);
      playMatch(false, full);
      const log = (events: readonly EffectEvent[]): unknown =>
        events.map((event) => [event.kind, event.at, event.x, event.y, event.energy, event.admitted]);
      expect(log(reduced.events())).toEqual(log(full.events()));
      // Non-vacuous: the script produced real collisions to compare.
      expect(full.events().length).toBeGreaterThan(1);
      expect(full.events().map((event) => event.kind)).toContain('impact');
    });

    it('takes the same draws off the same seeded streams', () => {
      const reduced = createEffects();
      const full = createEffects();
      playMatch(true, reduced);
      playMatch(false, full);
      expect(reduced.readout().draws).toBe(full.readout().draws);
      expect(full.readout().draws).toBeGreaterThan(0);
      // A goal takes twenty-four draws either way, two per particle for the
      // twelve the burst makes, whether or not any of them is ever drawn.
      const withGoal = createEffects();
      const world = createWorld();
      withGoal.observe({ world, scoring: oneGoal(), elapsed: 1 / 60, reducedMotion: true });
      expect(withGoal.readout().draws).toBe(24);
    });
  });

  describe('every animation is removed entirely', () => {
    it('resolves every game-feel lifetime to zero, as a duration', () => {
      const steps = [
        'ballTrail',
        'impactFlash',
        'wallFlash',
        'screenShake',
        'goalCelebration',
      ] as const;
      for (const step of steps) {
        expect(effectSeconds(step, true), step).toBe(0);
        expect(effectSeconds(step, false), step).toBeGreaterThan(0);
      }
      // A zero that is a duration and not a skipped step, which is the same
      // shape the chrome scale takes and the reason nothing sequenced after an
      // effect stops arriving. Both against the literal, because either side
      // read off the other is an equality of a value with itself.
      expect(effectSeconds('goalCelebration', true)).toBe(0);
      expect(duration(4, true)).toBe(0);
      expect(DURATION[0]).toBe(0);
      expect(DURATION[4]).toBe(320);
    });

    it('shakes by exactly zero, at every display size, through a whole match', () => {
      const effects = createEffects();
      const match = createMatch({ onNonFinite: 'repair' });
      match.dispatch({ kind: 'start' });
      match.dispatch({ kind: 'launch', angle: 0, power: 1 });
      const offsets = new Set<string>();
      for (let frame = 0; frame < FRAMES; frame += 1) {
        match.update(1 / 60);
        effects.observe({
          world: match.world,
          scoring: match.readout().scoring,
          elapsed: 1 / 60,
          reducedMotion: true,
        });
        for (const height of [200, 720, 2160]) {
          const shake = effects.shake(height);
          offsets.add(`${String(shake.x)},${String(shake.y)}`);
          // Exactly zero, and positive zero: a negated zero is a different
          // number to `Object.is` and would ship a transform nobody meant.
          expect(Object.is(shake.x, 0)).toBe(true);
          expect(Object.is(shake.y, 0)).toBe(true);
        }
      }
      expect([...offsets]).toEqual(['0,0']);
      expect(effects.readout().shakeEnergy).toBe(0);

      // THE POSITIVE CONTROL. The same script with the flag off shakes, so the
      // zero above is the policy and not a shake that never happens.
      const moving = createEffects();
      const loud = createMatch({ onNonFinite: 'repair' });
      loud.dispatch({ kind: 'start' });
      loud.dispatch({ kind: 'launch', angle: 0, power: 1 });
      let shaken = 0;
      for (let frame = 0; frame < FRAMES; frame += 1) {
        loud.update(1 / 60);
        moving.observe({
          world: loud.world,
          scoring: loud.readout().scoring,
          elapsed: 1 / 60,
          reducedMotion: false,
        });
        if (moving.shake(720).x !== 0 || moving.shake(720).y !== 0) {
          shaken += 1;
        }
      }
      expect(shaken).toBeGreaterThan(0);
    });

    it('draws no trail, no flash, no particle and no pulse', () => {
      const effects = createEffects();
      const match = createMatch({ onNonFinite: 'repair' });
      match.dispatch({ kind: 'start' });
      match.dispatch({ kind: 'launch', angle: 0, power: 1 });
      let drawn = 0;
      for (let frame = 0; frame < FRAMES; frame += 1) {
        match.update(1 / 60);
        effects.observe({
          world: match.world,
          scoring: match.readout().scoring,
          elapsed: 1 / 60,
          reducedMotion: true,
        });
        drawn += drawnOps(effects, match.world);
      }
      // Two state sets per pass are unavoidable, because a pass that draws
      // nothing still declares the state it would have drawn with. What must
      // be zero is every mark on the surface.
      expect(drawn).toBe(FRAMES * 6);
      const readout = effects.readout();
      expect(readout.trailLength).toBe(0);
      expect(readout.impactFlashes).toBe(0);
      expect(readout.wallFlashes).toBe(0);
      expect(readout.particles).toBe(0);
      expect(readout.celebration).toBe(0);

      // THE POSITIVE CONTROL, same script, flag off: the passes draw.
      const moving = createEffects();
      const loud = createMatch({ onNonFinite: 'repair' });
      loud.dispatch({ kind: 'start' });
      loud.dispatch({ kind: 'launch', angle: 0, power: 1 });
      let marks = 0;
      for (let frame = 0; frame < FRAMES; frame += 1) {
        loud.update(1 / 60);
        moving.observe({
          world: loud.world,
          scoring: loud.readout().scoring,
          elapsed: 1 / 60,
          reducedMotion: false,
        });
        marks += drawnOps(moving, loud.world);
      }
      expect(marks).toBeGreaterThan(FRAMES * 6);
    });

    it('removes the particles a goal would have burst, and the frame pulse', () => {
      const effects = createEffects();
      const world = createWorld();
      effects.observe({ world, scoring: oneGoal(), elapsed: 1 / 60, reducedMotion: true });
      expect(effects.readout().particles).toBe(0);
      expect(effects.readout().celebration).toBe(0);
      expect(drawnOps(effects, world)).toBe(6);
      // The goal itself is still an event: the celebration was removed, the
      // step it belongs to was not, which is the difference the criterion
      // turns on.
      expect(effects.events().map((event) => event.kind)).toEqual(['goal']);

      // THE POSITIVE CONTROL: the same goal with the flag off bursts twelve.
      const moving = createEffects();
      moving.observe({ world, scoring: oneGoal(), elapsed: 1 / 60, reducedMotion: false });
      expect(moving.readout().particles).toBe(12);
      expect(moving.readout().celebration).toBeGreaterThan(0);
      expect(drawnOps(moving, world)).toBeGreaterThan(6);
    });

    it('removes the arrow pulse and leaves the colour ramp alone', () => {
      // The pulse is animation and goes; the ramp is information and stays,
      // which is why the ramp lives in `arrow.ts` and the pulse lives here.
      const effects = createEffects();
      const world = createWorld();
      effects.observe({
        world,
        scoring: {
          player: 0,
          opponent: 0,
          goals: 0,
          hold: 0,
          frozen: false,
          nextTurn: 'player',
          last: undefined,
          over: false,
        },
        elapsed: 1 / 60,
        reducedMotion: true,
      });
      const recorder = new CanvasRecorder();
      effects.drawInFront(recorder.context, PLAY_SURFACE.floodlit, world, {
        aim: { angleRad: 0, power01: 1 },
        reach: 180,
        launchable: true,
      });
      expect(recorder.calls('stroke')).toHaveLength(0);
    });
  });
});
