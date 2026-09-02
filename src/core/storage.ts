/**
 * SPEC section 16's saved state: ONE namespaced key holding ONE versioned JSON
 * document, and the door every byte of it comes back through.
 *
 * THE VERSION LIVES INSIDE THE DOCUMENT, NOT IN THE KEY. QUALITY-BAR section 8
 * asks for a namespaced, versioned document migrated on a bump; a version
 * carried in the key name means a reader has to guess which keys exist before
 * it can read any of them, and a key that was never guessed is a value that
 * silently stops migrating. One key answers one question, and the first field
 * of the answer says which shape the rest of it is in.
 *
 * NOTHING ABOUT A MATCH IN PROGRESS IS HERE, and the shape is what says so.
 * `GameData` has no score, no clock, no position and no turn: there is nowhere
 * for a live match to be written even by accident, which is a stronger promise
 * than a rule about when to call `save`.
 *
 * EVERY FIELD IS ANSWERED FOR, TWICE OVER. A stored document is untrusted
 * input: absent, truncated, hand-edited, from an older build or from a newer
 * one. `migrate` decides whether a document can be reached at all, and
 * `normaliseData` answers for each field of one that can. A value that cannot
 * cross falls back to the new-player value rather than crossing as garbage, so
 * a half-read document is not a state this game has.
 *
 * THE PLATFORM IS AN ARGUMENT, WHICH IS WHAT KEEPS THIS MODULE IN core/.
 * `createDataStore` takes a function that opens the platform's key-value store
 * and calls it inside a `try`, because QUALITY-BAR section 8's most dangerous
 * failure is a throw on the PROPERTY ACCESS itself, before any method is
 * called. The composition root supplies that one expression; everything else
 * about the failure, including the fall back to an in-memory store for the
 * session, is decided here where it can be tested headlessly.
 *
 * RESERVED FIELDS ARE MARKED AS SUCH. SPEC section 17 names settings whose
 * controls do not exist yet (sound, reduced motion and the play-surface size).
 * They are declared here, behind the version and behind the normalise door, so
 * the part that builds each control writes a value into a document that
 * already carries it rather than bumping the version to add one; nothing reads
 * them until then, and their defaults are the inert ones.
 */

import type { Difficulty, ModeChoice, ModeKind, Progress, ProgressStore } from './modes';
import {
  DEFAULT_DURATION,
  DEFAULT_TARGET,
  FIRST_TO_TARGETS,
  NEW_PROGRESS,
  QUICK_DURATIONS,
  guideOnByDefault,
  normaliseProgress,
} from './modes';

/**
 * The one key. Namespaced by the game so a host serving more than one project
 * from an origin cannot collide, and named for what it holds rather than for
 * the shape it is in.
 */
export const STORAGE_KEY = 'pocket-football:save';

/** The shape the game writes today. Bumped when a stored field changes meaning. */
export const DOCUMENT_VERSION = 2;

/**
 * The oldest shape that can still be reached.
 *
 * VERSION 1 IS THE PROGRESS-ONLY DOCUMENT: the three fields `core/modes.ts`'s
 * seam round-trips, written flat at the top of the document. That is the shape
 * this game's saved state had before SPEC section 16's settings, records and
 * counters joined it.
 *
 * NO SHIPPED BUILD EVER WROTE ONE, and saying so is the honest version of the
 * sentence above: the seam held those three fields in memory, and storage
 * arrives with version 2. The step is here because the first bump this game
 * actually takes should be one whose machinery has already been proven, not
 * one written on the day it is needed, and because a reader that knows only
 * its own version has nothing to do on a bump except discard.
 */
export const FIRST_VERSION = 1;

/** SPEC section 9's four modes as values, so a stored one can be checked. */
export const MODE_KINDS: readonly ModeKind[] = ['quick', 'first-to', 'ladder', 'hotseat'];

/** SPEC section 8's three difficulties, for the same reason. */
export const DIFFICULTIES: readonly Difficulty[] = ['casual', 'pro', 'ace'];

/** SPEC section 17's theme setting. System is a value, not the absence of one. */
export type ThemeSetting = 'system' | 'light' | 'dark';

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark'];

/** SPEC section 17's reduced-motion setting. RESERVED: no control exists yet. */
export type MotionSetting = 'system' | 'always';

export const MOTION_SETTINGS: readonly MotionSetting[] = ['system', 'always'];

