import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createWorld, kickoff, setVelocity } from '../../src/core/bodies';
import type { World } from '../../src/core/bodies';
import {
  BALL_RADIUS,
  CIRCLE_RADIUS,
  DELTA_CEILING,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  GOAL_FRAME_DEPTH,
  GOAL_OPENING_HIGH,
  GOAL_OPENING_LOW,
  LOGICAL_HEIGHT,
  RESUME_GAP,
  WALL_THICKNESS,
} from '../../src/core/config';
import type { ScoringReadout } from '../../src/core/goals';
import { createSimulation } from '../../src/core/physics';
import { set } from '../../src/core/vec2';
import { aimFromDrag } from '../../src/core/aiming';
import {
  EFFECT_SECONDS,
  EFFECTS_SEED,
  FLASHES_PER_WINDOW,
  FLASH_WINDOW_SECONDS,
  HARD_IMPACT_ENERGY,
  SHAKE_DECAY_PER_SECOND,
  SHAKE_ENERGY_SCALE,
  SHAKE_HEIGHT_FRACTION,
  createEffects,
  effectSeconds,
  elapsedFor,
  goalFrameOf,
  impactEnergy,
  pairContact,
  regionOf,
  shakeMagnitude,
  wallBandsOf,
  wallContact,
} from '../../src/render/effects';
import type {
  BodySample,
  Effects,
  EffectsFrame,
  EffectsReadout,
  WallBand,
} from '../../src/render/effects';
import { arrowGeometry, arrowPath, drawAimArrow, traceArrow } from '../../src/render/arrow';
import { drawFrame, drawVignette } from '../../src/render/pitch';
import type { PitchCacheCell, PitchLayer } from '../../src/render/pitch';
import { attachSurface, backingRatio, resizeSurface } from '../../src/render/surface';
import { PLAY_SURFACE } from '../../src/render/tokens';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';

/**
 * Armour for SPEC section 14's motion set, item E5.
 *
 * ARMOUR, NOT CLOSURE: E5 is a demonstration item and closes by the scripted
 * capture produced at the demonstration session, not by anything here. What
 * automation can reach, this file pins: that each of the six motions the
 * criterion enumerates exists and is derived from the thing the section says
 * derives it, that the shake carries both of SPEC section 14's terms with the
 * cap expressed as a fraction of the rendered height, that the flash limiter
 * enforces SC 2.3.1 under a burst no physics would produce by accident, and
 * that the one decaying quantity decays per second rather than per frame.
 *
 * THE SIX CLAUSES, and where each is asserted below:
 *
 *   arrow colour ramp          `arrow.ts` and tests/unit/arrow-geometry.test.ts
 *                              own the ramp; the MAXIMUM PULSE is here
 *   speed-proportional trail   "the trail is exactly the distance the ball
 *                              covered inside the window"
 *   impact flash               "a hard collision flashes at the contact point"
 *   energy-scaled capped shake "both terms of the shake" and the two displays
 *   wall-segment flash         "a wall bounce flashes the struck band"
 *   goal celebration           "a goal pulses its own frame and bursts"
 *
 * NOTHING HERE READS THE CODE'S OWN CONSTANTS AS ITS EXPECTATION. Every
 * threshold is a literal, because asserting a bound against the symbol that
 * defines it passes for whatever value the symbol takes.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const EFFECTS_SOURCE = path.join(PROJECT_ROOT, 'src', 'render', 'effects.ts');
const RENDER_ROOT = path.join(PROJECT_ROOT, 'src', 'render');

/**
 * The platform generator SPEC section 6 bans, in the shapes it can be spelt.
 *
 * THE BRACKET FORM IS A CALL LIKE ANY OTHER, and the M3 lint rule refuses it by
 * name inside `core/`: a computed key is a route to the same function, so
 * `Math["random"]()` planted in a render module passed a scan that knew only
 * the dotted spelling. `globalThis.Math.random()` needs no branch of its own,
 * because the dotted spelling is inside it. All three quotings of the key are
 * matched, and the boundary after the name keeps `Math.randomise` out.
 *
 * TWO ROUTES ARE DELIBERATELY NOT MATCHED, with their reason: an ALIAS
 * (`const M = Math`) and a COMPUTED key read from a variable (`Math[key]`).
 * Neither can be settled by reading text - following an alias is scope
 * analysis, and a variable key is not in the source at all - which is exactly
 * why the lint rule that owns `core/` is written over the syntax tree and
 * reports every capture of the bare object. This scan covers the renderer,
 * where the discipline is stated rather than lint-enforced, so it matches the
 * spellings that CALL the function and says so rather than implying more.
 */
