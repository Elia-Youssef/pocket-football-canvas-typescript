import { describe, expect, it } from 'vitest';

import { ACE, CASUAL, LADDER, PRO } from '../../src/core/ai';
import {
  DEFAULT_DURATION,
  DEFAULT_MODE,
  DEFAULT_TARGET,
  FIRST_MATCH_GUIDE_TURNS,
  FIRST_TO_TARGETS,
  GENERIC_OPPONENT,
  LADDER_DIFFICULTY,
  LADDER_TARGET,
  LADDER_TOTAL,
  MATCH_SEED,
  NEW_PROGRESS,
  PLAYER_ONE,
  PLAYER_TWO,
  QUICK_DURATIONS,
  createMemoryProgress,
  difficultyAt,
  difficultyOf,
  guideOnByDefault,
  guideShown,
  ladderComplete,
  ladderRungAfter,
  ladderStepFor,
  normaliseProgress,
  outcomeOf,
  rungAt,
  setupFor,
} from '../../src/core/modes';
import type { Difficulty, ModeChoice, Progress } from '../../src/core/modes';

/**
 * SPEC section 9's four modes, section 10's ladder and section 19's onboarding
 * state, over the real module.
 *
 * EVERY NUMBER IS A LITERAL FROM THE DOCUMENT. The durations, the targets, the
 * six names, the difficulty column and the two-turn onboarding rule are written
 * out here as the sections state them; asserting them against the constants
 * that define them would pass for whatever those constants became, which is the
 * defect class this file exists to catch.
 *
 * THE PERSISTENCE SEAM IS GRADED AS A ROUND TRIP AND AS A DOOR. The in-memory
 * store has to give back exactly what it was given, and `normaliseProgress` has
 * to answer for every shape a stored document can come back in, because SPEC
 * section 16's document arrives at PF-10 behind this same interface and a
 * document read from storage is untrusted input.
 */

describe('PF-9 the modes, SPEC section 9', () => {
  it('offers the durations and the targets the section states, and no others', () => {
    expect([...QUICK_DURATIONS]).toEqual([60, 90, 120]);
    expect([...FIRST_TO_TARGETS]).toEqual([3, 5, 7]);
    expect(DEFAULT_DURATION).toBe(60);
    expect(DEFAULT_TARGET).toBe(3);
    expect(DEFAULT_MODE).toEqual({ kind: 'quick', duration: 60, difficulty: 'casual' });
  });

  it('builds a Quick Match with a clock and no target', () => {
    for (const duration of [60, 90, 120]) {
      const setup = setupFor({ kind: 'quick', duration, difficulty: 'casual' });
      expect(setup.configuration).toEqual({ duration, first: 'player' });
      expect(setup.configuration.target).toBeUndefined();
      expect(setup.profile).toBe(CASUAL);
      expect(setup.opponentName).toBe(GENERIC_OPPONENT);
      expect(setup.playerName).toBeUndefined();
      expect(setup.ladder).toBeUndefined();
    }
  });

  it('builds a First to N with a target and no clock', () => {
    for (const target of [3, 5, 7]) {
      const setup = setupFor({ kind: 'first-to', target, difficulty: 'pro' });
      expect(setup.configuration).toEqual({ target, first: 'player' });
      expect(setup.configuration.duration).toBeUndefined();
      expect(setup.profile).toBe(PRO);
    }
  });

  it('carries the difficulty the choice names into the profile', () => {
    const profiles: Readonly<Record<Difficulty, unknown>> = {
      casual: CASUAL,
      pro: PRO,
      ace: ACE,
    };
    for (const difficulty of ['casual', 'pro', 'ace'] as const) {
      expect(setupFor({ kind: 'quick', duration: 60, difficulty }).profile).toBe(
        profiles[difficulty],
      );
    }
  });

  it('gives Hotseat two named humans and NO opponent profile at all', () => {
    const setup = setupFor({ kind: 'hotseat', target: 5 });
    // The whole of SPEC section 9's "no AI": there is no profile for anything
    // to answer the opponent's seam with, so nothing can.
    expect(setup.profile).toBeUndefined();
    expect(setup.opponentName).toBe(PLAYER_TWO);
    expect(setup.playerName).toBe(PLAYER_ONE);
    expect(PLAYER_ONE).toBe('Player 1');
    expect(PLAYER_TWO).toBe('Player 2');
    // SPEC section 12: a clockless match, so the centre slot has a target.
    expect(setup.configuration).toEqual({ target: 5, first: 'player' });
  });

  it('plays the ladder as a First to N against the rung it is on', () => {
    expect(LADDER_TARGET).toBe(3);
    const setup = setupFor({ kind: 'ladder', rung: 3 });
    expect(setup.configuration).toEqual({ target: 3, first: 'player' });
    expect(setup.ladder).toEqual({ name: 'Anchor', position: 3, total: 6 });
    expect(setup.profile).toBe(LADDER[2]?.profile);
  });

  it('clamps a rung outside the ladder rather than falling off it', () => {
    expect(setupFor({ kind: 'ladder', rung: 0 }).ladder?.position).toBe(1);
    expect(setupFor({ kind: 'ladder', rung: 99 }).ladder?.position).toBe(6);
    expect(rungAt(0).name).toBe('Sparks');
    expect(rungAt(99).name).toBe('Meridian');
  });

  it('derives one seed per choice, and the same seed every time', () => {
    const seeds = new Set<string>();
    const choices: readonly ModeChoice[] = [
      { kind: 'quick', duration: 60, difficulty: 'casual' },
      { kind: 'quick', duration: 90, difficulty: 'casual' },
      { kind: 'quick', duration: 60, difficulty: 'ace' },
      { kind: 'first-to', target: 3, difficulty: 'casual' },
      { kind: 'first-to', target: 7, difficulty: 'casual' },
      { kind: 'ladder', rung: 1 },
      { kind: 'ladder', rung: 6 },
      { kind: 'hotseat', target: 3 },
    ];
    for (const choice of choices) {
      const seed = setupFor(choice).seed;
      expect(seed.startsWith(MATCH_SEED)).toBe(true);
      expect(seeds.has(seed), seed).toBe(false);
      seeds.add(seed);
      // The same choice, again, is the same seed: this is what lets one seed
      // replay a whole match (SPEC section 6).
      expect(setupFor(choice).seed).toBe(seed);
    }
    expect(seeds.size).toBe(choices.length);
  });
});

