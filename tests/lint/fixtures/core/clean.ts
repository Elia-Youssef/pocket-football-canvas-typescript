/*
 * The other half of the fixture, and the half that decides whether the boundary
 * rules are usable. Every line here is a near miss: it contains the letters, or
 * the shape, or the name, and it is not an offence. The boundary test asserts
 * this file produces ZERO messages.
 *
 * A rule that only has a violating fixture is a rule nobody can tell apart from
 * a rule that reports everything.
 */

// Specifiers that contain the letters and do not name the layer. Segment
// equality is what separates them, and a substring match would fail all three.
import { readCache } from '../render-cache/store';
import { turnPrompt } from '../guidance/ui-copy';
import { passOrder } from '../rendering-order';
import { measureText } from '@js-games/engine/render-utils';

// A locally declared type whose name starts with a platform family prefix. The
// rule reports names that resolve to NOTHING, so a declaration is the answer.
export interface HTMLPanelSpec {
  columns: number;
}

export interface CanvasSpec {
  logicalWidth: number;
  logicalHeight: number;
}

export type DOMLikeBox = { left: number; top: number };

// A parameter named after a global. Shadowing is not a violation, and a text
// scan cannot tell this from the real thing.
export function measurePanel(window: HTMLPanelSpec): number {
  return window.columns;
}

// An ordinary local with a global's name, in a module that never reaches the
// ambient one.
const document = { title: 'pitch' };
export const documentTitle = document.title;

// A locally declared value with an event family name, used as a plain record.
const PointerBudget = { maxPointers: 2 };
export const pointerBudget = PointerBudget.maxPointers;

// Math is ordinary arithmetic here. Named members and a destructure whose keys
// are all known and none of them random.
export function stopBelowThreshold(speed: number, threshold: number): number {
  return Math.abs(speed) <= threshold ? 0 : speed;
}

export const stepsPerSecond = Math.floor(120.4);
export const bracketFloor = Math['floor'](3.7);

const { abs, max, min, hypot } = Math;
export const clampSpeed = (value: number, cap: number): number =>
  min(max(abs(value), 0), cap);
export const distance = (dx: number, dy: number): number => hypot(dx, dy);

export const spec: CanvasSpec = { logicalWidth: 1280, logicalHeight: 720 };
export const box: DOMLikeBox = { left: 0, top: 0 };
export const imported = [readCache, turnPrompt, passOrder, measureText];
