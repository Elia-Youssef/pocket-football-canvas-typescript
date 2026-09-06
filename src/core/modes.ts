/**
 * SPEC section 9's four modes, section 10's ladder, section 11's aim-guide
 * default and section 19's onboarding state, as one module of pure data and
 * pure functions.
 *
 * A MODE IS A CONFIGURATION, NOT A CODE PATH. Every mode ends up as the same
 * three answers: what the match is built with, who the opponent is, and what
 * the scoreboard means when the whistle goes. `setupFor` is the whole of it,
 * so a fifth mode would be a fifth row here and nothing else anywhere. The
 * opponent profiles are `core/ai.ts`'s and are consumed rather than restated,
 * exactly as the ladder's six rungs are.
 *
 * THE PERSISTENCE SEAM IS DEFINED HERE AND IMPLEMENTED ELSEWHERE. Ladder
 * progress and the onboarding dismissal are the two things SPEC sections 9 and
 * 19 require to outlive a match, and SPEC section 16's stored document is
 * PF-10's. What this part owns is the interface between them: a `ProgressStore`
 * the composition root holds, with an in-memory implementation that is the real
 * store for a session and the stand-in the tests drive. `normaliseProgress` is
 * the door PF-10's stored document comes back through, because a document read
 * from storage is untrusted input and every field of it has to be answered for.
 *
 * DESIGN section 1 puts this module under `core/`: it imports nothing outside
 * core, names no platform surface, reads no clock and draws no random number.
 * The match seed is derived from the choice rather than sampled, which is what
 * makes one seed replay a whole match (SPEC section 6).
 */

import { ACE, CASUAL, LADDER, PRO, type LadderOpponent, type OpponentProfile } from './ai';
import type { Side } from './goals';
import type { MatchConfiguration } from './match';

/** SPEC section 8's three difficulties, as the menu names them. */
export type Difficulty = 'casual' | 'pro' | 'ace';

/** SPEC section 9's four modes. */
export type ModeKind = 'quick' | 'first-to' | 'ladder' | 'hotseat';

/** SPEC section 9: Quick Match is 60 s by default, with 90 and 120 offered. */
export const QUICK_DURATIONS: readonly number[] = [60, 90, 120];

/** SPEC section 9: First to N is 3 by default, with 5 and 7 offered. */
export const FIRST_TO_TARGETS: readonly number[] = [3, 5, 7];

/** SPEC section 9's two defaults, named rather than indexed out of the lists. */
export const DEFAULT_DURATION = 60;
export const DEFAULT_TARGET = 3;

/** SPEC section 10: the ladder is six rungs long. */
export const LADDER_TOTAL = LADDER.length;

/**
 * A ladder rung is played as the default First to N against the named
 * opponent.
 *
 * A DOCUMENTED READING, and the ladder's own rule is what decides it. SPEC
 * section 9 gives the ladder its opponents and its progression and says
 * nothing about the format of a rung, but it does say what a rung has to
 * produce: "losing restarts the ladder; winning unlocks the next". A timed
 * rung can end level, which is neither, and would leave the section's two
 * outcomes to be joined by a third nobody wrote down. A First-to-N rung cannot
 * end level, so every rung answers the question the ladder asks of it. SPEC
 * section 12's centre slot follows from that rather than being bent to it: a
 * rung IS a First-to-N match, so it carries the goal target and the score line
 * exactly as that section says a clockless match does.
 */
export const LADDER_TARGET = 3;

/** SPEC section 19: how many turns of a first-ever match force the guide on. */
export const FIRST_MATCH_GUIDE_TURNS = 2;

/**
 * The seed every match derives from. One constant, and the choice itself is
 * what varies it, so a mode replays identically from the same inputs and no
 * clock is read to start a match (SPEC section 6: every stream is seeded, one
 * split per consumer).
 */
export const MATCH_SEED = 'pocket-football-match';

/** What the menu chose. Every field a mode needs and none it does not. */
export type ModeChoice =
  | { readonly kind: 'quick'; readonly duration: number; readonly difficulty: Difficulty }
  | { readonly kind: 'first-to'; readonly target: number; readonly difficulty: Difficulty }
  | { readonly kind: 'ladder'; readonly rung: number }
  | { readonly kind: 'hotseat'; readonly target: number };