describe('PF-9 the ladder, SPEC section 10', () => {
  it('is the six opponents the section names, in the order it names them', () => {
    expect(LADDER_TOTAL).toBe(6);
    expect(LADDER.map((rung) => rung.name)).toEqual([
      'Sparks',
      'Bolt',
      'Anchor',
      'Vector',
      'Cinder',
      'Meridian',
    ]);
    for (const [index, name] of [
      'Sparks',
      'Bolt',
      'Anchor',
      'Vector',
      'Cinder',
      'Meridian',
    ].entries()) {
      expect(setupFor({ kind: 'ladder', rung: index + 1 }).ladder?.name).toBe(name);
    }
  });

  it('carries the section own difficulty column, rung by rung', () => {
    expect([...LADDER_DIFFICULTY]).toEqual(['casual', 'casual', 'pro', 'pro', 'ace', 'ace']);
    for (const [index, difficulty] of [
      'casual',
      'casual',
      'pro',
      'pro',
      'ace',
      'ace',
    ].entries()) {
      expect(difficultyAt(index + 1)).toBe(difficulty);
      expect(difficultyOf({ kind: 'ladder', rung: index + 1 })).toBe(difficulty);
    }
  });

  it('advances on a win, restarts on a loss, and replays a draw', () => {
    expect(outcomeOf(3, 1)).toBe('player');
    expect(outcomeOf(1, 3)).toBe('opponent');
    expect(outcomeOf(2, 2)).toBe('draw');
    expect(ladderStepFor('player')).toBe('advance');
    expect(ladderStepFor('opponent')).toBe('restart');
    expect(ladderStepFor('draw')).toBe('replay');
    for (let rung = 1; rung <= 6; rung += 1) {
      expect(ladderRungAfter(rung, 'advance')).toBe(Math.min(rung + 1, 6));
      expect(ladderRungAfter(rung, 'restart')).toBe(1);
      expect(ladderRungAfter(rung, 'replay')).toBe(rung);
    }
  });

  it('has nowhere to advance to at the top, and says so', () => {
    expect(ladderRungAfter(6, 'advance')).toBe(6);
    expect(ladderComplete(6, 'advance')).toBe(true);
    expect(ladderComplete(5, 'advance')).toBe(false);
    expect(ladderComplete(6, 'restart')).toBe(false);
    expect(ladderComplete(6, 'replay')).toBe(false);
  });
});

