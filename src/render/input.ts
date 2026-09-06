/**
 * The play surface's input: CSS pixels in, design units out, and the three
 * models that name an aim.
 *
 * ONE TRANSFORM, AND ITS ONE INVERSE. `surface.ts` owns the draw transform,
 * design units to device pixels with the y flip and the device pixel ratio
 * folded in once. This file owns the other direction, and the two live beside
 * each other because they are one decision: a pointer arrives in CSS pixels
 * measured from the viewport, and the pitch is a 1280 by 720 logical space
 * with its origin at the bottom left.
 *
 * THE DEVICE PIXEL RATIO IS DELIBERATELY NOT IN THIS CHAIN. `clientX` and
 * `clientY` are CSS pixels and so is `getBoundingClientRect()`, while the
 * backing-store scale is already cancelled inside the draw transform.
 * Multiplying by the ratio here would divide by it twice, which is
 * QUALITY-BAR section 7's third recorded failure mode. Nothing in this file
 * asks the platform for that ratio under any spelling, and the same drag maps
 * to the same design delta at every density because of it.
 *
 * THE RECTANGLE IS RE-READ ON EVERY EVENT, never cached. QUALITY-BAR section
 * 7 asks for a re-read per gesture; a drag is a gesture the page can scroll,
 * resize or reorient underneath, so each event maps with the rectangle of its
 * own moment and the two design points that result are anchored to the pitch
 * rather than to the page. The delta is taken in design space afterwards,
 * where a scroll between the press and the release cannot reach it.
 *
 * WHY THIS FILE IS THE ONE M1 EXEMPTION. `tests/unit/chrome-dom.test.ts`
 * scans every file under `src/` for a pointer-coordinate read and for a
 * rectangle query, because a hand-rolled hit test against a chrome rectangle
 * is the defect item M1 exists to prevent. The play surface is not chrome and
 * has no chrome rectangle to hit-test: it maps a pointer into the one
 * coordinate space the game thinks in, and it is exempted BY NAME so that a
 * second site doing the same thing reddens the suite instead of joining it.
 * The tap model below lives here for the same reason and not by convenience:
 * it reads a pointer coordinate, so it belongs to the one module that may.
 *
 * THREE MODELS, ONE AIM. A drag (SPEC section 5), a tap (5.0) and the
 * keyboard (5.1) all write the SAME `live` preview, which `preview()` hands
 * to the composition root and the root draws once. SPEC section 5.1 requires
 * the arrow to render identically whichever model made it, and one variable
 * is the only arrangement in which that cannot drift. A drag is continuous
 * and holds the pointer; the other two are discrete, hold nothing, and stay
 * on the surface until they are launched, cancelled or refused.
 *
 * THE LOCK IS ASKED THREE TIMES, not once. At the press, because an aim may
 * not begin outside the player's own turn; at the release, because a drag that
 * began legally may be released into a state that refuses it; and once a frame
 * through `refresh`, because the state can change between two pointer events
 * and an aim that outlives its own turn is exactly what item C8 forbids. The
 * middle one alone would leave a paused match showing a live arrow that a
 * player could still adjust, which is aiming by any reading of the word. The
 * discrete models are held to the same three: every entry point asks, and the
 * per-frame ask is what ends a keyboard aim the match has moved past.
 *
 * POINTER EVENTS ONLY, per QUALITY-BAR section 3. There is no mouse listener
 * and no touch listener here, and the lint rule behind item C9 is what keeps
 * it that way rather than this paragraph. A drag takes a pointer capture on
 * pointerdown so that a pointer leaving the canvas keeps aiming, and
 * `touch-action` is `pinch-zoom` except for the duration of that capture,
 * because `none` outside it would deny magnification across the whole
 * surface. A tap takes no capture: it is one press and one release in the
 * same place, and holding the platform's panning for the length of it would
 * cost a pinch-zoom to buy nothing.
 *
 * THE HOLD RATES ARE TIMED BY THE FRAME LOOP, never by the platform's own key
 * repeat. SPEC section 5.1 fixes the delay, the ramp and the top rate in real
 * seconds; an operating system's repeat interval is a user setting and would
 * make the sweep a different length on every machine. A repeat keydown is
 * therefore ignored outright, and `refresh` is handed the frame's own elapsed
 * time.
 */

