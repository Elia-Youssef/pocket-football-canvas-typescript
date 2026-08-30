/**
 * The chrome wiring: the HUD and the four panels mounted around the play
 * surface, and nothing else.
 *
 * WIRING, NOT POLICY. Every control raises an intent or a callback; what
 * each one means lives with the match or with the composition root. The one
 * policy the wiring owns is derivation: the pause and game-over panels are
 * the PAUSED and GAME_OVER states, and sync() shows and hides them from the
 * readout alone, so the chrome never keeps a second copy of the state to
 * drift away from the one on the pitch. Settings and how-to-play are
 * chrome-owned rather than match state, and one rule ties them in: the pause
 * stack closes with the pause, because a sub-panel left open over a running
 * match is a panel nobody is looking at.
 *
 * FOCUS COMES BACK TO WHERE IT CAME FROM. Settings and how-to-play are
 * opened from their own buttons in the pause panel, and hand focus back
 * there, so Escape keeps reaching the pause overlay that is still open
 * beneath them; the game-over panel opens without an invoker and uses the
 * HUD's pause control as its stable anchor on the way out. Containment of
 * focus inside an open overlay is the accessibility part's.
 *
 * THE THEME OVERRIDE WRAPS THE PLATFORM READ. Choosing Light or Dark writes
 * `data-theme` on the root, which the token stylesheet answers in both
 * directions; System clears it and the composition root falls back to the
 * media query it already ties the pitch palette to. Either way the pitch is
 * asked to re-render, so the canvas variant and the chrome theme cannot
 * split.
 */

import type { Match } from '../core/match';
import { createGameOverPanel } from './components/game-over-panel';
import { createHowToPanel } from './components/how-to-panel';
import { createHud } from './components/hud';
import { createPausePanel } from './components/pause-panel';
import { createSettingsPanel } from './components/settings-panel';
import type { ThemeChoice } from './components/settings-panel';

export interface ChromeOptions {
  /** The match the chrome reads. The only state source there is. */
  readonly match: Match;
  /** Called after a theme change, so the pitch re-renders in the variant. */
  readonly onThemeChange: () => void;
}

export interface Chrome {
  /** Re-reads the match readout and brings every readout and panel in line. */
  sync(): void;
}

/**
 * The stored theme setting, written where the token stylesheet reads it.
 * System is the absence of an override, not a third value.
 */
function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  if (theme === 'system') {
    delete root.dataset['theme'];
    return;
  }
  root.dataset['theme'] = theme;
}

export function mountChrome(host: HTMLElement, options: ChromeOptions): Chrome {
  const match = options.match;

  const hud = createHud({
    onPause: () => {
      match.dispatch({ kind: 'pause' });
      sync();
    },
  });

  const settings = createSettingsPanel({
    onThemeChange: (theme) => {
      applyTheme(theme);
      options.onThemeChange();
    },
    onClose: () => settings.hide(),
    onEscape: () => settings.hide(),
  });
  settings.select('system');

  const howTo = createHowToPanel({
    onClose: () => howTo.hide(),
    onEscape: () => howTo.hide(),
  });

  const pause = createPausePanel({
    onResume: () => {
      match.dispatch({ kind: 'resume' });
      sync();
    },
    onOpenSettings: () => settings.show(invokerOf(pause.controls(), 1)),
    onOpenHowToPlay: () => howTo.show(invokerOf(pause.controls(), 2)),
    onQuit: () => {
      match.dispatch({ kind: 'quit' });
      sync();
    },
    onEscape: () => {
      match.dispatch({ kind: 'resume' });
      sync();
    },
  });

  const game = createGameOverPanel({
    onPlayAgain: () => {
      match.restart();
      sync();
    },
  });

  function sync(): void {
    const readout = match.readout();
    hud.update(readout);
    if (readout.state.kind === 'GAME_OVER') {
      game.update(readout);
      if (!game.isOpen()) {
        game.show(hud.pause);
      }
    } else if (game.isOpen()) {
      game.hide();
    }
    if (readout.state.kind !== 'PAUSED') {
      if (pause.isOpen()) {
        pause.hide();
      }
      // The pause stack closes with the pause, whatever dismissed it.
      if (settings.isOpen()) {
        settings.hide();
      }
      if (howTo.isOpen()) {
        howTo.hide();
      }
    } else if (!pause.isOpen()) {
      pause.show(hud.pause);
    }
  }

  function invokerOf(controls: readonly HTMLElement[], at: number): HTMLElement {
    return controls[at] ?? hud.pause;
  }

  // The HUD leads the document so the play surface follows it in reading
  // order; the panels close the document, and paint above the canvas as
  // fixed overlays without depending on where the surface sits in the tree.
  host.insertBefore(hud.root, host.firstChild);
  host.append(pause.root, settings.root, howTo.root, game.root);

  sync();
  return { sync };
}
