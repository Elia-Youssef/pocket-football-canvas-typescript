import { describe, expect, it, vi } from 'vitest';

import { createMatch } from '../../src/core/match';
import type { MatchReadout } from '../../src/core/match';
import type { ScoringReadout } from '../../src/core/goals';
import { createGameOverPanel } from '../../src/ui/components/game-over-panel';
import { createHud, turnIndicatorText } from '../../src/ui/components/hud';
import { createModePanel } from '../../src/ui/components/mode-panel';
import type { ModePanel } from '../../src/ui/components/mode-panel';
import type { ModeChoice } from '../../src/core/modes';
import { censusControls, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement, InstalledDocument } from './support/chrome-dom';

/**
 * The chrome SPEC section 9's modes bring with them: the menu, the game-over
 * actions those modes give somewhere to go, and the two HUD readouts a mode
 * decides. Real DOM against the stand-in document, exactly as the rest of the
 * chrome is graded.
 *
 * THE MENU'S CENSUS IS FROZEN HERE. tests/unit/chrome-dom.test.ts freezes the
 * whole chrome, menu included, as the composition root mounts it; this file
 * freezes the menu on its own, so a control added to it is named in the same
 * change in both places.
 *
 * REFUSED IN PLACE IS ASSERTED AS BOTH HALVES. A group a mode does not read
 * has to still be in the document (QUALITY-BAR section 3: a control that
 * vanishes on a phase change drops focus on the floor) AND has to ignore a
 * change delivered to it anyway, because `aria-disabled` is a promise to a
 * screen reader and not a lock the platform enforces.
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

interface Rig {
  readonly installed: InstalledDocument;
  readonly panel: ModePanel;
  readonly root: FakeElement;
}

function menu(
  onStart: (choice: ModeChoice, guideOn: boolean) => void = () => undefined,
): Rig {
  const installed = installFakeDocument();
  const panel = createModePanel({
    initial: { kind: 'quick', duration: 60, difficulty: 'casual' },
    guideOn: true,
    onStart,
    onHowToPlay: () => undefined,
  });
  return { installed, panel, root: panel.root as unknown as FakeElement };
}

/** Pick a control the way the platform does: check it, then raise the change. */
function pick(root: FakeElement, marker: string): void {
  const input = findByMarker(root, marker);
  if (input === undefined) {
    throw new Error(`no control marked ${marker}`);
  }
  input.checked = true;
  input.dispatch('change');
}

function refused(root: FakeElement, marker: string): boolean {
  return findByMarker(root, marker)?.getAttribute('aria-disabled') === 'true';
}

