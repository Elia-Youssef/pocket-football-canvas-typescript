/**
 * The HUD, SPEC section 12: player score top-left, opponent score top-right,
 * the clock or the centre slot between them, the turn indicator below, the
 * ladder readout, and the pause control.
 *
 * REAL DOM, ALL OF IT. QUALITY-BAR section 1: every readout and control here
 * is an element, because text on the canvas is invisible to the platform and
 * out of reach of a keyboard. Nothing in this module measures a rectangle or
 * reads a pointer: the pause control is a button the platform hit-tests, and
 * its one refusal is gated on the state the turn indicator is already
 * naming, so the reason is visible text and never a tooltip.
 *
 * THE READOUT IS THE ONLY INPUT. Everything shown is derived from one
 * `MatchReadout` per sync; the module keeps no copy of the match state, so
 * there is nothing to drift. The clock is `undefined` for the clockless
 * modes, and that is what flips the centre slot between the MM:SS face and
 * the goal target with the score line (SPEC section 12).
 *
 * THE PAUSE CONTROL IS NEVER REMOVED. QUALITY-BAR section 3: a control that
 * is out of context is disabled in place and kept focusable, because a phase
 * change that removed it would drop a focused element on the floor. Outside
 * the four in-play states it carries `aria-disabled="true"` and ignores its
 * click; the turn indicator names the state that refuses it.
 */

import type { MatchReadout, MatchState } from '../../core/match';
import { formatClock, formatNumber } from './clock';

export interface HudOptions {
  /** Called when the pause control is activated while it can be honoured. */
  readonly onPause: () => void;
  /**
   * The opponent's name, for the turn indicator's aiming line. The modes
   * supply it (SPEC section 10's ladder names); until one does, the side is
   * named generically.
   */
  readonly opponentName?: string;
  /**
   * First-to-N's target, shown in the centre slot of a clockless match.
   * Omitted, a clockless match shows the score line alone.
   */
  readonly target?: number;
}

export interface Hud {
  readonly root: HTMLElement;
  /** The pause control, kept for the wiring that places focus on open. */
  readonly pause: HTMLButtonElement;
  /** Re-derives every readout from the match. */
  update(readout: MatchReadout): void;
  /** The ladder readout: opponent name and rung, or nothing without one. */
  showLadder(name: string, position: number, total: number): void;
  clearLadder(): void;
}

/** The states the match accepts a pause intent from, and the control with it. */
const PAUSABLE: readonly MatchState['kind'][] = [
  'PLAYER_TURN',
  'OPPONENT_TURN',
  'MOVING',
  'GOAL',
];

/**
 * The turn indicator's line: the side to act and the state, in that order.
 * KICKOFF never reaches a readout (PF-7 routes it inside the update that
 * enters it) but the switch is total over the chart regardless.
 */
export function turnIndicatorText(state: MatchState, opponentName: string): string {
  switch (state.kind) {
    case 'MENU':
      return 'MENU';
    case 'KICKOFF':
      return 'KICKOFF';
    case 'PLAYER_TURN':
      return 'YOUR TURN';
    case 'OPPONENT_TURN':
      return `${opponentName.toUpperCase()} IS AIMING`;
    case 'MOVING':
      return 'IN PLAY';
    case 'GOAL':
      return 'GOAL';
    case 'PAUSED':
      return 'PAUSED';
    case 'GAME_OVER':
      return 'FULL TIME';
  }
}

function span(marker: string, className: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.dataset['pf'] = marker;
  return element;
}

export function createHud(options: HudOptions): Hud {
  const opponentName = options.opponentName ?? 'OPPONENT';

  const root = document.createElement('div');
  root.className = 'pf-hud';
  root.dataset['pf'] = 'hud';

  const playerScore = span('score-player', 'pf-score');
  const centre = span('centre-slot', 'pf-centre');
  const opponentScore = span('score-opponent', 'pf-score');

  // The centre slot carries one of two faces: the clock, or the goal target
  // above the score line for the matches with no clock (SPEC section 12).
  const clock = span('clock', 'pf-clock');
  const targetLine = span('target-line', 'pf-target');
  const centreScore = span('centre-score', 'pf-centre-score');
  targetLine.hidden = true;
  centreScore.hidden = true;

  const turn = span('turn', 'pf-turn');
  const ladder = span('ladder', 'pf-ladder');

  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'pf-pause';
  pause.dataset['pf'] = 'pause';
  pause.textContent = 'Pause';
  pause.setAttribute('aria-disabled', 'true');
  pause.addEventListener('click', () => {
    if (pause.getAttribute('aria-disabled') === 'true') {
      return;
    }
    options.onPause();
  });

  centre.append(clock, targetLine, centreScore, turn);
  root.append(playerScore, centre, opponentScore, ladder, pause);

  function updateCentre(readout: MatchReadout): void {
    if (readout.clock !== undefined) {
      clock.textContent = formatClock(readout.clock);
      clock.hidden = false;
      targetLine.hidden = true;
      centreScore.hidden = true;
      return;
    }
    clock.hidden = true;
    if (options.target !== undefined) {
      targetLine.textContent = `FIRST TO ${formatNumber(options.target)}`;
      targetLine.hidden = false;
    } else {
      targetLine.hidden = true;
    }
    centreScore.textContent = `${formatNumber(readout.scoring.player)} : ${formatNumber(
      readout.scoring.opponent,
    )}`;
    centreScore.hidden = false;
  }

  return {
    root,
    pause,

    update(readout: MatchReadout): void {
      playerScore.textContent = formatNumber(readout.scoring.player);
      opponentScore.textContent = formatNumber(readout.scoring.opponent);
      updateCentre(readout);
      turn.textContent = turnIndicatorText(readout.state, opponentName);
      const pausable = PAUSABLE.includes(readout.state.kind);
      pause.setAttribute('aria-disabled', pausable ? 'false' : 'true');
    },

    showLadder(name: string, position: number, total: number): void {
      ladder.textContent = `${name} - RUNG ${formatNumber(position)} OF ${formatNumber(total)}`;
    },

    clearLadder(): void {
      ladder.textContent = '';
    },
  };
}
