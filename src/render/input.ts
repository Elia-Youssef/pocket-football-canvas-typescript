/**
 * The pointer half of the play surface: CSS pixels in, design units out.
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
 *
 * THE LOCK IS ASKED THREE TIMES, not once. At the press, because an aim may
 * not begin outside the player's own turn; at the release, because a drag that
 * began legally may be released into a state that refuses it; and once a frame
 * through `refresh`, because the state can change between two pointer events
 * and an aim that outlives its own turn is exactly what item C8 forbids. The
 * middle one alone would leave a paused match showing a live arrow that a
 * player could still adjust, which is aiming by any reading of the word.
 *
 * POINTER EVENTS ONLY, per QUALITY-BAR section 3. There is no mouse listener
 * and no touch listener here. A drag takes a pointer capture on pointerdown
 * so that a pointer leaving the canvas keeps aiming, and `touch-action` is
 * `pinch-zoom` except for the duration of that capture, because `none`
 * outside it would deny magnification across the whole surface.
 */

import type { AimPreview, AimState } from '../core/aiming';
import { aimFromDrag, aimingAllowed, aimingBegins } from '../core/aiming';
import type { World } from '../core/bodies';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from '../core/config';
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
}

export interface AimInput {
  /**
   * Re-reads the lock and ends an aim the match no longer allows. Called once
   * a frame by the composition root, because the state can change between two
   * pointer events and an aim that outlived its own turn is exactly what item
   * C8 forbids: the pause control is chrome and answers a keyboard or a second
   * finger while a drag is in progress.
   */
  refresh(): void;
  /** The aim in progress, or null. What the arrow draws, and nothing else. */
  preview(): AimPreview | null;
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

/**
 * Wire the drag-to-aim gesture onto a play surface.
 *
 * DESIGN section 8: the listeners are added once and nothing tears them down,
 * so a restart mutates state and never rebuilds this. The gesture is a small
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
    canvas.style.touchAction = TOUCH_IDLE;
    mirror();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (captured !== null) {
      return;
    }
    const at = toDesignPoint(rectNow(), event.clientX, event.clientY);
    if (!aimingBegins(options.state(), options.world, at.x, at.y)) {
      return;
    }
    captured = event.pointerId;
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
      options.onLaunch(finished.aim);
    }
  });

  canvas.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== captured) {
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

  return {
    refresh: () => {
      if (live !== null && !aimingAllowed(options.state(), options.world)) {
        endGesture();
      }
    },
    preview: () => live,
  };
}