import type { AimPreview, AimState } from '../core/aiming';
import {
  ANGLE_FINE_TAP_DEGREES,
  ANGLE_TAP_DEGREES,
  POWER_TAP,
  aimFromDrag,
  aimPreviewFor,
  aimTowardPoint,
  aimingAllowed,
  aimingBegins,
  clampPower,
  degreesToRadians,
  holdSweptDegrees,
  holdSweptFineDegrees,
  holdSweptPower,
  normaliseDegrees,
  normalisedAim,
  openingAim,
  radiansToDegrees,
} from '../core/aiming';
import type { World } from '../core/bodies';
import {
  DELTA_CEILING,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  MIN_DRAG,
  RESUME_GAP,
} from '../core/config';
import type { MatchState } from '../core/match';

/** A point in the logical design space SPEC section 3 defines. */
export interface DesignPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The part of a DOMRect the mapping uses, as plain data, so the arithmetic
 * below can be driven at any scale and offset without a document.
 */
export interface SurfaceRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A viewport point in CSS pixels, as a point in design space.
 *
 * The rectangle's own left and top carry the letterbox: whatever the fit
 * strategy leaves as dead space above or beside the surface is outside the
 * rectangle, so subtracting the origin removes both offsets at once. The two
 * axes take their own scale rather than a shared one, so a rectangle that
 * rounded to a fraction off the exact ratio still maps its own extent onto
 * the whole logical space. The y axis then flips, because SPEC section 3 puts
 * the origin at the bottom left and a viewport puts it at the top left.
 *
 * A collapsed surface has no arithmetic and needs no guard: a zero width
 * yields a coordinate that is not a finite number, and every reading of a
 * design point downstream refuses one.
 */
export function toDesignPoint(
  rect: SurfaceRect,
  clientX: number,
  clientY: number,
): DesignPoint {
  return {
    x: ((clientX - rect.left) * LOGICAL_WIDTH) / rect.width,
    y: LOGICAL_HEIGHT - ((clientY - rect.top) * LOGICAL_HEIGHT) / rect.height,
  };
}

export interface AimInputOptions {
  /** The play surface. The listeners and the capture both live on it. */
  readonly canvas: HTMLCanvasElement;
  /** The world being aimed in. Read, never written. */
  readonly world: World;
  /** The match state of the moment, asked per event and never copied. */
  readonly state: () => MatchState;
  /** Called on a release that earned a launch, with the aim just previewed. */
  readonly onLaunch: (aim: AimState) => void;
  /**
   * The focusable element SPEC section 5.1 calls the play surface: the canvas
   * itself is `aria-hidden` and out of the accessibility tree, so the frame
   * around it is what carries `tabindex`, the accessible name and every key.
   * Omitted, this module is the pointer half alone and binds no key, which is
   * the shape the mapping tests drive it in.
   */
  readonly surface?: HTMLElement;
  /**
   * SPEC section 5.1: Escape with no aim active opens the pause overlay. What
   * "opens" means is the composition root's, so the key raises this instead.
   */
  readonly onPause?: () => void;
}

export interface AimInput {
  /**
   * Re-reads the lock and ends an aim the match no longer allows, then
   * advances any held key by the frame's own elapsed seconds. Called once a
   * frame by the composition root, because the state can change between two
   * pointer events and an aim that outlived its own turn is exactly what item
   * C8 forbids: the pause control is chrome and answers a keyboard or a second
   * finger while a drag is in progress.
   */
  refresh(elapsed?: number): void;
  /** The aim in progress, or null. What the arrow draws, and nothing else. */
  preview(): AimPreview | null;
  /**
   * Set the aim from a control outside the surface: the two sliders and their
   * stepper buttons, which are SPEC section 5.0's no-drag path. Refused
   * exactly where every other entry point is, and ignored while a drag holds
   * the pointer, because the gesture in the player's hand owns the aim.
   */
  setAim(angleRad: number, power01Value: number): void;
  /** Launch the aim in progress. False when there was nothing to launch. */
  launch(): boolean;
  /** End the aim in progress with no launch, which is SPEC 5.1's Escape. */
  cancel(): void;
  /** Whether an aim is allowed right now. The controls disable in place on it. */
  allowed(): boolean;
}

