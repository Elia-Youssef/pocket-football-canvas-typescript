/**
 * The no-drag aim controls, SPEC section 5.0 and QUALITY-BAR sections 3 and 4:
 * two sliders with stepper buttons, plus Launch and Cancel.
 *
 * REQUIRED, NOT A CONVENIENCE. WCAG 2.2 SC 2.5.7 asks that any function
 * operable by dragging also be operable by a single pointer without dragging,
 * and it says in as many words that a keyboard equivalent does not satisfy it.
 * Everything here is therefore a real, VISIBLE, tappable control: a player on
 * a head pointer or an eye-gaze rig, or with a tremor, plays the whole game
 * from this row. That is also why nothing here is visually hidden and why the
 * sliders are `input type="range"` rather than an ARIA construction: role,
 * name and value come from the platform, and the arrow keys, Home and End that
 * a range answers are the platform's too.
 *
 * THE STEPPERS ARE THE NO-DRAG HALF OF EACH SLIDER. A range thumb can be
 * dragged, so a slider alone would put the whole aim back behind a drag. Each
 * one is flanked by two buttons that move it by exactly the step SPEC section
 * 5.1 gives the matching key tap, so the two pointerless paths agree about
 * what one press is worth.
 *
 * NOTHING HERE OWNS THE AIM. Every control raises the pair it would like and
 * the composition root hands it to the one input module, which answers with
 * the same `AimPreview` the drag and the keyboard produce; `sync` then writes
 * that preview back into the controls. The row is a view of the aim and never
 * a second copy of it, so a slider cannot disagree with the arrow on the pitch.
 *
 * DISABLED IN PLACE. QUALITY-BAR section 3: outside the player's own turn the
 * controls carry `aria-disabled="true"` and ignore their own events, and they
 * stay in the document and in the tab order. A control removed on a phase
 * change would drop a focused element on the floor, which is the defect that
 * rule exists to prevent.
 *
 * THE READOUT IS A CONTROL'S WORTH OF INFORMATION, so it is real text and not
 * a canvas glyph. It carries `aria-live="polite"` and is written at most once
 * every 500 ms with the newest value replacing whatever was pending, which is
 * QUALITY-BAR section 4's announcement rule: a held arrow sweeps 240 degrees a
 * second and would otherwise clobber the region faster than it can be spoken.
 * Power is a percentage rather than a distance, because a drag length means
 * nothing to a player who never dragged (SPEC section 5.1).
 */

import type { AimPreview } from '../../core/aiming';
import {
  ANGLE_TAP_DEGREES,
  DEGREES_PER_TURN,
  POWER_TAP,
  aimDegrees,
  aimPercent,
  degreesToRadians,
  normaliseDegrees,
} from '../../core/aiming';
import { formatNumber } from './clock';
import {
  createButton,
  createRange,
  setRefused,
  setTextIfChanged,
  setValueIfChanged,
} from './control';

/** The percent scale the power slider is expressed on. */
const PERCENT = 100;

/** The stepper buttons move by the same step the matching key tap does. */
const ANGLE_STEP = ANGLE_TAP_DEGREES;
const PERCENT_STEP = POWER_TAP * PERCENT;

/**
 * QUALITY-BAR section 4: at least half a second between polite writes, with
 * the newest value replacing a pending one rather than queueing behind it.
 */
const ANNOUNCE_INTERVAL = 0.5;

/** Before the first aim of a match there is no angle and no power to state. */
const NO_AIM_TEXT = 'No aim yet';

export interface AimControlsOptions {
  /** The aim the player has asked for, in radians and on the power01 scale. */
  readonly onAim: (angleRad: number, power01Value: number) => void;
  readonly onLaunch: () => void;
  readonly onCancel: () => void;
}

export interface AimControls {
  readonly root: HTMLElement;
  /** The named focusable controls in tab order. The census reads this. */
  controls(): readonly HTMLElement[];
  /**
   * One frame: bring every control in line with the aim of the moment, and
   * pay out at most one announcement per interval of real elapsed time.
   */
  sync(elapsed: number, preview: AimPreview | null, allowed: boolean): void;
}