describe('PF-9 the mode menu', () => {
  it('freezes its own focusable controls, in order', () => {
    const rig = menu();
    try {
      expect(censusControls(rig.root)).toEqual([
        'Quick Match',
        'First to N',
        'Ladder',
        'Hotseat',
        '60 seconds',
        '90 seconds',
        '120 seconds',
        '3 goals',
        '5 goals',
        '7 goals',
        'Casual',
        'Pro',
        'Ace',
        'Aim guide',
        'Start',
        'How to play',
      ]);
      expect(rig.root.hidden).toBe(true);
    } finally {
      rig.installed.restore();
    }
  });

  it('answers with the choice its controls name', () => {
    const started: unknown[] = [];
    const rig = menu((choice, guideOn) => {
      started.push({ choice, guideOn });
    });
    try {
      expect(rig.panel.choice()).toEqual({
        kind: 'quick',
        duration: 60,
        difficulty: 'casual',
      });
      pick(rig.root, 'duration-120');
      pick(rig.root, 'difficulty-pro');
      expect(rig.panel.choice()).toEqual({
        kind: 'quick',
        duration: 120,
        difficulty: 'pro',
      });

      pick(rig.root, 'mode-first-to');
      pick(rig.root, 'target-7');
      expect(rig.panel.choice()).toEqual({
        kind: 'first-to',
        target: 7,
        difficulty: 'pro',
      });

      pick(rig.root, 'mode-hotseat');
      expect(rig.panel.choice()).toEqual({ kind: 'hotseat', target: 7 });

      pick(rig.root, 'mode-ladder');
      rig.panel.setLadderRung(4);
      expect(rig.panel.choice()).toEqual({ kind: 'ladder', rung: 4 });

      // Start hands the choice over exactly as it stands.
      findByMarker(rig.root, 'mode-start')?.dispatch('click');
      expect(started).toEqual([
        { choice: { kind: 'ladder', rung: 4 }, guideOn: rig.panel.guideOn() },
      ]);
    } finally {
      rig.installed.restore();
    }
  });

  it('refuses in place the groups a mode does not read', () => {
    const rig = menu();
    try {
      // Quick Match reads the duration and the difficulty and not the target.
      expect(refused(rig.root, 'duration-60')).toBe(false);
      expect(refused(rig.root, 'difficulty-casual')).toBe(false);
      expect(refused(rig.root, 'target-3')).toBe(true);

      pick(rig.root, 'mode-first-to');
      expect(refused(rig.root, 'target-3')).toBe(false);
      expect(refused(rig.root, 'duration-60')).toBe(true);
      expect(refused(rig.root, 'difficulty-casual')).toBe(false);

      pick(rig.root, 'mode-ladder');
      // The ladder's rung carries its own difficulty (SPEC section 10), so the
      // menu offers neither a length nor a difficulty for it.
      expect(refused(rig.root, 'duration-60')).toBe(true);
      expect(refused(rig.root, 'target-3')).toBe(true);
      expect(refused(rig.root, 'difficulty-casual')).toBe(true);

      pick(rig.root, 'mode-hotseat');
      expect(refused(rig.root, 'target-3')).toBe(false);
      expect(refused(rig.root, 'difficulty-casual')).toBe(true);

      // Present in every one of those modes, which is the other half of
      // refusing in place.
      for (const marker of ['duration-60', 'target-3', 'difficulty-casual']) {
        expect(findByMarker(rig.root, marker)).toBeDefined();
      }
    } finally {
      rig.installed.restore();
    }
  });

  it('ignores a change delivered to a refused control', () => {
    const rig = menu();
    try {
      pick(rig.root, 'mode-ladder');
      // The platform can still deliver this: aria-disabled is a promise, not
      // a lock. The choice must not move.
      pick(rig.root, 'target-7');
      expect(rig.panel.choice()).toEqual({ kind: 'ladder', rung: 1 });
      pick(rig.root, 'duration-120');
      expect(rig.panel.choice()).toEqual({ kind: 'ladder', rung: 1 });
      // And the refused control is put back rather than left checked.
      expect(findByMarker(rig.root, 'target-7')?.checked).toBe(false);
      expect(findByMarker(rig.root, 'target-3')?.checked).toBe(true);
    } finally {
      rig.installed.restore();
    }
  });

  it('puts the guide back to the default of whatever was just chosen', () => {
    const rig = menu();
    try {
      // SPEC section 11: on at Casual, off above it, and the menu shows it.
      expect(rig.panel.guideOn()).toBe(true);
      pick(rig.root, 'difficulty-ace');
      expect(rig.panel.guideOn()).toBe(false);
      expect(findByMarker(rig.root, 'mode-guide')?.checked).toBe(false);
      pick(rig.root, 'difficulty-casual');
      expect(rig.panel.guideOn()).toBe(true);

      // An explicit tick is the player's and stands until the choice changes.
      const box = findByMarker(rig.root, 'mode-guide');
      if (box === undefined) {
        throw new Error('no guide control');
      }
      box.checked = false;
      box.dispatch('change');
      expect(rig.panel.guideOn()).toBe(false);
      // The ladder's rung one is Casual, so choosing it defaults it back on.
      pick(rig.root, 'mode-ladder');
      expect(rig.panel.guideOn()).toBe(true);
    } finally {
      rig.installed.restore();
    }
  });

  it('names the rung the ladder would resume at', () => {
    const rig = menu();
    try {
      expect(findByMarker(rig.root, 'mode-ladder-rung')?.textContent).toBe(
        'Ladder: rung 1 of 6, Sparks',
      );
      rig.panel.setLadderRung(6);
      expect(findByMarker(rig.root, 'mode-ladder-rung')?.textContent).toBe(
        'Ladder: rung 6 of 6, Meridian',
      );
      // A rung outside the ladder is clamped rather than shown.
      rig.panel.setLadderRung(99);
      expect(findByMarker(rig.root, 'mode-ladder-rung')?.textContent).toBe(
        'Ladder: rung 6 of 6, Meridian',
      );
    } finally {
      rig.installed.restore();
    }
  });
});