describe('PF-9 the aim guide default, SPEC sections 11 and 19', () => {
  it('is on at Casual and off above it', () => {
    expect(guideOnByDefault('casual')).toBe(true);
    expect(guideOnByDefault('pro')).toBe(false);
    expect(guideOnByDefault('ace')).toBe(false);
    expect(setupFor({ kind: 'quick', duration: 60, difficulty: 'casual' }).guideDefault).toBe(
      true,
    );
    expect(setupFor({ kind: 'quick', duration: 60, difficulty: 'ace' }).guideDefault).toBe(
      false,
    );
  });

  it('follows the rung difficulty in the ladder, and Casual in Hotseat', () => {
    expect(setupFor({ kind: 'ladder', rung: 1 }).guideDefault).toBe(true);
    expect(setupFor({ kind: 'ladder', rung: 3 }).guideDefault).toBe(false);
    expect(setupFor({ kind: 'ladder', rung: 6 }).guideDefault).toBe(false);
    expect(setupFor({ kind: 'hotseat', target: 3 }).guideDefault).toBe(true);
    expect(difficultyOf({ kind: 'hotseat', target: 3 })).toBe('casual');
  });

  it('holds the guide on for the first two turns of a first-ever match', () => {
    expect(FIRST_MATCH_GUIDE_TURNS).toBe(2);
    // A first-ever match, with the setting OFF: on for turns one and two, and
    // the setting governs from the third (SPEC section 19).
    expect(guideShown(false, true, 0)).toBe(true);
    expect(guideShown(false, true, 1)).toBe(true);
    expect(guideShown(false, true, 2)).toBe(false);
    expect(guideShown(false, true, 7)).toBe(false);
    // The setting on: on throughout, first match or not.
    expect(guideShown(true, true, 5)).toBe(true);
    expect(guideShown(true, false, 5)).toBe(true);
    // Not the first match: the setting alone, from the very first turn.
    expect(guideShown(false, false, 0)).toBe(false);
    expect(guideShown(false, false, 1)).toBe(false);
  });
});

describe('PF-9 the persistence seam', () => {
  it('starts a player who has never opened the game at the bottom', () => {
    expect(NEW_PROGRESS).toEqual({
      ladderRung: 1,
      howToDismissed: false,
      rotateHintDismissed: false,
      playedBefore: false,
    });
  });

  it('round trips exactly what it was given', () => {
    const store = createMemoryProgress();
    expect(store.read()).toEqual(NEW_PROGRESS);
    const next: Progress = {
      ladderRung: 4,
      howToDismissed: true,
      rotateHintDismissed: true,
      playedBefore: true,
    };
    store.write(next);
    expect(store.read()).toEqual(next);
    // And again, so a second write is not a second store.
    store.write({ ...next, ladderRung: 2 });
    expect(store.read()).toEqual({ ...next, ladderRung: 2 });
  });

  it('opens on whatever it was seeded with', () => {
    const store = createMemoryProgress({
      ladderRung: 5,
      howToDismissed: true,
      rotateHintDismissed: true,
      playedBefore: true,
    });
    expect(store.read().ladderRung).toBe(5);
  });

  it('answers for every shape a stored document can come back in', () => {
    // The door PF-10's document comes through. Each of these is a real thing
    // storage hands back: nothing there, something of another type, a rung
    // outside the ladder, a hand-edited value, a half-written document.
    expect(normaliseProgress(null)).toEqual(NEW_PROGRESS);
    expect(normaliseProgress(undefined)).toEqual(NEW_PROGRESS);
    expect(normaliseProgress('a string')).toEqual(NEW_PROGRESS);
    expect(normaliseProgress(42)).toEqual(NEW_PROGRESS);
    expect(normaliseProgress({})).toEqual(NEW_PROGRESS);
    expect(normaliseProgress({ ladderRung: 40 }).ladderRung).toBe(6);
    expect(normaliseProgress({ ladderRung: -3 }).ladderRung).toBe(1);
    expect(normaliseProgress({ ladderRung: 0 }).ladderRung).toBe(1);
    expect(normaliseProgress({ ladderRung: 2.7 }).ladderRung).toBe(2);
    expect(normaliseProgress({ ladderRung: Number.NaN }).ladderRung).toBe(1);
    expect(normaliseProgress({ ladderRung: '3' }).ladderRung).toBe(1);
    expect(normaliseProgress({ howToDismissed: 'yes' }).howToDismissed).toBe(false);
    expect(normaliseProgress({ howToDismissed: true }).howToDismissed).toBe(true);
    expect(normaliseProgress({ rotateHintDismissed: 'yes' }).rotateHintDismissed).toBe(false);
    expect(normaliseProgress({ rotateHintDismissed: true }).rotateHintDismissed).toBe(true);
    expect(normaliseProgress({ playedBefore: 1 }).playedBefore).toBe(false);
    expect(normaliseProgress({ playedBefore: true }).playedBefore).toBe(true);
    // An extra field is carried by nothing: the shape is this game's, not the
    // document's.
    expect(normaliseProgress({ ladderRung: 3, extra: 'x' })).toEqual({
      ladderRung: 3,
      howToDismissed: false,
      rotateHintDismissed: false,
      playedBefore: false,
    });
  });

  it('normalises on the way in as well as on the way out', () => {
    const store = createMemoryProgress();
    store.write({
      ladderRung: 99,
      howToDismissed: true,
      rotateHintDismissed: true,
      playedBefore: true,
    });
    expect(store.read().ladderRung).toBe(6);
  });
});
