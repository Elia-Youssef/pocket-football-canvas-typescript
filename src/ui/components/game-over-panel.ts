/**
 * The game-over panel, SPEC section 13: both scores and the result, and the
 * way back into a match.
 *
 * THE RESULT IS DERIVED, ONCE, FROM THE READOUT. Player ahead is "You win!",
 * the opponent ahead names them, level is "Draw!". In the ladder the name is
 * the rung's; until the modes supply one, the side is named generically.
 * "Change mode" and the ladder's next-opponent and restart-ladder actions
 * are named in place for the mode part, whose chart owns the edges they
 * need: the match has no GAME_OVER to MENU path yet, and a button whose
 * intent no state accepts is exactly the dishonesty this part exists to
 * end.
 *
 * The panel is not dismissible: the match is over, and Play Again is the
 * way back in. Escape has nothing honest to restore, so it has no listener.
 */

import type { MatchReadout } from '../../core/match';
import { formatNumber } from './clock';
import { createPanel } from './panel';
import type { Panel } from './panel';

export interface GameOverPanelOptions {
  readonly onPlayAgain: () => void;
  readonly opponentName?: string;
}

export interface GameOverPanel extends Panel {
  /** Re-derives the result and the score line from the readout. */
  update(readout: MatchReadout): void;
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
  const name = options.opponentName ?? 'Opponent';
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

  const playAgain = document.createElement('button');
  playAgain.type = 'button';
  playAgain.className = 'pf-choice-button';
  playAgain.textContent = 'Play Again';
  playAgain.addEventListener('click', options.onPlayAgain);
  panel.addControl(playAgain);

  return {
    ...panel,

    update(readout: MatchReadout): void {
      result.textContent = resultText(
        readout.scoring.player,
        readout.scoring.opponent,
        name,
      );
      scoreLine.textContent = `${formatNumber(readout.scoring.player)} : ${formatNumber(
        readout.scoring.opponent,
      )}`;
    },
  };
}
