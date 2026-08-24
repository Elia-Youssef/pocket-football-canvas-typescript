/*
 * The same offences as core/violations.ts, in a module that is not under core.
 * The boundary test asserts this file produces ZERO messages.
 *
 * This is the control for the scope of item M3 rather than for its content. The
 * rules exist to keep the simulation headless, not to ban the platform from the
 * project: render/ and ui/ are made of exactly these calls, and a rule that
 * reported them everywhere would be switched off within a week.
 */

import { drawPitch } from '../render/pitch';
import { mountHud } from '../ui/hud';
import { createSurface } from '@js-games/engine/render';

export const width = window.innerWidth;
export const root = document;
export const ratio = devicePixelRatio;
export const frame = requestAnimationFrame;
export const stored = localStorage;
export const everything = globalThis;

export const surface: HTMLCanvasElement | null = null;
export const context: CanvasRenderingContext2D | null = null;
export const press: PointerEvent | null = null;

export const roll = Math.random();
export const bracketRoll = Math['random']();
const { random } = Math;
const aliased = Math;

export function useMath(value: unknown): unknown {
  return value;
}
useMath(Math);

export const used = [drawPitch, mountHud, createSurface, random, aliased];