describe('PF-9 the game-over actions, SPEC section 13', () => {
  function panelRig(): {
    installed: InstalledDocument;
    panel: ReturnType<typeof createGameOverPanel>;
    root: FakeElement;
    pressed: string[];
  } {
    const installed = installFakeDocument();
    const pressed: string[] = [];
    const panel = createGameOverPanel({
      onPlayAgain: () => pressed.push('play-again'),
      onChangeMode: () => pressed.push('change-mode'),
      onNextOpponent: () => pressed.push('next-opponent'),
      onRestartLadder: () => pressed.push('restart-ladder'),
    });
    return { installed, panel, root: panel.root as unknown as FakeElement, pressed };
  }

  it('offers the next opponent on a win and the ladder on a loss, never both', () => {
    const rig = panelRig();
    try {
      rig.panel.update(gameOverReadout(3, 1), {
        opponentName: 'Sparks',
        ladderStep: 'advance',
        ladderComplete: false,
      });
      expect(refused(rig.root, 'next-opponent')).toBe(false);
      expect(refused(rig.root, 'restart-ladder')).toBe(true);

      rig.panel.update(gameOverReadout(1, 3), {
        opponentName: 'Sparks',
        ladderStep: 'restart',
      });
      expect(refused(rig.root, 'next-opponent')).toBe(true);
      expect(refused(rig.root, 'restart-ladder')).toBe(false);

      // A drawn rung offers neither, and Play Again replays it.
      rig.panel.update(gameOverReadout(2, 2), {
        opponentName: 'Sparks',
        ladderStep: 'replay',
      });
      expect(refused(rig.root, 'next-opponent')).toBe(true);
      expect(refused(rig.root, 'restart-ladder')).toBe(true);
      expect(refused(rig.root, 'play-again')).toBe(false);

      // The top of the ladder has nothing to advance to.
      rig.panel.update(gameOverReadout(3, 0), {
        opponentName: 'Meridian',
        ladderStep: 'advance',
        ladderComplete: true,
      });
      expect(refused(rig.root, 'next-opponent')).toBe(true);
      expect(refused(rig.root, 'restart-ladder')).toBe(false);
    } finally {
      rig.installed.restore();
    }
  });

  it('refuses both ladder actions outside the ladder, and Change mode never', () => {
    const rig = panelRig();
    try {
      rig.panel.update(gameOverReadout(2, 1), { opponentName: 'Opponent' });
      expect(refused(rig.root, 'next-opponent')).toBe(true);
      expect(refused(rig.root, 'restart-ladder')).toBe(true);
      expect(refused(rig.root, 'change-mode')).toBe(false);
      expect(refused(rig.root, 'play-again')).toBe(false);
    } finally {
      rig.installed.restore();
    }
  });

  it('ignores a press on a refused action and honours a live one', () => {
    const rig = panelRig();
    try {
      rig.panel.update(gameOverReadout(2, 1), { opponentName: 'Opponent' });
      findByMarker(rig.root, 'next-opponent')?.dispatch('click');
      expect(rig.pressed).toEqual([]);
      findByMarker(rig.root, 'change-mode')?.dispatch('click');
      findByMarker(rig.root, 'play-again')?.dispatch('click');
      expect(rig.pressed).toEqual(['change-mode', 'play-again']);
    } finally {
      rig.installed.restore();
    }
  });

  it('names the mode own opponent in the result string', () => {
    const rig = panelRig();
    try {
      rig.panel.update(gameOverReadout(0, 2), { opponentName: 'Meridian' });
      expect(findByMarker(rig.root, 'result')?.textContent).toBe('Meridian wins!');
      expect(findByMarker(rig.root, 'final-score')?.textContent).toBe('0 : 2');
      rig.panel.update(gameOverReadout(2, 0), { opponentName: 'Player 2' });
      expect(findByMarker(rig.root, 'result')?.textContent).toBe('You win!');
      rig.panel.update(gameOverReadout(1, 1), { opponentName: 'Player 2' });
      expect(findByMarker(rig.root, 'result')?.textContent).toBe('Draw!');
    } finally {
      rig.installed.restore();
    }
  });
});