export function createAimControls(options: AimControlsOptions): AimControls {
  const root = document.createElement('div');
  root.className = 'pf-aim-controls';
  root.dataset['pf'] = 'aim-controls';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Aim controls');

  const added: HTMLElement[] = [];

  function row(): HTMLDivElement {
    const element = document.createElement('div');
    element.className = 'pf-aim-row';
    root.appendChild(element);
    return element;
  }

  function button(
    parent: HTMLElement,
    marker: string,
    label: string,
    className: string,
    onActivate: () => void,
  ): HTMLButtonElement {
    const control = createButton({
      marker,
      label,
      className,
      refused: true,
      onActivate,
    });
    parent.appendChild(control);
    added.push(control);
    return control;
  }

  function slider(
    parent: HTMLElement,
    marker: string,
    label: string,
    high: number,
    step: number,
    onSlide: (value: number) => void,
  ): HTMLInputElement {
    const control = createRange({
      marker,
      label,
      high,
      step,
      refused: true,
      onInput: onSlide,
    });
    parent.appendChild(control.root);
    added.push(control.input);
    return control.input;
  }

  // The displayed pair, which is what a stepper steps from. Held as the whole
  // numbers the controls carry rather than as the aim's own floats, so a
  // button press moves the readout by exactly the step it is labelled with.
  let shownDegrees = 0;
  let shownPercent = 0;

  /**
   * The aim a control has just asked for. The pair is moved HERE and not only
   * when the answer comes back on the next sync, because two presses inside
   * one frame both step from this pair: without it the second would step from
   * the same value the first did, and a stepper pressed twice quickly would be
   * worth one step. The same reading is what stops the angle steppers from
   * carrying a stale power back down with them.
   */
  function ask(degrees: number, percent: number): void {
    shownDegrees = normaliseDegrees(degrees);
    shownPercent = Math.min(PERCENT, Math.max(0, percent));
    options.onAim(degreesToRadians(shownDegrees), shownPercent / PERCENT);
  }

  const angleRow = row();
  // Left turns the aim the way the design space turns, which is the same
  // direction the left arrow turns it on the play surface.
  button(angleRow, 'aim-left', 'Aim left', 'pf-aim-step', () => {
    ask(shownDegrees + ANGLE_STEP, shownPercent);
  });
  const angleSlider = slider(
    angleRow,
    'aim-angle',
    'Aim angle in degrees',
    // A whole turn's last direction is its first, so the track stops one
    // short of the turn and the two steppers are what wrap.
    DEGREES_PER_TURN - 1,
    1,
    (value) => {
      ask(value, shownPercent);
    },
  );
  button(angleRow, 'aim-right', 'Aim right', 'pf-aim-step', () => {
    ask(shownDegrees - ANGLE_STEP, shownPercent);
  });

  const powerRow = row();
  button(powerRow, 'power-down', 'Less power', 'pf-aim-step', () => {
    ask(shownDegrees, shownPercent - PERCENT_STEP);
  });
  const powerSlider = slider(
    powerRow,
    'power',
    'Power percent',
    PERCENT,
    // ONE POINT, not the five the steppers are worth. A range input SNAPS its
    // value to a multiple of its own step, so a track stepping in fives could
    // not hold a strength that is not one: a 47 percent aim, which a drag
    // reaches easily, would show as 45 while the arrow was drawn at 47 and the
    // readout announced 47. The steppers carry SPEC section 5.1's five-point
    // tap; the track's own arrow keys are the fine step, as they are on the
    // angle track beside it.
    1,
    (value) => {
      ask(shownDegrees, value);
    },
  );
  button(powerRow, 'power-up', 'More power', 'pf-aim-step', () => {
    ask(shownDegrees, shownPercent + PERCENT_STEP);
  });

  const actionRow = row();
  button(actionRow, 'aim-launch', 'Launch', 'pf-aim-action', options.onLaunch);
  button(actionRow, 'aim-cancel', 'Cancel', 'pf-aim-action', options.onCancel);

  const readout = document.createElement('p');
  readout.className = 'pf-aim-readout';
  readout.dataset['pf'] = 'aim-readout';
  readout.setAttribute('aria-live', 'polite');
  readout.textContent = NO_AIM_TEXT;
  root.appendChild(readout);

  // The announcement queue: one pending line, the newest wins, and the first
  // change of a still period is written at once rather than after a wait.
  let announced = NO_AIM_TEXT;
  let latest = NO_AIM_TEXT;
  let sinceWrite = ANNOUNCE_INTERVAL;

  function queue(text: string): void {
    latest = text;
  }

  function pump(elapsed: number): void {
    sinceWrite += Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
    if (latest === announced || sinceWrite < ANNOUNCE_INTERVAL) {
      return;
    }
    setTextIfChanged(readout, latest);
    announced = latest;
    sinceWrite = 0;
  }

  return {
    root,

    controls(): readonly HTMLElement[] {
      return added;
    },

    sync(elapsed: number, preview: AimPreview | null, allowed: boolean): void {
      for (const control of added) {
        setRefused(control, !allowed);
      }
      if (preview === null) {
        queue(NO_AIM_TEXT);
      } else {
        shownDegrees = aimDegrees(preview.aim);
        shownPercent = aimPercent(preview.aim);
        queue(
          `Aim ${formatNumber(shownDegrees)} degrees, power ${formatNumber(
            shownPercent,
          )} percent`,
        );
      }
      // WRITTEN EVERY FRAME, with or without an aim. A range input is a real
      // control and a refused one still moves under a finger or an arrow key:
      // its own listener declines, so the aim never changes, and the element
      // would then sit there showing a strength the game does not hold.
      // Writing the legitimate pair back on every sync is what stops a refused
      // track from lying about the shot it is going to take.
      setValueIfChanged(angleSlider, String(shownDegrees));
      setValueIfChanged(powerSlider, String(shownPercent));
      pump(elapsed);
    },
  };
}
