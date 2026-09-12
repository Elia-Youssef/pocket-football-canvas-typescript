import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createWorld } from '../../src/core/bodies';
import { CAPTURE_KEY, installCaptureHooks } from '../../src/render/capture';
import { compareTrees, readTree } from '../../scripts/output-fingerprint.mjs';
import { asCanvas, CanvasRecorder, fakeCanvas } from './support/canvas-recorder';
import {
  buildCopiedProject,
  copyProjectGraph,
  removeCopiedProject,
} from './support/isolated-project';
import { testSourceWriteOffenders } from './support/test-source-write-hygiene';

/**
 * Armour for the capture hooks, and for the sentence that governs them: they
 * are test time only, and they never ship.
 *
 * ARMOUR, NOT CLOSURE: E3 closes by the scripted capture produced at the
 * demonstration session, not by anything here. The hooks exist so that
 * session can drive the scene; this file pins that they work headlessly and,
 * the load-bearing half, that the shipping build neither imports nor emits
 * them: the import closure of the composition root is asserted against the
 * capture module by name, and the emitted bundle is byte-identical with the
 * hooks in the tree and with them stubbed out, which is the property the
 * contract asks the dist fingerprint to prove.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const VITE = path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * The import closure of a src module, by reading its import specifiers and
 * following the relative ones. Not a bundler: just enough of one to answer
 * "does the shipping entry reach this file", which is the question.
 */
function importClosure(entry: string): Set<string> {
  const closure = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      break;
    }
    const absolute = path.join(PROJECT_ROOT, current);
    if (!existsSync(absolute)) {
      continue;
    }
    const text = readFileSync(absolute, 'utf8');
    const specifiers = [
      ...text.matchAll(/\bfrom\s+'([^']+)'/g),
      ...text.matchAll(/\bimport\s+'([^']+)'/g),
    ].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      let resolved = path
        .posix.join(path.posix.dirname(current), specifier)
        .replace(/\\/g, '/');
      if (!path.extname(resolved).endsWith('.ts')) {
        resolved += '.ts';
      }
      if (!closure.has(resolved)) {
        closure.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return closure;
}

describe('PF-11 the capture hooks', () => {
  it('registers under the capture key and drives the live canvas', () => {
    const recorder = new CanvasRecorder();
    const canvas = fakeCanvas(recorder);
    canvas.width = 1280;
    canvas.height = 720;
    canvas.style['width'] = '1280px';
    const layerRecorder = new CanvasRecorder();
    const target: Record<string, unknown> = {};
    const hooks = installCaptureHooks(
      {
        canvas: asCanvas(canvas),
        createLayer: () => asCanvas(fakeCanvas(layerRecorder)),
        theme: 'dark',
      },
      target,
    );
    expect(target[CAPTURE_KEY]).toBe(hooks);
    expect(CAPTURE_KEY).toBe('__pfCapture');
    // The hooks' scale is derived from the canvas itself, not from the
    // composition root: the rebuilt layer carries the transform that scale
    // produces, and at 1280 backing px that is exactly one.
    expect(hooks.state().ball).toEqual({ x: 640, y: 360 });
    hooks.redraw();
    expect(layerRecorder.ops[0]?.args).toEqual([1, 0, 0, -1, 0, 720]);
    // A frame went through: blit, then the entity pass, on the canvas.
    expect(recorder.calls('drawImage')).toHaveLength(1);
    expect(recorder.calls('fillText').map((op) => op.args[0])).toEqual(['P', 'O']);
    // Placement moves a body for a boundary shot, and the redraw follows it.
    hooks.place('ball', 120, 100);
    expect(hooks.state().ball).toEqual({ x: 120, y: 100 });
    hooks.redraw();
    const ballArc = recorder.calls('arc').at(-1)?.args ?? [];
    expect(ballArc[0]).toBe(120);
    expect(ballArc[1]).toBe(100);
    // A facing override moves the marker wedge on the next frame. Each frame
    // records three moveTos - two marker tips and the panel pentagon - so the
    // player tip of the last frame is third from the end.
    hooks.face('player', -Math.PI / 2);
    hooks.redraw();
    const tip = recorder.calls('moveTo').at(-3)?.args ?? [];
    expect(tip[0]).toBeCloseTo(300, 6);
    expect(tip[1]).toBeCloseTo(360 - 34 * 0.95, 6);
    // A window resize after install: the scale is re-derived per redraw, so
    // the rebuilt layer carries the new backing store's transform, not the
    // one the hooks were installed with.
    canvas.width = 1600;
    hooks.redraw();
    const transform = layerRecorder.calls('setTransform').at(-1)?.args ?? [];
    expect(transform[0]).toBeCloseTo(1600 / 1280, 12);
    expect(transform[3]).toBeCloseTo(-1600 / 1280, 12);
    expect(transform[5]).toBeCloseTo(720 * (1600 / 1280), 12);
    hooks.snapshot();
    expect(canvas.snapshots).toBe(1);
  });

  it('re-renders in the other brightness variant, rebuilding the stale layer', () => {
    const recorder = new CanvasRecorder();
    const canvas = fakeCanvas(recorder);
    canvas.width = 1280;
    const layers: CanvasRecorder[] = [];
    const hooks = installCaptureHooks(
      {
        canvas: asCanvas(canvas),
        createLayer: () => {
          const layer = new CanvasRecorder();
          layers.push(layer);
          return asCanvas(fakeCanvas(layer));
        },
        theme: 'dark',
      },
      {},
    );
    hooks.redraw();
    expect(layers).toHaveLength(1);
    hooks.variant('light');
    hooks.redraw();
    // The palette identity changed, so the layer was rebuilt exactly once,
    // and the second blit came through as before.
    expect(layers).toHaveLength(2);
    expect(recorder.calls('drawImage')).toHaveLength(2);
    expect(hooks.state().ball).toEqual({ x: 640, y: 360 });
    // And the hooks' own world is a fresh kickoff, not the composition
    // root's: nothing the capture does can move the game's bodies.
    expect(createWorld().ball.position).toEqual({ x: 640, y: 360 });
  });

  it('stays out of the composition root import closure', () => {
    const closure = importClosure('src/main.ts');
    // Sanity first: the walker reaches the whole shipping graph, so a clean
    // answer below is an answer and not an empty walk.
    for (const expected of [
      'src/main.ts',
      'src/ui/tokens.css.ts',
      'src/render/surface.ts',
      'src/render/pitch.ts',
      'src/render/entities.ts',
      'src/render/tokens.ts',
      'src/core/bodies.ts',
      'src/core/config.ts',
    ]) {
      if (expected === 'src/ui/tokens.css.ts') {
        // The stylesheet resolves as a side-effect import; the walker
        // appends .ts to it, and the suffix is the assertion: it was seen.
        expect([...closure].some((name) => name.startsWith('src/ui/tokens.css'))).toBe(
          true,
        );
      } else {
        expect(closure.has(expected), expected).toBe(true);
      }
    }
    expect(closure.has('src/render/capture.ts')).toBe(false);
  });

  it('emits byte-identical bytes with the hooks stubbed out', { timeout: 240_000 }, () => {
    const copied = copyProjectGraph(PROJECT_ROOT, 'pf11-capture');
    try {
      const builtWith = readTree(buildCopiedProject(copied, VITE, 'with-hooks'));
      expect(testSourceWriteOffenders(PROJECT_ROOT)).toEqual([]);
      writeFileSync(path.join(copied.root, 'src', 'render', 'capture.ts'), 'export {};\n');
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