/**
 * QUALITY-BAR section 3: `none` for the duration of an active capture only,
 * `pinch-zoom` at every other moment, because `none` disables the browser's
 * magnification as well as its panning.
 */
const TOUCH_IDLE = 'pinch-zoom';
const TOUCH_DRAGGING = 'none';

/**
 * The aim phase, mirrored onto the surface element as `data-pf-aim`. The
 * canvas is `aria-hidden` and QUALITY-BAR section 1 gives the scene a DOM
 * mirror rather than an accessible canvas; this is the first fact of that
 * mirror, derived from the one aim state on every change so there is no
 * second copy to drift.
 */
const PHASE_IDLE = 'idle';
const PHASE_AIMING = 'aiming';
const PHASE_BELOW_MINIMUM = 'below-minimum';

function phaseOf(preview: AimPreview | null): string {
  if (preview === null) {
    return PHASE_IDLE;
  }
  return preview.launchable ? PHASE_AIMING : PHASE_BELOW_MINIMUM;
}

/** SPEC section 5.1's four arrows, and the two keys that launch. */
const ANGLE_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight']);
const POWER_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown']);
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([' ', 'Enter']);

/**
 * The keys the surface takes off the page while it has focus: the four
 * arrows, Space and Enter (SPEC section 5.1). Escape is deliberately not one
 * of them, because with no aim to cancel it belongs to the chrome.
 */
const PREVENTED: ReadonlySet<string> = new Set([
  ...ANGLE_KEYS,
  ...POWER_KEYS,
  ...ACTIVATION_KEYS,
]);

/**
 * A frame's elapsed time as time to charge a hold, and it is the SIMULATION's
 * reading of a delta rather than the clock's.
 *
 * A negative frame would run the sweep backwards and a NaN one would never let
 * it recover, so neither is time. The other two clauses are SPEC section 6.2's
 * and are here because an aim is something the player is WATCHING: a gap
 * longer than the resume threshold is a tab coming back rather than elapsed
 * time, and a frame past the delta ceiling is a hitch the simulation itself
 * refuses to consume. A hold that charged either would arrive at an angle
 * nobody saw it sweep to, on a pitch that had not moved. The two constants are
 * `config.ts`'s own and are consumed rather than restated.
 */
function elapsedOf(delta: number | undefined): number {
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta <= 0) {
    return 0;
  }
  if (delta > RESUME_GAP) {
    return 0;
  }
  return Math.min(delta, DELTA_CEILING);
}

/**
 * One key held down: which way it turns, whether the fine modifier was held
 * when it went down, how long it has been down, and the value its sweep is
 * measured from. The sweep is a total rather than an increment, so `base` and
 * `from` are what let an outside control re-seat the aim mid-hold without
 * either restarting the ramp or losing the degrees already paid out.
 */
interface Hold {
  readonly key: string;
  readonly direction: number;
  readonly fine: boolean;
  held: number;
  base: number;
  from: number;
}

function sweptBy(hold: Hold): number {
  return hold.fine ? holdSweptFineDegrees(hold.held) : holdSweptDegrees(hold.held);
}

/**
 * Wire the drag, tap and keyboard aim models onto a play surface.
 *
 * DESIGN section 8: the listeners are added once and nothing tears them down,
 * so a restart mutates state and never rebuilds this. The drag is a small
 * state machine over one captured pointer id: a second pointer arriving
 * mid-drag is not a second aim and is ignored outright, which is also what
 * makes a stray pointerup from anything else harmless.
 */