describe('PF-9 the HUD readouts a mode decides', () => {
  it('names both humans in Hotseat and neither anywhere else', () => {
    expect(turnIndicatorText({ kind: 'PLAYER_TURN' }, 'OPPONENT')).toBe('YOUR TURN');
    expect(turnIndicatorText({ kind: 'PLAYER_TURN' }, 'PLAYER 2', 'Player 1')).toBe(
      'PLAYER 1 IS AIMING',
    );
    expect(turnIndicatorText({ kind: 'OPPONENT_TURN' }, 'Player 2', 'Player 1')).toBe(
      'PLAYER 2 IS AIMING',
    );
    expect(turnIndicatorText({ kind: 'OPPONENT_TURN' }, 'Sparks')).toBe('SPARKS IS AIMING');
  });

  it('takes its names and its ladder line from the mode', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined });
      const root = hud.root as unknown as FakeElement;
      hud.setNames('Sparks');
      hud.update({
        state: { kind: 'OPPONENT_TURN' },
        clock: 60,
        opponentReady: false,
        scoring: scoring(0, 0),
      });
      expect(findByMarker(root, 'turn')?.textContent).toBe('SPARKS IS AIMING');
      hud.showLadder('Sparks', 1, 6);
      expect(findByMarker(root, 'ladder')?.textContent).toBe('Sparks - RUNG 1 OF 6');
      hud.clearLadder();
      expect(findByMarker(root, 'ladder')?.textContent).toBe('');

      hud.setNames('Player 2', 'Player 1');
      hud.update({
        state: { kind: 'PLAYER_TURN' },
        clock: undefined,
        opponentReady: false,
        scoring: scoring(1, 2),
      });
      expect(findByMarker(root, 'turn')?.textContent).toBe('PLAYER 1 IS AIMING');
    } finally {
      installed.restore();
    }
  });

  it('takes the goal target from the readout, which is where a mode puts it', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined });
      const root = hud.root as unknown as FakeElement;
      hud.update({
        state: { kind: 'PLAYER_TURN' },
        clock: undefined,
        opponentReady: false,
        scoring: scoring(1, 0),
        target: 7,
      });
      expect(findByMarker(root, 'target-line')?.textContent).toBe('FIRST TO 7');
      expect(findByMarker(root, 'target-line')?.hidden).toBe(false);
      expect(findByMarker(root, 'centre-score')?.textContent).toBe('1 : 0');
      expect(findByMarker(root, 'clock')?.hidden).toBe(true);

      // A clocked match flips the slot back, target or no target.
      hud.update({
        state: { kind: 'PLAYER_TURN' },
        clock: 90,
        opponentReady: false,
        scoring: scoring(1, 0),
      });
      expect(findByMarker(root, 'clock')?.hidden).toBe(false);
      expect(findByMarker(root, 'target-line')?.hidden).toBe(true);
    } finally {
      installed.restore();
    }
  });
});

