/**
 * The chrome wiring: the HUD, SPEC section 2.1's portrait hint and the five
 * panels mounted around the play surface, and nothing else.
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
 * AND WHILE ONE IS OPEN, NOTHING ELSE IS REACHABLE. Item G9 asks every overlay
 * to trap focus, and the trap is `inert` on every other element of the app
 * column: the platform then takes them out of the tab order, out of pointer
 * hit-testing and out of the accessibility tree together, so a Tab walk wraps
 * inside the open panel at both ends with no key handler anywhere. It is applied
 * HERE because the stack is here: a panel can sit over another one (settings and
 * how-to-play both open from the pause overlay, and how-to-play opens over the
 * menu on first launch), so the only element that stays live is the TOP-MOST
 * open one, which is the last open panel in source order because that is the one
 * the browser paints on top. The elements the composition root mounts rather
 * than this wiring arrive as `background`, so the column's membership is stated
 * in one place rather than split between two modules that would drift.
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
 * NOTHING HERE IS OPTIONAL, AND THAT IS THE CHANGE THIS FILE HAS MOST OF. The
 * wiring used to take seven optional members and the one composition that mounts
 * a chrome supplied all seven, so the absent cases were branches nothing shipping
 * took: a menu that could be missing, a game-over panel wired two ways, a theme
 * that fell back to System here as well as at the store that owns it. They are
 * gone, and `ChromeOptions` below says what the composition root does.
 *
 * NO BREAKPOINT IS DECIDED HERE. QUALITY-BAR section 5's four names are
 * resolved in `ui/breakpoints.ts` and written onto the root element by the
 * composition root, and the stylesheet selects on the result; this wiring
 * mounts the portrait hint unconditionally and never asks how wide anything
 * is. Nothing under `ui/` measures a rectangle, which is what item M1 is
 * about, and a second copy of the breakpoint rule here is exactly the drift
 * that rule exists to prevent.
 */

import type { Match } from '../core/match';
import type { ModeChoice, ModeSetup } from '../core/modes';
import { NEW_SETTINGS } from '../core/storage';
import { setInertIfChanged } from './components/control';
import { createGameOverPanel } from './components/game-over-panel';
import type { GameOverContext, GameOverPanelOptions } from './components/game-over-panel';
import { createHowToPanel } from './components/how-to-panel';
import { createHud } from './components/hud';
import { createModePanel } from './components/mode-panel';
import type { ModePanel } from './components/mode-panel';
import type { Panel } from './components/panel';
import { createPausePanel } from './components/pause-panel';
import { createPortraitHint } from './components/portrait-hint';
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

/**
 * Everything the chrome is wired with. EVERY FIELD IS REQUIRED, and that is a
 * decision rather than an oversight.
 *
 * Seven of these were optional and the one composition that mounts a chrome
 * supplied all seven every time, so the absent cases were seven branches
 * nothing shipping ever took: each a defaulting rule stated here as well as at
 * the store that owns it, and each a way for a test to mount a chrome the game
 * does not have. A theme that falls back to System is the stored document's
 * decision and not the wiring's, and a mode menu that can be absent is a game
 * with no way to start a match. Required, the type says what the composition
 * root does, and `tests/unit/support/chrome-options.ts` is the ONE place a test
 * fills the fields it does not care about, so a field added here is added once
 * there rather than in every mount.
 */
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
  readonly initialTheme: ThemeChoice;
  /**
   * QUALITY-BAR section 4's play-surface size, raised when it is changed. The
   * chrome owns the control and the composition root owns the fit, because a
   * CSS box is not something anything under `ui/` may measure or set.
   */
  readonly onSurfaceScaleChange: (percent: number) => void;
  /** The stored size the control opens on. */
  readonly initialSurfaceScale: number;
  /** SPEC section 2.1's portrait hint, as the stored document left it. */
  readonly hintDismissed: boolean;
  /** Raised when the hint is put away, so the dismissal can be persisted. */
  readonly onHintDismissed: () => void;
  /**
   * SPEC section 17's Reset all data, raised after the panel's own
   * confirmation.
   */
  readonly onResetData: () => void;
  /** SPEC section 9's mode menu, which every composition that plays has. */
  readonly modes: ModeWiring;
  /**
   * The elements of the app column this wiring did NOT mount: the play stage,
   * the accessible mirror beside it and SPEC section 5.0's aim row. Item G9's
   * trap makes every one of them `inert` while an overlay is open, and they are
   * handed in rather than looked up because a wiring that searched the column
   * for them would find whatever a later part added and call it background.
   */
  readonly background: readonly HTMLElement[];
}