export function attachAimInput(options: AimInputOptions): AimInput {
  const canvas = options.canvas;
  let captured: number | null = null;
  let originX = 0;
  let originY = 0;
  let live: AimPreview | null = null;

  // The press that has not yet decided whether it was a tap, and the design
  // point it landed on. SPEC section 5.0 names the point, not the release.
  let tapPointer: number | null = null;
  let tapX = 0;
  let tapY = 0;

  // The discrete aim as the models hold it: unrounded degrees and the one
  // power01 scale. `seated` is SPEC section 5.1's "last used angle and power":
  // false only until the first aim of a match has been made.
  let aimDegreesNow = 0;
  let aimPowerNow = 0;
  let seated = false;
  let angleHold: Hold | null = null;
  let powerHold: Hold | null = null;

  canvas.style.touchAction = TOUCH_IDLE;
  canvas.dataset['pfAim'] = PHASE_IDLE;

  function rectNow(): SurfaceRect {
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  function mirror(): void {
    canvas.dataset['pfAim'] = phaseOf(live);
  }

  function endGesture(): void {
    if (captured !== null && canvas.hasPointerCapture(captured)) {
      canvas.releasePointerCapture(captured);
    }
    captured = null;
    live = null;
    tapPointer = null;
    angleHold = null;
    powerHold = null;
    canvas.style.touchAction = TOUCH_IDLE;
    mirror();
  }

  /** SPEC section 5.1's "last used angle and power", after every launch. */
  function remember(aim: AimState): void {
    aimDegreesNow = radiansToDegrees(aim.angleRad);
    aimPowerNow = clampPower(aim.power01);
    seated = true;
  }

  /** The discrete aim, as the one preview everything else reads and draws. */
  function showDiscrete(): void {
    live = aimPreviewFor(normalisedAim(degreesToRadians(aimDegreesNow), aimPowerNow));
    mirror();
  }

  /**
   * Bring the discrete aim into existence if the match allows one. SPEC
   * section 5.1: it opens at the last used angle and power, or pointing at the
   * ball at 60 percent on the first turn of a match.
   */
  function beginDiscrete(): boolean {
    if (captured !== null) {
      return false;
    }
    if (!aimingAllowed(options.state(), options.world)) {
      return false;
    }
    if (live === null) {
      if (!seated) {
        const opening = openingAim(options.world);
        aimDegreesNow = radiansToDegrees(opening.angleRad);
        aimPowerNow = opening.power01;
        seated = true;
      }
      showDiscrete();
    }
    return true;
  }

  /**
   * Move a hold's origin to a value something else has just set, keeping the
   * seconds it has already been down. Without it, a slider moved mid-hold
   * would be overwritten by the next frame; with the ramp restarted instead,
   * every touch of a control would buy a fresh 250 ms of stillness.
   */
  function reseatAngle(base: number): void {
    if (angleHold !== null) {
      angleHold.base = base;
      angleHold.from = sweptBy(angleHold);
    }
  }

  function reseatPower(base: number): void {
    if (powerHold !== null) {
      powerHold.base = base;
      powerHold.from = holdSweptPower(powerHold.held);
    }
  }

  /**
   * Launch the discrete aim. A drag holding the pointer owns the aim and is
   * refused here for the same reason `setAim` refuses it: the gesture in the
   * player's hand decides what its own release means, and a Launch press from
   * a second finger part way through one would take the shot out of its hands.
   *
   * Nothing is remembered here, and the absence is the point: the discrete
   * models launch the value they are already holding, so the "last used angle
   * and power" is what it was a moment ago. Only a drag brings an aim from
   * somewhere else, and the release is where that one is remembered.
   */
  function launchNow(): boolean {
    const finished = live;
    if (finished === null || !finished.launchable || captured !== null) {
      return false;
    }
    if (!aimingAllowed(options.state(), options.world)) {
      return false;
    }
    endGesture();
    options.onLaunch(finished.aim);
    return true;
  }

  /**
   * A press that began no drag, decided at the release. A press that travelled
   * at least the minimum drag was a gesture and not a tap, and the comparison
   * is written as a refusal so that a coordinate which is not a number is
   * neither: a press nobody can locate names no direction.
   */
  function finishTap(pointerId: number, clientX: number, clientY: number): void {
    if (pointerId !== tapPointer) {
      return;
    }
    tapPointer = null;
    const at = toDesignPoint(rectNow(), clientX, clientY);
    if (!(Math.hypot(at.x - tapX, at.y - tapY) < MIN_DRAG)) {
      return;
    }
    if (!beginDiscrete()) {
      return;
    }
    const player = options.world.player.position;
    aimDegreesNow = radiansToDegrees(aimTowardPoint(player.x, player.y, tapX, tapY));
    reseatAngle(aimDegreesNow);
    showDiscrete();
  }

  /** SPEC section 5.1's tap steps, and the hold each one seats behind it. */
  function pressArrow(key: string, fine: boolean): void {
    if (POWER_KEYS.has(key)) {
      const direction = key === 'ArrowUp' ? 1 : -1;
      aimPowerNow = clampPower(aimPowerNow + direction * POWER_TAP);
      powerHold = { key, direction, fine: false, held: 0, base: aimPowerNow, from: 0 };
      showDiscrete();
      return;
    }
    // Left turns the aim the way the design space turns, which is
    // anticlockwise with y up, and right turns it back.
    const direction = key === 'ArrowLeft' ? 1 : -1;
    const step = fine ? ANGLE_FINE_TAP_DEGREES : ANGLE_TAP_DEGREES;
    aimDegreesNow = normaliseDegrees(aimDegreesNow + direction * step);
    angleHold = { key, direction, fine, held: 0, base: aimDegreesNow, from: 0 };
    showDiscrete();
  }

  /**
   * Every held key, advanced by the frame's own elapsed seconds. The aim is
   * the total swept since the hold was seated rather than a running sum of
   * per-frame increments, so the partition of the interval cannot change the
   * answer: that is what SPEC section 5.1 means by identical at every frame
   * rate, and it is the only reading an unstable clock also satisfies.
   */
  function advanceHolds(elapsed: number): void {
    // A DRAG OWNS THE AIM WHILE IT HOLDS THE POINTER. A key can still be down
    // when a press lands - the surface keeps focus through a press, and a hand
    // on the keyboard is not a hand off the mouse - and a hold left running
    // would rewrite the drag's own preview on the very next frame and launch
    // an aim the player never pulled. The press drops the holds and this
    // refuses to start another, which are the same rule stated at both ends.
    if (live === null || captured !== null) {
      angleHold = null;
      powerHold = null;
      return;
    }
    if (angleHold === null && powerHold === null) {
      return;
    }
    if (angleHold !== null) {
      angleHold.held += elapsed;
      aimDegreesNow = normaliseDegrees(
        angleHold.base + angleHold.direction * (sweptBy(angleHold) - angleHold.from),
      );
    }
    if (powerHold !== null) {
      powerHold.held += elapsed;
      aimPowerNow = clampPower(
        powerHold.base +
          powerHold.direction * (holdSweptPower(powerHold.held) - powerHold.from),
      );
    }
    showDiscrete();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (captured !== null) {
      return;
    }
    const at = toDesignPoint(rectNow(), event.clientX, event.clientY);
    if (!aimingBegins(options.state(), options.world, at.x, at.y)) {
      // SPEC section 5.0: a press that starts no drag may still be a tap
      // naming a direction. Nothing is committed here, because a press that
      // goes on to travel was a gesture and the release is what tells them
      // apart.
      tapPointer = event.pointerId;
      tapX = at.x;
      tapY = at.y;
      return;
    }
    captured = event.pointerId;
    tapPointer = null;
    originX = at.x;
    originY = at.y;
    // A press with no movement yet is an aim of no length, which is the
    // sub-minimum case and shows the sub-minimum signal from the first frame.
    live = aimFromDrag(0, 0);
    // The gesture's own state is settled before the platform is told
    // anything, mirror and touch-action included, so a capture the platform
    // refuses cannot leave the surface claiming to be idle while an aim runs,
    // and cannot leave the browser free to pan the page under the drag.
    mirror();
    canvas.style.touchAction = TOUCH_DRAGGING;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== captured) {
      return;
    }
    const at = toDesignPoint(rectNow(), event.clientX, event.clientY);
    live = aimFromDrag(at.x - originX, at.y - originY);
    mirror();
  });

  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== captured) {
      finishTap(event.pointerId, event.clientX, event.clientY);
      return;
    }
    // The aim that launches is the one last previewed, not one re-read from
    // the release's own coordinates: item C6 asks the launch to match the
    // arrow the player was shown, and the last frame drawn is that arrow.
    const finished = live;
    // The lock is asked again at the release. A drag that began legally can
    // still be released into a state that refuses it, because the pause
    // control and the chrome act between the press and the release.
    const allowed = aimingAllowed(options.state(), options.world);
    endGesture();
    if (finished !== null && finished.launchable && allowed) {
      remember(finished.aim);
      options.onLaunch(finished.aim);
    }
  });

  canvas.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== captured) {
      if (event.pointerId === tapPointer) {
        tapPointer = null;
      }
      return;
    }
    endGesture();
  });

  // A capture can be lost without a pointerup or a pointercancel, and an aim
  // whose pointer the platform has taken away is over. The guard is what makes
  // this harmless in the ordinary case: the implicit release after a pointerup
  // fires this too, by which time the gesture has already ended itself.
  canvas.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId !== captured) {
      return;
    }
    endGesture();
  });

  const surface = options.surface;
  if (surface !== undefined) {
    surface.addEventListener('focus', () => {
      // SPEC section 5.1: focusing the surface during your own turn enters
      // aim mode. KEYBOARD focus only. A press on the pitch focuses this
      // frame too, and it is the same press that is starting a drag or a tap;
      // entering an aim under it would pre-empt the gesture the player made.
      if (!surface.matches(':focus-visible')) {
        return;
      }
      beginDiscrete();
    });

    surface.addEventListener('blur', () => {
      // A key released while the surface has lost focus never reports, so a
      // hold that outlived the focus would sweep for the rest of the session.
      // The aim itself stays: the no-drag path leaves this frame for the
      // Launch button, and cancelling on the way there would launch nothing.
      angleHold = null;
      powerHold = null;
    });

    surface.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // SPEC section 5.1: Escape cancels the aim, and pressed again with no
        // aim active it opens the pause overlay. It is deliberately not
        // prevented: an open overlay holds focus and this listener never sees
        // the key, so the two readings never compete for one press.
        if (live !== null) {
          endGesture();
          return;
        }
        options.onPause?.();
        return;
      }
      if (!PREVENTED.has(event.key)) {
        return;
      }
      // SPEC section 5.1: the four arrows, Space and Enter never reach the
      // page while the surface has focus, so the page never scrolls. They are
      // prevented whether or not the aim then honours them, because a refused
      // press that scrolled the pitch out of view is worse than a refusal.
      event.preventDefault();
      if (!beginDiscrete()) {
        return;
      }
      if (ACTIVATION_KEYS.has(event.key)) {
        launchNow();
        return;
      }
      if (event.repeat) {
        // The platform's own repeat interval is a user setting, and SPEC
        // section 5.1's rates are in real seconds. The hold is timed by the
        // frame loop instead, so a repeat is nothing at all.
        return;
      }
      pressArrow(event.key, event.shiftKey);
    });

    surface.addEventListener('keyup', (event: KeyboardEvent) => {
      if (angleHold !== null && angleHold.key === event.key) {
        angleHold = null;
      }
      if (powerHold !== null && powerHold.key === event.key) {
        powerHold = null;
      }
    });
  }

  return {
    refresh: (elapsed?: number) => {
      if (live !== null && !aimingAllowed(options.state(), options.world)) {
        endGesture();
      }
      advanceHolds(elapsedOf(elapsed));
    },
    preview: () => live,
    setAim: (angleRad: number, power01Value: number) => {
      if (!beginDiscrete()) {
        return;
      }
      aimDegreesNow = radiansToDegrees(angleRad);
      aimPowerNow = clampPower(power01Value);
      reseatAngle(aimDegreesNow);
      reseatPower(aimPowerNow);
      showDiscrete();
    },
    launch: () => {
      // The Launch control is the pointer's Space, and Space enters aim mode
      // before it fires. Without this a press on an enabled Launch with no aim
      // yet showing is a silent no-op, which is the one outcome a control
      // offered to a player must never have.
      if (!beginDiscrete()) {
        return false;
      }
      return launchNow();
    },
    cancel: () => {
      if (live !== null) {
        endGesture();
      }
    },
    allowed: () => aimingAllowed(options.state(), options.world),
  };
}