describe('PF-9 the match configuration seam', () => {
  it('applies a mode from MENU and nowhere else', () => {
    const match = createMatch();
    expect(match.readout().clock).toBeUndefined();
    match.dispatch({ kind: 'configure', configuration: { duration: 90, target: 5 } });
    expect(match.readout().clock).toBe(90);
    expect(match.readout().target).toBe(5);

    match.dispatch({ kind: 'start' });
    expect(match.readout().state.kind).toBe('PLAYER_TURN');
    // Refused in play: SPEC section 7 configures a match in MENU.
    match.dispatch({ kind: 'configure', configuration: { duration: 60 } });
    expect(match.readout().clock).toBe(90);
    expect(match.readout().target).toBe(5);
  });

  it('keeps ONE world across every configuration', () => {
    const match = createMatch();
    const world = match.world;
    match.dispatch({ kind: 'configure', configuration: { duration: 60 } });
    expect(match.world).toBe(world);
    match.dispatch({ kind: 'configure', configuration: { target: 3 } });
    expect(match.world).toBe(world);
    expect(match.world.player).toBe(world.player);
    // And the simulation really is driving that same world.
    match.dispatch({ kind: 'start' });
    match.dispatch({ kind: 'launch', angle: 0, power: 1 });
    match.update(1 / 60);
    expect(world.player.position.x).toBeGreaterThan(300);
  });

  it('puts the world back before the scoreboard on a configuration', () => {
    const match = createMatch({ duration: 60 });
    match.dispatch({ kind: 'start' });
    match.dispatch({ kind: 'launch', angle: 0, power: 1 });
    for (let step = 0; step < 60; step += 1) {
      match.update(1 / 60);
    }
    expect(match.world.player.position.x).not.toBe(300);
    match.dispatch({ kind: 'quit' });
    // A quit from PAUSED is the chart's way to MENU; from a running turn it is
    // refused, so the match is paused first.
    match.dispatch({ kind: 'pause' });
    match.dispatch({ kind: 'quit' });
    expect(match.readout().state.kind).toBe('MENU');
    match.dispatch({ kind: 'configure', configuration: { target: 3 } });
    expect(match.world.player.position.x).toBe(300);
    expect(match.world.ball.position.x).toBe(640);
    expect(match.readout().scoring.goals).toBe(0);
    expect(match.readout().clock).toBeUndefined();
  });

  it('takes SPEC section 13 Change mode out of GAME_OVER', () => {
    const match = createMatch({ duration: 1 });
    match.dispatch({ kind: 'start' });
    for (let frame = 0; frame < 4; frame += 1) {
      match.update(0.25);
    }
    expect(match.readout().state.kind).toBe('GAME_OVER');
    match.dispatch({ kind: 'quit' });
    expect(match.readout().state.kind).toBe('MENU');
    // And the menu can configure again, which is what Change mode is for.
    match.dispatch({ kind: 'configure', configuration: { duration: 120 } });
    expect(match.readout().clock).toBe(120);
  });

  it('carries the target on the readout only when there is one', () => {
    const match = createMatch({ duration: 60 });
    expect(match.readout().target).toBeUndefined();
    expect('target' in match.readout()).toBe(false);
    match.dispatch({ kind: 'configure', configuration: { target: 5 } });
    expect(match.readout().target).toBe(5);
  });

  it('restarts on the mode in force rather than on the one it was built with', () => {
    const match = createMatch({ duration: 60 });
    match.dispatch({ kind: 'configure', configuration: { duration: 120 } });
    match.dispatch({ kind: 'start' });
    for (let frame = 0; frame < 20; frame += 1) {
      match.update(0.25);
    }
    expect(match.readout().clock).toBeCloseTo(115, 9);
    match.restart();
    expect(match.readout().clock).toBe(120);
  });

  it('never draws a random number or reads a clock to do any of it', () => {
    // `core/` is lint-enforced against both; this is the behavioural half, and
    // it is what lets one seed replay a whole match.
    const random = vi.spyOn(Math, 'random');
    try {
      const match = createMatch();
      match.dispatch({ kind: 'configure', configuration: { duration: 60 } });
      match.dispatch({ kind: 'start' });
      match.update(1 / 60);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