/** SPEC section 9's default: a 60 second Quick Match at the lowest difficulty. */
export const DEFAULT_MODE: ModeChoice = {
  kind: 'quick',
  duration: 60,
  difficulty: 'casual',
};

/** SPEC section 8's table, reached by the name the menu uses. */
const PROFILES: Readonly<Record<Difficulty, OpponentProfile>> = {
  casual: CASUAL,
  pro: PRO,
  ace: ACE,
};

/**
 * SPEC section 10's difficulty column, by rung, as literals. The profiles
 * themselves carry each rung's quirk and belong to the opponent module; what
 * is written out here is only the column the section states, because a rung's
 * difficulty is what SPEC section 11's guide default reads and no profile
 * field spells it.
 */
export const LADDER_DIFFICULTY: readonly Difficulty[] = [
  'casual',
  'casual',
  'pro',
  'pro',
  'ace',
  'ace',
];

/** SPEC section 13: in Hotseat the result names the winning player. */
export const PLAYER_ONE = 'Player 1';
export const PLAYER_TWO = 'Player 2';

/** The generic name a mode with no named opponent uses (SPEC section 12). */
export const GENERIC_OPPONENT = 'Opponent';

/** The ladder rung a position names, clamped into the ladder. */
export function rungAt(position: number): LadderOpponent {
  const slot = Math.min(Math.max(Math.trunc(position), 1), LADDER_TOTAL) - 1;
  const rung = LADDER[slot];
  if (rung === undefined) {
    throw new Error(`the ladder has no rung at position ${String(position)}`);
  }
  return rung;
}

/** The difficulty of a ladder rung, from SPEC section 10's own column. */
export function difficultyAt(position: number): Difficulty {
  const slot = Math.min(Math.max(Math.trunc(position), 1), LADDER_TOTAL) - 1;
  return LADDER_DIFFICULTY[slot] ?? 'casual';
}

/**
 * SPEC section 11: the aim guide is on by default at Casual and off by default
 * above it. Hotseat has no opponent difficulty at all, and answers Casual for
 * the same reason it has no AI: there is nothing above Casual to defend
 * against, so the most helpful default is the honest one.
 */
export function guideOnByDefault(difficulty: Difficulty): boolean {
  return difficulty === 'casual';
}

/**
 * SPEC section 19: on a first-ever match the guide is on for the first two
 * turns whatever the difficulty is, and the setting governs from then on.
 * Turns are counted as the player's own launches, which is what "turns" means
 * to somebody being shown how to aim.
 */
export function guideShown(
  enabled: boolean,
  firstEverMatch: boolean,
  turnsTaken: number,
): boolean {
  if (firstEverMatch && turnsTaken < FIRST_MATCH_GUIDE_TURNS) {
    return true;
  }
  return enabled;
}

/**
 * The difficulty a choice is played at, which is what SPEC section 11's guide
 * default is a function of. The ladder takes its rung's, and Hotseat answers
 * Casual for the reason `guideOnByDefault` gives.
 */
export function difficultyOf(choice: ModeChoice): Difficulty {
  if (choice.kind === 'quick' || choice.kind === 'first-to') {
    return choice.difficulty;
  }
  if (choice.kind === 'ladder') {
    return difficultyAt(choice.rung);
  }
  return 'casual';
}

/** Everything a mode decides, in the one shape the composition root reads. */
export interface ModeSetup {
  readonly choice: ModeChoice;
  /** What the match is built with: the clock, the target and the opening side. */
  readonly configuration: MatchConfiguration;
  /** The opponent's aim routine, or nothing at all in Hotseat (SPEC section 9). */
  readonly profile: OpponentProfile | undefined;
  /** The name the turn indicator and the result string use for the other side. */
  readonly opponentName: string;
  /** The name for the player's own side, which only Hotseat gives one. */
  readonly playerName: string | undefined;
  /** SPEC section 12's ladder readout, or nothing outside the ladder. */
  readonly ladder: { readonly name: string; readonly position: number; readonly total: number }
    | undefined;
  readonly difficulty: Difficulty;
  /** SPEC section 11's default for this mode, before the player changes it. */
  readonly guideDefault: boolean;
  /** The seed this match's every stream derives from. */
  readonly seed: string;
}

