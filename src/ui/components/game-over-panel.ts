/**
 * The game-over panel, SPEC section 13: both scores, the result, and every way
 * back into a match.
 *
 * THE RESULT IS DERIVED, ONCE, FROM THE READOUT. Player ahead is "You win!",
 * the opponent ahead names them, level is "Draw!". The name is the mode's: the
 * ladder rung's in Ladder, the second human's in Hotseat, and a generic one
 * where SPEC section 9 gives the opponent no name at all.
 *
 * FOUR ACTIONS, ALL FOUR ALWAYS IN THE DOCUMENT, EACH REFUSED IN PLACE WHERE
 * IT DOES NOT APPLY. SPEC section 13 lists Play Again, Change mode, and in
 * Ladder either Next opponent or Restart ladder, and "either" is the reason
 * the last two are never both live at once: a rung won offers the next
 * opponent, a rung lost offers the ladder again, a rung drawn offers neither
 * and leaves Play Again to replay it, and a ladder completed offers the
 * restart because there is no seventh rung. Removing the inapplicable one
 * would drop a focused control on a state change, which QUALITY-BAR section 3
 * forbids, so they are disabled in place exactly as the pause control is.
 *
 * The panel is not dismissible: the match is over, and the four actions are
 * the ways back in. Escape has nothing honest to restore, so it has no
 * listener.
 */

import type { MatchReadout } from '../../core/match';
import type { LadderStep } from '../../core/modes';
import { formatNumber } from './clock';
import { createButton, setRefused, setTextIfChanged } from './control';
import { createPanel } from './panel';
import type { Panel } from './panel';

export interface GameOverPanelOptions {
  readonly onPlayAgain: () => void;
  readonly opponentName?: string;
  /** SPEC section 13's Change mode. Absent in a composition with no menu. */
  readonly onChangeMode?: () => void;
  /** SPEC section 9's ladder actions. Absent where there is no ladder. */
  readonly onNextOpponent?: () => void;
  readonly onRestartLadder?: () => void;
}

/** What the mode tells the panel about the match that has just finished. */
export interface GameOverContext {
  /** The name the result string uses for the other side. */
  readonly opponentName: string;
  /** SPEC section 9's ladder step this result earned, or nothing outside it. */
  readonly ladderStep?: LadderStep;
  /** True when the rung just won was the last one, so nothing follows it. */
  readonly ladderComplete?: boolean;
}

export interface GameOverPanel extends Panel {
  /** Re-derives the result, the score line and which actions are live. */
  update(readout: MatchReadout, context?: GameOverContext): void;
}

/** SPEC section 13's three results, decided on the scoreboard alone. */
export function resultText(player: number, opponent: number, name: string): string {
  if (player > opponent) {
    return 'You win!';
  }
  if (opponent > player) {
    return `${name} wins!`;
  }
  return 'Draw!';
}

export function createGameOverPanel(options: GameOverPanelOptions): GameOverPanel {
  const fallbackName = options.opponentName ?? 'Opponent';
  const panel = createPanel({
    name: 'panel-game-over',
    heading: 'Full time',
  });

  const result = document.createElement('p');
  result.className = 'pf-panel-result';
  result.dataset['pf'] = 'result';

  const scoreLine = document.createElement('p');
  scoreLine.className = 'pf-panel-text';
  scoreLine.dataset['pf'] = 'final-score';

  panel.addControl(result);
  panel.addControl(scoreLine);

  function action(
    marker: string,
    label: string,
    handler: (() => void) | undefined,
  ): HTMLButtonElement {
    const button = createButton({
      marker,
      label,
      className: 'pf-choice-button',
      onActivate: () => {
        handler?.();
      },
    });
    panel.addControl(button);
    return button;
  }

  const playAgain = action('play-again', 'Play Again', options.onPlayAgain);
  const changeMode = action('change-mode', 'Change mode', options.onChangeMode);
  const nextOpponent = action('next-opponent', 'Next opponent', options.onNextOpponent);
  const restartLadder = action('restart-ladder', 'Restart ladder', options.onRestartLadder);

  function refuse(button: HTMLButtonElement, live: boolean): void {
    setRefused(button, !live);
  }

  refuse(playAgain, true);
  refuse(changeMode, options.onChangeMode !== undefined);
  refuse(nextOpponent, false);
  refuse(restartLadder, false);

  return {
    ...panel,

    update(readout: MatchReadout, context?: GameOverContext): void {
      const name = context?.opponentName ?? fallbackName;
      setTextIfChanged(
        result,
        resultText(readout.scoring.player, readout.scoring.opponent, name),
      );
      setTextIfChanged(
        scoreLine,
        `${formatNumber(readout.scoring.player)} : ${formatNumber(readout.scoring.opponent)}`,
      );
      const step: LadderStep | undefined = context?.ladderStep;
      const complete = context?.ladderComplete === true;
      refuse(changeMode, options.onChangeMode !== undefined);
      refuse(
        nextOpponent,
        options.onNextOpponent !== undefined && step === 'advance' && !complete,
      );
      refuse(
        restartLadder,
        options.onRestartLadder !== undefined && (step === 'restart' || complete),
      );
    },
  };
}