/** SPEC section 17's play-surface size, in percent. RESERVED: no control yet. */
export const SURFACE_SCALES: readonly number[] = [100, 125, 150, 200];

/** SPEC section 17's settings, and nothing that is not a setting. */
export interface Settings {
  readonly mode: ModeKind;
  /** SPEC section 9's match length, one of the offered Quick Match durations. */
  readonly duration: number;
  /** SPEC section 9's First to N target, one of the offered targets. */
  readonly target: number;
  readonly difficulty: Difficulty;
  /** SPEC section 11's aim guide, as the menu last left it. */
  readonly guide: boolean;
  readonly theme: ThemeSetting;
  /** RESERVED for the audio part: SPEC section 17's mute. */
  readonly muted: boolean;
  /** RESERVED for the audio part: SPEC section 17's volume, 0 through 1. */
  readonly volume: number;
  /** RESERVED for the accessibility part: SPEC section 17's reduced motion. */
  readonly motion: MotionSetting;
  /** RESERVED for the accessibility part: SPEC section 17's surface size. */
  readonly surfaceScale: number;
}

/**
 * SPEC section 16's best result for one mode, as the scoreline that produced
 * it rather than as a number the scoreline was reduced to.
 *
 * A DOCUMENTED READING, because SPEC section 16 says "best results per mode"
 * and defines neither "best" nor what a result is. The reading here is the
 * best GOAL MARGIN, ties broken by goals scored: a 4-1 beats a 3-1 on margin,
 * and a 4-2 beats a 3-1 on the tie-break, because the same margin with more
 * goals in it is the better performance. A defeat is still a result and is
 * still recorded, so the first match played in a mode sets the record whatever
 * it was. Storing the scoreline rather than the margin is what lets the
 * readout that eventually shows it say 4 : 1 instead of "+3", and it is the
 * reason `bestOf` is a function over two scorelines rather than a `Math.max`.
 * The reading is pinned by literal in tests/unit/storage-migration.test.ts.
 */
export interface ModeRecord {
  readonly goalsFor: number;
  readonly goalsAgainst: number;
}

export type Records = Record<ModeKind, ModeRecord | null>;

/** SPEC section 16's lifetime counters. */
export interface Counters {
  readonly matchesPlayed: number;
  readonly goalsFor: number;
  readonly goalsAgainst: number;
}

/** Everything that outlives a match, in the one shape the document holds. */
export interface GameData {
  readonly progress: Progress;
  readonly settings: Settings;
  readonly records: Records;
  readonly counters: Counters;
}

/**
 * SPEC section 9's own defaults, reached through the constants that own them.
 * The aim guide's default is SPEC section 11's function of the difficulty
 * rather than a second copy of its answer.
 */
export const NEW_SETTINGS: Settings = {
  mode: 'quick',
  duration: DEFAULT_DURATION,
  target: DEFAULT_TARGET,
  difficulty: 'casual',
  guide: guideOnByDefault('casual'),
  theme: 'system',
  muted: false,
  volume: 1,
  motion: 'system',
  surfaceScale: 100,
};

/** One answer per mode, built by name so the four are total by construction. */
function mapRecords(build: (mode: ModeKind) => ModeRecord | null): Records {
  return {
    quick: build('quick'),
    'first-to': build('first-to'),
    ladder: build('ladder'),
    hotseat: build('hotseat'),
  };
}

export const NEW_RECORDS: Records = mapRecords(() => null);

export const NEW_COUNTERS: Counters = {
  matchesPlayed: 0,
  goalsFor: 0,
  goalsAgainst: 0,
};

/** A player who has never opened the game, in every field the document has. */
export const NEW_DATA: GameData = {
  progress: NEW_PROGRESS,
  settings: NEW_SETTINGS,
  records: NEW_RECORDS,
  counters: NEW_COUNTERS,
};

/* ---------------------------------------------------------------------------
 * The normalise door. Nothing below trusts anything it is handed.
 * ------------------------------------------------------------------------- */

/** The stored value where it is one of the offered ones, the fallback where not. */
function chosen<T extends string | number>(
  offered: readonly T[],
  value: unknown,
  fallback: T,
): T {
  for (const option of offered) {
    if (option === value) {
      return option;
    }
  }
  return fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A lifetime count: a whole number at or above zero, or the fallback. */
function counted(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

/** A 0 through 1 setting, kept exact rather than truncated. */
function fraction(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, 0), 1);
}

