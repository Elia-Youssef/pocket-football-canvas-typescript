/// <reference lib="dom" /> // @expect core-boundary/no-dom:domLib

/*
 * The deliberately violating fixture item M3 requires. Every line below is a
 * real offence against the core boundary, and every one carries an `@expect`
 * marker naming the rule id, and the message id where the distinction matters.
 *
 * tests/unit/core-boundary.test.ts lints this file through the shipping
 * eslint.config.js and asserts in BOTH directions: every marked line is
 * reported by the rule its marker names, and nothing unmarked is reported at
 * all. A fixture checked in one direction only is how a rule quietly grows a
 * false positive and how a marker quietly stops matching anything.
 *
 * This file is excluded from tsc by tsconfig.json and from the shipping lint
 * run by the --ignore-pattern on the lint script. It is linted by that one test
 * and nowhere else.
 */

// -- no-forbidden-imports: the presentation layers ------------------------

import { drawPitch } from '../render/pitch'; // @expect core-boundary/no-forbidden-imports:surfaceSegment
import { mountHud } from '../ui/hud'; // @expect core-boundary/no-forbidden-imports:surfaceSegment
import type { Surface } from '../render/surface'; // @expect core-boundary/no-forbidden-imports:surfaceSegment
export { drawArrow } from '../render/arrow'; // @expect core-boundary/no-forbidden-imports:surfaceSegment
export * from '../ui/panel'; // @expect core-boundary/no-forbidden-imports:surfaceSegment

// -- no-forbidden-imports: the shared engine renderer ---------------------

import { createSurface } from '@js-games/engine/render'; // @expect core-boundary/no-forbidden-imports:engineRenderer
import type { Pass } from '@js-games/engine/render/passes'; // @expect core-boundary/no-forbidden-imports:engineRenderer

// -- no-forbidden-imports: the routes that are easy to forget -------------

export const deferred = import('../render/effects'); // @expect core-boundary/no-forbidden-imports:surfaceSegment
export const legacy = require('../ui/legacy-panel'); // @expect core-boundary/no-forbidden-imports:surfaceSegment
export type Deep = import('../render/pitch').PitchStyle; // @expect core-boundary/no-forbidden-imports:surfaceSegment

export const usedImports = [drawPitch, mountHud, createSurface];
export type UsedTypes = Surface | Pass;

// -- no-dom: value positions ----------------------------------------------

export const width = window.innerWidth; // @expect core-boundary/no-dom
export const root = document; // @expect core-boundary/no-dom
export const platform = navigator; // @expect core-boundary/no-dom
export const ratio = devicePixelRatio; // @expect core-boundary/no-dom
export const stored = localStorage; // @expect core-boundary/no-dom
export const loader = fetch; // @expect core-boundary/no-dom
export const everything = globalThis; // @expect core-boundary/no-dom
export const here = self; // @expect core-boundary/no-dom
export const frame = requestAnimationFrame; // @expect core-boundary/no-dom
export const later = setTimeout; // @expect core-boundary/no-dom
export const watcher = ResizeObserver; // @expect core-boundary/no-dom
export const sound = AudioContext; // @expect core-boundary/no-dom
export const draws = Path2D; // @expect core-boundary/no-dom
export const entropy = crypto; // @expect core-boundary/no-dom

// -- no-dom: type positions, which compile away and leave no trace --------

export const surface: HTMLCanvasElement | null = null; // @expect core-boundary/no-dom
export const panel: HTMLDivElement | null = null; // @expect core-boundary/no-dom
export const context: CanvasRenderingContext2D | null = null; // @expect core-boundary/no-dom
export const matrix: DOMMatrix | null = null; // @expect core-boundary/no-dom
export const press: PointerEvent | null = null; // @expect core-boundary/no-dom
export const query: MediaQueryList | null = null; // @expect core-boundary/no-dom
export type Ratio = typeof devicePixelRatio; // @expect core-boundary/no-dom

// -- no-dom: the wall clock and the microtask queue -----------------------

export const now = Date.now(); // @expect core-boundary/no-dom
export const stamped = new Date('2001-09-09T01:46:40Z'); // @expect core-boundary/no-dom
queueMicrotask((): undefined => undefined); // @expect core-boundary/no-dom

// -- no-dom: names no hand-written list had ------------------------------
//
// Each of these passed every gate this project has, because a denylist reports
// what somebody remembered. They are reported now because the DOM library the
// build compiles against declares them and no ES library file does.

export type Child = ChildNode; // @expect core-boundary/no-dom
export type Listen = EventListener; // @expect core-boundary/no-dom
export const blob: Blob | null = null; // @expect core-boundary/no-dom
export const log = console; // @expect core-boundary/no-dom

// -- no-dom: a name the library does not have YET -------------------------
//
// AND THIS IS WHY THE FAMILY PREFIXES STAY. The derived set covers every name
// the installed type library declares, which is most of the platform and all of
// the lines above. It cannot cover a name that library has not caught up with:
// a platform surface ships before the definitions do, and this one is not in
// lib.dom.d.ts today. The prefix is what reports it, and it is the only line in
// this fixture that the prefix alone reports, which is what makes the prefix
// list a gate rather than a comment.

export const future: HTMLModelElement | null = null; // @expect core-boundary/no-dom

// -- no-math-random: every route to the function --------------------------

export const roll = Math.random(); // @expect core-boundary/no-math-random:mathRandom
export const bracketRoll = Math['random'](); // @expect core-boundary/no-math-random:mathRandom
const { random } = Math; // @expect core-boundary/no-math-random:mathDestructure
const { random: renamed } = Math; // @expect core-boundary/no-math-random:mathDestructure
const { ...everyKey } = Math; // @expect core-boundary/no-math-random:mathDestructure
const aliased = Math; // @expect core-boundary/no-math-random:mathAlias

let holder: unknown;
holder = Math; // @expect core-boundary/no-math-random:mathAlias

const chosenKey = 'random';
export const computed = Math[chosenKey]; // @expect core-boundary/no-math-random:mathComputed

export function useMath(value: unknown): unknown {
  return value;
}
useMath(Math); // @expect core-boundary/no-math-random:mathCapture

export const captured = [random, renamed, everyKey, aliased, holder];

// -- a violating line may not switch off its own detection ----------------

// eslint-disable-next-line core-boundary/no-math-random
export const suppressed = Math.random(); // @expect core-boundary/no-math-random:mathRandom
