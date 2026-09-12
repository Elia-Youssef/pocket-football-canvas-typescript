import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createWorld, setVelocity } from '../../src/core/bodies';
import type { ScoringReadout } from '../../src/core/goals';
import { set } from '../../src/core/vec2';
import { BALL_RADIUS, CIRCLE_RADIUS } from '../../src/core/config';
import {
  MOTION_CAPTURE_KEY,
  createEffects,
  installMotionHooks,
} from '../../src/render/effects';
import { compareTrees, readTree } from '../../scripts/output-fingerprint.mjs';
import {
  buildCopiedProject,
  copyProjectGraph,
  removeCopiedProject,
} from './support/isolated-project';
import { testSourceWriteOffenders } from './support/test-source-write-hygiene';

/**
 * Armour for the motion capture hooks, and for the sentence that governs them:
 * they are test time only, and they never ship.
 *
 * ARMOUR, NOT CLOSURE: item E5 closes by the scripted capture produced at the
 * demonstration session, not by anything here. The hooks exist so that session
 * can tell which motion is live frame by frame, which is what a recording of an
 * effect the simulation produces needs and cannot read off the canvas. This
 * file pins that they work headlessly and, the load-bearing half, that the
 * shipping build neither names nor emits them: no module under `src/` outside
 * the effects layer mentions the installer, and the emitted bundle is
 * byte-identical with the installer in the tree and with it stubbed to a
 * no-op, which is the property the dist fingerprint is asked to prove.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const EFFECTS_SOURCE = path.join(PROJECT_ROOT, 'src', 'render', 'effects.ts');
const SOURCE_ROOT = path.join(PROJECT_ROOT, 'src');
const VITE = path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** The installer, and the body a stub replaces it with, byte for byte. */
const INSTALLER = 'export function installMotionHooks(';
const STUB = 'function unusedMotionHooks(';

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

/** Every module under src/, so a scan for a name cannot miss one. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const stack = [SOURCE_ROOT];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        found.push(path.relative(PROJECT_ROOT, absolute).split(path.sep).join('/'));
      }
    }
  }
  return found.sort();
}

describe('PF-12 the motion capture hooks', () => {
  it('registers under the key a capture script reads, and reports the scene', () => {
    const effects = createEffects();
    const target: Record<string, unknown> = {};
    const hooks = installMotionHooks(effects, target);
    expect(target[MOTION_CAPTURE_KEY]).toBe(hooks);
    expect(MOTION_CAPTURE_KEY).toBe('__pfMotion');

    // A staged hard collision, so the hooks have something to report.
    const world = createWorld();
    const gap = CIRCLE_RADIUS + BALL_RADIUS;
    set(world.player.position, 500, 360);
    set(world.ball.position, 500 + gap + 10, 360);
    setVelocity(world.player, 600, 0);
    effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
    set(world.player.position, 510, 360);
    set(world.ball.position, 510 + gap, 360);
    setVelocity(world.player, 0, 0);
    setVelocity(world.ball, 600, 0);
    effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });

    expect(hooks.events().map((event) => event.kind)).toEqual(['impact']);
    expect(hooks.readout().impactFlashes).toBe(1);
    expect(hooks.shake(720).x).not.toBe(0);
    // The lifetimes in force, so a capture can label the mode it recorded in.
    expect(hooks.settings(false)).toEqual({
      ballTrail: 0.18,
      impactFlash: 0.12,
      wallFlash: 0.15,
      screenShake: 0.2,
      goalCelebration: 1.2,
    });
    expect(hooks.settings(true)).toEqual({
      ballTrail: 0,
      impactFlash: 0,
      wallFlash: 0,
      screenShake: 0,
      goalCelebration: 0,
    });
    // They observe LIVE and never snapshot: a further frame moves the numbers
    // the hooks report, so a capture script reading them between two frames
    // sees the scene rather than whatever the install happened to catch.
    const before = hooks.readout().now;
    effects.observe({ world, scoring: NO_GOALS, elapsed: 1 / 60, reducedMotion: false });
    expect(hooks.readout().now).toBeGreaterThan(before);
    expect(hooks.readout().now).toBeCloseTo(3 / 60, 9);
    // And never inject: the event log they hand out is the layer's own array
    // rather than a copy the hooks could have written to.
    expect(hooks.events()).toBe(effects.events());
  });

  it('is named by no module in the shipping graph', () => {
    const named = sourceFiles().filter(
      (relative) =>
        relative !== 'src/render/effects.ts' &&
        readFileSync(path.join(PROJECT_ROOT, relative), 'utf8').includes('installMotionHooks'),
    );
    expect(named).toEqual([]);
    // A sweep over nothing passes. This is the part of it that cannot: the
    // walk really did read the whole of src/, the entry among it.
    expect(sourceFiles()).toContain('src/main.ts');
    expect(sourceFiles().length).toBeGreaterThan(10);
    // And the effects module really does carry the name, so the exclusion
    // above is an exclusion of something rather than of nothing.
    expect(readFileSync(EFFECTS_SOURCE, 'utf8')).toContain(INSTALLER);
  });

  it('emits byte-identical bytes with the installer stubbed out', { timeout: 240_000 }, () => {
    const copied = copyProjectGraph(PROJECT_ROOT, 'pf12-motion');
    try {
      const builtWith = readTree(buildCopiedProject(copied, VITE, 'with-hooks'));
      // The bundle is the game, so the absences asserted here are absences
      // from something rather than from an empty directory.
      const emitted = [...builtWith.keys()]
        .filter((name) => name.endsWith('.js'))
        .map((name) => readFileSync(path.join(copied.root, 'with-hooks', name), 'utf8'))
        .join('\n');
      expect(emitted.length).toBeGreaterThan(1000);
      expect(emitted).toContain('pocket-football');
      expect(emitted).not.toContain(MOTION_CAPTURE_KEY);
      expect(emitted).not.toContain('installMotionHooks');
      // The export is what a bundler follows. Take it away and the function is
      // unreachable from anywhere, so anything it contributed to the emitted
      // bytes would show up as a difference below.
      const copiedEffects = path.join(copied.root, 'src', 'render', 'effects.ts');
      const original = readFileSync(copiedEffects, 'utf8');
      expect(original).toContain(INSTALLER);
      expect(testSourceWriteOffenders(PROJECT_ROOT)).toEqual([]);
      writeFileSync(copiedEffects, original.replace(INSTALLER, STUB), 'utf8');
      const builtWithout = readTree(buildCopiedProject(copied, VITE, 'without-hooks'));
      expect(builtWith.size).toBeGreaterThan(1);
      expect(builtWithout.size).toBe(builtWith.size);
      const comparison = compareTrees(builtWith, builtWithout);
      expect(comparison.identical, JSON.stringify(comparison.differing)).toBe(true);
    } finally {
      removeCopiedProject(copied);
    }
  });
});