function normaliseSettings(raw: unknown): Settings {
  if (raw === null || typeof raw !== 'object') {
    return NEW_SETTINGS;
  }
  const held = raw as Record<string, unknown>;
  return {
    mode: chosen(MODE_KINDS, held['mode'], NEW_SETTINGS.mode),
    duration: chosen(QUICK_DURATIONS, held['duration'], NEW_SETTINGS.duration),
    target: chosen(FIRST_TO_TARGETS, held['target'], NEW_SETTINGS.target),
    difficulty: chosen(DIFFICULTIES, held['difficulty'], NEW_SETTINGS.difficulty),
    guide: flag(held['guide'], NEW_SETTINGS.guide),
    theme: chosen(THEME_SETTINGS, held['theme'], NEW_SETTINGS.theme),
    muted: flag(held['muted'], NEW_SETTINGS.muted),
    volume: fraction(held['volume'], NEW_SETTINGS.volume),
    motion: chosen(MOTION_SETTINGS, held['motion'], NEW_SETTINGS.motion),
    surfaceScale: chosen(SURFACE_SCALES, held['surfaceScale'], NEW_SETTINGS.surfaceScale),
  };
}

/**
 * A stored best result, or none at all. A record with either half unusable is
 * no record rather than half a record: a scoreline with one number in it would
 * compare against a real one and could win.
 */
function normaliseRecord(raw: unknown): ModeRecord | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const held = raw as Record<string, unknown>;
  const scored = held['goalsFor'];
  const conceded = held['goalsAgainst'];
  if (typeof scored !== 'number' || !Number.isFinite(scored) || scored < 0) {
    return null;
  }
  if (typeof conceded !== 'number' || !Number.isFinite(conceded) || conceded < 0) {
    return null;
  }
  return { goalsFor: Math.trunc(scored), goalsAgainst: Math.trunc(conceded) };
}

function normaliseRecords(raw: unknown): Records {
  if (raw === null || typeof raw !== 'object') {
    return NEW_RECORDS;
  }
  const held = raw as Record<string, unknown>;
  return mapRecords((mode) => normaliseRecord(held[mode]));
}

function normaliseCounters(raw: unknown): Counters {
  if (raw === null || typeof raw !== 'object') {
    return NEW_COUNTERS;
  }
  const held = raw as Record<string, unknown>;
  return {
    matchesPlayed: counted(held['matchesPlayed'], NEW_COUNTERS.matchesPlayed),
    goalsFor: counted(held['goalsFor'], NEW_COUNTERS.goalsFor),
    goalsAgainst: counted(held['goalsAgainst'], NEW_COUNTERS.goalsAgainst),
  };
}

/** Whatever came back, as the data this game can use. Every field answered for. */
export function normaliseData(raw: unknown): GameData {
  if (raw === null || typeof raw !== 'object') {
    return NEW_DATA;
  }
  const document = raw as Record<string, unknown>;
  return {
    progress: normaliseProgress(document['progress']),
    settings: normaliseSettings(document['settings']),
    records: normaliseRecords(document['records']),
    counters: normaliseCounters(document['counters']),
  };
}

/* ---------------------------------------------------------------------------
 * Migration.
 * ------------------------------------------------------------------------- */

/**
 * A version 1 document as a version 2 one: the three progress fields lifted
 * into the shape that now holds them, and nothing else carried.
 *
 * THE LIFT IS DELIBERATELY NOT A COPY. Every other key of a version 1
 * document, including one this build has never heard of, has no home in
 * version 2 and is dropped whole; the fields version 2 added arrive at their
 * new-player values from the normalise door rather than as absent properties.
 * That is the discard half of the criterion, and it is what stops a bump
 * producing a document that is partly one shape and partly the other.
 */
function liftVersionOne(document: Record<string, unknown>): unknown {
  return {
    progress: {
      ladderRung: document['ladderRung'],
      howToDismissed: document['howToDismissed'],
      playedBefore: document['playedBefore'],
    },
  };
}

