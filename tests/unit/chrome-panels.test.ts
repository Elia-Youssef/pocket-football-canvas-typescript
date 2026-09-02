import { describe, expect, it, vi } from 'vitest';

import type { ScoringReadout } from '../../src/core/goals';
import type { MatchReadout } from '../../src/core/match';
import { createGameOverPanel, resultText } from '../../src/ui/components/game-over-panel';
import { createHowToPanel } from '../../src/ui/components/how-to-panel';
import { createPausePanel } from '../../src/ui/components/pause-panel';
import { createSettingsPanel } from '../../src/ui/components/settings-panel';
import { censusControls, findAllByTag, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * The four panels, each one real DOM: opened and closed, censused, and
 * wired.
 *
 * THE CENSUS FREEZES EACH SCREEN. The named focusable controls per panel,
 * in order, are asserted as literals, so an unreviewed addition reddens the
 * suite before it can reach a player. Escape is asserted only where a panel
 * is dismissible: the game-over panel is not, because the match is over and
 * Play Again is the way back in.
 */

function scoring(player: number, opponent: number): ScoringReadout {
  return {
    player,
    opponent,
    goals: player + opponent,
    hold: 0,
    frozen: false,
    nextTurn: 'player',
    last: undefined,
    over: false,
  };
}

function gameOverReadout(player: number, opponent: number): MatchReadout {
  return {
    state: { kind: 'GAME_OVER' },
    clock: 0,
    opponentReady: false,
    scoring: scoring(player, opponent),
  };
}

function pauseRoot(onEscape: () => void): FakeElement {
  return createPausePanel({
    onResume: () => undefined,
    onOpenSettings: () => undefined,
    onOpenHowToPlay: () => undefined,
    onQuit: () => undefined,
    onEscape,
  }).root as unknown as FakeElement;
}

function settingsRoot(onTheme: (theme: 'system' | 'light' | 'dark') => void): FakeElement {
  return createSettingsPanel({
    onThemeChange: onTheme,
    onSurfaceScaleChange: () => undefined,
    onReset: () => undefined,
    onClose: () => undefined,
    onEscape: () => undefined,
  }).root as unknown as FakeElement;
}

function howToRoot(): FakeElement {
  return createHowToPanel({
    onClose: () => undefined,
    onEscape: () => undefined,
  }).root as unknown as FakeElement;
}

function gameRoot(): FakeElement {
  // The panel as the composition root builds it: SPEC section 13's four
  // actions, which PF-9's mode wiring is what gives three of them somewhere
  // to go. The census below grew by exactly those three at that part.
  return createGameOverPanel({
    onPlayAgain: () => undefined,
    onChangeMode: () => undefined,
    onNextOpponent: () => undefined,
    onRestartLadder: () => undefined,
  }).root as unknown as FakeElement;
}

describe('PF-13 the panels', () => {
  it('freezes the named focusable controls on each screen', () => {
    const installed = installFakeDocument();
    try {
      expect(censusControls(pauseRoot(() => undefined))).toEqual([
        'Resume',
        'Settings',
        'How to play',
        'Quit',
      ]);
      // Grown at PF-10 by SPEC section 17's Reset all data and the two halves
      // of its in-place confirmation, and at PF-14 by the four play-surface
      // sizes QUALITY-BAR section 4 offers. Nothing that was here was removed
      // or renamed: the three theme radios and Close are where they were.
      expect(censusControls(settingsRoot(() => undefined))).toEqual([
        'System',
        'Light',
        'Dark',
        '100%',
        '125%',
        '150%',
        '200%',
        'Reset all data',
        'Confirm reset',
        'Cancel reset',
        'Close',
      ]);
      expect(censusControls(howToRoot())).toEqual(['Close']);
      expect(censusControls(gameRoot())).toEqual([
        'Play Again',
        'Change mode',
        'Next opponent',
        'Restart ladder',
      ]);
    } finally {
      installed.restore();
    }
  });

  it('mounts every panel closed', () => {
    const installed = installFakeDocument();
    try {
      const panels = [pauseRoot(() => undefined), settingsRoot(() => undefined), howToRoot(), gameRoot()];
      for (const root of panels) {
        expect(root.hidden).toBe(true);
      }
    } finally {
      installed.restore();
    }
  });

  it('opens with focus on the first control and closes with focus restored', () => {
    const installed = installFakeDocument();
    try {
      const panel = createPausePanel({
        onResume: () => undefined,
        onOpenSettings: () => undefined,
        onOpenHowToPlay: () => undefined,
        onQuit: () => undefined,
        onEscape: () => undefined,
      });
      const root = panel.root as unknown as FakeElement;
      const opener = installed.document.createElement('button');
      panel.show(opener as unknown as HTMLElement);
      expect(root.hidden).toBe(false);
      const first = findAllByTag(root, 'BUTTON')[0];
      expect(installed.document.activeElement).toBe(first);
      panel.hide();
      expect(root.hidden).toBe(true);
      expect(installed.document.activeElement).toBe(opener);
    } finally {
      installed.restore();
    }
  });

  it('raises escape only where the panel is dismissible', () => {
    const installed = installFakeDocument();
    try {
      const escape = { key: 'Escape' };

      const pauseEscape = vi.fn();
      pauseRoot(pauseEscape).dispatch('keydown', escape);
      expect(pauseEscape).toHaveBeenCalledTimes(1);

      const settingsEscape = vi.fn();
      const settings = createSettingsPanel({
        onThemeChange: () => undefined,
        onSurfaceScaleChange: () => undefined,
        onReset: () => undefined,
        onClose: () => undefined,
        onEscape: settingsEscape,
      });
      (settings.root as unknown as FakeElement).dispatch('keydown', escape);
      expect(settingsEscape).toHaveBeenCalledTimes(1);

      const howToEscape = vi.fn();
      const howTo = createHowToPanel({
        onClose: () => undefined,
        onEscape: howToEscape,
      });
      (howTo.root as unknown as FakeElement).dispatch('keydown', escape);
      expect(howToEscape).toHaveBeenCalledTimes(1);

      // The game-over panel has no escape listener at all: dispatching
      // reaches nobody, and the panel stays put.
      const game = gameRoot();
      expect(() => game.dispatch('keydown', escape)).not.toThrow();
      expect(game.hidden).toBe(true);
    } finally {
      installed.restore();
    }
  });

  it('wires every pause-panel button to its own callback', () => {
    const installed = installFakeDocument();
    try {
      const calls: string[] = [];
      const panel = createPausePanel({
        onResume: () => calls.push('resume'),
        onOpenSettings: () => calls.push('settings'),
        onOpenHowToPlay: () => calls.push('howto'),
        onQuit: () => calls.push('quit'),
        onEscape: () => calls.push('escape'),
      });
      const root = panel.root as unknown as FakeElement;
      const buttons = findAllByTag(root, 'BUTTON');
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Resume',
        'Settings',
        'How to play',
        'Quit',
      ]);
      for (const button of buttons) {
        button.dispatch('click');
      }
      expect(calls).toEqual(['resume', 'settings', 'howto', 'quit']);
    } finally {
      installed.restore();
    }
  });

  it('raises a theme change only from the checked radio, and never on select', () => {
    const installed = installFakeDocument();
    try {
      const changes: string[] = [];
      const panel = createSettingsPanel({
        onThemeChange: (theme) => changes.push(theme),
        onSurfaceScaleChange: () => undefined,
        onReset: () => undefined,
        onClose: () => undefined,
        onEscape: () => undefined,
      });
      const root = panel.root as unknown as FakeElement;
      panel.select('dark');
      expect(changes).toEqual([]);
      const inputs = findAllByTag(root, 'INPUT');
      // Seven from PF-14: the three theme radios, then the four play-surface
      // sizes, which are a group of their own and raise their own callback.
      expect(inputs).toHaveLength(7);
      expect(inputs.map((radio) => radio.getAttribute('aria-label'))).toEqual([
        'System',
        'Light',
        'Dark',
        '100%',
        '125%',
        '150%',
        '200%',
      ]);
      const radios = inputs.slice(0, 3);
      expect(radios.map((radio) => radio.getAttribute('name'))).toEqual([
        'pf-theme',
        'pf-theme',
        'pf-theme',
      ]);
      const dark = radios[2];
      expect(dark?.checked).toBe(true);
      dark?.dispatch('change');
      expect(changes).toEqual(['dark']);
    } finally {
      installed.restore();
    }
  });

  it('closes the settings panel from its own close button', () => {
    const installed = installFakeDocument();
    try {
      let closed = false;
      const panel = createSettingsPanel({
        onThemeChange: () => undefined,
        onSurfaceScaleChange: () => undefined,
        onReset: () => undefined,
        onClose: () => {
          closed = true;
        },
        onEscape: () => undefined,
      });
      const root = panel.root as unknown as FakeElement;
      panel.show();
      expect(root.hidden).toBe(false);
      // Found by its own marker rather than by position: the panel grew three
      // buttons ahead of Close at PF-10, and a control identified by index is
      // a test that quietly starts asserting something else.
      findByMarker(root, 'settings-close')?.dispatch('click');
      expect(closed).toBe(true);
    } finally {
      installed.restore();
    }
  });

  it('derives the result and the score line from the readout', () => {
    const installed = installFakeDocument();
    try {
      const resultOf = (player: number, opponent: number, name?: string): string => {
        const panel = createGameOverPanel({
          onPlayAgain: () => undefined,
          ...(name === undefined ? {} : { opponentName: name }),
        });
        panel.update(gameOverReadout(player, opponent));
        const root = panel.root as unknown as FakeElement;
        const result = findByMarker(root, 'result')?.textContent ?? '';
        const line = findByMarker(root, 'final-score')?.textContent ?? '';
        return `${result} ${line}`;
      };
      expect(resultOf(2, 1, 'Sparks')).toBe('You win! 2 : 1');
      expect(resultOf(1, 2, 'Sparks')).toBe('Sparks wins! 1 : 2');
      expect(resultOf(1, 1, 'Sparks')).toBe('Draw! 1 : 1');
      // Without a named rung, the side is named generically, not as "you".
      expect(resultOf(1, 2)).toBe('Opponent wins! 1 : 2');
    } finally {
      installed.restore();
    }
  });

  it('states the three results exactly as SPEC section 13 words them', () => {
    expect(resultText(3, 1, 'Sparks')).toBe('You win!');
    expect(resultText(1, 3, 'Sparks')).toBe('Sparks wins!');
    expect(resultText(2, 2, 'Sparks')).toBe('Draw!');
  });

  it('carries each panel heading as real text', () => {
    const installed = installFakeDocument();
    try {
      const headings = [
        findByMarker(pauseRoot(() => undefined), 'panel-pause'),
        findByMarker(settingsRoot(() => undefined), 'panel-settings'),
        findByMarker(howToRoot(), 'panel-how-to-play'),
        findByMarker(gameRoot(), 'panel-game-over'),
      ];
      const texts = headings.map((heading) => {
        const title = heading === undefined ? undefined : findAllByTag(heading, 'H2')[0];
        return title?.textContent;
      });
      expect(texts).toEqual(['Paused', 'Settings', 'How to play', 'Full time']);
    } finally {
      installed.restore();
    }
  });
});
