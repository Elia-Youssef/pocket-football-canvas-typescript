/**
 * The chrome wiring: the HUD and the five panels mounted around the play
 * surface, and nothing else.
 *
 * WIRING, NOT POLICY. Every control raises an intent or a callback; what
 * each one means lives with the match or with the composition root. The one
 * policy the wiring owns is derivation: the mode, pause and game-over panels
 * are the MENU, PAUSED and GAME_OVER states, and sync() shows and hides them
 * from the readout alone, so the chrome never keeps a second copy of the
 * state to drift away from the one on the pitch. Settings and how-to-play are
 * chrome-owned rather than match state, and one rule ties them in: the pause
 * stack closes WHEN THE PAUSE DOES, which is an edge and not a standing
 * condition, because How to Play is also opened from the menu on first launch
 * (SPEC section 19) and a standing condition would shut it in the same frame.
 *
 * FOCUS COMES BACK TO WHERE IT CAME FROM. Settings and how-to-play are
 * opened from their own buttons in the pause panel and in the menu, and hand
 * focus back there, so Escape keeps reaching the overlay that is still open
 * beneath them; the game-over panel opens without an invoker and uses the
 * HUD's pause control as its stable anchor on the way out.
 *
 * THE THEME OVERRIDE WRAPS THE PLATFORM READ. Choosing Light or Dark writes
 * `data-theme` on the root, which the token stylesheet answers in both
 * directions; System clears it and the composition root falls back to the
 * media query it already ties the pitch palette to. Either way the pitch is
 * asked to re-render, so the canvas variant and the chrome theme cannot
 * split.
 *
 * THE STORED THEME IS APPLIED HERE AND NOWHERE ELSE, for the same reason: a
 * composition root that wrote `data-theme` itself at boot would be a second
 * writer of the one attribute this wiring owns, and the two would drift the
 * first time either changed. The stored value arrives as an option, is applied
 * once at mount and is what the reset puts back.
 *
 * THE MODE WIRING IS OPTIONAL, AND ITS ABSENCE IS HONEST. A composition that
 * supplies no modes gets no menu, and the game-over panel's mode actions stay
 * refused in place: SPEC section 13's Change mode needs somewhere to change to.
 */

import type { Match } from '../core/match';
import type { ModeChoice, ModeSetup } from '../core/modes';
import { createGameOverPanel } from './components/game-over-panel';
import type { GameOverContext, GameOverPanelOptions } from './components/game-over-panel';
import { createHowToPanel } from './components/how-to-panel';
import { createHud } from './components/hud';
import { createModePanel } from './components/mode-panel';
import type { ModePanel } from './components/mode-panel';
import { createPausePanel } from './components/pause-panel';
import { createSettingsPanel } from './components/settings-panel';
import type { ThemeChoice } from './components/settings-panel';

/** SPEC section 9's menu, and the ways back into a match from SPEC section 13. */
export interface ModeWiring {
  /** The mode the menu opens on. */
  readonly initial: ModeChoice;
  /** SPEC section 11's guide setting the menu opens with. */
  readonly guideOn: boolean;
  readonly onStart: (choice: ModeChoice, guideOn: boolean) => void;
  readonly onPlayAgain: () => void;
  readonly onChangeMode: () => void;
  readonly onNextOpponent: () => void;
  readonly onRestartLadder: () => void;
  /** SPEC section 19: How to Play was put away, which is what persists. */
  readonly onHowToDismissed: () => void;
  /**
   * The rung the ladder stands on, asked EVERY time the menu opens. The menu
   * is derived from this the way every panel is derived from the readout, so
   * no route back to it can leave a rung the player has already passed.
   */
  readonly ladderRung: () => number;
  /** What the mode says about the match that has just finished. */
  readonly gameOver: () => GameOverContext;
}

export interface ChromeOptions {
  /** The match the chrome reads. The only state source there is. */
  readonly match: Match;
  /** Called after a theme change, so the pitch re-renders in the variant. */
  readonly onThemeChange: () => void;
  /**
   * SPEC section 17's stored theme, applied at mount. The chrome owns the
   * theme policy, so the stored value is handed to it rather than written to
   * the root by whoever read it: two writers of `data-theme` would be two
   * places for the canvas variant and the chrome theme to disagree.
   */
  readonly initialTheme?: ThemeChoice;
  /**
   * SPEC section 17's Reset all data, raised after the panel's own
   * confirmation. Absent in a composition that stores nothing.
   */
  readonly onResetData?: () => void;
  /** SPEC section 9's mode menu, absent in a composition that has none. */
  readonly modes?: ModeWiring;
}

export interface Chrome {
  /** Re-reads the match readout and brings every readout and panel in line. */
  sync(): void;
  /** SPEC section 19's overlay, opened on first launch and from the menu. */
  showHowToPlay(): void;
  /** Bring the HUD's names and ladder readout in line with a started mode. */
  applyMode(setup: ModeSetup): void;
  /** The guide setting the menu shows, for a mode that changed its default. */
  setGuide(on: boolean): void;
}

