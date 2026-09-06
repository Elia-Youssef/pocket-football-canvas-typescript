import { describe, expect, it, vi } from 'vitest';

import { CASUAL, OPPONENT_STREAM, respond } from '../../src/core/ai';
import type { AimPreview, AimState } from '../../src/core/aiming';
import {
  ANGLE_FINE_HOLD_DEGREES,
  ANGLE_FINE_TAP_DEGREES,
  ANGLE_HOLD_FROM_DEGREES,
  ANGLE_HOLD_TO_DEGREES,
  ANGLE_TAP_DEGREES,
  DEGREES_PER_TURN,
  HOLD_DELAY,
  HOLD_RAMP,
  OPENING_POWER,
  POWER_HOLD_RATE,
  POWER_TAP,
  aimDegrees,
  aimPercent,
  aimPreviewFor,
  aimTowardPoint,
  degreesToRadians,
  holdSweptDegrees,
  holdSweptFineDegrees,
  holdSweptPower,
  normaliseDegrees,
  openingAim,
  radiansToDegrees,
  reachFor,
} from '../../src/core/aiming';
import {
  DELTA_CEILING,
  MAX_DRAG,
  MIN_DRAG,
  RESUME_GAP,
  power01,
} from '../../src/core/config';
import { createMatch } from '../../src/core/match';
import type { Match, MatchOptions } from '../../src/core/match';
import { createRng } from '../../src/core/rng';
import { set } from '../../src/core/vec2';
import { attachAimInput } from '../../src/render/input';
import type { AimInput } from '../../src/render/input';
import { createAimControls } from '../../src/ui/components/aim-controls';
import type { AimControls } from '../../src/ui/components/aim-controls';
import { censusControls, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement, InstalledDocument } from './support/chrome-dom';

/**
 * The two no-drag aim models, SPEC sections 5.0 and 5.1, and the two matches
 * they each have to be able to play on their own.
 *
 * WHAT LIVES HERE AND WHY. Items C11 and G5 are graded in the browser, over
 * the built bundle, because "real visible controls" and "a real Tab walk" are
 * claims about a document and only a browser has one. Two of their clauses are
 * not: SPEC section 5.1's hold rates have to be identical at EVERY frame rate
 * and on an unstable clock, and no browser lets a test choose either; and "a
 * full match" needs a match that ends, which the shipped composition cannot
 * reach until the modes give one a clock or a target. Both are driven here
 * instead, over the real modules the browser runs - the real match, the real
 * opponent, the real input module and the real controls - and the report
 * discloses the split rather than letting the browser suite imply it covered
 * them. The full-match half of it RE-HOMES AT PF-9, which owns the modes and
 * the opponent driver together; the frame-rate half stays here for good,
 * because a browser cannot choose its own frame rate.
 *
 * NO DRAGGING, PROVED BY THE HARNESS ITSELF. The tap loop below fires
 * `pointerdown` and `pointerup` at ONE point and never a `pointermove`, and
 * the fake surface counts every event type it was given, so "no dragging
 * movement at any point" is a property the test can be held to rather than a
 * sentence in its docstring. The keyboard loop fires no pointer event at all.
 *
 * EVERY THRESHOLD IS PINNED BY LITERAL. Asserting a rate against the symbol
 * that defines it passes for whatever value the symbol takes, and the numbers
 * here are SPEC section 5.1's own.
 */

// ---------------------------------------------------------------------------
// The stand-ins. The unit suite runs headless (vitest.config.ts), so the
// alternative to a stand-in is not a real canvas, it is no test.
// ---------------------------------------------------------------------------

interface FakePointer {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface FakeCanvas {
  readonly element: HTMLCanvasElement;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  /** Every event type this surface was ever given, in order. */
  readonly seen: string[];
  fire(type: string, event: FakePointer): void;
}

function fakeCanvas(): FakeCanvas {
  const handlers = new Map<string, (event: FakePointer) => void>();
  const style: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const seen: string[] = [];
  let capture: number | null = null;
  const element = {
    style,
    dataset,
    addEventListener(type: string, handler: (event: FakePointer) => void): void {
      handlers.set(type, handler);
    },
    getBoundingClientRect(): {
      left: number;
      top: number;
      width: number;
      height: number;
    } {
      return { left: 0, top: 0, width: 1280, height: 720 };
    },
    setPointerCapture(pointerId: number): void {
      capture = pointerId;
    },
    hasPointerCapture(pointerId: number): boolean {
      return capture === pointerId;
    },
    releasePointerCapture(pointerId: number): void {
      if (capture === pointerId) {
        capture = null;
      }
    },
  };
  return {
    element: element as unknown as HTMLCanvasElement,
    style,
    dataset,
    seen,
    fire(type: string, event: FakePointer): void {
      seen.push(type);
      handlers.get(type)?.(event);
    },
  };
}

interface FakeKey {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
}

interface FakeFrame {
  readonly element: HTMLElement;
  /** Whether the platform would report this focus as keyboard focus. */
  focusVisible: boolean;
  /** The keys whose default this surface took off the page, in order. */
  readonly prevented: string[];
  fire(type: string, event?: FakeKey): void;
  bound(): string[];
}

function fakeFrame(): FakeFrame {
  const handlers = new Map<string, (event: unknown) => void>();
  const prevented: string[] = [];
  const state = { focusVisible: true };
  const element = {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      handlers.set(type, handler);
    },
    matches(selector: string): boolean {
      return selector === ':focus-visible' && state.focusVisible;
    },
  };
  return {
    element: element as unknown as HTMLElement,
    get focusVisible(): boolean {
      return state.focusVisible;
    },
    set focusVisible(next: boolean) {
      state.focusVisible = next;
    },
    prevented,
    fire(type: string, event: FakeKey = { key: '' }): void {
      handlers.get(type)?.({
        ...event,
        shiftKey: event.shiftKey ?? false,
        repeat: event.repeat ?? false,
        preventDefault: (): void => {
          prevented.push(event.key);
        },
      });
    },
    bound(): string[] {
      return [...handlers.keys()].sort();
    },
  };
}

// ---------------------------------------------------------------------------
// One rig, wired exactly the way src/main.ts wires the real one.
// ---------------------------------------------------------------------------

interface Rig {
  readonly installed: InstalledDocument;
  readonly match: Match;
  readonly canvas: FakeCanvas;
  readonly frame: FakeFrame;
  readonly input: AimInput;
  readonly controls: AimControls;
  readonly root: FakeElement;
  readonly launches: AimState[];
  readonly pauses: number[];
  /** One frame of the composition root's loop, in its order. */
  step(delta: number): void;
  preview(): AimPreview | null;
  /** The aim as the controls and the announcement state it. */
  shown(): { degrees: number; percent: number };
  /** A press and a release at one design point, with no movement between. */
  tap(designX: number, designY: number): void;
  press(marker: string): void;
  close(): void;
}

