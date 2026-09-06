import { describe, expect, it, vi } from 'vitest';

import type { Goal, ScoringReadout } from '../../src/core/goals';
import type { MatchReadout, MatchState } from '../../src/core/match';
import { createHud } from '../../src/ui/components/hud';
import { censusControls, findByMarker, installFakeDocument } from './support/chrome-dom';
import type { FakeElement } from './support/chrome-dom';

/**
 * The HUD against the readout it consumes, SPEC section 12.
 *
 * PRESENCE BEFORE REACHABILITY, and both per phase: every phase the match
 * can report sees the same readouts and the same pause control in the tree,
 * and only then is the per-phase reachability of that control asserted on
 * its own. A control that vanished in a phase change would drop focus on
 * the floor (QUALITY-BAR section 3), so the census is asserted identical
 * across every observable state, and the states that refuse a pause are
 * enumerated as literals rather than derived from the same list the
 * component reads.
 */

const OBSERVABLE_STATES: readonly MatchState['kind'][] = [
  'MENU',
  'PLAYER_TURN',
  'OPPONENT_TURN',
  'MOVING',
  'GOAL',
  'PAUSED',
  'GAME_OVER',
];

/** The four states SPEC section 7 lets a pause intent arrive from. */
const PAUSABLE_STATES: readonly MatchState['kind'][] = [
  'PLAYER_TURN',
  'OPPONENT_TURN',
  'MOVING',
  'GOAL',
];

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

function goalFor(scorer: 'player' | 'opponent'): Goal {
  return {
    scorer,
    conceded: scorer === 'player' ? 'opponent' : 'player',
    mouth: scorer === 'player' ? 'right' : 'left',
    step: 100,
  };
}

function stateOf(kind: MatchState['kind']): MatchState {
  switch (kind) {
    case 'MENU':
      return { kind: 'MENU' };
    case 'PLAYER_TURN':
      return { kind: 'PLAYER_TURN' };
    case 'OPPONENT_TURN':
      return { kind: 'OPPONENT_TURN' };
    case 'MOVING':
      return { kind: 'MOVING', launchedBy: 'player' };
    case 'GOAL':
      return { kind: 'GOAL', goal: goalFor('player') };
    case 'PAUSED':
      return { kind: 'PAUSED', interrupted: { kind: 'PLAYER_TURN' } };
    case 'GAME_OVER':
      return { kind: 'GAME_OVER' };
    case 'KICKOFF':
      return { kind: 'KICKOFF', side: 'player' };
  }
}

function readoutOf(
  kind: MatchState['kind'],
  clock: number | undefined,
  player = 0,
  opponent = 0,
): MatchReadout {
  return {
    state: stateOf(kind),
    clock,
    opponentReady: false,
    scoring: scoring(player, opponent),
  };
}