/** The theme a player who has never chosen one gets, and the reset's target. */
const NEW_THEME: ThemeChoice = 'system';

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
  const modes = options.modes;

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
    // THE THEME GOES BACK BEFORE THE DATA GOES. The chrome's own theme policy
    // puts the override where a new player would have it and asks the pitch to
    // follow, and only then is the stored data cleared, so the clear is the
    // last word rather than something a default written over the top of it.
    onReset: () => {
      applyTheme(NEW_THEME);
      settings.select(NEW_THEME);
      options.onThemeChange();
      options.onResetData?.();
    },
    onClose: () => settings.hide(),
    onEscape: () => settings.hide(),
  });
  const theme = options.initialTheme ?? NEW_THEME;
  applyTheme(theme);
  settings.select(theme);

  const howTo = createHowToPanel({
    onClose: () => dismissHowTo(),
    onEscape: () => dismissHowTo(),
  });

  const mode: ModePanel | undefined =
    modes === undefined
      ? undefined
      : createModePanel({
          initial: modes.initial,
          guideOn: modes.guideOn,
          onStart: (choice, guideOn) => {
            modes.onStart(choice, guideOn);
            sync();
          },
          onHowToPlay: () => {
            showHowToPlay();
          },
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

  const game = createGameOverPanel(gameOverOptions());

  function gameOverOptions(): GameOverPanelOptions {
    if (modes === undefined) {
      return {
        onPlayAgain: () => {
          match.restart();
          sync();
        },
      };
    }
    return {
      onPlayAgain: () => {
        modes.onPlayAgain();
        sync();
      },
      onChangeMode: () => {
        modes.onChangeMode();
        sync();
      },
      onNextOpponent: () => {
        modes.onNextOpponent();
        sync();
      },
      onRestartLadder: () => {
        modes.onRestartLadder();
        sync();
      },
    };
  }

  /** SPEC section 19: putting How to Play away is the dismissal that persists. */
  function dismissHowTo(): void {
    howTo.hide();
    modes?.onHowToDismissed();
  }

  function showHowToPlay(): void {
    // The anchor is whatever is honest to come back to: the menu's own button
    // while the menu is open, and the pause control otherwise, so focus never
    // lands on the document body when the overlay closes.
    const anchor = mode !== undefined && mode.isOpen() ? menuAnchor(mode) : hud.pause;
    howTo.show(anchor);
  }

  function menuAnchor(panel: ModePanel): HTMLElement {
    const controls = panel.controls();
    return controls.at(-1) ?? hud.pause;
  }

  /** True while the readout is a paused match, tracked so the stack closes on the edge. */
  let wasPaused = false;

  function sync(): void {
    const readout = match.readout();
    hud.update(readout);
    if (readout.state.kind === 'GAME_OVER') {
      game.update(readout, modes?.gameOver());
      if (!game.isOpen()) {
        game.show(hud.pause);
      }
    } else if (game.isOpen()) {
      game.hide();
    }
    if (mode !== undefined) {
      const inMenu = readout.state.kind === 'MENU';
      if (inMenu && !mode.isOpen()) {
        // Derived on every open, never pushed: see `ModeWiring.ladderRung`.
        mode.setLadderRung(modes?.ladderRung() ?? 1);
        mode.show(hud.pause);
      } else if (!inMenu && mode.isOpen()) {
        mode.hide();
      }
    }
    const paused = readout.state.kind === 'PAUSED';
    if (paused && !pause.isOpen()) {
      pause.show(hud.pause);
    }
    if (!paused) {
      if (pause.isOpen()) {
        pause.hide();
      }
      if (wasPaused) {
        // The pause stack closes with the pause, whatever dismissed it: a
        // sub-panel left open over a running match is a panel nobody is
        // looking at. It closes on the EDGE, so an overlay opened outside a
        // pause, which is what first launch does, is left where it is.
        if (settings.isOpen()) {
          settings.hide();
        }
        if (howTo.isOpen()) {
          howTo.hide();
        }
      }
    }
    wasPaused = paused;
  }

  function invokerOf(controls: readonly HTMLElement[], at: number): HTMLElement {
    return controls[at] ?? hud.pause;
  }

  // The HUD leads the document so the play surface follows it in reading
  // order; the panels close the document, and paint above the canvas as
  // fixed overlays without depending on where the surface sits in the tree.
  //
  // THE MENU IS THE BOTTOM OVERLAY, and its place in the source order is what
  // says so: every other panel opens OVER it, and How to Play opens over it on
  // first launch (SPEC section 19), so a menu appended last would take the
  // presses meant for the overlay above it.
  host.insertBefore(hud.root, host.firstChild);
  if (mode !== undefined) {
    host.append(mode.root);
  }
  host.append(pause.root, settings.root, howTo.root, game.root);

  sync();
  return {
    sync,
    showHowToPlay,

    applyMode(setup: ModeSetup): void {
      hud.setNames(setup.opponentName, setup.playerName);
      if (setup.ladder === undefined) {
        hud.clearLadder();
      } else {
        hud.showLadder(setup.ladder.name, setup.ladder.position, setup.ladder.total);
      }
    },

    setGuide(on: boolean): void {
      mode?.setGuide(on);
    },
  };
}