/**
 * Whatever was parsed out of storage, as this build's data.
 *
 * A DOCUMENT THIS BUILD CANNOT REACH IS DISCARDED WHOLE. A version from the
 * future is the case that matters: its fields may mean something else
 * entirely, so reading the ones whose names happen to still exist would be
 * half-reading a document nobody wrote for this build. A newer build reading
 * an older document migrates it; an older build reading a newer one starts the
 * player again, which is the honest outcome and the one QUALITY-BAR section 8
 * already accepts by calling persistence best effort.
 *
 * THE COST OF THAT IS STATED RATHER THAN HIDDEN: a refused document is left on
 * the platform untouched at the read, but the first ordinary write of the new
 * session replaces it, so rolling a deployment back past a version bump costs
 * the player what the newer build had saved. The alternative is a session that
 * never saves anything at all, which costs them the same thing more slowly.
 */
export function migrate(raw: unknown): GameData {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return NEW_DATA;
  }
  const document = raw as Record<string, unknown>;
  const version = document['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return NEW_DATA;
  }
  if (version < FIRST_VERSION || version > DOCUMENT_VERSION) {
    return NEW_DATA;
  }
  if (version === FIRST_VERSION) {
    return normaliseData(liftVersionOne(document));
  }
  return normaliseData(document);
}

/** The bytes this build writes: the version, then the data behind it. */
export function serialiseData(data: GameData): string {
  return JSON.stringify({ version: DOCUMENT_VERSION, ...data });
}

/* ---------------------------------------------------------------------------
 * What a match and a menu do to the data.
 * ------------------------------------------------------------------------- */

/**
 * The menu choice the stored settings name. The ladder's rung is progress
 * rather than a setting, so it arrives separately and the menu shows it.
 */
export function choiceOf(settings: Settings, ladderRung: number): ModeChoice {
  if (settings.mode === 'quick') {
    return { kind: 'quick', duration: settings.duration, difficulty: settings.difficulty };
  }
  if (settings.mode === 'first-to') {
    return { kind: 'first-to', target: settings.target, difficulty: settings.difficulty };
  }
  if (settings.mode === 'ladder') {
    return { kind: 'ladder', rung: ladderRung };
  }
  return { kind: 'hotseat', target: settings.target };
}

/**
 * The settings a start leaves behind.
 *
 * A CHOICE CARRIES LESS THAN THE SETTINGS DO, and this is the join. SPEC
 * section 17 makes the match length, the goal target and the difficulty three
 * separate settings, while a `ModeChoice` only carries the ones its own mode
 * reads: starting a ladder rung says nothing about the difficulty, so the
 * stored difficulty survives it rather than being overwritten with a default.
 */
export function settingsAfter(
  settings: Settings,
  choice: ModeChoice,
  guide: boolean,
): Settings {
  return {
    ...settings,
    mode: choice.kind,
    duration: choice.kind === 'quick' ? choice.duration : settings.duration,
    target:
      choice.kind === 'first-to' || choice.kind === 'hotseat'
        ? choice.target
        : settings.target,
    difficulty:
      choice.kind === 'quick' || choice.kind === 'first-to'
        ? choice.difficulty
        : settings.difficulty,
    guide,
  };
}

/** The better of two scorelines, by margin and then by goals scored. */
export function bestOf(held: ModeRecord | null, played: ModeRecord): ModeRecord {
  if (held === null) {
    return played;
  }
  const heldMargin = held.goalsFor - held.goalsAgainst;
  const playedMargin = played.goalsFor - played.goalsAgainst;
  if (playedMargin > heldMargin) {
    return played;
  }
  if (playedMargin === heldMargin && played.goalsFor > held.goalsFor) {
    return played;
  }
  return held;
}

/**
 * SPEC section 16's record of a finished match: the mode's best result where
 * this one beats it, and the lifetime counters either way. Called once, at the
 * whistle, from the same place the ladder rung is recorded.
 */
export function recordResult(
  data: GameData,
  mode: ModeKind,
  scored: number,
  conceded: number,
): GameData {
  const played: ModeRecord = {
    goalsFor: Math.max(0, Math.trunc(scored)),
    goalsAgainst: Math.max(0, Math.trunc(conceded)),
  };
  return {
    ...data,
    records: mapRecords((kind) =>
      kind === mode ? bestOf(data.records[kind], played) : data.records[kind],
    ),
    counters: {
      matchesPlayed: data.counters.matchesPlayed + 1,
      goalsFor: data.counters.goalsFor + played.goalsFor,
      goalsAgainst: data.counters.goalsAgainst + played.goalsAgainst,
    },
  };
}