function rig(options: MatchOptions = {}, started = true): Rig {
  const installed = installFakeDocument();
  const match = createMatch(options);
  const canvas = fakeCanvas();
  const frame = fakeFrame();
  const launches: AimState[] = [];
  const pauses: number[] = [];
  const input = attachAimInput({
    canvas: canvas.element,
    world: match.world,
    state: () => match.readout().state,
    onLaunch: (aim: AimState) => {
      launches.push(aim);
      match.dispatch({ kind: 'launch', angle: aim.angleRad, power: aim.power01 });
    },
    surface: frame.element,
    onPause: () => {
      pauses.push(1);
      match.dispatch({ kind: 'pause' });
    },
  });
  const controls = createAimControls({
    onAim: (angleRad: number, power01Value: number) => {
      input.setAim(angleRad, power01Value);
    },
    onLaunch: () => {
      input.launch();
    },
    onCancel: () => {
      input.cancel();
    },
  });
  if (started) {
    match.dispatch({ kind: 'start' });
  }
  const root = controls.root as unknown as FakeElement;
  return {
    installed,
    match,
    canvas,
    frame,
    input,
    controls,
    root,
    launches,
    pauses,
    step(delta: number): void {
      match.update(delta);
      input.refresh(delta);
      controls.sync(delta, input.preview(), input.allowed());
    },
    preview: () => input.preview(),
    shown(): { degrees: number; percent: number } {
      return {
        degrees: Number(findByMarker(root, 'aim-angle')?.value ?? ''),
        percent: Number(findByMarker(root, 'power')?.value ?? ''),
      };
    },
    tap(designX: number, designY: number): void {
      const at = { pointerId: 7, clientX: designX, clientY: 720 - designY };
      canvas.fire('pointerdown', at);
      canvas.fire('pointerup', at);
    },
    press(marker: string): void {
      findByMarker(root, marker)?.dispatch('click');
    },
    close(): void {
      installed.restore();
    },
  };
}

/**
 * Drive `seconds` of real time as ordinary frames. A single frame longer than
 * SPEC section 6.2's delta ceiling is a HITCH, and the hold reads a hitch the
 * way the simulation does, so a test that wants a second and a quarter of hold
 * has to hand it over the way a browser would: in frames.
 */
function advance(harness: Rig, seconds: number, frame = 0.125): void {
  let left = seconds;
  while (left > 1e-9) {
    const take = Math.min(frame, left);
    harness.step(take);
    left -= take;
  }
}

/** The unrounded aim direction, which is what a rate has to be measured on. */
function liveDegrees(input: AimInput): number {
  const preview = input.preview();
  if (preview === null) {
    throw new Error('there is no aim to measure');
  }
  return radiansToDegrees(preview.aim.angleRad);
}

// ---------------------------------------------------------------------------

describe('PF-6 the SPEC 5.1 rates, pinned by literal', () => {
  it('states every step and rate as the table states it', () => {
    expect(ANGLE_TAP_DEGREES).toBe(3);
    expect(ANGLE_FINE_TAP_DEGREES).toBe(1);
    expect(ANGLE_HOLD_FROM_DEGREES).toBe(60);
    expect(ANGLE_HOLD_TO_DEGREES).toBe(240);
    expect(ANGLE_FINE_HOLD_DEGREES).toBe(20);
    expect(POWER_TAP).toBe(0.05);
    expect(POWER_HOLD_RATE).toBe(0.4);
    expect(HOLD_DELAY).toBe(0.25);
    expect(HOLD_RAMP).toBe(1);
    expect(OPENING_POWER).toBe(0.6);
    expect(DEGREES_PER_TURN).toBe(360);
  });

  it('pays out nothing at all through the 250 ms delay', () => {
    for (const held of [0, 0.1, 0.2, 0.249, 0.25]) {
      expect(holdSweptDegrees(held), `held ${String(held)}`).toBe(0);
      expect(holdSweptFineDegrees(held), `held ${String(held)}`).toBe(0);
      expect(holdSweptPower(held), `held ${String(held)}`).toBe(0);
    }
  });

  it('ramps linearly from 60 to 240 degrees per second over one second', () => {
    // The integral of a rate rising linearly from 60 to 240 over a second:
    // a quarter of the way in the rate is 105, and the area under it is
    // 60 * 0.25 + 90 * 0.0625 = 20.625.
    expect(holdSweptDegrees(0.25 + 0.25)).toBeCloseTo(20.625, 10);
    expect(holdSweptDegrees(0.25 + 0.5)).toBeCloseTo(52.5, 10);
    expect(holdSweptDegrees(0.25 + 0.75)).toBeCloseTo(95.625, 10);
    // The whole ramp is its mean rate, which is 150 degrees per second.
    expect(holdSweptDegrees(1.25)).toBeCloseTo(150, 10);
  });

  it('holds 240 degrees per second after the ramp, and sweeps a turn in 2.125 s', () => {
    expect(holdSweptDegrees(1.25 + 0.5)).toBeCloseTo(150 + 120, 10);
    // SPEC section 5.1's own worked example: 0.25 s of delay, 150 degrees of
    // ramp, then 210 degrees at the top rate. It is exact, not close.
    expect(holdSweptDegrees(2.125)).toBe(360);
    // Which is the "about 2.1 seconds" the section quotes, and no other
    // reading of the ramp lands there.
    expect(holdSweptDegrees(2.1)).toBeLessThan(360);
    expect(holdSweptDegrees(2.15)).toBeGreaterThan(360);
  });

  it('gives the fine modifier a constant 20 degrees per second and no ramp', () => {
    expect(holdSweptFineDegrees(1.25)).toBeCloseTo(20, 10);
    expect(holdSweptFineDegrees(2.25)).toBeCloseTo(40, 10);
    // No ramp means the second second is worth exactly what the first was,
    // which is the half of the row that "no ramp" states.
    expect(holdSweptFineDegrees(3.25) - holdSweptFineDegrees(2.25)).toBeCloseTo(20, 10);
    expect(holdSweptFineDegrees(2.25) - holdSweptFineDegrees(1.25)).toBeCloseTo(20, 10);
  });

  it('gives a held power key 40 points a second after the same delay', () => {
    expect(holdSweptPower(1.25)).toBeCloseTo(0.4, 10);
    expect(holdSweptPower(2.75)).toBeCloseTo(1, 10);
    expect(holdSweptPower(0.75) * 100).toBeCloseTo(20, 10);
  });

  it('reads a delta it cannot use as no time at all', () => {
    for (const held of [Number.NaN, Number.POSITIVE_INFINITY * 0, -5, -0.001]) {
      expect(holdSweptDegrees(held)).toBe(0);
      expect(holdSweptFineDegrees(held)).toBe(0);
      expect(holdSweptPower(held)).toBe(0);
    }
  });
});