export interface Chrome {
  /**
   * SPEC section 12's bar, which is the sticky top half of QUALITY-BAR section
   * 5's arrangement. The composition root measures it for the scroll padding
   * WCAG 2.2 SC 2.4.11 needs, because a css box is not something anything under
   * `ui/` may measure and a bar's height is content plus padding plus whatever
   * the safe-area insets add.
   */
  readonly hudBar: HTMLElement;
  /** Re-reads the match readout and brings every readout and panel in line. */
  sync(): void;
  /** SPEC section 19's overlay, opened on first launch and from the menu. */
  showHowToPlay(): void;
  /** Bring the HUD's names and ladder readout in line with a started mode. */
  applyMode(setup: ModeSetup): void;
  /** The guide setting the menu shows, for a mode that changed its default. */
  setGuide(on: boolean): void;
  /**
   * The marker of the overlay that currently holds focus, or `null` while the
   * page is playable. Item G9's trap is applied by `sync`; this is what a test
   * reads to say which panel the trap is around.
   */
  modalMarker(): string | null;
}

/** The theme a player who has never chosen one gets, and the reset's target. */
const NEW_THEME: ThemeChoice = 'system';

/**
 * The play-surface size a player who has never chosen one gets, and the
 * reset's target. Consumed from the stored settings rather than restated: the
 * document owns the new-player value and this is the same one.
 */
const NEW_SURFACE_SCALE = NEW_SETTINGS.surfaceScale;

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

/**
 * A panel's invoker is its stable marker, never its present position. Adding a
 * control before Settings or How to play must not silently restore focus to a
 * different button.
 */
