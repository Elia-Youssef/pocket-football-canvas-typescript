/**
 * Capture hooks for the demonstration session.
 *
 * THIS MODULE IS TEST TIME ONLY, AND THE TREE PROVES IT. E3 closes by a
 * scripted capture produced at the demonstration session, and the capture
 * needs to place bodies, switch brightness variants and read the scene back.
 * That is demo behaviour, not game behaviour, so it lives here, and nothing
 * in the shipping graph imports this file: the composition root's import
 * closure is asserted against it by name, and a build of the tree with this
 * module stubbed out is byte-identical to a build of the tree with it
 * present. The hooks never reach the emitted bytes; the armour tests are
 * what keep that sentence true.
 *
 * ARMOUR, NOT CLOSURE. Installing these hooks proves nothing about E3 by
 * itself. Only the capture produced at the demonstration session closes the
 * item; the hooks exist so that session can drive the scene deterministically
 * instead of poking at live coordinates by hand.
 */

import { createWorld, kickoff } from '../core/bodies';
import type { BodyKind, World } from '../core/bodies';
import { LOGICAL_WIDTH } from '../core/config';
import { set as setVec } from '../core/vec2';
import { pitchFor } from './tokens';
import type { Theme } from './tokens';
import { attachSurface } from './surface';
import { drawFrame } from './pitch';
import type { PitchCacheCell } from './pitch';
import { kickoffFacing } from './entities';
import type { Facing } from './entities';

/** The key the hooks register themselves under on the target object. */
export const CAPTURE_KEY = '__pfCapture';

/** Backing pixels per design unit, for the one transform this renderer has. */
function scaleOf(canvas: HTMLCanvasElement): number {
  return canvas.width / LOGICAL_WIDTH;
}

/** What a capture script can do to the scene. */
export interface CaptureHooks {
  /** Put a body's centre at a design coordinate, for boundary shots. */
  place(kind: BodyKind, x: number, y: number): void;
  /** Override one circle's facing, in radians of design space. */
  face(kind: Extract<BodyKind, 'player' | 'opponent'>, radians: number): void;
  /** Re-render in a chosen brightness variant. */
  variant(theme: Theme): void;
  /** Draw a frame from the hooks' own world into the canvas. */
  redraw(): void;
  /** The canvas's own encoding of its pixels. */
  snapshot(): string;
  /** Where every body is, in design coordinates. */
  state(): Readonly<Record<BodyKind, { readonly x: number; readonly y: number }>>;
}

/** What the installer cannot find for itself in a headless harness. */
export interface CaptureSeams {
  /** The canvas the composition root already created and sized. */
  readonly canvas: HTMLCanvasElement;
  /** The offscreen layer factory, for a harness with no document. */
  readonly createLayer: () => HTMLCanvasElement;
  /** The variant the hooks start in. */
  readonly theme: Theme;
}

/**
 * Install the hooks against a live surface. The scale is read off the canvas
 * rather than out of the composition root's surface object, because the
 * capture runs after boot against the finished element: for the one
 * transform this renderer has, backing pixels per design unit is exactly the
 * backing width over the logical width.
 */
export function installCaptureHooks(
  seams: CaptureSeams,
  target: Record<string, unknown> = globalThis,
): CaptureHooks {
  const surface = attachSurface(seams.canvas);
  surface.scale = scaleOf(seams.canvas);
  const world: World = createWorld();
  kickoff(world);
  const cache: PitchCacheCell = { current: null };
  let palette = pitchFor(seams.theme);
  const overrides: { player?: number; opponent?: number } = {};

  const hooks: CaptureHooks = {
    place(kind: BodyKind, x: number, y: number): void {
      setVec(world[kind].position, x, y);
    },
    face(kind: 'player' | 'opponent', radians: number): void {
      overrides[kind] = radians;
    },
    variant(theme: Theme): void {
      palette = pitchFor(theme);
    },
    redraw(): void {
      // Re-derived per redraw, not only at install: the demonstration session
      // may resize the window after the hooks went in, and a layer built at
      // the old backing store would blit at the wrong size from then on.
      surface.scale = scaleOf(seams.canvas);
      const base = kickoffFacing(world);
      const facing: Facing = {
        player: overrides.player ?? base.player,
        opponent: overrides.opponent ?? base.opponent,
      };
      drawFrame(surface, cache, world, palette, {
        facing,
        createLayer: seams.createLayer,
      });
    },
    snapshot(): string {
      return seams.canvas.toDataURL();
    },
    state() {
      return {
        player: { ...world.player.position },
        opponent: { ...world.opponent.position },
        ball: { ...world.ball.position },
      };
    },
  };
  target[CAPTURE_KEY] = hooks;
  return hooks;
}