describe('PF-13 the HUD', () => {
  it('shows the same controls in every observable phase, before reachability', () => {
    for (const kind of OBSERVABLE_STATES) {
      const installed = installFakeDocument();
      try {
        const hud = createHud({ onPause: () => undefined });
        const root = hud.root as unknown as FakeElement;
        hud.update(readoutOf(kind, 60));
        expect(censusControls(root), `in ${kind}`).toEqual(['Pause']);
      } finally {
        installed.restore();
      }
    }
  });

  it('reaches the pause control in exactly the four in-play states', () => {
    for (const kind of OBSERVABLE_STATES) {
      const installed = installFakeDocument();
      try {
        const hud = createHud({ onPause: () => undefined });
        const root = hud.root as unknown as FakeElement;
        hud.update(readoutOf(kind, 60));
        const pause = findByMarker(root, 'pause');
        const expected = PAUSABLE_STATES.includes(kind) ? 'false' : 'true';
        expect(pause?.getAttribute('aria-disabled'), `in ${kind}`).toBe(expected);
      } finally {
        installed.restore();
      }
    }
  });

  it('refuses the pause control outside play, naming the refusing state', () => {
    for (const kind of ['MENU', 'PAUSED', 'GAME_OVER'] as const) {
      const installed = installFakeDocument();
      try {
        const onPause = vi.fn();
        const hud = createHud({ onPause });
        const root = hud.root as unknown as FakeElement;
        hud.update(readoutOf(kind, undefined));
        findByMarker(root, 'pause')?.dispatch('click');
        expect(onPause, `in ${kind}`).not.toHaveBeenCalled();
        // The reason is readable without a pointer: the turn indicator is
        // naming the state that refuses the control.
        expect(findByMarker(root, 'turn')?.textContent, `in ${kind}`).not.toBe('');
      } finally {
        installed.restore();
      }
    }
  });

  it('raises the pause intent from a state that can serve it', () => {
    const installed = installFakeDocument();
    try {
      const onPause = vi.fn();
      const hud = createHud({ onPause });
      const root = hud.root as unknown as FakeElement;
      hud.update(readoutOf('PLAYER_TURN', 60));
      findByMarker(root, 'pause')?.dispatch('click');
      expect(onPause).toHaveBeenCalledTimes(1);
    } finally {
      installed.restore();
    }
  });

  it('names the side and the state through a full turn cycle', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined, opponentName: 'Sparks' });
      const root = hud.root as unknown as FakeElement;
      const turn = findByMarker(root, 'turn');
      const cycle: readonly (readonly [MatchState['kind'], number | undefined, string])[] = [
        ['MENU', 60, 'MENU'],
        ['PLAYER_TURN', 60, 'YOUR TURN'],
        ['OPPONENT_TURN', 59.5, 'SPARKS IS AIMING'],
        ['MOVING', 59, 'IN PLAY'],
        ['GOAL', 58, 'GOAL'],
        ['PLAYER_TURN', 57, 'YOUR TURN'],
        ['PAUSED', 57, 'PAUSED'],
        ['GAME_OVER', 0, 'FULL TIME'],
      ];
      for (const [kind, clock, text] of cycle) {
        hud.update(readoutOf(kind, clock));
        expect(turn?.textContent, `after ${kind}`).toBe(text);
      }
    } finally {
      installed.restore();
    }
  });

  it('shows both scores where the spec puts them', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined });
      const root = hud.root as unknown as FakeElement;
      hud.update(readoutOf('PLAYER_TURN', 30, 2, 1));
      expect(findByMarker(root, 'score-player')?.textContent).toBe('2');
      expect(findByMarker(root, 'score-opponent')?.textContent).toBe('1');
    } finally {
      installed.restore();
    }
  });

  it('carries the clock in the centre slot of a timed match', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined, target: 3 });
      const root = hud.root as unknown as FakeElement;
      hud.update(readoutOf('PLAYER_TURN', 60));
      const clock = findByMarker(root, 'clock');
      expect(clock?.textContent).toBe('01:00');
      expect(clock?.hidden).toBe(false);
      expect(findByMarker(root, 'target-line')?.hidden).toBe(true);
      expect(findByMarker(root, 'centre-score')?.hidden).toBe(true);
    } finally {
      installed.restore();
    }
  });

  it('carries the goal target and the score line in a clockless match', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined, target: 3 });
      const root = hud.root as unknown as FakeElement;
      hud.update(readoutOf('PLAYER_TURN', undefined, 1, 2));
      expect(findByMarker(root, 'clock')?.hidden).toBe(true);
      expect(findByMarker(root, 'target-line')?.textContent).toBe('FIRST TO 3');
      expect(findByMarker(root, 'target-line')?.hidden).toBe(false);
      expect(findByMarker(root, 'centre-score')?.textContent).toBe('1 : 2');
      expect(findByMarker(root, 'centre-score')?.hidden).toBe(false);
    } finally {
      installed.restore();
    }
  });

  it('shows the score line alone in a clockless match with no target', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined });
      const root = hud.root as unknown as FakeElement;
      hud.update(readoutOf('PLAYER_TURN', undefined));
      expect(findByMarker(root, 'clock')?.hidden).toBe(true);
      expect(findByMarker(root, 'target-line')?.hidden).toBe(true);
      expect(findByMarker(root, 'centre-score')?.hidden).toBe(false);
    } finally {
      installed.restore();
    }
  });

  it('names the ladder opponent and the rung, and clears again', () => {
    const installed = installFakeDocument();
    try {
      const hud = createHud({ onPause: () => undefined });
      const root = hud.root as unknown as FakeElement;
      const ladder = findByMarker(root, 'ladder');
      hud.showLadder('Vector', 4, 6);
      expect(ladder?.textContent).toBe('Vector - RUNG 4 OF 6');
      hud.clearLadder();
      expect(ladder?.textContent).toBe('');
    } finally {
      installed.restore();
    }
  });
});