describe('PF-6 a discrete aim draws the same arrow a drag does', () => {
  it('derives the reach from the strength, as the exact inverse of power01', () => {
    expect(reachFor(0)).toBe(MIN_DRAG);
    expect(reachFor(1)).toBe(MAX_DRAG);
    expect(reachFor(0)).toBe(30);
    expect(reachFor(1)).toBe(180);
    for (const strength of [0, 0.05, 0.25, 0.5, 0.6, 0.75, 1]) {
      expect(power01(reachFor(strength)), `strength ${String(strength)}`).toBeCloseTo(
        strength,
        12,
      );
    }
    // Out of range in either direction is held to the scale, not extrapolated.
    expect(reachFor(-1)).toBe(30);
    expect(reachFor(2)).toBe(180);
    expect(reachFor(Number.NaN)).toBe(30);
  });

  it('is never the sub-minimum case, because the scale starts at the minimum', () => {
    for (const strength of [0, 0.5, 1]) {
      const preview = aimPreviewFor({ angleRad: 0, power01: strength });
      expect(preview.launchable, `strength ${String(strength)}`).toBe(true);
      expect(preview.reach).toBeGreaterThanOrEqual(MIN_DRAG);
      expect(preview.aim.power01).toBe(strength);
    }
  });

  it('folds every angle into one turn, and rounds the readout to a direction', () => {
    expect(normaliseDegrees(0)).toBe(0);
    expect(normaliseDegrees(360)).toBe(0);
    expect(normaliseDegrees(-90)).toBe(270);
    expect(normaliseDegrees(450)).toBe(90);
    expect(normaliseDegrees(-720.5)).toBeCloseTo(359.5, 10);
    expect(normaliseDegrees(Number.NaN)).toBe(0);
    expect(radiansToDegrees(Math.PI)).toBeCloseTo(180, 10);
    expect(radiansToDegrees(-Math.PI / 2)).toBeCloseTo(270, 10);
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI, 12);
    // A rounding that lands on a whole turn is the first direction, not a
    // three-hundred-and-sixtieth one the slider has no room for.
    expect(aimDegrees({ angleRad: degreesToRadians(359.7), power01: 0 })).toBe(0);
    expect(aimDegrees({ angleRad: degreesToRadians(13.146), power01: 0 })).toBe(13);
    expect(aimPercent({ angleRad: 0, power01: 0.6 })).toBe(60);
    expect(aimPercent({ angleRad: 0, power01: 0.055 })).toBe(6);
  });

  it('aims a tap toward the point and never opposite it', () => {
    // The drag is a slingshot and a tap is not. Four quadrants, because a
    // mirrored reading agrees with the correct one in exactly two of them.
    expect(radiansToDegrees(aimTowardPoint(0, 0, 10, 0))).toBeCloseTo(0, 10);
    expect(radiansToDegrees(aimTowardPoint(0, 0, 0, 10))).toBeCloseTo(90, 10);
    expect(radiansToDegrees(aimTowardPoint(0, 0, -10, 0))).toBeCloseTo(180, 10);
    expect(radiansToDegrees(aimTowardPoint(0, 0, 0, -10))).toBeCloseTo(270, 10);
    expect(radiansToDegrees(aimTowardPoint(100, 100, 200, 200))).toBeCloseTo(45, 10);
    expect(radiansToDegrees(aimTowardPoint(0, 0, Number.NaN, 10))).toBeCloseTo(90, 10);
  });

  it('opens a keyboard aim at the ball, at 60 percent', () => {
    const match = createMatch();
    const opening = openingAim(match.world);
    // SPEC section 3 puts the player at x 300 and the ball at the centre spot
    // on the same midline, so the opening direction is straight down the pitch.
    expect(radiansToDegrees(opening.angleRad)).toBeCloseTo(0, 10);
    expect(opening.power01).toBe(0.6);
    expect(aimPercent(opening)).toBe(60);

    // At kickoff the player, the ball and the opponent share a line, so that
    // reading alone cannot tell an aim at the BALL from an aim at the other
    // circle. Moving the ball off the line is what separates them.
    set(match.world.ball.position, 500, 560);
    const moved = openingAim(match.world);
    expect(radiansToDegrees(moved.angleRad)).toBeCloseTo(45, 10);
    expect(radiansToDegrees(openingAim(match.world).angleRad)).not.toBeCloseTo(
      radiansToDegrees(
        aimTowardPoint(
          match.world.player.position.x,
          match.world.player.position.y,
          match.world.opponent.position.x,
          match.world.opponent.position.y,
        ),
      ),
      1,
    );
  });
});