export function controlByMarker(
  controls: readonly HTMLElement[],
  marker: string,
  fallback: HTMLElement,
): HTMLElement {
  return controls.find((control) => control.dataset['pf'] === marker) ?? fallback;
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

  const hint = createPortraitHint({
    onDismiss: () => {
      options.onHintDismissed();
    },
  });
  hint.setDismissed(options.hintDismissed);

  const settings = createSettingsPanel({
    onThemeChange: (theme) => {
      applyTheme(theme);
      options.onThemeChange();
    },
    onSurfaceScaleChange: (percent) => {
      options.onSurfaceScaleChange(percent);
    },
    // THE CHROME'S OWN DEFAULTS GO BACK BEFORE THE DATA GOES. The chrome owns
    // the theme, the size control and the hint, so each is put where a new
    // player would have it and the pitch is asked to follow, and only then is
    // the stored data cleared, so the clear is the last word rather than
    // something a default written over the top of it. The hint needs no write
    // of its own: the clear is what puts its stored dismissal back.
    onReset: () => {
      applyTheme(NEW_THEME);
      settings.select(NEW_THEME);
      settings.selectSurfaceScale(NEW_SURFACE_SCALE);
      hint.setDismissed(false);
      options.onThemeChange();
      options.onSurfaceScaleChange(NEW_SURFACE_SCALE);
      options.onResetData();
    },
    onClose: () => {
      dismiss(settings);
    },
    onEscape: () => {
      dismiss(settings);
    },
  });
  const theme = options.initialTheme;
  applyTheme(theme);
  settings.select(theme);
  settings.selectSurfaceScale(options.initialSurfaceScale);

  const howTo = createHowToPanel({
    onClose: () => dismissHowTo(),
    onEscape: () => dismissHowTo(),
  });

  const mode: ModePanel = createModePanel({
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
    onOpenSettings: () => {
      open(settings, controlByMarker(pause.controls(), 'pause-settings', hud.pause));
    },
    onOpenHowToPlay: () => {
      open(howTo, controlByMarker(pause.controls(), 'pause-how-to', hud.pause));
    },
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
    dismiss(howTo);
    modes.onHowToDismissed();
  }

  function showHowToPlay(): void {
    // The anchor is whatever is honest to come back to: the menu's own button
    // while the menu is open, and the pause control otherwise, so focus never
    // lands on the document body when the overlay closes.
    const anchor = mode.isOpen() ? menuAnchor(mode) : hud.pause;
    open(howTo, anchor);
  }

  function menuAnchor(panel: ModePanel): HTMLElement {
    // BY MARKER, like every other invoker in this file. It was the LAST control
    // in the menu's list, which is the How to play button only for as long as
    // nothing is added after it: a control appended later would silently become
    // the thing focus came back to. `controlByMarker` is the rule stated a few
    // lines above `mountChrome` and this was the one place not following it.
    return controlByMarker(panel.controls(), 'mode-how-to', hud.pause);
  }

  /**
   * The overlays, in the order the document holds them, which is the order they
   * paint in: every panel is fixed at the same stacking level, so the LAST open
   * one is the one on top and the one the trap is built around. The menu is
   * first because every other overlay can open above it.
   */
  const STACK: readonly Panel[] = [mode, pause, settings, howTo, game];

  /**
   * The overlays closing in the call now running.
   *
   * THE TRAP HAS TO BE LIFTED BEFORE THE FOCUS COMES BACK, and that is the only
   * reason this set exists. A panel hands focus to the control that opened it as
   * it closes, an `inert` element REFUSES focus, and the refusal is silent:
   * focus falls to the document body, which is exactly the outcome QUALITY-BAR
   * section 3 and item C12 forbid. So a panel about to close is treated as
   * already closed while the stack is recomputed, the background it was covering
   * comes back to life, and only then does it hand focus over. Measured, not
   * theorised: three keyboard tests failed this way before the set existed.
   */
  const closing = new Set<Panel>();

  /** The top-most open overlay, or nothing while the page is playable. */
  function topOpen(): Panel | null {
    for (let at = STACK.length - 1; at >= 0; at -= 1) {
      const panel = STACK[at];
      if (panel !== undefined && panel.isOpen() && !closing.has(panel)) {
        return panel;
      }
    }
    return null;
  }

  /**
   * Item G9's trap: everything except the top-most open overlay is `inert`.
   *
   * Applied on every sync rather than on an open, because an overlay can close
   * underneath an open one (the pause stack closes with the pause) and because
   * `setInertIfChanged` makes a sync that changes nothing cost nothing.
   */
  function applyModal(): void {
    const top = topOpen();
    for (const element of [hud.root, hint.root, ...options.background]) {
      setInertIfChanged(element, top !== null);
    }
    for (const panel of STACK) {
      setInertIfChanged(panel.root, top !== null && panel !== top);
    }
  }

  /**
   * Open or close an overlay the MATCH does not decide: settings and how-to-play
   * are chrome-owned, so `sync` has no state to derive them from and the trap
   * has to be reapplied where they are actually opened and closed.
   */
  /**
   * Show an overlay and put focus on its first control.
   *
   * THE TRAP COMES OFF THE PANEL FIRST, and it is the same rule as `dismiss`
   * below read the other way round: a panel opening from inside another one was
   * that one's background a moment ago and is still `inert`, so its own `show`
   * would ask an inert control to take focus and be silently refused. Settings
   * and How to Play both open from the pause overlay, and the menu opens
   * underneath it on a quit, so all three arrive here already inert.
   */
  function reveal(panel: Panel, invoker: HTMLElement): void {
    setInertIfChanged(panel.root, false);
    panel.show(invoker);
  }

  function open(panel: Panel, invoker: HTMLElement): void {
    reveal(panel, invoker);
    applyModal();
  }

  /**
   * Close an overlay, lifting the trap off its opener before it hands focus
   * back. Every `hide` in this wiring goes through here for that reason.
   */
  function dismiss(panel: Panel): void {
    closing.add(panel);
    applyModal();
    panel.hide();
    closing.delete(panel);
  }

  /** True while the readout is a paused match, tracked so the stack closes on the edge. */
  let wasPaused = false;

  function sync(): void {
    const readout = match.readout();
    hud.update(readout);
    if (readout.state.kind === 'GAME_OVER') {
      game.update(readout, modes.gameOver());
      if (!game.isOpen()) {
        reveal(game, hud.pause);
      }
    } else if (game.isOpen()) {
      dismiss(game);
    }
    const inMenu = readout.state.kind === 'MENU';
    if (inMenu && !mode.isOpen()) {
      // Derived on every open, never pushed: see `ModeWiring.ladderRung`.
      mode.setLadderRung(modes.ladderRung());
      reveal(mode, hud.pause);
    } else if (!inMenu && mode.isOpen()) {
      dismiss(mode);
    }
    const paused = readout.state.kind === 'PAUSED';
    if (paused && !pause.isOpen()) {
      reveal(pause, hud.pause);
    }
    if (!paused) {
      if (pause.isOpen()) {
        dismiss(pause);
      }
      if (wasPaused) {
        // The pause stack closes with the pause, whatever dismissed it: a
        // sub-panel left open over a running match is a panel nobody is
        // looking at. It closes on the EDGE, so an overlay opened outside a
        // pause, which is what first launch does, is left where it is.
        if (settings.isOpen()) {
          dismiss(settings);
        }
        if (howTo.isOpen()) {
          dismiss(howTo);
        }
      }
    }
    wasPaused = paused;
    // LAST, and that is the order: every branch above can open or close a
    // panel, so the trap is applied once from the settled stack rather than
    // reapplied by each of them.
    applyModal();
  }

  // The HUD leads the document so the play surface follows it in reading
  // order; the panels close the document, and paint above the canvas as
  // fixed overlays without depending on where the surface sits in the tree.
  //
  // THE HINT TAKES THE ROW BETWEEN THE HUD AND THE PITCH, which is what makes
  // "covers no control" a fact about the layout rather than a measurement: it
  // is in the flow, so it displaces rather than overlaps. It is inserted
  // first and the HUD ahead of it, because a stand-in document need only
  // answer `firstChild` for that and never a sibling walk.
  //
  // THE MENU IS THE BOTTOM OVERLAY, and its place in the source order is what
  // says so: every other panel opens OVER it, and How to Play opens over it on
  // first launch (SPEC section 19), so a menu appended last would take the
  // presses meant for the overlay above it.
  host.insertBefore(hint.root, host.firstChild);
  host.insertBefore(hud.root, hint.root);
  host.append(mode.root);
  host.append(pause.root, settings.root, howTo.root, game.root);

  sync();
  return {
    hudBar: hud.root,
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
      mode.setGuide(on);
    },

    modalMarker(): string | null {
      return topOpen()?.root.dataset['pf'] ?? null;
    },
  };
}