const PLATFORM_GENERATOR = /Math\s*(?:\.\s*random(?![\w$])|\[\s*(['"`])random\1\s*\])/;

/**
 * Every module that draws, which is what the scan below covers.
 *
 * WHY IT IS THE WHOLE RENDER LAYER AND THE ROOT. Expensive rule 5 and SPEC
 * section 6 scope the ban to `core/`, and the lint boundary enforces it there;
 * this file's own subject states the same discipline for the renderer ("the
 * lint boundary does not police `render/`, so the discipline is stated here
 * and pinned by a test that scans this file"), and the scan honoured that for
 * `effects.ts` alone. Planted in `pitch.ts`, `entities.ts`, `input.ts` or the
 * composition root, a platform draw passed everything. Item `E7`'s visual
 * baselines compare at a threshold of zero, so a renderer-side platform draw
 * would first surface as an unexplained baseline flake, which is the hardest
 * place there is to diagnose it.
 *
 * The list is written out AND checked against the directory, so a render
 * module added tomorrow is a red rather than a file the scan never opens, and
 * a name removed from the list is a red rather than a hole.
 */
/**
 * Every module under a directory, at any depth, by its path relative to it.
 * A directory the walk never opens is a file the scan never reads, and a
 * two-way reconciliation is satisfied by a file that is missing from both
 * sides, so the recursion is part of the gate rather than a convenience.
 */
function modulesUnder(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of modulesUnder(path.join(root, entry.name))) {
        found.push(`${entry.name}/${nested}`);
      }
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      found.push(entry.name);
    }
  }
  return found;
}

const MODULES_THAT_DRAW: readonly string[] = [
  'src/main.ts',
  'src/render/arrow.ts',
  'src/render/capture.ts',
  'src/render/effects.ts',
  'src/render/entities.ts',
  'src/render/guide.ts',
  'src/render/input.ts',
  'src/render/pitch.ts',
  'src/render/surface.ts',
  'src/render/tokens.ts',
];

/** Block and line comments replaced by spaces, so a scan reads code only. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** A scoreboard with nothing on it, for a frame that is not about a goal. */
const NO_GOALS: ScoringReadout = {
  player: 0,
  opponent: 0,
  goals: 0,
  hold: 0,
  frozen: false,
  nextTurn: 'player',
  last: undefined,
  over: false,
};

/** A scoreboard reporting one goal into a named mouth. */
function oneGoal(mouth: 'left' | 'right'): ScoringReadout {
  return {
    player: mouth === 'right' ? 1 : 0,
    opponent: mouth === 'left' ? 1 : 0,
    goals: 1,
    hold: 144,
    frozen: true,
    nextTurn: 'player',
    last: {
      scorer: mouth === 'right' ? 'player' : 'opponent',
      conceded: mouth === 'right' ? 'opponent' : 'player',
      mouth,
      step: 1,
    },
    over: false,
  };
}

/** One observation of a world nothing is happening in. */
function tick(effects: Effects, world: World, elapsed: number): void {
  effects.observe({ world, scoring: NO_GOALS, elapsed, reducedMotion: false });
}

/**
 * A hand-built collision, so an energy is the SAME number at every frame rate
 * the control below drives. The bodies meet head on with equal masses, which
 * SPEC section 6.1 makes an exchange of the normal components, so each one's
 * velocity changes by the closing speed and the energy is that speed exactly.
 */
function stagedImpact(
  effects: Effects,
  closingSpeed: number,
  elapsed: number,
  atX = 500,
  atY = 360,
): World {
  const world = createWorld();
  const gap = CIRCLE_RADIUS + BALL_RADIUS;
  set(world.opponent.position, FIELD_LEFT, FIELD_BOTTOM);
  set(world.player.position, atX, atY);
  set(world.ball.position, atX + gap + closingSpeed * elapsed, atY);
  setVelocity(world.player, closingSpeed, 0);
  effects.observe({ world, scoring: NO_GOALS, elapsed, reducedMotion: false });
  // The frame the meeting happened in: the pair is exactly touching, the
  // player has handed its whole velocity over, and the ball carries it away.
  set(world.player.position, atX + closingSpeed * elapsed, atY);
  set(world.ball.position, atX + closingSpeed * elapsed + gap, atY);
  setVelocity(world.player, 0, 0);
  setVelocity(world.ball, closingSpeed, 0);
  effects.observe({ world, scoring: NO_GOALS, elapsed, reducedMotion: false });
  // Everything stops, so no later frame derives an event of its own.
  setVelocity(world.ball, 0, 0);
  return world;
}

/** A surface and a current layer, at one scale, for the pass-order census. */
function frameFixture(): {
  recorder: CanvasRecorder;
  surface: ReturnType<typeof attachSurface>;
  cache: PitchCacheCell;
} {
  const recorder = new CanvasRecorder();
  const surface = attachSurface(asCanvas(fakeCanvas(recorder)));
  surface.scale = 1;
  surface.canvas.width = 1280;
  surface.canvas.height = 720;
  surface.cssHeight = 720;
  const layerCanvas = fakeCanvas(new CanvasRecorder());
  layerCanvas.width = 1280;
  layerCanvas.height = 720;
  const layer: PitchLayer = {
    canvas: asCanvas(layerCanvas),
    scale: 1,
    palette: PLAY_SURFACE.floodlit,
  };
  return { recorder, surface, cache: { current: layer } };
}

describe('PF-12 the motion set, item E5', () => {
  describe('SPEC section 14 tunable block, pinned by literal', () => {
    it('carries the section constants, in seconds', () => {
      expect(EFFECT_SECONDS.ballTrail).toBe(0.18);
      expect(EFFECT_SECONDS.impactFlash).toBe(0.12);
      expect(EFFECT_SECONDS.wallFlash).toBe(0.15);
      expect(EFFECT_SECONDS.screenShake).toBe(0.2);
      expect(EFFECT_SECONDS.goalCelebration).toBe(1.2);
      expect(Object.keys(EFFECT_SECONDS)).toHaveLength(5);
    });

    it('carries the shake terms and the hard-collision floor', () => {
      expect(SHAKE_ENERGY_SCALE).toBe(0.004);
      expect(SHAKE_HEIGHT_FRACTION).toBe(0.015);
      expect(HARD_IMPACT_ENERGY).toBe(150);
      expect(FLASHES_PER_WINDOW).toBe(3);
      expect(FLASH_WINDOW_SECONDS).toBe(1);
    });

    it('derives the decay constant from the window it has to cross', () => {
      // A hundredth of the peak survives SPEC section 14's 0.20 s, which is
      // what makes the cut at the end of the window invisible rather than a
      // step. The relation is the reason the constant has the value it has.
      expect(SHAKE_DECAY_PER_SECOND).toBe(1e-10);
      expect(SHAKE_DECAY_PER_SECOND ** 0.2).toBeCloseTo(0.01, 12);
    });

    it('resolves every step, and every step to zero under reduced motion', () => {
      const steps = ['ballTrail', 'impactFlash', 'wallFlash', 'screenShake', 'goalCelebration'] as const;
      for (const step of steps) {
        expect(effectSeconds(step, false), step).toBe(EFFECT_SECONDS[step]);
        expect(effectSeconds(step, true), step).toBe(0);
      }
      expect(steps).toHaveLength(Object.keys(EFFECT_SECONDS).length);
    });
  });

  describe('the effects clock reads a delta the way the simulation does', () => {
    it('takes QUALITY-BAR section 7 readings, all four', () => {
      expect(elapsedFor(1 / 60)).toBe(1 / 60);
      expect(elapsedFor(-1)).toBe(0);
      expect(elapsedFor(Number.NaN)).toBe(0);
      expect(elapsedFor(Number.POSITIVE_INFINITY)).toBe(0);
      // The ceiling, and the resume above it, at the literals section 7 states.
      expect(elapsedFor(0.4)).toBe(0.25);
      expect(elapsedFor(6)).toBe(0);
      expect(DELTA_CEILING).toBe(0.25);
      expect(RESUME_GAP).toBe(5);
    });
  });

  describe('the shake carries both of the section terms', () => {
    it('scales with impact energy until the cap binds', () => {
      // The energy term, in rendered pixels, on a surface tall enough that the
      // cap cannot bind: 0.004 rendered pixels per unit of velocity change.
      expect(shakeMagnitude(500, 720)).toBeCloseTo(2, 12);
      expect(shakeMagnitude(1000, 720)).toBeCloseTo(4, 12);
      // Twice the energy is twice the shake, which is what "scaled by impact
      // energy" means and what a constant magnitude would still pass without.
      expect(shakeMagnitude(1000, 720) / shakeMagnitude(500, 720)).toBeCloseTo(2, 12);
    });

    it('caps at one and a half percent of the RENDERED height', () => {
      // A tall surface: the cap is 10.8 rendered pixels, and the largest
      // closing speed the simulation can produce is two bodies at the cap.
      expect(shakeMagnitude(2400, 720)).toBeCloseTo(9.6, 12);
      expect(shakeMagnitude(1e9, 720)).toBeCloseTo(10.8, 12);
      // A short one: the same stimulus is capped harder, which is the whole
      // reason the ceiling is a fraction of the height rather than a count.
      expect(shakeMagnitude(1e9, 200)).toBeCloseTo(3, 12);
      expect(shakeMagnitude(2400, 200)).toBeCloseTo(3, 12);
    });

    it('does not grow the same stimulus on a larger display', () => {
      // The energy term is a rendered-pixel count, so a display twice the size
      // shakes by the same number of pixels until its larger cap is reached.
      expect(shakeMagnitude(500, 400)).toBe(shakeMagnitude(500, 1600));
      // And the cap does scale with the display, or a small surface would be
      // shaken by a far larger share of itself than a big one.
      expect(shakeMagnitude(1e9, 1600) / shakeMagnitude(1e9, 400)).toBeCloseTo(4, 12);
    });

    it('refuses a nonsense energy or a collapsed surface', () => {
      expect(shakeMagnitude(Number.NaN, 720)).toBe(0);
      expect(shakeMagnitude(-500, 720)).toBe(0);
      expect(shakeMagnitude(500, 0)).toBe(0);
      expect(shakeMagnitude(500, Number.NaN)).toBe(0);
    });
  });

  describe('impact energy is the velocity change the meeting produced', () => {
    it('measures the change and not the speed', () => {
      expect(impactEnergy(600, 0, 0, 0)).toBe(600);
      expect(impactEnergy(600, 0, -600, 0)).toBe(1200);
      expect(impactEnergy(0, 0, 300, 400)).toBe(500);
      // A body that only slowed by damping released nothing worth marking.
      expect(impactEnergy(600, 0, 590, 0)).toBe(10);
    });
  });

  describe('the ball trail is proportional to speed', () => {
    it('is exactly the distance the ball covered inside the window', () => {
      // Ten segments survive at sixty frames a second: an eleventh sample is
      // 0.1833 s old against SPEC section 14's 0.18 s window and is dropped.
      // The trail is therefore the distance covered in ten frames, which is
      // the speed times one sixth of a second.
      const measure = (speed: number): number => {
        const effects = createEffects();
        const world = createWorld();
        setVelocity(world.ball, speed, 0);
        for (let frame = 0; frame < 30; frame += 1) {
          set(world.ball.position, 300 + (speed * frame) / 60, 360);
          tick(effects, world, 1 / 60);
        }
        return effects.readout().trailLength;
      };
      expect(measure(600)).toBeCloseTo(100, 9);
      expect(measure(1200)).toBeCloseTo(200, 9);
      expect(measure(1200) / measure(600)).toBeCloseTo(2, 9);
    });

    it('has no length at all while the ball is at rest', () => {
      const effects = createEffects();
      const world = createWorld();
      for (let frame = 0; frame < 30; frame += 1) {
        tick(effects, world, 1 / 60);
      }
      expect(effects.readout().trailLength).toBe(0);
      expect(effects.readout().trailSamples).toBeGreaterThan(1);
    });

    it('drops every sample older than the window and keeps the rest', () => {
      const effects = createEffects();
      const world = createWorld();
      setVelocity(world.ball, 60, 0);
      for (let frame = 0; frame < 40; frame += 1) {
        set(world.ball.position, 300 + frame, 360);
        tick(effects, world, 1 / 60);
      }
      expect(effects.readout().trailSamples).toBe(11);
    });
  });

  describe('a hard collision flashes at the contact point and shakes', () => {
    it('derives the impact from a real launch through the real physics', () => {
      const effects = createEffects();
      const simulation = createSimulation();
      // The opponent is moved off the line so the only meeting is the one
      // being measured.
      set(simulation.world.opponent.position, 980, 600);
      setVelocity(simulation.world.player, 900, 0);
      let frames = 0;
      for (let frame = 0; frame < 60; frame += 1) {
        simulation.update(1 / 60);
        effects.observe({
          world: simulation.world,
          scoring: simulation.scoring.readout(),
          elapsed: 1 / 60,
          reducedMotion: false,
        });
        frames += 1;
        if (effects.readout().impactFlashes > 0) {
          break;
        }
      }
      // The meeting happened partway through the flight rather than on the
      // first frame, so the detection is of a collision and not of a launch.
      expect(frames).toBeGreaterThan(10);
      expect(frames).toBeLessThan(60);
      const impacts = effects.events().filter((event) => event.kind === 'impact');
      expect(impacts).toHaveLength(1);
      const meeting = impacts[0];
      // The contact point is on the player's own rim, on the line to the ball,
      // which is where SPEC section 14 puts the flash.
      expect(meeting?.x).toBeGreaterThan(500);
      expect(meeting?.x).toBeLessThan(640);
      expect(meeting?.y).toBeCloseTo(360, 6);
      expect(meeting?.admitted).toBe(true);
      // The player was travelling at 900 and had damped to roughly 570 by the
      // time it arrived, and an equal-mass head-on meeting hands all of it
      // over, so the energy is that order and comfortably a hard collision.
      expect(meeting?.energy).toBeGreaterThan(400);
      expect(meeting?.energy).toBeLessThan(700);
      expect(effects.readout().impactFlashes).toBe(1);
      // And the surface answered it.
      expect(effects.shake(720).x).not.toBe(0);
    });

    it('refuses a meeting softer than the weakest legal shot', () => {
      const effects = createEffects();
      stagedImpact(effects, 100, 1 / 60);
      const impacts = effects.events().filter((event) => event.kind === 'impact');
      expect(impacts).toHaveLength(1);
      expect(impacts[0]?.energy).toBeCloseTo(100, 9);
      expect(impacts[0]?.admitted).toBe(false);
      expect(effects.readout().impactFlashes).toBe(0);
      expect(effects.shake(720)).toEqual({ x: 0, y: 0 });
      // The positive control: the same staging one unit over the floor is a
      // hard collision, so the refusal above is the threshold and not a
      // detector that never fires.
      const harder = createEffects();
      stagedImpact(harder, 151, 1 / 60);
      expect(harder.readout().impactFlashes).toBe(1);
      expect(harder.shake(720).x).not.toBe(0);
    });

    it('never fires on a pair that passes close without meeting', () => {
      const effects = createEffects();
      const world = createWorld();
      set(world.opponent.position, FIELD_RIGHT - CIRCLE_RADIUS, FIELD_TOP - CIRCLE_RADIUS);
      // The player crosses the ball's line a clear diameter away, at speed.
      for (let frame = 0; frame < 30; frame += 1) {
        set(world.player.position, 300 + frame * 20, 360 - 200);
        setVelocity(world.player, 1200, 0);
        tick(effects, world, 1 / 60);
      }
      expect(effects.events()).toEqual([]);
    });

    it('refuses a pair that is overlapping and still closing', () => {
      // One frame before the solver pushes them apart, the pair is inside the
      // sum of its radii and still approaching. The closest approach is inside
      // the radii and the gap is nothing, so the separation signature is the
      // only thing that says the meeting has not finished happening.
      const effects = createEffects();
      const world = createWorld();
      set(world.opponent.position, FIELD_LEFT, FIELD_BOTTOM);
      set(world.player.position, 500, 360);
      set(world.ball.position, 560, 360);
      setVelocity(world.player, 600, 0);
      effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
      set(world.player.position, 510, 360);
      effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
      expect(effects.events()).toEqual([]);

      // THE POSITIVE CONTROL: the next frame, with the ball carrying the
      // velocity away, is the meeting.
      set(world.player.position, 512, 360);
      setVelocity(world.player, 0, 0);
      setVelocity(world.ball, 600, 0);
      effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
      expect(effects.events().map((event) => event.kind)).toEqual(['impact']);
    });

    it('refuses a clean miss even when a clamped frame widens the reach', () => {
      // The reach gate alone admits this: over a quarter of a second the pair
      // closes far more than the gap it ends with, and damping alone changes a
      // velocity by more than the hard-collision floor, so the energy gate
      // does not save it either. Two bodies passing each other ALWAYS cross
      // from closing to separating at their closest approach, so the signature
      // does not save it. Only the closest approach itself does.
      // Seventy units off the ball's line, so the pair misses by eighteen. The
      // player crosses from in front of the ball to behind it inside the one
      // frame, travelling the hundred and fifty-one units a quarter of a second
      // at 680 actually buys after damping, so it moved rather than being
      // placed; it was closing and is now separating; and the gap it ends with
      // is well inside a frame of that speed. Every gate but the closest
      // approach admits this, and the closest approach is seventy.
      const effects = createEffects();
      const world = createWorld();
      set(world.opponent.position, FIELD_LEFT, FIELD_BOTTOM);
      set(world.player.position, 560, 360 - 70);
      set(world.ball.position, 640, 360);
      setVelocity(world.player, 680, 0);
      effects.observe({ world, scoring: NO_GOALS, elapsed: 0.25, reducedMotion: false });
      set(world.player.position, 560 + 151, 360 - 70);
      setVelocity(world.player, 508, 0);
      effects.observe({ world, scoring: NO_GOALS, elapsed: 0.25, reducedMotion: false });
      expect(effects.events()).toEqual([]);
      expect(effects.shake(720)).toEqual({ x: 0, y: 0 });

      // THE POSITIVE CONTROL, same clamped frame, same speeds, on the ball's
      // own line: a real meeting under a hitch is still a meeting.
      const met = createEffects();
      const hit = createWorld();
      set(hit.opponent.position, FIELD_LEFT, FIELD_BOTTOM);
      // A hundred and fifty-one units of travel is what 680 buys in a quarter
      // of a second after damping, so the meeting is one the frame contains.
      set(hit.player.position, 640 - 52 - 151, 360);
      set(hit.ball.position, 640, 360);
      setVelocity(hit.player, 680, 0);
      met.observe({ world: hit, scoring: NO_GOALS, elapsed: 0.25, reducedMotion: false });
      set(hit.player.position, 640 - 52, 360);
      setVelocity(hit.player, 0, 0);
      setVelocity(hit.ball, 508, 0);
      met.observe({ world: hit, scoring: NO_GOALS, elapsed: 0.25, reducedMotion: false });
      expect(met.events().map((event) => event.kind)).toEqual(['impact']);
      expect(met.readout().impactFlashes).toBe(1);
    });

    it('derives nothing from a frame a body was placed in rather than moved through', () => {
      // SPEC section 6.4 puts all three bodies back on their marks when the
      // celebration hold expires. Compared against the sample before it, that
      // is three bodies crossing the pitch in one frame: a contact the physics
      // never resolved, a wall bounce that never happened, and a trail drawn
      // from the net to the centre spot.
      const effects = createEffects();
      const world = createWorld();
      set(world.ball.position, FIELD_RIGHT + 20, 360);
      setVelocity(world.ball, 40, 0);
      tick(effects, world, 1 / 60);
      set(world.ball.position, FIELD_RIGHT + 20.6, 360);
      tick(effects, world, 1 / 60);
      expect(effects.readout().trailSamples).toBe(2);
      // The kickoff, in place, exactly as `core/bodies.ts` performs it.
      kickoff(world);
      tick(effects, world, 1 / 60);
      expect(effects.events()).toEqual([]);
      expect(effects.readout().trailSamples).toBe(1);
      expect(effects.readout().trailLength).toBe(0);
      // And the frame after the placement derives normally again.
      setVelocity(world.ball, 600, 0);
      set(world.ball.position, 650, 360);
      tick(effects, world, 1 / 60);
      expect(effects.readout().trailSamples).toBe(2);
    });
  });

  describe('a wall bounce flashes the struck segment', () => {
    it('derives the bounce from the real containment and reflection', () => {
      const effects = createEffects();
      const simulation = createSimulation();
      set(simulation.world.opponent.position, 980, 600);
      setVelocity(simulation.world.ball, 0, 600);
      for (let frame = 0; frame < 60; frame += 1) {
        simulation.update(1 / 60);
        effects.observe({
          world: simulation.world,
          scoring: simulation.scoring.readout(),
          elapsed: 1 / 60,
          reducedMotion: false,
        });
        if (effects.readout().wallFlashes > 0) {
          break;
        }
      }
      const bounces = effects.events().filter((event) => event.kind === 'wall');
      expect(bounces.length).toBeGreaterThanOrEqual(1);
      const first = bounces[0];
      // The contact is recorded ON the wall the section says flashes, which is
      // the top bound, and at the x the ball met it.
      expect(first?.y).toBe(FIELD_TOP);
      expect(first?.x).toBeCloseTo(640, 6);
      expect(first?.admitted).toBe(true);
      // Restitution is 0.92, so the change is 1.92 times the arriving speed,
      // and the arrival is well under the launch speed after damping: the
      // ball leaves at 600 and arrives at roughly 307, so the change is near
      // 589 and cannot reach the 1152 an undamped arrival would give.
      expect(first?.energy).toBeGreaterThan(500);
      expect(first?.energy).toBeLessThan(1152);
    });

    it('draws the struck band and nothing wider than one spacing step', () => {
      const effects = createEffects();
      const simulation = createSimulation();
      set(simulation.world.opponent.position, 980, 600);
      setVelocity(simulation.world.ball, 0, 600);
      for (let frame = 0; frame < 60; frame += 1) {
        simulation.update(1 / 60);
        effects.observe({
          world: simulation.world,
          scoring: simulation.scoring.readout(),
          elapsed: 1 / 60,
          reducedMotion: false,
        });
        if (effects.readout().wallFlashes > 0) {
          break;
        }
      }
      const recorder = new CanvasRecorder();
      effects.drawBehind(recorder.context, PLAY_SURFACE.floodlit);
      const band = recorder.calls('fillRect').at(-1)?.args ?? [];
      // The top band as pitch.ts draws it: at the field's top bound, one wall
      // thickness deep, one spacing step across, centred on the contact.
      expect(band[1]).toBe(FIELD_TOP);
      expect(band[2]).toBe(64);
      expect(band[3]).toBe(WALL_THICKNESS);
      expect(Number(band[0])).toBeCloseTo(640 - 32, 6);
      expect(recorder.values('fillStyle')).toContain(PLAY_SURFACE.floodlit.line);
      // The alpha is handed back, or every later pass would inherit it.
      expect(recorder.values('globalAlpha').at(-1)).toBe(1);
    });

    it('draws no band where the goal opening leaves no wall to draw', () => {
      // The reviewer's case, and the most ordinary shot in the game: the
      // player circle is contained by the side wall along the whole of it,
      // including the mouth, so it bounces where `pitch.ts` drew no wall. A
      // band centred on that contact would be a solid bar across an open goal.
      const effects = createEffects();
      const simulation = createSimulation();
      set(simulation.world.opponent.position, 980, 600);
      setVelocity(simulation.world.player, -900, 0);
      for (let frame = 0; frame < 120; frame += 1) {
        simulation.update(1 / 60);
        effects.observe({
          world: simulation.world,
          scoring: simulation.scoring.readout(),
          elapsed: 1 / 60,
          reducedMotion: false,
        });
        if (effects.readout().wallFlashes > 0) {
          break;
        }
      }
      const bounce = effects.events().find((event) => event.kind === 'wall');
      expect(bounce?.x).toBe(FIELD_LEFT);
      expect(bounce?.y).toBeCloseTo(360, 6);
      // A real bounce, recorded and admitted, and nothing drawn for it.
      expect(effects.readout().wallFlashes).toBe(1);
      const recorder = new CanvasRecorder();
      effects.drawBehind(recorder.context, PLAY_SURFACE.floodlit);
      expect(recorder.calls('fillRect')).toHaveLength(0);
    });

    it('clips the band to the wall pieces the pitch actually draws', () => {
      // Straight arithmetic on the bands, because the physics cannot put a
      // contact at every interesting y. The opening runs 265 to 455 and the
      // side wall is drawn either side of it.
      const at = (y: number, wall: 'left' | 'right'): readonly WallBand[] =>
        wallBandsOf({ x: wall === 'left' ? FIELD_LEFT : FIELD_RIGHT, y, at: 0, life: 1, wall });
      // Deep inside the mouth: nothing is drawn there, so nothing flashes.
      expect(at(360, 'left')).toEqual([]);
      expect(at(360, 'right')).toEqual([]);
      // Straddling the low post: the half below the opening, and only it.
      const post = at(GOAL_OPENING_LOW, 'left');
      expect(post).toHaveLength(1);
      expect(post[0]).toEqual({
        x: FIELD_LEFT - WALL_THICKNESS,
        y: GOAL_OPENING_LOW - 32,
        width: WALL_THICKNESS,
        height: 32,
      });
      // Well below it: the whole span, one spacing step of it.
      const clear = at(200, 'left');
      expect(clear).toHaveLength(1);
      expect(clear[0]?.height).toBe(64);
      expect(clear[0]?.y).toBe(168);
      // The right wall's band sits on the other side of the field bound.
      expect(at(200, 'right')[0]?.x).toBe(FIELD_RIGHT);
      // And an end wall is one band across, unaffected by the opening.
      const top = wallBandsOf({ x: 640, y: FIELD_TOP, at: 0, life: 1, wall: 'top' });
      expect(top).toEqual([
        { x: 608, y: FIELD_TOP, width: 64, height: WALL_THICKNESS },
      ]);
    });
  });

  describe('a goal celebrates', () => {
    it('pulses the scoring frame and bursts from primitives', () => {
      const effects = createEffects();
      const world = createWorld();
      tick(effects, world, 1 / 60);
      effects.observe({
        world,
        scoring: oneGoal('right'),
        elapsed: 1 / 60,
        reducedMotion: false,
      });
      const goals = effects.events().filter((event) => event.kind === 'goal');
      expect(goals).toHaveLength(1);
      const readout = effects.readout();
      expect(readout.particles).toBe(12);
      expect(readout.celebration).toBeCloseTo(1.2, 9);

      const recorder = new CanvasRecorder();
      effects.drawInFront(recorder.context, PLAY_SURFACE.floodlit, world.player, null);
      // The frame that was scored in, and only that one: the right mouth sits
      // outside the right field bound, at the opening's own extent.
      const pulse = recorder.calls('strokeRect').at(-1)?.args ?? [];
      expect(pulse).toEqual([
        FIELD_RIGHT,
        GOAL_OPENING_LOW,
        GOAL_FRAME_DEPTH,
        GOAL_OPENING_HIGH - GOAL_OPENING_LOW,
      ]);
      expect(goalFrameOf('left').x).toBe(FIELD_LEFT - GOAL_FRAME_DEPTH);
      // Twelve particles, each an arc, each in the accent token.
      expect(recorder.calls('arc')).toHaveLength(12);
      expect(recorder.values('fillStyle')).toContain(PLAY_SURFACE.floodlit.accent);
      expect(recorder.values('globalAlpha').at(-1)).toBe(1);
    });

    it('celebrates the conceding end when the other mouth is scored in', () => {
      const effects = createEffects();
      const world = createWorld();
      tick(effects, world, 1 / 60);
      effects.observe({ world, scoring: oneGoal('left'), elapsed: 1 / 60, reducedMotion: false });
      const recorder = new CanvasRecorder();
      effects.drawInFront(recorder.context, PLAY_SURFACE.floodlit, world.player, null);
      expect(recorder.calls('strokeRect').at(-1)?.args[0]).toBe(FIELD_LEFT - GOAL_FRAME_DEPTH);
    });

    it('takes a real goal off the real physics, and calls no wall on the way', () => {
      const effects = createEffects();
      const simulation = createSimulation();
      // The opponent off the line and the ball struck along it, hard enough to
      // clear the mouth: SPEC section 6.4 makes the side walls transparent to
      // a ball that fits the opening, so the pass through is not a bounce.
      set(simulation.world.opponent.position, 980, 600);
      setVelocity(simulation.world.ball, 900, 0);
      for (let frame = 0; frame < 300; frame += 1) {
        simulation.update(1 / 60);
        effects.observe({
          world: simulation.world,
          scoring: simulation.scoring.readout(),
          elapsed: 1 / 60,
          reducedMotion: false,
        });
      }
      expect(simulation.scoring.readout().goals).toBe(1);
      const kinds = effects.events().map((event) => event.kind);
      expect(kinds).toContain('goal');
      // Not one wall event: the ball went through the mouth rather than off a
      // wall, and it lies in the net at rest for the whole celebration hold.
      expect(kinds.filter((kind) => kind === 'wall')).toEqual([]);
    });

    it('calls no wall on a ball that stopped in the mouth it was rolling into', () => {
      // SPEC section 6.4 makes the side walls transparent to a ball that fits
      // the opening, so a ball that came to rest in front of one never touched
      // a wall. Without the predicate this frame reads as a right-wall bounce:
      // the normal component went from positive to zero and the ball is inside
      // one frame's travel of the bound, which is the whole of the wall test.
      const effects = createEffects();
      const world = createWorld();
      set(world.opponent.position, FIELD_LEFT, FIELD_BOTTOM);
      set(world.player.position, FIELD_LEFT, FIELD_TOP);
      set(world.ball.position, FIELD_RIGHT - BALL_RADIUS - 1, 360);
      setVelocity(world.ball, 60, 0);
      tick(effects, world, 1 / 60);
      set(world.ball.position, FIELD_RIGHT - BALL_RADIUS, 360);
      setVelocity(world.ball, 0, 0);
      tick(effects, world, 1 / 60);
      expect(effects.events()).toEqual([]);

      // THE POSITIVE CONTROL: the same approach off the ball's own line, where
      // the opening does not fit it, IS a wall bounce.
      const solid = createEffects();
      const blocked = createWorld();
      set(blocked.opponent.position, FIELD_LEFT, FIELD_BOTTOM);
      set(blocked.player.position, FIELD_LEFT, FIELD_TOP);
      set(blocked.ball.position, FIELD_RIGHT - BALL_RADIUS - 1, GOAL_OPENING_LOW - 40);
      setVelocity(blocked.ball, 60, 0);
      tick(solid, blocked, 1 / 60);
      set(blocked.ball.position, FIELD_RIGHT - BALL_RADIUS, GOAL_OPENING_LOW - 40);
      setVelocity(blocked.ball, 0, 0);
      tick(solid, blocked, 1 / 60);
      expect(solid.events().map((event) => event.kind)).toEqual(['wall']);
    });

    it('sees the collision at a frame rate that steps the world unevenly', () => {
      // DESIGN section 2 consumes a frame in whole fixed steps and carries the
      // remainder, so at 240 frames a second the world advances by a whole
      // step on every other frame and by nothing on the rest. A bound taken
      // from the frame's own delta is then half the distance the bodies
      // covered, and every real meeting is refused. Found by a browser test on
      // an engine that runs its frames at that rate, pinned here.
      const effects = createEffects();
      const simulation = createSimulation();
      set(simulation.world.opponent.position, 980, 600);
      setVelocity(simulation.world.player, 900, 0);
      for (let frame = 0; frame < 240; frame += 1) {
        simulation.update(1 / 240);
        effects.observe({
          world: simulation.world,
          scoring: simulation.scoring.readout(),
          elapsed: 1 / 240,
          reducedMotion: false,
        });
        if (effects.readout().impactFlashes > 0) {
          break;
        }
      }
      expect(effects.events().filter((event) => event.kind === 'impact')).toHaveLength(1);
      expect(effects.readout().impactFlashes).toBe(1);
      expect(effects.shake(720).x).not.toBe(0);
    });

    it('measures the shake against the height the surface renders at', () => {
      // The one place the device pixel ratio is recovered, and the one field it
      // is recovered from. A surface sized at 640 CSS pixels wide on a display
      // at twice the density has a 720-pixel backing store and a 360-pixel
      // rendered height, so SPEC section 14's cap is 5.4 CSS pixels there and
      // 10.8 on a surface that renders at 720.
      const surface = attachSurface(asCanvas(fakeCanvas(new CanvasRecorder())));
      resizeSurface(surface, 640, 2);
      expect(surface.cssHeight).toBe(360);
      expect(surface.canvas.height).toBe(720);
      expect(backingRatio(surface)).toBe(2);
      expect(shakeMagnitude(1e9, surface.cssHeight)).toBeCloseTo(5.4, 12);
      resizeSurface(surface, 1280, 1);
      expect(surface.cssHeight).toBe(720);
      expect(backingRatio(surface)).toBe(1);
      expect(shakeMagnitude(1e9, surface.cssHeight)).toBeCloseTo(10.8, 12);
      // A surface nobody sized converts by one, because a scene drawn at no
      // size needs no conversion.
      expect(backingRatio(attachSurface(asCanvas(fakeCanvas(new CanvasRecorder()))))).toBe(1);
    });

    it('celebrates once per goal and not once per frame of the hold', () => {
      const effects = createEffects();
      const world = createWorld();
      tick(effects, world, 1 / 60);
      for (let frame = 0; frame < 20; frame += 1) {
        effects.observe({
          world,
          scoring: oneGoal('right'),
          elapsed: 1 / 60,
          reducedMotion: false,
        });
      }
      expect(effects.events().filter((event) => event.kind === 'goal')).toHaveLength(1);
      expect(effects.readout().particles).toBe(12);
    });
  });

  describe('the arrow pulses at maximum and only at maximum', () => {
    it('strokes the arrow path at full strength and leaves it alone below', () => {
      const effects = createEffects();
      const world = createWorld();
      tick(effects, world, 1 / 60);
      const full = aimFromDrag(-180, 0);
      expect(full.aim.power01).toBe(1);
      const atMaximum = new CanvasRecorder();
      effects.drawInFront(atMaximum.context, PLAY_SURFACE.floodlit, world.player, full);
      expect(atMaximum.calls('stroke')).toHaveLength(1);
      expect(atMaximum.values('strokeStyle')).toEqual([PLAY_SURFACE.floodlit.accent]);
      // Seven points, which is the arrow's own path and not a shape of its own.
      expect(atMaximum.calls('moveTo')).toHaveLength(1);
      expect(atMaximum.calls('lineTo')).toHaveLength(6);

      const below = aimFromDrag(-100, 0);
      expect(below.aim.power01).toBeLessThan(1);
      const under = new CanvasRecorder();
      effects.drawInFront(under.context, PLAY_SURFACE.floodlit, world.player, below);
      expect(under.calls('stroke')).toHaveLength(0);

      // And no aim at all draws no pulse, which is the other half of "at
      // maximum": a detector that fires on every frame is not a maximum.
      const idle = new CanvasRecorder();
      effects.drawInFront(idle.context, PLAY_SURFACE.floodlit, world.player, null);
      expect(idle.calls('stroke')).toHaveLength(0);
    });
  });

  describe('SC 2.3.1, the per-region rate limiter', () => {
    it('admits three flashes in a second and refuses the fourth', () => {
      const effects = createEffects();
      // Six hard collisions in a fifth of a second, all in one region, which
      // is a burst no rally produces and exactly what the criterion is about.
      for (let burst = 0; burst < 6; burst += 1) {
        stagedImpact(effects, 600, 1 / 60);
      }
      const impacts = effects.events().filter((event) => event.kind === 'impact');
      expect(impacts).toHaveLength(6);
      expect(impacts.filter((event) => event.admitted)).toHaveLength(3);
      expect(effects.readout().refusals).toBe(3);
    });

    it('lets the window roll rather than closing the region for good', () => {
      const effects = createEffects();
      for (let burst = 0; burst < 4; burst += 1) {
        stagedImpact(effects, 600, 1 / 60);
      }
      expect(effects.readout().refusals).toBe(1);
      // A second and a bit later the oldest three have left the window, so the
      // next flash is admitted again: a rolling window and not a fuse.
      const world = createWorld();
      for (let frame = 0; frame < 70; frame += 1) {
        tick(effects, world, 1 / 60);
      }
      stagedImpact(effects, 600, 1 / 60);
      const impacts = effects.events().filter((event) => event.kind === 'impact');
      expect(impacts.at(-1)?.admitted).toBe(true);
      expect(effects.readout().refusals).toBe(1);
    });

    it('gives a region a column away its own budget', () => {
      const effects = createEffects();
      for (let burst = 0; burst < 3; burst += 1) {
        stagedImpact(effects, 600, 1 / 60, 200, 200);
      }
      for (let burst = 0; burst < 3; burst += 1) {
        stagedImpact(effects, 600, 1 / 60, 700, 200);
      }
      // Same row, four columns apart: six flashes, none refused.
      expect(regionOf(234, 200)).not.toBe(regionOf(734, 200));
      expect(effects.readout().refusals).toBe(0);
      expect(effects.events().filter((event) => event.admitted)).toHaveLength(6);
    });

    it('gives a region a row away its own budget', () => {
      const effects = createEffects();
      for (let burst = 0; burst < 3; burst += 1) {
        stagedImpact(effects, 600, 1 / 60, 200, 200);
      }
      for (let burst = 0; burst < 3; burst += 1) {
        stagedImpact(effects, 600, 1 / 60, 200, 500);
      }
      expect(regionOf(234, 200)).not.toBe(regionOf(234, 500));
      expect(effects.readout().refusals).toBe(0);
      expect(effects.events().filter((event) => event.admitted)).toHaveLength(6);
    });

    it('counts a one-second period as a closed one', () => {
      // Onsets at 0, 0.1, 0.2 and 1.0 are four flashes inside the period from
      // 0 to 1.0. The window is closed at both ends, so the fourth is refused;
      // dropping an onset that is exactly a second old admits it.
      // An eighth of a second is exact in binary, so every time below is the
      // time it says it is and the boundary is a boundary rather than a
      // rounding. Each staged meeting takes two observations and its onset is
      // the second, so the onsets land on 0.25, 0.50, 0.75 and 1.25.
      const effects = createEffects();
      const world = createWorld();
      stagedImpact(effects, 600, 0.125);
      stagedImpact(effects, 600, 0.125);
      stagedImpact(effects, 600, 0.125);
      expect(effects.readout().now).toBe(0.75);
      expect(effects.readout().refusals).toBe(0);
      tick(effects, world, 0.125);
      tick(effects, world, 0.125);
      stagedImpact(effects, 600, 0.125);
      expect(effects.readout().now).toBe(1.25);
      // Exactly one second between the first onset and the fourth, so the
      // period from 0.25 to 1.25 would carry four flashes and the fourth is
      // refused. Dropping an onset that is exactly a second old admits it.
      expect(effects.readout().refusals).toBe(1);
    });

    it('counts regions apart, so the grid is a grid', () => {
      expect(regionOf(FIELD_LEFT, FIELD_BOTTOM)).toBe(0);
      expect(regionOf(FIELD_RIGHT, FIELD_TOP)).toBe(31);
      expect(regionOf(FIELD_LEFT, FIELD_BOTTOM)).not.toBe(regionOf(FIELD_RIGHT, FIELD_BOTTOM));
      expect(regionOf(FIELD_LEFT, FIELD_BOTTOM)).not.toBe(regionOf(FIELD_LEFT, FIELD_TOP));
      // A point outside the field belongs to the region it touches, so a
      // flash on a goal line is limited with the mouth it happened at.
      expect(regionOf(FIELD_LEFT - 1000, FIELD_BOTTOM - 1000)).toBe(0);
      expect(regionOf(Number.NaN, Number.NaN)).toBe(0);
    });
  });

  describe('the shake decays per second, never per frame', () => {
    it('agrees at three frame rates over the same elapsed time', () => {
      const measure = (rate: number): number => {
        const effects = createEffects();
        const world = stagedImpact(effects, 600, 1 / rate);
        // A tenth of a second more, which is a whole number of frames at all
        // three rates and is inside SPEC section 14's 0.20 s window.
        for (let frame = 0; frame < rate / 10; frame += 1) {
          tick(effects, world, 1 / rate);
        }
        return effects.readout().shakeEnergy;
      };
      const slow = measure(30);
      const middling = measure(60);
      const fast = measure(120);
      // Against the LITERAL, at every rate, not against each other: under the
      // per-frame form all three arms collapse to within a billionth of zero,
      // so a closeness between them passes for the defect it exists to find.
      expect(slow).toBeCloseTo(60, 9);
      expect(middling).toBeCloseTo(60, 9);
      expect(fast).toBeCloseTo(60, 9);
      expect(middling).toBeCloseTo(slow, 9);
      expect(fast).toBeCloseTo(slow, 9);

      // THE NEGATIVE CONTROL, criterion-named: the per-frame form of the same
      // constant. It is what a reviewer would write by accident, and the two
      // rates disagree by more than sixty orders of magnitude, so the check
      // above is not a check that passes for any implementation.
      const perFrame = (rate: number): number => {
        let energy = 600;
        for (let frame = 0; frame < rate / 10 + 2; frame += 1) {
          energy *= SHAKE_DECAY_PER_SECOND;
        }
        return energy;
      };
      expect(perFrame(30) / perFrame(120)).toBeGreaterThan(1e60);
      // Stated as a ratio rather than as a closeness, because both arms of the
      // wrong form are so near zero that a difference test would call them
      // equal and the control would pass for the defect it exists to find.
      expect(perFrame(30)).toBeGreaterThan(0);
      expect(perFrame(120)).toBeGreaterThan(0);
    });

    it('lands on the closed form the constant states', () => {
      const effects = createEffects();
      const world = stagedImpact(effects, 600, 1 / 60);
      for (let frame = 0; frame < 6; frame += 1) {
        tick(effects, world, 1 / 60);
      }
      // Six frames of decay at a sixtieth each, against a peak of 600: the
      // frame the shake was born in decays nothing, because the decay is taken
      // before the detection that starts it. A tenth of a second of this
      // constant is exactly a tenth of the peak.
      expect(effects.readout().shakeEnergy).toBeCloseTo(600 * SHAKE_DECAY_PER_SECOND ** 0.1, 9);
      expect(effects.readout().shakeEnergy).toBeCloseTo(60, 9);
    });

    it('is over when the window is, and is exactly zero after it', () => {
      const effects = createEffects();
      const world = stagedImpact(effects, 600, 1 / 60);
      for (let frame = 0; frame < 13; frame += 1) {
        tick(effects, world, 1 / 60);
      }
      // Thirteen frames of decay is 0.2167 s, past section 14's 0.20 s window.
      expect(effects.readout().now).toBeGreaterThan(0.2);
      expect(effects.readout().shakeEnergy).toBe(0);
      expect(effects.shake(720)).toEqual({ x: 0, y: 0 });
    });
  });

  describe('every draw comes off a seeded stream', () => {
    it('names the platform generator nowhere in any module that draws', () => {
      // Comments first, because this file's own header discusses the ban and
      // prose that quotes a name is not code that calls it. The scan is of
      // what runs. The lint boundary policies `core/` and not `render/`, so
      // this is the gate that keeps the rule true here.
      const offences: string[] = [];
      for (const relative of MODULES_THAT_DRAW) {
        const code = withoutComments(readFileSync(path.join(PROJECT_ROOT, relative), 'utf8'));
        if (PLATFORM_GENERATOR.test(code)) {
          offences.push(relative);
        }
        // A scan over an empty read passes; every module really was opened.
        expect(code.length, relative).toBeGreaterThan(500);
      }
      expect(offences).toEqual([]);
      // The positive controls: the matcher finds one when there is one, and
      // the stripper does not eat code, so a clean answer above is an answer
      // rather than a matcher or a stripper that has stopped.
      expect('const roll = Math.random();').toMatch(PLATFORM_GENERATOR);
      expect(withoutComments('/* a */ const roll = Math.random();')).toMatch(PLATFORM_GENERATOR);
      expect(withoutComments('// a\nconst roll = Math.random();')).toMatch(PLATFORM_GENERATOR);
      expect(withoutComments('/* Math.random */ const gap = 1;')).not.toMatch(PLATFORM_GENERATOR);
      // ONE CONTROL PER SPELLING THE M3 RULE REFUSES. The bracket forms are the
      // ones a scan for the dotted name cannot see, and they are a call to the
      // same function.
      expect('const roll = Math["random"]();').toMatch(PLATFORM_GENERATOR);
      expect("const roll = Math['random']();").toMatch(PLATFORM_GENERATOR);
      expect('const roll = Math[`random`]();').toMatch(PLATFORM_GENERATOR);
      expect('const roll = globalThis.Math.random();').toMatch(PLATFORM_GENERATOR);
      expect('const roll = Math [ "random" ] ();').toMatch(PLATFORM_GENERATOR);
      // And the negative controls, so the wider matcher stays off ordinary
      // code: another member of the same object, a longer name that begins
      // with this one, a key that is not this one, and a local of the name.
      expect('const top = Math.max(one, other);').not.toMatch(PLATFORM_GENERATOR);
      expect('const roll = Math.randomise();').not.toMatch(PLATFORM_GENERATOR);
      expect('const value = Math["round"](one);').not.toMatch(PLATFORM_GENERATOR);
      expect('const random = stream.next();').not.toMatch(PLATFORM_GENERATOR);
      const effects = withoutComments(readFileSync(EFFECTS_SOURCE, 'utf8'));
      expect(effects).toContain('createRng');
      expect(effects.length).toBeGreaterThan(1000);
    });

    it('covers every module that draws, and knows when one arrives', () => {
      // THE LIST IS THE GATE. A scan whose list has quietly lost a file
      // reports a clean tree forever, and a render module added tomorrow would
      // never be opened at all, so the written list is reconciled against the
      // directory in both directions.
      //
      // AND THE WALK IS RECURSIVE, because a walk that opens no directory
      // satisfies the reconciliation with a file's ABSENCE FROM BOTH SIDES: a
      // module under `src/render/sub/` would be in neither the written list nor
      // the walked one, and the two would go on agreeing while it drew off the
      // platform generator.
      const walked = modulesUnder(RENDER_ROOT).map((name) => `src/render/${name}`);
      expect([...MODULES_THAT_DRAW].sort()).toEqual(['src/main.ts', ...walked].sort());
      expect(MODULES_THAT_DRAW).toHaveLength(10);
      expect(walked.length).toBeGreaterThan(5);
      expect(MODULES_THAT_DRAW).toContain('src/main.ts');
    });

    it('opens a render module in a subdirectory, which is the walk it needs', () => {
      // THE CONTROL FOR THE RECURSION, over a fixture tree rather than over the
      // real one: the real one has no subdirectory today, so a walk that had
      // stopped opening them would answer exactly as it does now. The fixture
      // is built, walked and removed here, and it holds one module at the top
      // and one two levels down.
      const fixture = mkdtempSync(path.join(tmpdir(), 'pf-render-walk-'));
      try {
        writeFileSync(path.join(fixture, 'top.ts'), 'export const one = 1;\n', 'utf8');
        writeFileSync(path.join(fixture, 'notes.md'), 'not a module\n', 'utf8');
        mkdirSync(path.join(fixture, 'sub', 'deeper'), { recursive: true });
        writeFileSync(
          path.join(fixture, 'sub', 'plant.ts'),
          'export const roll = Math.random();\n',
          'utf8',
        );
        writeFileSync(
          path.join(fixture, 'sub', 'deeper', 'buried.ts'),
          'export const two = 2;\n',
          'utf8',
        );
        expect([...modulesUnder(fixture)].sort()).toEqual([
          'sub/deeper/buried.ts',
          'sub/plant.ts',
          'top.ts',
        ]);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });

    it('reproduces exactly from one seed and differs from another', () => {
      const shakeOf = (seed: string): number => {
        const effects = createEffects({ seed });
        stagedImpact(effects, 600, 1 / 60);
        return effects.shake(720).x;
      };
      expect(shakeOf('one')).toBe(shakeOf('one'));
      expect(shakeOf('one')).not.toBe(shakeOf('two'));
      expect(EFFECTS_SEED).toBe('pocket-football-effects');
    });

    it('keeps the burst off the shake stream, so one cannot move the other', () => {
      // The same seed, one run with a goal drawn before the impact and one
      // without. The burst takes two draws per particle; if the two consumers
      // shared a stream the shake would land somewhere else.
      const withoutGoal = createEffects({ seed: 'split' });
      stagedImpact(withoutGoal, 600, 1 / 60);

      const withGoal = createEffects({ seed: 'split' });
      const world = createWorld();
      withGoal.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
      withGoal.observe({ world, scoring: oneGoal('right'), elapsed: 1 / 60, reducedMotion: false });
      expect(withGoal.readout().draws).toBe(24);
      stagedImpact(withGoal, 600, 1 / 60);

      expect(withGoal.shake(720).x).toBe(withoutGoal.shake(720).x);
      expect(withGoal.readout().draws).toBe(withoutGoal.readout().draws + 24);
    });
  });

  describe('the alphas and the cycle rates, pinned like the vignette', () => {
    it('opens every fade at the weight it was given, and hands the alpha back', () => {
      // Age zero, so every envelope is exactly one and the recorded alpha is
      // the constant itself. An alpha is not a colour, a size, a radius or a
      // duration, so it has no token to resolve through and is pinned here.
      const effects = createEffects();
      const world = stagedImpact(effects, 600, 1 / 60);
      const front = new CanvasRecorder();
      effects.drawInFront(front.context, PLAY_SURFACE.floodlit, world.player, null);
      expect(front.values('globalAlpha')[0]).toBeCloseTo(0.7, 12);
      expect(front.values('globalAlpha').at(-1)).toBe(1);

      // The trail, which needs two samples a frame apart to draw a segment.
      const trail = createEffects();
      const moving = createWorld();
      setVelocity(moving.ball, 600, 0);
      for (let frame = 0; frame < 3; frame += 1) {
        set(moving.ball.position, 300 + frame * 10, 360);
        tick(trail, moving, 1 / 60);
      }
      const behind = new CanvasRecorder();
      trail.drawBehind(behind.context, PLAY_SURFACE.floodlit);
      // Two segments, oldest first and faintest, then the alpha handed back
      // by the trail and again by the wall pass behind it.
      const trailAlphas = behind.values('globalAlpha').map(Number);
      expect(trailAlphas).toHaveLength(4);
      expect(trailAlphas[0]).toBeCloseTo(0.45 * (1 - 2 / 60 / 0.18), 9);
      expect(trailAlphas[1]).toBeCloseTo(0.45 * (1 - 1 / 60 / 0.18), 9);
      expect(trailAlphas[2]).toBe(1);
      expect(trailAlphas[3]).toBe(1);

      // The celebration and the burst, both at age zero.
      const goal = createEffects();
      const still = createWorld();
      tick(goal, still, 1 / 60);
      goal.observe({ world: still, scoring: oneGoal('right'), elapsed: 1 / 60, reducedMotion: false });
      const party = new CanvasRecorder();
      goal.drawInFront(party.context, PLAY_SURFACE.floodlit, still.player, null);
      // The impact pass runs first and has nothing to draw, so it only hands
      // the alpha back; the celebration's own weight is the next one set.
      const partyAlphas = party.values('globalAlpha').map(Number);
      expect(partyAlphas[0]).toBe(1);
      expect(partyAlphas[1]).toBeCloseTo(0.8, 12);
      // Twelve particles at full weight at age zero, and three hand-backs.
      expect(partyAlphas.filter((value) => value === 1)).toHaveLength(15);
    });

    it('pulses the arrow to its own peak and no further', () => {
      const effects = createEffects();
      const world = createWorld();
      const full = aimFromDrag(-180, 0);
      const alphaAt = (): number[] => {
        const recorder = new CanvasRecorder();
        effects.drawInFront(recorder.context, PLAY_SURFACE.floodlit, world.player, full);
        return recorder.values('globalAlpha').map(Number).filter((value) => value !== 1);
      };
      let peak = 0;
      let trough = 1;
      for (let step = 0; step < 32; step += 1) {
        tick(effects, world, 0.01);
        for (const value of alphaAt()) {
          peak = Math.max(peak, value);
          trough = Math.min(trough, value);
        }
      }
      // Thirty-two hundredths of a second is half of the 640 ms period, so the
      // wave has swept from its top to its bottom and the peak is the pulse's
      // own weight. A single step, 320 ms, would have swept a whole period and
      // returned to the top, which is also 3.1 cycles a second and over SC
      // 2.3.1's three.
      expect(peak).toBeLessThanOrEqual(0.55);
      expect(peak).toBeGreaterThan(0.54);
      expect(trough).toBeLessThan(0.01);
    });

    it('oscillates on the 140 ms step, which samples cleanly at 30 frames a second', () => {
      const effects = createEffects();
      const world = stagedImpact(effects, 600, 0.01);
      const born = effects.shake(720).x;
      expect(born).not.toBe(0);
      // Seven hundredths of a second is half of the 140 ms step, so the offset
      // has turned round; fourteen is a whole period, so it is back. Both are
      // inside SPEC section 14's 0.20 s window.
      for (let step = 0; step < 7; step += 1) {
        tick(effects, world, 0.01);
      }
      const halfway = effects.shake(720).x;
      for (let step = 0; step < 7; step += 1) {
        tick(effects, world, 0.01);
      }
      const around = effects.shake(720).x;
      expect(Math.sign(halfway)).toBe(-Math.sign(born));
      expect(Math.sign(around)).toBe(Math.sign(born));
      // And it decayed on the way round rather than holding its peak.
      expect(Math.abs(around)).toBeLessThan(Math.abs(born));
      // The period is long enough to survive being sampled once a frame at the
      // lowest rate the performance budget covers: a period at or under twice
      // the frame interval alternates at full amplitude instead of oscillating.
      expect(0.14).toBeGreaterThan(2 / 30);
    });

    it('pulses the goal frame on two of the longest step, under three a second', () => {
      const effects = createEffects();
      const world = createWorld();
      tick(effects, world, 1 / 60);
      effects.observe({ world, scoring: oneGoal('right'), elapsed: 1 / 60, reducedMotion: false });
      // Thirty-two hundredths of a second is half of the 640 ms period, where
      // the pulse is at its trough and the frame stroke is drawn at nothing.
      for (let frame = 0; frame < 32; frame += 1) {
        tick(effects, world, 0.01);
      }
      const recorder = new CanvasRecorder();
      effects.drawInFront(recorder.context, PLAY_SURFACE.floodlit, world.player, null);
      const beforeStroke = recorder.ops
        .slice(0, recorder.ops.findIndex((op) => op.name === 'strokeRect'))
        .filter((op) => op.name === 'globalAlpha');
      expect(Number(beforeStroke.at(-1)?.args[0])).toBeCloseTo(0, 9);
    });
  });

  describe('the passes land where DESIGN section 7 puts them', () => {
    it('draws behind the entities and in front of the arrow', () => {
      const { recorder, surface, cache } = frameFixture();
      const order: string[] = [];
      const effects: EffectsFrame = {
        shake: () => ({ x: 0, y: 0 }),
        drawBehind: () => {
          order.push('behind');
          recorder.context.fillRect(0, 0, 1, 1);
        },
        drawInFront: () => {
          order.push('front');
          recorder.context.fillRect(0, 0, 2, 2);
        },
      };
      const world = createWorld();
      drawFrame(surface, cache, world, PLAY_SURFACE.floodlit, {
        effects,
        aim: aimFromDrag(-180, 0),
      });
      expect(order).toEqual(['behind', 'front']);
      const behind = recorder.ops.findIndex((op) => op.name === 'fillRect');
      const entities = recorder.indexOf('set', 'fillStyle');
      const front = recorder.ops.map((op) => op.name).lastIndexOf('fillRect');
      const arrow = recorder.ops.map((op) => op.name).lastIndexOf('closePath');
      expect(behind).toBeGreaterThan(recorder.indexOf('call', 'drawImage'));
      expect(behind).toBeLessThan(entities);
      expect(front).toBeGreaterThan(arrow);
    });

    it('offsets the blit and the design transform by the shake together', () => {
      const { recorder, surface, cache } = frameFixture();
      const effects: EffectsFrame = {
        shake: (renderedHeight: number) => ({ x: renderedHeight / 100, y: -2 }),
        drawBehind: () => undefined,
        drawInFront: () => undefined,
      };
      drawFrame(surface, cache, createWorld(), PLAY_SURFACE.floodlit, { effects });
      const transforms = recorder.calls('setTransform');
      // The clear is NOT shaken: it covers the whole backing store from the
      // origin, or the strip the offset uncovers keeps the previous frame.
      expect(transforms[0]?.args).toEqual([1, 0, 0, 1, 0, 0]);
      expect(recorder.calls('clearRect')[0]?.args).toEqual([0, 0, 1280, 720]);
      // The blit and the design transform both carry it, so the whole scene
      // moves as one on the backing store.
      expect(transforms[1]?.args).toEqual([1, 0, 0, 1, 7.2, -2]);
      expect(transforms[2]?.args).toEqual([1, 0, 0, -1, 7.2, LOGICAL_HEIGHT - 2]);
    });

    it('asks the shake about the CSS height, and converts by the backing ratio', () => {
      const { recorder, surface, cache } = frameFixture();
      // A rendered height that is NOT the logical height, so a composition
      // that asked about the design space instead of the display fails here,
      // and a backing store at twice the density, so an offset stated in CSS
      // pixels has to be doubled on the way to the transform.
      surface.cssHeight = 900;
      surface.canvas.height = 1800;
      const asked: number[] = [];
      const effects: EffectsFrame = {
        shake: (renderedHeight: number) => {
          asked.push(renderedHeight);
          return { x: 3, y: 0 };
        },
        drawBehind: () => undefined,
        drawInFront: () => undefined,
      };
      drawFrame(surface, cache, createWorld(), PLAY_SURFACE.floodlit, {
        effects,
        createLayer: () => asCanvas(fakeCanvas(new CanvasRecorder())),
      });
      expect(asked).toEqual([900]);
      expect(asked).not.toEqual([LOGICAL_HEIGHT]);
      // Three CSS pixels of shake on a surface at two device pixels to the
      // CSS pixel is six device pixels of offset, and the same three CSS
      // pixels on a surface at one is three. That is the ratio cancelling.
      expect(recorder.calls('setTransform')[1]?.args).toEqual([1, 0, 0, 1, 6, 0]);
    });
  });
});

/* ---------------------------------------------------------------------------
 * The two contact predicates, the alpha invariant and the shared arrow tracer.
 * ------------------------------------------------------------------------- */

/** One body as a previous frame left it, built by hand for a boundary case. */
function sampleAt(x: number, y: number, vx: number, vy: number): BodySample {
  return { x, y, vx, vy };
}

/** A world with one body placed and moving, for a direct predicate call. */
function bodyAt(
  kind: 'player' | 'ball',
  x: number,
  y: number,
  vx: number,
  vy: number,
): World['player'] {
  const world = createWorld();
  const body = kind === 'ball' ? world.ball : world.player;
  set(body.position, x, y);
  setVelocity(body, vx, vy);
  return body;
}

/**
 * Every function under `src/render/` that leaves `globalAlpha` somewhere other
 * than 1, read out of the source rather than listed by hand.
 *
 * The enclosing function is found by walking back to the nearest declaration in
 * column zero, which is where every function in this layer is declared.
 */
function fadingPasses(): string[] {
  const found = new Set<string>();
  for (const relative of MODULES_THAT_DRAW) {
    const text = withoutComments(readFileSync(path.join(PROJECT_ROOT, relative), 'utf8'));
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const assignment = /globalAlpha\s*=\s*([^;]+);/.exec(line);
      if (assignment === null || (assignment[1] ?? '').trim() === '1') {
        return;
      }
      for (let above = index; above >= 0; above -= 1) {
        const declaration = /^(?:export )?function ([A-Za-z0-9_$]+)\s*\(/.exec(lines[above] ?? '');
        if (declaration !== null) {
          found.add(`${relative.replace('src/render/', '')} ${declaration[1] ?? ''}`);
          return;
        }
      }
      found.add(`${relative} <top level>`);
    });
  }
  return [...found].sort();
}

/**
 * THE INVARIANT, STATED ONCE: EVERY PASS LEAVES `globalAlpha` AT 1.
 *
 * No pass here wraps itself in `save()`/`restore()`; each fades by hand and
 * puts the alpha back at the end. That is one line per pass to forget, and a
 * forgotten one does not fail: it tints whatever the NEXT pass draws, in a
 * frame whose contents depend on what happened to be running, which is the
 * kind of defect that shows up as an unexplained visual baseline flake three
 * parts later. So the passes that fade are enumerated FROM THE SOURCE, every
 * one of them is driven here with a state that makes it actually draw, and the
 * context is asserted to come back at 1 afterwards. A seventh fading pass
 * added tomorrow reddens the census below until it is driven too.
 */
const FADING_PASSES: readonly string[] = [
  'effects.ts drawCelebration',
  'effects.ts drawImpactFlashes',
  'effects.ts drawMaximumPulse',
  'effects.ts drawParticles',
  'effects.ts drawTrail',
  'effects.ts drawWallFlashes',
  'pitch.ts drawVignette',
];

describe('PF-12 every pass leaves globalAlpha at 1', () => {
  it('enumerates the fading passes from the source, and the list is that set', () => {
    // THE CENSUS. The list above is the gate, so it is pinned as a value: a
    // fading pass this file does not drive is a pass whose restore nothing
    // checks, and a name left here after its pass is gone is a carve-out that
    // outlived the code.
    expect(fadingPasses()).toEqual([...FADING_PASSES]);
    expect(FADING_PASSES).toHaveLength(7);
    // The scan is non-vacuous in both directions: it finds these seven, and it
    // does not find a function whose only assignment is the restore itself.
    expect(fadingPasses()).not.toContain('effects.ts remaining');
    expect(fadingPasses().every((entry) => entry.includes(' '))).toBe(true);
  });

  it('would see a pass that fades, and would not see one that only restores', () => {
    // The positive and negative controls for the scanner, over sources it is
    // handed rather than over the tree, so a scanner that had stopped scanning
    // reports a compliant tree forever.
    const scan = (text: string): string[] => {
      const lines = withoutComments(text).split('\n');
      const found: string[] = [];
      lines.forEach((line, index) => {
        const assignment = /globalAlpha\s*=\s*([^;]+);/.exec(line);
        if (assignment === null || (assignment[1] ?? '').trim() === '1') {
          return;
        }
        for (let above = index; above >= 0; above -= 1) {
          const declaration = /^(?:export )?function ([A-Za-z0-9_$]+)\s*\(/.exec(
            lines[above] ?? '',
          );
          if (declaration !== null) {
            found.push(declaration[1] ?? '');
            return;
          }
        }
      });
      return found;
    };
    expect(scan('function fades() {\n  context.globalAlpha = 0.5;\n}\n')).toEqual(['fades']);
    expect(scan('export function fades() {\n  context.globalAlpha = left;\n}\n')).toEqual([
      'fades',
    ]);
    expect(scan('function restores() {\n  context.globalAlpha = 1;\n}\n')).toEqual([]);
    expect(scan('function commented() {\n  // context.globalAlpha = 0.5;\n}\n')).toEqual([]);
  });

  it('puts the alpha back after every one of them, driven so each really draws', () => {
    const palette = PLAY_SURFACE.floodlit;

    // drawTrail: a ball moving between two frames leaves segments to stroke.
    const trail = new CanvasRecorder();
    const trailEffects = createEffects();
    const world = createWorld();
    kickoff(world);
    setVelocity(world.ball, 600, 0);
    tick(trailEffects, world, 1 / 60);
    set(world.ball.position, world.ball.position.x + 10, world.ball.position.y);
    tick(trailEffects, world, 1 / 60);
    trailEffects.drawBehind(trail.context, palette);
    expect(trail.calls('stroke').length).toBeGreaterThan(0);
    expect(trail.values('globalAlpha').at(-1)).toBe(1);
    expect(trail.values('globalAlpha').some((value) => value !== 1)).toBe(true);

    // drawWallFlashes: a wall bounce staged through the real observation.
    const wall = new CanvasRecorder();
    const wallEffects = createEffects();
    const bouncing = createWorld();
    set(bouncing.ball.position, FIELD_LEFT + BALL_RADIUS + 4, 200);
    setVelocity(bouncing.ball, -600, 0);
    tick(wallEffects, bouncing, 1 / 60);
    set(bouncing.ball.position, FIELD_LEFT + BALL_RADIUS, 200);
    setVelocity(bouncing.ball, 552, 0);
    tick(wallEffects, bouncing, 1 / 60);
    wallEffects.drawBehind(wall.context, palette);
    expect(wall.calls('fillRect').length).toBeGreaterThan(0);
    expect(wall.values('globalAlpha').at(-1)).toBe(1);
    expect(wall.values('globalAlpha').some((value) => value !== 1)).toBe(true);

    // drawImpactFlashes: the staged head-on collision this file already uses.
    const impact = new CanvasRecorder();
    const impactEffects = createEffects();
    const hit = stagedImpact(impactEffects, 600, 1 / 60);
    impactEffects.drawInFront(impact.context, palette, hit.player, null);
    expect(impact.calls('arc').length).toBeGreaterThan(0);
    expect(impact.values('globalAlpha').at(-1)).toBe(1);
    expect(impact.values('globalAlpha').some((value) => value !== 1)).toBe(true);

    // drawCelebration and drawParticles: one goal, drawn in the same pass.
    const party = new CanvasRecorder();
    const goalEffects = createEffects();
    const scored = createWorld();
    goalEffects.observe({
      world: scored,
      scoring: oneGoal('left'),
      elapsed: 1 / 60,
      reducedMotion: false,
    });
    goalEffects.drawInFront(party.context, palette, scored.player, null);
    expect(goalEffects.readout().celebration).toBeGreaterThan(0);
    expect(goalEffects.readout().particles).toBeGreaterThan(0);
    expect(party.calls('strokeRect')).toHaveLength(1);
    expect(party.calls('arc').length).toBeGreaterThan(0);
    expect(party.values('globalAlpha').at(-1)).toBe(1);
    expect(party.values('globalAlpha').some((value) => value !== 1)).toBe(true);
    // THE CELEBRATION IS THE ONE PASS A LATER RESTORE WOULD COVER FOR, because
    // the particles run after it and hand the alpha back themselves. So its own
    // restore is read where it happens: the op straight after its one stroked
    // rectangle has to be the alpha going home.
    const celebrationAt = party.ops.findIndex((op) => op.name === 'strokeRect');
    expect(celebrationAt).toBeGreaterThanOrEqual(0);
    const restore = party.ops[celebrationAt + 1];
    expect(restore?.kind).toBe('set');
    expect(restore?.name).toBe('globalAlpha');
    expect(restore?.args[0]).toBe(1);

    // drawMaximumPulse: a full-power aim, which is the only aim it draws for.
    const pulse = new CanvasRecorder();
    const pulseEffects = createEffects();
    const aiming = createWorld();
    tick(pulseEffects, aiming, 1 / 60);
    pulseEffects.drawInFront(pulse.context, palette, aiming.player, aimFromDrag(-180, 0));
    expect(pulse.calls('stroke')).toHaveLength(1);
    expect(pulse.values('globalAlpha').at(-1)).toBe(1);
    expect(pulse.values('globalAlpha').some((value) => value !== 1)).toBe(true);

    // drawVignette: the one fading pass outside this module.
    const vignette = new CanvasRecorder();
    drawVignette(vignette.context, palette);
    expect(vignette.calls('fillRect')).toHaveLength(1);
    expect(vignette.values('globalAlpha')).toEqual([0.35, 1]);
  });

  it('leaves a whole frame at 1, which is the invariant a next frame depends on', () => {
    // The same property over the composition rather than over one pass: a frame
    // with every fading pass live in it ends with the context at 1, so the
    // first pass of the NEXT frame draws at full strength.
    const { recorder, surface, cache } = frameFixture();
    const effects = createEffects();
    const world = createWorld();
    kickoff(world);
    setVelocity(world.ball, 600, 0);
    effects.observe({ world, scoring: oneGoal('left'), elapsed: 1 / 60, reducedMotion: false });
    drawFrame(surface, cache, world, PLAY_SURFACE.floodlit, {
      effects,
      aim: aimFromDrag(-180, 0),
    });
    expect(recorder.values('globalAlpha').some((value) => value !== 1)).toBe(true);
    expect(recorder.values('globalAlpha').at(-1)).toBe(1);
  });
});

describe('PF-12 the two contact predicates, at their boundaries', () => {
  /**
   * `wallContact` and `pairContact` are the most delicate predicates in the
   * renderer and they were graded only through the frames that happen to reach
   * them. Both are exported and both are total, so they are graded here
   * directly, at the boundary each one turns on, with literal inputs.
   *
   * THE FRAME LENGTH IS PART OF EVERY BOUND. A frame of `seconds` can have
   * advanced the world by `seconds + 1/120` (the accumulator carries a
   * remainder), so at a sixtieth the span is 0.025 and a body at 400 px/s
   * could have covered 10 px plus the 1e-6 of slack.
   */
  it('reads a wall bounce at exactly one frame of travel, and not a hair beyond', () => {
    const seconds = 1 / 60;
    const span = seconds + 1 / 120;
    expect(span).toBeCloseTo(0.025, 12);
    const travel = 400 * span;
    expect(travel).toBeCloseTo(10, 12);

    // ON the bound: the circle's rim is exactly one frame of travel from the
    // left field bound, it was moving left and it is moving right now.
    const onTheBound = bodyAt('player', FIELD_LEFT + CIRCLE_RADIUS + travel, 300, 360, 0);
    expect(
      wallContact(onTheBound, sampleAt(onTheBound.position.x, 300, -400, 0), seconds),
    ).toEqual({ x: FIELD_LEFT, y: 300, wall: 'left' });

    // A tenth of a pixel past it, which is the same frame and the same
    // reversal and is no longer a bounce: the slack is 1e-6, not a tenth.
    const past = bodyAt('player', FIELD_LEFT + CIRCLE_RADIUS + travel + 0.1, 300, 360, 0);
    expect(wallContact(past, sampleAt(past.position.x, 300, -400, 0), seconds)).toBeNull();

    // THE DIRECTION GATE, both halves. A body still travelling into the wall
    // has not bounced off it, and a body that was not travelling into it never
    // met it; both are refused where the distance alone would admit them.
    const still = bodyAt('player', FIELD_LEFT + CIRCLE_RADIUS, 300, -400, 0);
    expect(wallContact(still, sampleAt(still.position.x, 300, -400, 0), seconds)).toBeNull();
    const never = bodyAt('player', FIELD_LEFT + CIRCLE_RADIUS, 300, 360, 0);
    expect(wallContact(never, sampleAt(never.position.x, 300, 0, 0), seconds)).toBeNull();

    // THE GOAL OPENING IS NOT A WALL (SPEC section 6.4). A ball inside the
    // mouth passes through the side wall rather than bouncing off it, so the
    // side branches refuse it while the end walls still answer for it.
    const inTheMouth = bodyAt('ball', FIELD_LEFT + BALL_RADIUS, 360, 360, 0);
    expect(inTheMouth.position.y - BALL_RADIUS).toBeGreaterThanOrEqual(GOAL_OPENING_LOW);
    expect(inTheMouth.position.y + BALL_RADIUS).toBeLessThanOrEqual(GOAL_OPENING_HIGH);
    expect(
      wallContact(inTheMouth, sampleAt(inTheMouth.position.x, 360, -400, 0), seconds),
    ).toBeNull();
    const highBall = bodyAt('ball', 600, FIELD_TOP - BALL_RADIUS, 0, -360);
    expect(wallContact(highBall, sampleAt(600, highBall.position.y, 0, 400), seconds)).toEqual({
      x: 600,
      y: FIELD_TOP,
      wall: 'top',
    });

    // ONE WALL PER BODY PER FRAME, and the x axis is tested first: a corner
    // answers the side wall rather than depending on which comparison rounded.
    const corner = bodyAt(
      'player',
      FIELD_LEFT + CIRCLE_RADIUS,
      FIELD_BOTTOM + CIRCLE_RADIUS,
      360,
      360,
    );
    expect(
      wallContact(
        corner,
        sampleAt(corner.position.x, corner.position.y, -400, -400),
        seconds,
      ),
    ).toEqual({ x: FIELD_LEFT, y: FIELD_BOTTOM + CIRCLE_RADIUS, wall: 'left' });
  });

  it('reads a pair meeting at exactly the touching distance, and refuses a clean miss', () => {
    // A QUARTER-SECOND FRAME, which is the clamped ceiling and the frame length
    // the miss below was measured under: the whole point of the second gate is
    // that a long frame turns a pass-by into a signature that looks like a
    // meeting, so the case is taken at the length where it does.
    const seconds = 0.25;
    const world = createWorld();
    const still = world.player;
    const passing = world.ball;
    set(still.position, 500, 360);
    setVelocity(still, 0, 0);
    expect(still.radius + passing.radius).toBe(52);

    const meeting = (offset: number): ReturnType<typeof pairContact> => {
      set(passing.position, 550, 360 + offset);
      setVelocity(passing, 600, 0);
      return pairContact(
        still,
        passing,
        sampleAt(500, 360, 0, 0),
        sampleAt(450, 360 + offset, 600, 0),
        seconds,
      );
    };

    // ON the bound: the closest the pair came was exactly the sum of the radii.
    const touching = meeting(52);
    expect(touching).not.toBeNull();
    // The contact point is on the first body's own rim, toward the second.
    const apart = Math.hypot(50, 52);
    expect(touching?.x).toBeCloseTo(500 + (50 / apart) * 34, 9);
    expect(touching?.y).toBeCloseTo(360 + (52 / apart) * 34, 9);

    // A thousandth of a pixel past it is a miss, and eighteen units of clear
    // air is the miss the second gate was built for: both were flashes before.
    expect(meeting(52.001)).toBeNull();
    expect(meeting(70)).toBeNull();

    // THE CLOSING GATE. A pair that was already separating at the previous
    // sample never met in this frame, whatever it is doing now.
    expect(
      pairContact(
        still,
        passing,
        sampleAt(500, 360, 0, 0),
        sampleAt(560, 360, 600, 0),
        seconds,
      ),
    ).toBeNull();

    // THE SEPARATING GATE. A pair still closing is mid-collision, one frame
    // before the solver has pushed it apart, and has not finished meeting yet.
    set(passing.position, 540, 360);
    setVelocity(passing, -600, 0);
    expect(
      pairContact(
        still,
        passing,
        sampleAt(500, 360, 0, 0),
        sampleAt(600, 360, -600, 0),
        seconds,
      ),
    ).toBeNull();

    // AND THE TWO COINCIDENT REFUSALS, which keep a zero-length normal out of
    // the answer: centres on one point before, and centres on one point now.
    set(passing.position, 550, 360);
    setVelocity(passing, 600, 0);
    expect(
      pairContact(still, passing, sampleAt(500, 360, 0, 0), sampleAt(500, 360, 600, 0), seconds),
    ).toBeNull();
    set(passing.position, 500, 360);
    expect(
      pairContact(still, passing, sampleAt(500, 360, 0, 0), sampleAt(450, 360, 600, 0), seconds),
    ).toBeNull();
  });
});

describe('PF-12 one arrow tracer, two drawings of it', () => {
  it('traces the path as one closed subpath, and both callers use it', () => {
    // `traceArrow` is the path convention: first point a moveTo, every other a
    // lineTo, and the subpath closed. Graded directly, because the two callers
    // agreeing with each other would agree just as well if both were wrong.
    const direct = new CanvasRecorder();
    traceArrow(direct.context, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
    expect(direct.ops.map((op) => op.name)).toEqual([
      'beginPath',
      'moveTo',
      'lineTo',
      'lineTo',
      'closePath',
    ]);
    expect(direct.calls('moveTo')[0]?.args).toEqual([1, 2]);
    expect(direct.calls('lineTo')[1]?.args).toEqual([5, 6]);
    // An empty path opens and closes and draws nothing, which is what keeps a
    // zero-length arrow from leaving a subpath open for the next pass.
    const empty = new CanvasRecorder();
    traceArrow(empty.context, []);
    expect(empty.ops.map((op) => op.name)).toEqual(['beginPath', 'closePath']);

    // AND THE TWO CALLERS TRACE THE SAME PATH FOR THE SAME AIM. The pulse used
    // to carry its own copy of this loop, so a change to the point order would
    // have re-traced the arrow and mis-traced the pulse.
    const aim = aimFromDrag(-180, 0);
    const world = createWorld();
    kickoff(world);
    const arrowRecorder = new CanvasRecorder();
    drawAimArrow(arrowRecorder.context, PLAY_SURFACE.floodlit, world.player, aim);
    const effects = createEffects();
    tick(effects, world, 1 / 60);
    const pulseRecorder = new CanvasRecorder();
    effects.drawInFront(pulseRecorder.context, PLAY_SURFACE.floodlit, world.player, aim);
    const geometry = arrowGeometry(aim.reach);
    const expected = arrowPath(
      world.player.position.x,
      world.player.position.y,
      aim.aim.angleRad,
      geometry,
    );
    const traced = (recorder: CanvasRecorder): unknown[] =>
      recorder.ops
        .filter((op) => op.name === 'moveTo' || op.name === 'lineTo')
        .map((op) => op.args);
    const points = expected.map((point) => [point.x, point.y]);
    expect(traced(arrowRecorder)).toEqual(points);
    expect(traced(pulseRecorder)).toEqual(points);
    expect(points).toHaveLength(7);
  });
});

describe('PF-12 the maximum-power pulse follows the acting circle', () => {
  it('draws one pulse, at the launcher, in a Hotseat frame', () => {
    // SPEC SECTION 9's HOTSEAT AIMS THE OPPONENT'S CIRCLE on the second human's
    // turn, and the arrow and the pulse are two strokes of ONE aim. The pulse
    // read `world.player` whatever the frame said, so a full-power aim from the
    // second circle drew a second arrow out of the first one: two arrows on the
    // pitch, one of them belonging to nobody.
    const { recorder, surface, cache } = frameFixture();
    const effects = createEffects();
    const world = createWorld();
    kickoff(world);
    effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
    const aim = aimFromDrag(-180, 0);
    expect(aim.aim.power01).toBe(1);
    drawFrame(surface, cache, world, PLAY_SURFACE.floodlit, {
      effects,
      aim,
      launcher: world.opponent,
    });
    // The frame draws entity markers with the same primitives, so the arrows
    // are counted as the seven-point subpaths they are rather than as every
    // moveTo on the surface.
    const geometry = arrowGeometry(aim.reach);
    const pathAt = (body: World['player']): ReadonlyArray<readonly [number, number]> =>
      arrowPath(body.position.x, body.position.y, aim.aim.angleRad, geometry).map(
        (point) => [point.x, point.y] as const,
      );
    const atOpponent = pathAt(world.opponent);
    const atPlayer = pathAt(world.player);
    expect(atOpponent).toHaveLength(7);
    const subpaths = (taken: CanvasRecorder): unknown[][][] => {
      const found: unknown[][][] = [];
      let current: unknown[][] | null = null;
      for (const op of taken.ops) {
        if (op.name === 'moveTo') {
          current = [[...op.args]];
          found.push(current);
          continue;
        }
        if (op.name === 'lineTo' && current !== null) {
          current.push([...op.args]);
          continue;
        }
        current = null;
      }
      return found.filter((subpath) => subpath.length === 7);
    };
    // TWO ARROW-SHAPED SUBPATHS AND NO MORE: the outline and its pulse, both at
    // the opponent's circle, and neither at the player's.
    const drawn = subpaths(recorder);
    expect(drawn).toHaveLength(2);
    for (const subpath of drawn) {
      expect(subpath).toEqual(atOpponent.map((point) => [...point]));
      expect(subpath).not.toEqual(atPlayer.map((point) => [...point]));
    }

    // AND THE DEFAULT IS UNCHANGED: with no launcher named, both are drawn at
    // the player's circle, which is every mode but Hotseat.
    const plain = frameFixture();
    const plainEffects = createEffects();
    plainEffects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
    drawFrame(plain.surface, plain.cache, world, PLAY_SURFACE.floodlit, {
      effects: plainEffects,
      aim,
    });
    const plainDrawn = subpaths(plain.recorder);
    expect(plainDrawn).toHaveLength(2);
    for (const subpath of plainDrawn) {
      expect(subpath).toEqual(atPlayer.map((point) => [...point]));
    }
  });
});

describe('PF-12 the event log is handed out live, which the interface states', () => {
  it('answers the same array every time, and it keeps changing under a holder', () => {
    // THE ALIASING IS THE CONTRACT, so it is pinned rather than described. A
    // caller that took this for a snapshot would read events that arrived after
    // it asked, and would lose the oldest ones once the log reached its bound.
    const effects = createEffects();
    const held = effects.events();
    expect(held).toHaveLength(0);
    expect(effects.events()).toBe(held);
    stagedImpact(effects, 600, 1 / 60);
    expect(held.length).toBeGreaterThan(0);
    expect(effects.events()).toBe(held);
    // A caller that wants a snapshot takes one, which is the documented way out
    // and the control that keeps the assertion above from being about nothing.
    const snapshot = [...effects.events()];
    stagedImpact(effects, 600, 1 / 60, 700, 200);
    expect(effects.events().length).toBeGreaterThan(snapshot.length);
    expect(snapshot).toHaveLength(1);
  });
});

describe('PF-12 a paused match charges the effects clock nothing', () => {
  /**
   * SPEC section 7: entering PAUSED "zeroes nothing and steps no simulation",
   * and this module states its own clock as advancing by the seconds the world
   * advanced by. A paused world advances by none, so the composition root
   * observes the frame and charges zero.
   *
   * TWO HALVES, GRADED SEPARATELY. That charging zero really freezes the layer
   * is a property of this module and is driven here over the real effects. That
   * the root charges zero while the match is paused is a property of the
   * composition root, which no unit test can import - it is the bundler's entry
   * and it runs on import - so it is read out of its source instead.
   */
  /**
   * Every field of the readout, enumerated so that a sixth accumulator cannot
   * arrive invisibly. It is a `Record` over the type's own keys, so a field
   * added to `EffectsReadout` is a COMPILE error here until it is named, and
   * the test below then holds it still across a pause like the rest.
   *
   * The first version of this test named five fields by hand and the layer had
   * six that move; the one it did not name, `trailSamples`, was the one that
   * grew without bound.
   */
  const EVERY_READOUT_FIELD: Readonly<Record<keyof EffectsReadout, true>> = {
    now: true,
    trailLength: true,
    trailSamples: true,
    shakeEnergy: true,
    impactFlashes: true,
    wallFlashes: true,
    particles: true,
    celebration: true,
    draws: true,
    refusals: true,
  };

  /** A minute of paused frames at sixty a second, which is a real pause. */
  const PAUSED_FRAMES = 3600;

  it('freezes the clock and every field of the readout for a frame worth no time', () => {
    const effects = createEffects();
    const world = createWorld();
    kickoff(world);
    // A goal, so there is a celebration, a burst of particles and a shake all
    // running: something that would visibly age if the clock kept going.
    effects.observe({
      world,
      scoring: oneGoal('left'),
      elapsed: 1 / 60,
      reducedMotion: false,
    });
    const running = effects.readout();
    expect(running.celebration).toBeGreaterThan(0);
    expect(running.particles).toBeGreaterThan(0);
    const before = { ...running };

    // A minute of would-be frames, every one of them charged nothing, which is
    // what a paused match hands this layer - and a pause has no length limit.
    for (let frame = 0; frame < PAUSED_FRAMES; frame += 1) {
      effects.observe({ world, scoring: oneGoal('left'), elapsed: 0, reducedMotion: false });
    }
    const after = effects.readout();
    // EVERY FIELD, from the type rather than from a list somebody kept up to
    // date: the readout is the whole of what this layer retains, so a field
    // that moved while the clock stood still is state a pause is accumulating.
    const fields = Object.keys(EVERY_READOUT_FIELD) as ReadonlyArray<keyof EffectsReadout>;
    expect(Object.keys(after).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(after[field], field).toBe(before[field]);
    }
    // Named for the reader as well, because the loop above says nothing about
    // which fields exist if the readout ever answers an empty object.
    expect(fields).toHaveLength(10);
    expect(after.now).toBe(before.now);
    expect(after.trailSamples).toBe(before.trailSamples);

    // THE CONTROL: the same frames charged the time they would have taken run
    // the celebration out entirely, so the assertions above are about the zero
    // and not about a layer that never ages.
    const ticking = createEffects();
    ticking.observe({ world, scoring: oneGoal('left'), elapsed: 1 / 60, reducedMotion: false });
    expect(ticking.readout().celebration).toBeGreaterThan(0);
    for (let frame = 0; frame < 200; frame += 1) {
      ticking.observe({ world, scoring: oneGoal('left'), elapsed: 1 / 60, reducedMotion: false });
    }
    expect(ticking.readout().now).toBeGreaterThan(before.now);
    expect(ticking.readout().celebration).toBe(0);
    expect(ticking.readout().particles).toBe(0);
  });

  it('keeps the trail bounded by its own window however long the pause is', () => {
    // THE FIELD THE CLOCK CANNOT AGE. Every trail sample is stamped with `now`
    // and dropped once `now` has moved past its life, so a frame charged
    // nothing can push a sample and can expire none: the push is the one thing
    // in `observe` that a frozen clock does not stop. Before the guard, a pause
    // grew the list by one sample per frame for as long as it lasted - 3,601
    // after this minute - and `expire`, `drawTrail` and the length sum walk
    // every one of them on every frame of the pause.
    const effects = createEffects();
    const world = createWorld();
    kickoff(world);
    setVelocity(world.ball, 600, 0);
    for (let frame = 0; frame < 12; frame += 1) {
      set(world.ball.position, 300 + frame * 10, 360);
      effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
    }
    const moving = effects.readout().trailSamples;
    expect(moving).toBe(11);

    for (let frame = 0; frame < PAUSED_FRAMES; frame += 1) {
      effects.observe({ world, scoring: NO_GOALS, elapsed: 0, reducedMotion: false });
    }
    expect(effects.readout().trailSamples).toBe(moving);
    expect(effects.readout().trailSamples).toBeLessThan(PAUSED_FRAMES);

    // THE LIVE-CLOCK CONTROL: the same frames charged their own time keep the
    // list at the window's own length, which is what "bounded by its own
    // window" means and what the pause must not be allowed to escape.
    const ticking = createEffects();
    const running = createWorld();
    kickoff(running);
    setVelocity(running.ball, 600, 0);
    for (let frame = 0; frame < PAUSED_FRAMES; frame += 1) {
      set(running.ball.position, 300 + (frame % 60), 360);
      ticking.observe({ world: running, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
    }
    expect(ticking.readout().trailSamples).toBe(11);
    expect(ticking.readout().now).toBeCloseTo(PAUSED_FRAMES / 60, 6);

    // AND REDUCED MOTION IS UNTOUCHED: every lifetime is zero there, so the
    // sample the moving frame takes expires in the same frame it was taken.
    const still = createEffects();
    const quiet = createWorld();
    setVelocity(quiet.ball, 600, 0);
    for (let frame = 0; frame < 10; frame += 1) {
      set(quiet.ball.position, 300 + frame * 10, 360);
      still.observe({ world: quiet, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: true });
    }
    expect(still.readout().trailSamples).toBe(0);
    for (let frame = 0; frame < 100; frame += 1) {
      still.observe({ world: quiet, scoring: NO_GOALS, elapsed: 0, reducedMotion: true });
    }
    expect(still.readout().trailSamples).toBe(0);
  });

  it('is what the composition root hands it while the match is paused', () => {
    // THE ROOT'S HALF, READ OUT OF ITS SOURCE. `src/main.ts` is the bundler's
    // entry and runs on import, so a unit test that imported it would boot the
    // game; the gate is three lines long and its absence is invisible to every
    // other assertion in the suite, which is why it is pinned as text.
    const root = withoutComments(readFileSync(path.join(PROJECT_ROOT, 'src/main.ts'), 'utf8'));
    expect(root).toContain("const frozen = reading.state.kind === 'PAUSED';");
    expect(root).toContain('elapsed: frozen ? 0 : elapsed,');
    // The readout is taken ONCE and both fields come off it, so the state the
    // gate reads and the scoring the layer is handed are the same frame.
    expect(root).toContain('const reading = match.readout();');
    expect(root).toContain('scoring: reading.scoring,');
    // And the shape that shipped before it, which is what this must not be.
    expect(root).not.toContain('scoring: match.readout().scoring,\n      elapsed,');
  });
});