describe('PF-6 the keyboard model, item G5', () => {
  it('binds its keys to the play surface and never to the document', () => {
    const harness = rig();
    try {
      // The surface owns the keys, so a key pressed anywhere else in the
      // document reaches nothing here and the page keeps its own behaviour.
      expect(harness.frame.bound()).toEqual(['blur', 'focus', 'keydown', 'keyup']);
    } finally {
      harness.close();
    }
  });

  it('enters aim mode on keyboard focus, and not on a focus a press produced', () => {
    const harness = rig();
    try {
      harness.frame.focusVisible = false;
      harness.frame.fire('focus');
      expect(harness.preview()).toBeNull();
      expect(harness.canvas.dataset['pfAim']).toBe('idle');

      harness.frame.focusVisible = true;
      harness.frame.fire('focus');
      const preview = harness.preview();
      expect(preview).not.toBeNull();
      expect(aimPercent(preview?.aim ?? { angleRad: 0, power01: 0 })).toBe(60);
      expect(harness.canvas.dataset['pfAim']).toBe('aiming');
    } finally {
      harness.close();
    }
  });

  it('turns by the tap step, and by the fine step with the modifier', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      expect(liveDegrees(harness.input)).toBeCloseTo(0, 10);

      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      expect(liveDegrees(harness.input)).toBeCloseTo(3, 10);
      harness.frame.fire('keyup', { key: 'ArrowLeft' });

      harness.frame.fire('keydown', { key: 'ArrowRight' });
      harness.frame.fire('keyup', { key: 'ArrowRight' });
      expect(liveDegrees(harness.input)).toBeCloseTo(0, 10);

      harness.frame.fire('keydown', { key: 'ArrowRight' });
      harness.frame.fire('keyup', { key: 'ArrowRight' });
      // Right of zero is the far side of the turn, not a negative direction.
      expect(liveDegrees(harness.input)).toBeCloseTo(357, 10);

      harness.frame.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
      harness.frame.fire('keyup', { key: 'ArrowLeft' });
      expect(liveDegrees(harness.input)).toBeCloseTo(358, 10);
    } finally {
      harness.close();
    }
  });

  it('steps power by five points a tap, and holds it inside the scale', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowUp' });
      harness.frame.fire('keyup', { key: 'ArrowUp' });
      expect(harness.preview()?.aim.power01).toBeCloseTo(0.65, 12);

      for (let at = 0; at < 20; at += 1) {
        harness.frame.fire('keydown', { key: 'ArrowUp' });
        harness.frame.fire('keyup', { key: 'ArrowUp' });
      }
      expect(harness.preview()?.aim.power01).toBe(1);

      for (let at = 0; at < 40; at += 1) {
        harness.frame.fire('keydown', { key: 'ArrowDown' });
        harness.frame.fire('keyup', { key: 'ArrowDown' });
      }
      // Held to the scale as it goes, so the way back up is one tap and not
      // the forty taps a value banked below zero would have cost.
      expect(harness.preview()?.aim.power01).toBe(0);
      harness.frame.fire('keydown', { key: 'ArrowUp' });
      harness.frame.fire('keyup', { key: 'ArrowUp' });
      expect(harness.preview()?.aim.power01).toBeCloseTo(0.05, 12);
    } finally {
      harness.close();
    }
  });

  it('sweeps the same total at every frame rate and on an unstable clock', () => {
    // The property SPEC section 5.1 states in as many words. A rate multiplied
    // by a frame delta passes at one rate and fails at every other; the totals
    // below are the same to twelve decimal places because the model is an
    // integral and the partition of the interval cannot reach it.
    const sweep = (deltas: readonly number[]): number => {
      const harness = rig();
      try {
        harness.frame.fire('focus');
        harness.frame.fire('keydown', { key: 'ArrowLeft' });
        for (const delta of deltas) {
          harness.step(delta);
        }
        return liveDegrees(harness.input);
      } finally {
        harness.close();
      }
    };

    const evenly = (rate: number, seconds: number): number[] =>
      Array.from({ length: Math.round(rate * seconds) }, () => 1 / rate);

    const at30 = sweep(evenly(30, 1.5));
    const at60 = sweep(evenly(60, 1.5));
    const at144 = sweep(evenly(144, 1.5));
    // The tap that started the hold, plus the whole ramp, plus a quarter of a
    // second at the top rate: 3 + 150 + 60.
    expect(at30).toBeCloseTo(213, 9);
    expect(at60).toBeCloseTo(213, 9);
    expect(at144).toBeCloseTo(213, 9);
    // The residue between two rates is the floating sum of the deltas
    // themselves and nothing else: 216 additions of a ninth of a hundredth
    // against 45 of a thirtieth. A nanodegree is four orders of magnitude
    // below anything a rate error could hide in, and a per-frame model would
    // differ by tens of degrees here rather than by a billionth of one.
    expect(Math.abs(at60 - at30)).toBeLessThan(1e-9);
    expect(Math.abs(at144 - at60)).toBeLessThan(1e-9);
    expect(Math.abs(at144 - at30)).toBeLessThan(1e-9);

    // An unstable clock is the same statement about a ragged partition, and
    // the two frames it cannot use are worth nothing rather than something.
    const jitter: number[] = [];
    let banked = 0;
    const draws = createRng('pf-6-unstable-clock').split('frames');
    for (let at = 0; at < 200; at += 1) {
      const delta = 0.001 + draws.nextFloat() * 0.02;
      if (banked + delta > 1.5) {
        break;
      }
      banked += delta;
      jitter.push(delta);
    }
    jitter.push(Number.NaN, -0.4, 1.5 - banked);
    expect(sweep(jitter)).toBeCloseTo(213, 9);
  });

  it('keeps sweeping from a value a control set under it, without restarting', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      advance(harness, 1.25);
      expect(liveDegrees(harness.input)).toBeCloseTo(153, 9);

      // A slider moved mid-hold. The hold carries on from where the control
      // put it: re-seating the origin rather than restarting the ramp is what
      // stops every touch of a control buying another 250 ms of stillness,
      // and what stops the next frame overwriting the control outright.
      harness.controls.sync(0, harness.preview(), harness.input.allowed());
      harness.press('aim-right');
      expect(liveDegrees(harness.input)).toBeCloseTo(150, 9);
      advance(harness, 0.25);
      // A quarter second more at the top rate, from the value the control set.
      expect(liveDegrees(harness.input)).toBeCloseTo(210, 9);
    } finally {
      harness.close();
    }
  });

  it('charges a hold the same delta the simulation charges itself', () => {
    // SPEC section 6.2: a frame past the ceiling is a hitch the simulation
    // refuses to consume, and a gap past the resume threshold is a tab coming
    // back rather than elapsed time. An aim is something the player is
    // WATCHING, so a hold that charged either would arrive at an angle nobody
    // saw it sweep to, on a pitch that had not moved under it.
    const harness = rig();
    try {
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      harness.step(0.2);
      harness.step(0.1);
      // Three tenths of a second down, all of it under the ceiling.
      expect(liveDegrees(harness.input)).toBeCloseTo(3 + holdSweptDegrees(0.3), 9);

      // A four hundred millisecond hitch is charged as the quarter second the
      // ceiling allows, so the hold now stands at 0.55 and not at 0.7.
      harness.step(0.4);
      expect(liveDegrees(harness.input)).toBeCloseTo(3 + holdSweptDegrees(0.55), 9);
      expect(liveDegrees(harness.input)).not.toBeCloseTo(3 + holdSweptDegrees(0.7), 1);
      // Which is 29.1 degrees rather than 48.2, by the section's own rates.
      expect(liveDegrees(harness.input)).toBeCloseTo(29.1, 6);

      // And a resumed tab is worth nothing at all.
      const parked = liveDegrees(harness.input);
      harness.step(30);
      expect(liveDegrees(harness.input)).toBeCloseTo(parked, 12);
      // The ceiling and the threshold are the simulation's own constants.
      expect(DELTA_CEILING).toBe(0.25);
      expect(RESUME_GAP).toBe(5);
    } finally {
      harness.close();
    }
  });

  it('ignores the platform repeat, so the rate is the spec and not a setting', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      for (let at = 0; at < 50; at += 1) {
        harness.frame.fire('keydown', { key: 'ArrowLeft', repeat: true });
      }
      // Fifty repeats and no elapsed time: the aim has moved by exactly the
      // one tap the first press was worth.
      expect(liveDegrees(harness.input)).toBeCloseTo(3, 10);
    } finally {
      harness.close();
    }
  });

  it('stops sweeping when the key comes up, and when focus leaves', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      advance(harness, 1.25);
      expect(liveDegrees(harness.input)).toBeCloseTo(153, 9);
      harness.frame.fire('keyup', { key: 'ArrowLeft' });
      advance(harness, 1);
      expect(liveDegrees(harness.input)).toBeCloseTo(153, 9);

      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      advance(harness, 0.5);
      const afterBlurStarts = liveDegrees(harness.input);
      harness.frame.fire('blur');
      advance(harness, 2);
      // The aim SURVIVES the blur, because the no-drag path leaves the
      // surface for the Launch button; only the hold ends.
      expect(liveDegrees(harness.input)).toBeCloseTo(afterBlurStarts, 12);
      expect(harness.preview()).not.toBeNull();
    } finally {
      harness.close();
    }
  });

  it('launches on Space and on Enter, at the aim it was showing', () => {
    for (const key of [' ', 'Enter']) {
      const harness = rig();
      try {
        harness.frame.fire('focus');
        harness.frame.fire('keydown', { key: 'ArrowLeft' });
        harness.frame.fire('keyup', { key: 'ArrowLeft' });
        const shown = harness.preview();
        harness.frame.fire('keydown', { key });
        expect(harness.launches, key).toHaveLength(1);
        expect(harness.launches[0]?.angleRad, key).toBe(shown?.aim.angleRad);
        expect(harness.launches[0]?.power01, key).toBe(shown?.aim.power01);
        expect(harness.match.readout().state.kind, key).toBe('MOVING');
        expect(harness.preview(), key).toBeNull();
      } finally {
        harness.close();
      }
    }
  });

  it('cancels on Escape, and opens the pause with no aim to cancel', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      expect(harness.preview()).not.toBeNull();

      harness.frame.fire('keydown', { key: 'Escape' });
      expect(harness.preview()).toBeNull();
      expect(harness.pauses).toHaveLength(0);
      expect(harness.match.readout().state.kind).toBe('PLAYER_TURN');

      harness.frame.fire('keydown', { key: 'Escape' });
      expect(harness.pauses).toHaveLength(1);
      expect(harness.match.readout().state.kind).toBe('PAUSED');
    } finally {
      harness.close();
    }
  });

  it('takes the six keys off the page and leaves Escape to the chrome', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter']) {
        harness.frame.fire('keydown', { key });
        harness.frame.fire('keyup', { key });
      }
      expect(harness.frame.prevented).toEqual([
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        ' ',
        'Enter',
      ]);
      harness.frame.fire('keydown', { key: 'Escape' });
      harness.frame.fire('keydown', { key: 'Tab' });
      harness.frame.fire('keydown', { key: 'a' });
      // Escape and Tab keep their own meaning: one closes an overlay and the
      // other is how SPEC section 5.1 says you leave the surface at all.
      expect(harness.frame.prevented).toHaveLength(6);
    } finally {
      harness.close();
    }
  });

  it('refuses every key outside the player s own turn', () => {
    const harness = rig({}, false);
    try {
      // MENU: started nothing, so the whole model is refused, and the default
      // is still taken off the page so a refused press cannot scroll.
      harness.frame.fire('focus');
      expect(harness.preview()).toBeNull();
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      expect(harness.preview()).toBeNull();
      expect(harness.frame.prevented).toEqual(['ArrowLeft']);
      harness.frame.fire('keydown', { key: ' ' });
      expect(harness.launches).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it('ends an aim the match has moved past, once a frame', () => {
    const harness = rig();
    try {
      harness.frame.fire('focus');
      expect(harness.preview()).not.toBeNull();
      harness.match.dispatch({ kind: 'pause' });
      harness.step(1 / 60);
      expect(harness.preview()).toBeNull();
      expect(harness.canvas.dataset['pfAim']).toBe('idle');
    } finally {
      harness.close();
    }
  });
});

describe('PF-6 tap-to-aim, item C11', () => {
  it('aims toward the point that was tapped', () => {
    const harness = rig();
    try {
      harness.tap(900, 500);
      const preview = harness.preview();
      expect(preview).not.toBeNull();
      // From the player at 300, 360 toward 900, 500: atan(140 / 600).
      expect(radiansToDegrees(preview?.aim.angleRad ?? 0)).toBeCloseTo(13.134, 3);
      expect(harness.canvas.dataset['pfAim']).toBe('aiming');
      // And a tap on the other side of the pitch turns it the other way.
      harness.tap(100, 200);
      expect(radiansToDegrees(harness.preview()?.aim.angleRad ?? 0)).toBeCloseTo(
        218.66,
        1,
      );
    } finally {
      harness.close();
    }
  });

  it('opens at 60 percent and keeps the power the controls last set', () => {
    const harness = rig();
    try {
      harness.tap(900, 500);
      expect(harness.preview()?.aim.power01).toBe(0.6);
      harness.step(1 / 60);
      harness.press('power-up');
      expect(harness.preview()?.aim.power01).toBeCloseTo(0.65, 12);
      harness.step(1 / 60);
      harness.tap(400, 200);
      // A second tap names a direction and nothing else.
      expect(harness.preview()?.aim.power01).toBeCloseTo(0.65, 12);
    } finally {
      harness.close();
    }
  });

  it('is a press that did not travel, and never a drag', () => {
    const harness = rig();
    try {
      // A press that travels at least the minimum drag was a gesture, so the
      // release is not a tap and nothing is aimed.
      const from = { pointerId: 3, clientX: 900, clientY: 220 };
      harness.canvas.fire('pointerdown', from);
      harness.canvas.fire('pointerup', { pointerId: 3, clientX: 960, clientY: 220 });
      expect(harness.preview()).toBeNull();

      // One design unit short of the minimum is still a tap, and one past it
      // is not: the boundary is the same MIN_DRAG the drag model uses.
      harness.canvas.fire('pointerdown', from);
      harness.canvas.fire('pointerup', { pointerId: 3, clientX: 929, clientY: 220 });
      expect(harness.preview()).not.toBeNull();
      harness.input.cancel();
      harness.canvas.fire('pointerdown', from);
      harness.canvas.fire('pointerup', { pointerId: 3, clientX: 930, clientY: 220 });
      expect(harness.preview()).toBeNull();
      expect(MIN_DRAG).toBe(30);
    } finally {
      harness.close();
    }
  });

  it('leaves the drag model exactly where it was', () => {
    const harness = rig();
    try {
      // A press ON the player's own circle is still a drag: it captures the
      // pointer, and it is the drag that decides what the release means.
      harness.canvas.fire('pointerdown', { pointerId: 1, clientX: 300, clientY: 360 });
      expect(harness.canvas.dataset['pfAim']).toBe('below-minimum');
      expect(harness.canvas.style['touchAction']).toBe('none');
      harness.canvas.fire('pointermove', { pointerId: 1, clientX: 200, clientY: 360 });
      expect(harness.canvas.dataset['pfAim']).toBe('aiming');
      harness.canvas.fire('pointerup', { pointerId: 1, clientX: 200, clientY: 360 });
      expect(harness.launches).toHaveLength(1);
      // Pulled back 100 units to the left, so the shot goes right.
      expect(radiansToDegrees(harness.launches[0]?.angleRad ?? 1)).toBeCloseTo(0, 10);
      expect(harness.canvas.style['touchAction']).toBe('pinch-zoom');
    } finally {
      harness.close();
    }
  });

  it('carries a drag aim over as the next turn s starting point', () => {
    // SPEC section 5.1's "last used angle and power" spans the models: a turn
    // taken with a drag is what the next keyboard aim opens at. It is the one
    // reading the discrete models cannot check on themselves, because their
    // own launch is already at the value they hold.
    const harness = rig();
    try {
      // A drag straight up: pulled 120 units downward, so the shot goes up at
      // 90 degrees, and 120 units of drag is 60 percent of the power scale.
      harness.canvas.fire('pointerdown', { pointerId: 4, clientX: 300, clientY: 360 });
      harness.canvas.fire('pointermove', { pointerId: 4, clientX: 300, clientY: 480 });
      harness.canvas.fire('pointerup', { pointerId: 4, clientX: 300, clientY: 480 });
      expect(harness.launches).toHaveLength(1);
      expect(radiansToDegrees(harness.launches[0]?.angleRad ?? 0)).toBeCloseTo(90, 6);

      // Back round to the player's turn, with the opponent answering its own
      // seam the way the frame driver will.
      const opponent = createRng('pf-6-carry-over').split(OPPONENT_STREAM);
      let frames = 0;
      while (!harness.input.allowed()) {
        harness.step(1 / 60);
        respond(harness.match, CASUAL, opponent);
        frames += 1;
        if (frames > 20000) {
          throw new Error('the turn never came back');
        }
      }
      harness.frame.fire('focus');
      // Not the ball, and not 60 percent: the aim the drag launched.
      expect(liveDegrees(harness.input)).toBeCloseTo(90, 6);
      expect(harness.preview()?.aim.power01).toBeCloseTo(0.6, 6);
    } finally {
      harness.close();
    }
  });

  it('drops a held key the moment a press takes the pointer', () => {
    // A hand on the keyboard is not a hand off the mouse, and the surface
    // keeps focus through a press, so a key can still be down when a drag
    // starts. A hold left running would rewrite the drag's own preview on the
    // very next frame, and the release would then launch an aim the player
    // never pulled: a shot at whatever direction the key had swept to.
    const harness = rig();
    try {
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      advance(harness, 1.25);
      expect(liveDegrees(harness.input)).toBeCloseTo(153, 9);

      // The press lands with the key still down.
      harness.canvas.fire('pointerdown', { pointerId: 9, clientX: 300, clientY: 360 });
      expect(harness.canvas.dataset['pfAim']).toBe('below-minimum');
      harness.step(1 / 60);
      harness.step(1 / 60);
      // Still the drag's own aim, not the keyboard's: a press with no travel
      // yet is the sub-minimum case and stays there.
      expect(harness.canvas.dataset['pfAim']).toBe('below-minimum');
      expect(harness.preview()?.reach).toBe(0);

      harness.canvas.fire('pointermove', { pointerId: 9, clientX: 200, clientY: 360 });
      harness.step(1 / 60);
      harness.canvas.fire('pointerup', { pointerId: 9, clientX: 200, clientY: 360 });
      expect(harness.launches).toHaveLength(1);
      // Pulled 100 units left, so the shot goes right at 0 degrees. The
      // keyboard's 153 never reached the launch.
      expect(radiansToDegrees(harness.launches[0]?.angleRad ?? 1)).toBeCloseTo(0, 9);
    } finally {
      harness.close();
    }
  });

  it('refuses a Launch press while a drag still holds the pointer', () => {
    // The gesture in the player's hand owns the aim: a Launch press from a
    // second finger part way through a drag would take the shot out of it.
    const harness = rig();
    try {
      harness.canvas.fire('pointerdown', { pointerId: 5, clientX: 300, clientY: 360 });
      harness.canvas.fire('pointermove', { pointerId: 5, clientX: 200, clientY: 360 });
      harness.step(1 / 60);
      expect(harness.canvas.dataset['pfAim']).toBe('aiming');
      harness.press('aim-launch');
      expect(harness.launches).toHaveLength(0);
      expect(harness.canvas.dataset['pfAim']).toBe('aiming');
      // And the release still launches, so the refusal was the drag and not a
      // surface that had stopped listening.
      harness.canvas.fire('pointerup', { pointerId: 5, clientX: 200, clientY: 360 });
      expect(harness.launches).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('refuses a tap outside the player s own turn', () => {
    const harness = rig({}, false);
    try {
      harness.tap(900, 500);
      expect(harness.preview()).toBeNull();
      expect(harness.canvas.dataset['pfAim']).toBe('idle');
    } finally {
      harness.close();
    }
  });
});

describe('PF-6 the no-drag controls, item C11', () => {
  it('freezes the named controls of the row, in tab order', () => {
    const harness = rig();
    try {
      expect(censusControls(harness.root)).toEqual([
        'Aim left',
        'Aim angle in degrees',
        'Aim right',
        'Less power',
        'Power percent',
        'More power',
        'Launch',
        'Cancel',
      ]);
      expect(harness.controls.controls()).toHaveLength(8);
    } finally {
      harness.close();
    }
  });

  it('carries two real range inputs with their own step and bounds', () => {
    const harness = rig();
    try {
      const angle = findByMarker(harness.root, 'aim-angle');
      const power = findByMarker(harness.root, 'power');
      expect(angle?.tagName).toBe('INPUT');
      expect(angle?.type).toBe('range');
      expect(angle?.getAttribute('min')).toBe('0');
      expect(angle?.getAttribute('max')).toBe('359');
      expect(angle?.getAttribute('step')).toBe('1');
      expect(power?.tagName).toBe('INPUT');
      expect(power?.type).toBe('range');
      expect(power?.getAttribute('min')).toBe('0');
      expect(power?.getAttribute('max')).toBe('100');
      // ONE POINT, not the five the steppers are worth: a range input snaps
      // its value to a multiple of its own step, so a track stepping in fives
      // could not hold a 47 percent aim and would show 45 while the arrow was
      // drawn and the readout announced 47. Both tracks step by one and both
      // pairs of steppers carry SPEC section 5.1's tap.
      expect(power?.getAttribute('step')).toBe('1');
    } finally {
      harness.close();
    }
  });

  it('shows every control in every phase, and refuses them outside the turn', () => {
    const harness = rig({}, false);
    try {
      // Presence first, in a phase that refuses everything: a refusal and a
      // removed control look identical to a test that only looks one up.
      harness.step(1 / 60);
      expect(censusControls(harness.root)).toHaveLength(8);
      for (const control of harness.controls.controls()) {
        expect(control.getAttribute('aria-disabled')).toBe('true');
      }
      harness.press('aim-left');
      harness.press('aim-launch');
      expect(harness.preview()).toBeNull();
      expect(harness.launches).toHaveLength(0);

      harness.match.dispatch({ kind: 'start' });
      harness.step(1 / 60);
      expect(censusControls(harness.root)).toHaveLength(8);
      for (const control of harness.controls.controls()) {
        expect(control.getAttribute('aria-disabled')).toBe('false');
      }
    } finally {
      harness.close();
    }
  });

  it('refuses its own event when it is refused, without asking the aim', () => {
    // The control's refusal is asserted on its OWN callback rather than on
    // the aim, because the input lock would refuse the same press a moment
    // later whatever this control did: a test that only watched the aim
    // would pass with the control's refusal deleted, and the control is what
    // keeps a refused press from reaching a model that has to say no.
    const installed = installFakeDocument();
    try {
      const asked = vi.fn();
      const launched = vi.fn();
      const cancelled = vi.fn();
      const controls = createAimControls({
        onAim: asked,
        onLaunch: launched,
        onCancel: cancelled,
      });
      const root = controls.root as unknown as FakeElement;

      controls.sync(0, null, false);
      for (const marker of ['aim-left', 'power-up', 'aim-launch', 'aim-cancel']) {
        findByMarker(root, marker)?.dispatch('click');
      }
      findByMarker(root, 'aim-angle')?.dispatch('input');
      expect(asked).not.toHaveBeenCalled();
      expect(launched).not.toHaveBeenCalled();
      expect(cancelled).not.toHaveBeenCalled();

      // And the same presses land the moment the phase allows them, so the
      // silence above was the refusal and not a control that never worked.
      controls.sync(0, null, true);
      findByMarker(root, 'aim-left')?.dispatch('click');
      findByMarker(root, 'aim-launch')?.dispatch('click');
      findByMarker(root, 'aim-cancel')?.dispatch('click');
      expect(asked).toHaveBeenCalledTimes(1);
      expect(launched).toHaveBeenCalledTimes(1);
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      installed.restore();
    }
  });

  it('writes the legitimate pair back over a refused track that moved', () => {
    // A range input is a real control and a refused one still moves under a
    // finger or an arrow key. Its own listener declines, so the aim never
    // changes; without the write-back the element would then sit there showing
    // a strength the game does not hold and is not going to launch.
    const harness = rig();
    try {
      harness.tap(900, 360);
      harness.step(1 / 60);
      expect(harness.shown()).toEqual({ degrees: 0, percent: 60 });

      harness.match.dispatch({ kind: 'pause' });
      harness.step(1 / 60);
      const angle = findByMarker(harness.root, 'aim-angle');
      const power = findByMarker(harness.root, 'power');
      expect(angle?.getAttribute('aria-disabled')).toBe('true');

      // The platform moves both tracks under the refusal.
      if (angle === undefined || power === undefined) {
        throw new Error('the aim controls carry no sliders');
      }
      angle.value = '270';
      angle.dispatch('input');
      power.value = '5';
      power.dispatch('input');
      expect(harness.launches).toHaveLength(0);

      harness.step(1 / 60);
      // Back to the pair the game actually holds, on the very next frame.
      expect(harness.shown()).toEqual({ degrees: 0, percent: 60 });
    } finally {
      harness.close();
    }
  });

  it('returns the announcement to the no-aim state when the aim ends', () => {
    const harness = rig();
    try {
      const readout = findByMarker(harness.root, 'aim-readout');
      harness.tap(900, 500);
      harness.step(1 / 60);
      expect(readout?.textContent).toBe('Aim 13 degrees, power 60 percent');

      harness.press('aim-cancel');
      harness.step(0.6);
      // Not still describing an aim that is no longer on the pitch.
      expect(readout?.textContent).toBe('No aim yet');
    } finally {
      harness.close();
    }
  });

  it('launches from an enabled Launch even with no aim showing yet', () => {
    // The Launch control is the pointer's Space, and Space enters aim mode
    // before it fires. A press on an enabled control that silently did
    // nothing is the one outcome a control offered to a player must not have.
    const harness = rig();
    try {
      harness.step(1 / 60);
      expect(harness.preview()).toBeNull();
      expect(findByMarker(harness.root, 'aim-launch')?.getAttribute('aria-disabled'))
        .toBe('false');
      harness.press('aim-launch');
      expect(harness.launches).toHaveLength(1);
      // At the aim SPEC section 5.1 opens with: the ball, at 60 percent.
      expect(radiansToDegrees(harness.launches[0]?.angleRad ?? 1)).toBeCloseTo(0, 9);
      expect(harness.launches[0]?.power01).toBe(0.6);
      expect(harness.match.readout().state.kind).toBe('MOVING');
    } finally {
      harness.close();
    }
  });

  it('steps by exactly the step each button is labelled with, and wraps', () => {
    const harness = rig();
    try {
      harness.tap(900, 360);
      harness.step(1 / 60);
      expect(harness.shown()).toEqual({ degrees: 0, percent: 60 });

      harness.press('aim-left');
      harness.step(1 / 60);
      expect(harness.shown().degrees).toBe(3);
      harness.press('aim-right');
      harness.press('aim-right');
      harness.step(1 / 60);
      // Three degrees a press, and past zero it wraps rather than sticking.
      expect(harness.shown().degrees).toBe(357);

      harness.press('power-up');
      harness.step(1 / 60);
      expect(harness.shown().percent).toBe(65);
      harness.press('power-down');
      harness.press('power-down');
      harness.step(1 / 60);
      expect(harness.shown().percent).toBe(55);
    } finally {
      harness.close();
    }
  });

  it('takes an aim from either slider without the other one moving', () => {
    const harness = rig();
    try {
      harness.tap(900, 360);
      harness.step(1 / 60);
      const angle = findByMarker(harness.root, 'aim-angle');
      const power = findByMarker(harness.root, 'power');
      if (angle === undefined || power === undefined) {
        throw new Error('the aim controls carry no sliders');
      }

      angle.value = '90';
      angle.dispatch('input');
      harness.step(1 / 60);
      expect(harness.shown()).toEqual({ degrees: 90, percent: 60 });

      power.value = '25';
      power.dispatch('input');
      harness.step(1 / 60);
      expect(harness.shown()).toEqual({ degrees: 90, percent: 25 });
      expect(harness.preview()?.aim.power01).toBeCloseTo(0.25, 12);
    } finally {
      harness.close();
    }
  });

  it('launches from the Launch button and cancels from the Cancel button', () => {
    const harness = rig();
    try {
      harness.tap(900, 500);
      harness.step(1 / 60);
      harness.press('aim-cancel');
      expect(harness.preview()).toBeNull();
      expect(harness.launches).toHaveLength(0);

      harness.tap(900, 500);
      harness.step(1 / 60);
      const shown = harness.preview();
      harness.press('aim-launch');
      expect(harness.launches).toHaveLength(1);
      expect(harness.launches[0]?.angleRad).toBe(shown?.aim.angleRad);
      expect(harness.match.readout().state.kind).toBe('MOVING');
    } finally {
      harness.close();
    }
  });

  it('announces the aim as degrees and a percentage, at most twice a second', () => {
    const harness = rig();
    try {
      const readout = findByMarker(harness.root, 'aim-readout');
      expect(readout?.getAttribute('aria-live')).toBe('polite');
      expect(readout?.textContent).toBe('No aim yet');

      harness.tap(900, 500);
      harness.step(1 / 60);
      // Power is a percentage and never a pixel distance: a drag length is
      // meaningless to a player who never dragged (SPEC section 5.1).
      expect(readout?.textContent).toBe('Aim 13 degrees, power 60 percent');

      // A held key sweeps 240 degrees a second, so the region would be
      // rewritten every frame without the floor. Nothing is written for the
      // next half second, and what lands then is the NEWEST value rather than
      // the oldest one queued behind it.
      harness.frame.fire('focus');
      harness.frame.fire('keydown', { key: 'ArrowLeft' });
      for (let at = 0; at < 20; at += 1) {
        harness.step(0.02);
      }
      expect(readout?.textContent).toBe('Aim 13 degrees, power 60 percent');
      harness.step(0.12);
      const spoken = readout?.textContent ?? '';
      expect(spoken).not.toBe('Aim 13 degrees, power 60 percent');
      expect(spoken).toBe(
        `Aim ${String(aimDegrees(harness.preview()?.aim ?? { angleRad: 0, power01: 0 }))} degrees, power 60 percent`,
      );
    } finally {
      harness.close();
    }
  });
});

/**
 * The two full matches, and the clause they carry until PF-9.
 *
 * Both are driven over the real match, the real opponent, the real input
 * module and the real controls; the only stand-ins are the canvas and the
 * focusable frame, which are the platform and not the game.
 *
 * THE MATCH IS GIVEN A CLOCK SO THAT IT CAN END, and the reason is disclosed
 * rather than hidden. The shipped composition root builds a match with neither
 * a clock nor a goal target, because the modes that give it either arrive at
 * PF-9; nothing answers the opponent's seam there either, so a browser parks
 * in OPPONENT_TURN after the first shot and cannot be driven to GAME_OVER at
 * all. Items C11 and G5's "a full match" clause is therefore graded HERE, over
 * the same modules the browser runs, and the browser suite grades the complete
 * turn by each input method instead.
 *
 * THIS RE-HOMES AT PF-9, which owns the modes and the opponent driver
 * together, and it must not age into an implied browser proof: once a match
 * can both end and hand the turn back, the many-turn run belongs in
 * tests/browser/input-parity.spec.ts and tests/browser/keyboard-aim.spec.ts
 * beside the single turns already there. It is the same disclosure item C8's
 * game-over clause carries in tests/browser/input-lock.spec.ts.
 */
function playFullMatch(
  harness: Rig,
  takeTurn: (harness: Rig) => void,
): { turns: number; frames: number } {
  const opponent = createRng('pf-6-full-match').split(OPPONENT_STREAM);
  const step = 1 / 60;
  let turns = 0;
  let frames = 0;
  while (harness.match.readout().state.kind !== 'GAME_OVER') {
    harness.step(step);
    frames += 1;
    if (frames > 20000) {
      throw new Error('the match never reached full time');
    }
    // The opponent answers its own seam, which is the driver PF-7 designed
    // the flag for and PF-8 built the routine behind.
    respond(harness.match, CASUAL, opponent);
    if (harness.input.allowed() && harness.preview() === null) {
      takeTurn(harness);
      turns += 1;
    }
  }
  return { turns, frames };
}

describe('PF-6 a full match with no drag and a full match with no pointer', () => {
  it('is completable using discrete taps only, with no dragging movement', () => {
    const harness = rig({ duration: 40 });
    try {
      const played = playFullMatch(harness, (rigged) => {
        // Tap a point on the pitch, adjust with the steppers, press Launch.
        // Every one of them is a press and a release in one place.
        rigged.tap(1100, 360);
        rigged.step(1 / 60);
        rigged.press('power-up');
        rigged.press('power-up');
        rigged.press('aim-left');
        rigged.step(1 / 60);
        rigged.press('aim-launch');
      });
      expect(harness.match.readout().state.kind).toBe('GAME_OVER');
      // Several complete turn cycles, not one: the player aims and launches,
      // the opponent answers, and the turn comes back.
      expect(played.turns).toBeGreaterThanOrEqual(3);
      expect(harness.launches.length).toBe(played.turns);
      // THE CLAIM ITSELF: not one movement event was ever produced. A drag is
      // a press, a move and a release, and this path never made the middle one.
      expect(harness.canvas.seen).not.toContain('pointermove');
      expect(new Set(harness.canvas.seen)).toEqual(
        new Set(['pointerdown', 'pointerup']),
      );
      // And the launches carried the strength the steppers asked for, so the
      // no-drag path really is driving the shot: the opening 60 percent plus
      // the two presses, and then SPEC section 5.1's last used power as the
      // next turn's starting point, two presses higher again.
      expect(harness.launches[0]?.power01).toBeCloseTo(0.7, 12);
      expect(harness.launches[1]?.power01).toBeCloseTo(0.8, 12);
      for (const aim of harness.launches) {
        expect(aim.power01).toBeGreaterThanOrEqual(0.7);
        expect(aim.power01).toBeLessThanOrEqual(1);
      }
    } finally {
      harness.close();
    }
  });

  it('is playable with no pointer at all', () => {
    const harness = rig({ duration: 40 });
    try {
      const played = playFullMatch(harness, (rigged) => {
        rigged.frame.fire('focus');
        rigged.frame.fire('keydown', { key: 'ArrowLeft' });
        rigged.frame.fire('keyup', { key: 'ArrowLeft' });
        rigged.frame.fire('keydown', { key: 'ArrowUp' });
        rigged.frame.fire('keyup', { key: 'ArrowUp' });
        rigged.frame.fire('keydown', { key: ' ' });
      });
      expect(harness.match.readout().state.kind).toBe('GAME_OVER');
      expect(played.turns).toBeGreaterThanOrEqual(3);
      expect(harness.launches.length).toBe(played.turns);
      // No pointer event of any kind reached the surface in the whole match.
      expect(harness.canvas.seen).toEqual([]);
      // The opening 60 percent plus one press, and then the last used power
      // one press higher every turn after it.
      expect(harness.launches[0]?.power01).toBeCloseTo(0.65, 12);
      expect(harness.launches[1]?.power01).toBeCloseTo(0.7, 12);
      for (const aim of harness.launches) {
        expect(aim.power01).toBeGreaterThanOrEqual(0.65);
        expect(aim.power01).toBeLessThanOrEqual(1);
      }
    } finally {
      harness.close();
    }
  });

  it('drives both paths through the one launch intent and one preview', () => {
    // The two models are not two launch paths: DESIGN section 5 allows one,
    // and the browser suite reads the arrow back from the pixels to prove the
    // presentation is one too. This is the state half of the same claim.
    const harness = rig();
    try {
      const dispatched = vi.spyOn(harness.match, 'dispatch');
      harness.tap(900, 360);
      harness.step(1 / 60);
      const tapped = harness.preview();
      harness.press('aim-launch');
      expect(dispatched).toHaveBeenCalledWith({
        kind: 'launch',
        angle: tapped?.aim.angleRad,
        power: tapped?.aim.power01,
      });
    } finally {
      harness.close();
    }
  });
});