/* ---------------------------------------------------------------------------
 * The store.
 * ------------------------------------------------------------------------- */

/**
 * The platform's key-value store, named by what this module asks of it and
 * not by the platform type it happens to be. Naming the platform type here
 * would put a DOM name inside core; the three methods are all that is used,
 * and the composition root's own `window.localStorage` satisfies them.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The stored data, BEHIND `core/modes.ts`'s progress seam rather than beside
 * it: the interface is extended, so a `DataStore` is a `ProgressStore` by type
 * and not merely by shape. Everything above it that only wants the ladder rung
 * keeps talking to the narrow seam; the parts that own a setting or a record
 * use the wider surface. `read` answers the progress half and `write` replaces
 * it, leaving the rest of the document where it was.
 */
export interface DataStore extends ProgressStore {
  data(): GameData;
  save(next: GameData): void;
  /** SPEC section 17's Reset all data: the document gone, the session new. */
  clear(): void;
  /**
   * False when the platform refused to hand over a store AT ALL, which is the
   * one failure that costs every write of the session. A store whose writes
   * are refused one at a time still answers true: it has a platform, and the
   * next write may well be accepted. `lastFailure` is what names that case.
   */
  persistent(): boolean;
  /** The last refusal, kept so nothing here can fail silently. */
  lastFailure(): string | null;
}

function describeFailure(what: string, error: unknown): string {
  const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `${what} failed with ${named}`;
}

/**
 * The store the composition root holds.
 *
 * THE PROBE IS THE PROPERTY ACCESS ITSELF, once, at construction. QUALITY-BAR
 * section 8: `window.localStorage` throws a SecurityError on property access in
 * a partitioned or cookie-blocked context, before `getItem` is ever reached,
 * and that is the failure most easily missed because every method-level guard
 * in the world is downstream of it. `open` is called inside `try` for exactly
 * that reason.
 *
 * THE IN-MEMORY VALUE IS ALWAYS AUTHORITATIVE. `held` is updated before any
 * write is attempted and is what every read answers from, so a refused probe
 * and a throwing `setItem` cost the carry across sessions and nothing else:
 * the match in progress never notices either.
 */
export function createDataStore(open: () => KeyValueStore | null): DataStore {
  let failure: string | null = null;
  let backing: KeyValueStore | null = null;
  try {
    backing = open();
  } catch (error) {
    failure = describeFailure('opening the platform store', error);
  }

  function readText(): string | null {
    if (backing === null) {
      return null;
    }
    try {
      return backing.getItem(STORAGE_KEY);
    } catch (error) {
      failure = describeFailure('reading the saved document', error);
      return null;
    }
  }

  function writeText(text: string): void {
    if (backing === null) {
      return;
    }
    try {
      backing.setItem(STORAGE_KEY, text);
    } catch (error) {
      failure = describeFailure('writing the saved document', error);
    }
  }

  /** True when the document is gone as far as this store can tell. */
  function removeText(): boolean {
    if (backing === null) {
      return true;
    }
    try {
      backing.removeItem(STORAGE_KEY);
      return true;
    } catch (error) {
      failure = describeFailure('clearing the saved document', error);
      return false;
    }
  }

  function parseText(text: string | null): unknown {
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      failure = describeFailure('parsing the saved document', error);
      return null;
    }
  }

  let held: GameData = migrate(parseText(readText()));

  function save(next: GameData): void {
    held = normaliseData(next);
    writeText(serialiseData(held));
  }

  return {
    read(): Progress {
      return held.progress;
    },

    write(next: Progress): void {
      save({ ...held, progress: next });
    },

    data(): GameData {
      return held;
    },

    save,

    /**
     * THE REMOVE HAS A FALLBACK, because a platform that refuses one operation
     * has not necessarily refused the other and the player has just asked for
     * everything to go. Where the key cannot be deleted, the new-player
     * document is written over the top of it, which is the same outcome by
     * another route: the next session reads a player who has nothing. Where
     * both are refused the session is still cleared and the refusal is on
     * `lastFailure`, which is the whole of what a store with no writable
     * platform can do.
     */
    clear(): void {
      held = NEW_DATA;
      if (!removeText()) {
        writeText(serialiseData(held));
      }
    },

    persistent(): boolean {
      return backing !== null;
    },

    lastFailure(): string | null {
      return failure;
    },
  };
}