/** SPEC section 7: every mode opens with the player, which is the chart's default. */
const OPENS_WITH: Side = 'player';

/**
 * The one place a mode becomes a match. Every branch answers the same shape,
 * so nothing downstream asks which mode it is: the composition root wires the
 * opponent when there is a profile and wires nothing when there is not, which
 * is how the absence of an opponent routine is a fact about the configuration
 * rather than a flag some driver has to remember to test.
 */
export function setupFor(choice: ModeChoice): ModeSetup {
  if (choice.kind === 'quick') {
    return {
      choice,
      configuration: { duration: choice.duration, first: OPENS_WITH },
      profile: PROFILES[choice.difficulty],
      opponentName: GENERIC_OPPONENT,
      playerName: undefined,
      ladder: undefined,
      difficulty: choice.difficulty,
      guideDefault: guideOnByDefault(choice.difficulty),
      seed: `${MATCH_SEED}:quick:${String(choice.duration)}:${choice.difficulty}`,
    };
  }
  if (choice.kind === 'first-to') {
    return {
      choice,
      configuration: { target: choice.target, first: OPENS_WITH },
      profile: PROFILES[choice.difficulty],
      opponentName: GENERIC_OPPONENT,
      playerName: undefined,
      ladder: undefined,
      difficulty: choice.difficulty,
      guideDefault: guideOnByDefault(choice.difficulty),
      seed: `${MATCH_SEED}:first-to:${String(choice.target)}:${choice.difficulty}`,
    };
  }
  if (choice.kind === 'ladder') {
    const position = Math.min(Math.max(Math.trunc(choice.rung), 1), LADDER_TOTAL);
    const rung = rungAt(position);
    const difficulty = difficultyAt(position);
    return {
      choice: { kind: 'ladder', rung: position },
      configuration: { target: LADDER_TARGET, first: OPENS_WITH },
      profile: rung.profile,
      opponentName: rung.name,
      playerName: undefined,
      ladder: { name: rung.name, position, total: LADDER_TOTAL },
      difficulty,
      guideDefault: guideOnByDefault(difficulty),
      seed: `${MATCH_SEED}:ladder:${String(position)}`,
    };
  }
  // Hotseat. No profile at all, which is the whole of "no AI": there is
  // nothing for a driver to answer the opponent's seam with, so nothing does.
  // SPEC section 12 gives Hotseat the goal-target slot rather than a clock,
  // so the target is what ends it, and SPEC section 13 names both humans.
  return {
    choice,
    configuration: { target: choice.target, first: OPENS_WITH },
    profile: undefined,
    opponentName: PLAYER_TWO,
    playerName: PLAYER_ONE,
    ladder: undefined,
    difficulty: 'casual',
    guideDefault: guideOnByDefault('casual'),
    seed: `${MATCH_SEED}:hotseat:${String(choice.target)}`,
  };
}

/** SPEC section 13's three results, as the scoreboard alone decides them. */
export type Outcome = 'player' | 'opponent' | 'draw';

export function outcomeOf(player: number, opponent: number): Outcome {
  if (player > opponent) {
    return 'player';
  }
  if (opponent > player) {
    return 'opponent';
  }
  return 'draw';
}

/**
 * SPEC section 9: the ladder advances on a win and restarts on a loss.
 *
 * A DRAW IS NEITHER, and the section says so by omission: it names losing and
 * winning and nothing else, so a drawn rung would be replayed rather than
 * counted as a defeat. A First-to-N rung cannot end level, so this answer is
 * defensive rather than reachable through the ladder as it is played; it is
 * written out anyway, because a function over three outcomes that answers for
 * two is a function with a hole in it.
 */
export type LadderStep = 'advance' | 'restart' | 'replay';

export function ladderStepFor(outcome: Outcome): LadderStep {
  if (outcome === 'player') {
    return 'advance';
  }
  if (outcome === 'opponent') {
    return 'restart';
  }
  return 'replay';
}

/**
 * The rung a step leaves the ladder on. Winning the last rung has nowhere to
 * advance to and holds there, which is what leaves "Restart ladder" as the
 * only honest action at the top.
 */
export function ladderRungAfter(position: number, step: LadderStep): number {
  const at = Math.min(Math.max(Math.trunc(position), 1), LADDER_TOTAL);
  if (step === 'advance') {
    return Math.min(at + 1, LADDER_TOTAL);
  }
  if (step === 'restart') {
    return 1;
  }
  return at;
}

/** True when the rung just won was the last one, so nothing follows it. */
export function ladderComplete(position: number, step: LadderStep): boolean {
  return step === 'advance' && Math.trunc(position) >= LADDER_TOTAL;
}

/* ---------------------------------------------------------------------------
 * The persistence seam.
 * ------------------------------------------------------------------------- */

/** Everything that outlives a match, and nothing that does not. */
export interface Progress {
  /** SPEC section 9: the ladder rung reached, 1 through LADDER_TOTAL. */
  readonly ladderRung: number;
  /** SPEC section 19: How to Play has been dismissed at least once. */
  readonly howToDismissed: boolean;
  /**
   * SPEC section 2.1: the portrait hint has been dismissed at least once.
   *
   * A FLAG OF THE SAME KIND AS THE ONE ABOVE, and it belongs beside it rather
   * than among the settings. Nothing chooses it and nothing offers it back: it
   * records something the player did once, it only ever goes one way, and
   * `Settings` says in as many words that it holds SPEC section 17's settings
   * and nothing that is not a setting.
   */
  readonly rotateHintDismissed: boolean;
  /** SPEC section 19: a match has been started before, so this is not the first. */
  readonly playedBefore: boolean;
}

/** A player who has never opened the game. */
export const NEW_PROGRESS: Progress = {
  ladderRung: 1,
  howToDismissed: false,
  rotateHintDismissed: false,
  playedBefore: false,
};

/**
 * The seam PF-10 lands the stored document behind. The composition root holds
 * one of these and nothing else in the game knows where progress lives, which
 * is what keeps SPEC section 16's storage decisions out of every module that
 * only wants to know which rung the ladder is on.
 */
export interface ProgressStore {
  read(): Progress;
  write(next: Progress): void;
}

/**
 * Whatever came back from storage, as a Progress this game can use.
 *
 * EVERY FIELD IS ANSWERED FOR. A stored document is untrusted input: it can be
 * absent, a different shape, a different version, or hand-edited, and a rung
 * of 40 or of -1 would put the ladder somewhere it has no opponent. Each field
 * falls back to the new-player value rather than to whatever was there.
 */
export function normaliseProgress(raw: unknown): Progress {
  if (raw === null || typeof raw !== 'object') {
    return NEW_PROGRESS;
  }
  const document = raw as Record<string, unknown>;
  const rung = document['ladderRung'];
  const dismissed = document['howToDismissed'];
  const rotate = document['rotateHintDismissed'];
  const played = document['playedBefore'];
  return {
    ladderRung:
      typeof rung === 'number' && Number.isFinite(rung)
        ? Math.min(Math.max(Math.trunc(rung), 1), LADDER_TOTAL)
        : NEW_PROGRESS.ladderRung,
    howToDismissed: dismissed === true,
    rotateHintDismissed: rotate === true,
    playedBefore: played === true,
  };
}

/**
 * The in-memory implementation: the real store for a session, and the one the
 * tests drive. It is deliberately not a stub. It round-trips exactly what the
 * seam promises, so the day PF-10 puts a versioned document behind the same
 * interface, the only thing that changes is where the bytes go.
 */
export function createMemoryProgress(initial: Progress = NEW_PROGRESS): ProgressStore {
  let held = normaliseProgress(initial);
  return {
    read(): Progress {
      return held;
    },
    write(next: Progress): void {
      held = normaliseProgress(next);
    },
  };
}
