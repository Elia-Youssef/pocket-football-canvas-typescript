import { describe, expect, it } from 'vitest';

import { createMatch } from '../../src/core/match';
import { LADDER_TOTAL, setupFor } from '../../src/core/modes';
import {
  DOCUMENT_VERSION,
  NEW_COUNTERS,
  NEW_DATA,
  NEW_RECORDS,
  NEW_SETTINGS,
  STORAGE_KEY,
  choiceOf,
  createDataStore,
  normaliseData,
  serialiseData,
} from '../../src/core/storage';
import type { KeyValueStore } from '../../src/core/storage';

/**
 * Item I2, method T, evidence `unit/storage-corrupt`:
 *
 *   "A corrupt, unparseable or out-of-range saved value does not prevent the
 *    game from starting. Defaults are used and overwritten on the next
 *    successful write."
 *
 * "DOES NOT PREVENT THE GAME FROM STARTING" IS DRIVEN, NOT ASSERTED. The
 * tests below take the stored settings the way the composition root takes
 * them, build the match SPEC section 9 says those settings name, start it and
 * step it, so a document that poisoned the configuration would fail here as a
 * match that never reached a player's turn rather than as a store that
 * happened to answer with the wrong object.
 *
 * THE FALLBACK IS GRADED AS CONDITIONAL. Every corrupt case below is paired,
 * directly or through the whole-document control, with the same document made
 * valid, because a reader that answered with the defaults unconditionally
 * would pass every corruption test ever written and lose every player's
 * progress.
 *
 * OUT OF RANGE IS TAKEN FIELD BY FIELD. SPEC sections 9, 10, 11, 16 and 17
 * each state what a value may be; a stored 37 second match length and a
 * stored rung of 40 are both documents this game has to open, and each field
 * falls back on its own without taking its neighbours with it.
 */

function createBacking(seed?: string): KeyValueStore {
  const held = new Map<string, string>();
  if (seed !== undefined) {
    held.set(STORAGE_KEY, seed);
  }
  return {
    getItem(key: string): string | null {
      return held.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      held.set(key, value);
    },
    removeItem(key: string): void {
      held.delete(key);
    },
  };
}

/**
 * The composition the root builds out of the stored settings, played far
 * enough to prove the game started. Answers the state the match reached.
 */
function startsAMatch(store: ReturnType<typeof createDataStore>): string {
  const data = store.data();
  const setup = setupFor(choiceOf(data.settings, data.progress.ladderRung));
  const match = createMatch({ onNonFinite: 'repair' });
  match.dispatch({ kind: 'configure', configuration: setup.configuration });
  match.dispatch({ kind: 'start' });
  for (let step = 0; step < 30; step += 1) {
    match.update(1 / 120);
  }
  return match.readout().state.kind;
}

/** A truncated document, seeded and then asserted to have been replaced. */
const CORRUPT = '{"version": 2, "progress":';

/** Text that is not a document, in every shape a storage value can arrive in. */
const UNPARSEABLE: readonly string[] = [
  '',
  '{',
  CORRUPT,
  'not json at all',
  '<html>an error page</html>',
  // Whitespace alone is not a document either. Written as an escape
  // rather than as a literal space, so that nothing between here and the
  // file on disk can quietly turn it into something else.
  '\n',
];

describe('PF-10 a corrupt saved value cannot stop the game starting, item I2', () => {
  it('opens on the defaults after text that will not parse, and starts a match', () => {
    for (const text of UNPARSEABLE) {
      const backing = createBacking(text);
      // The corrupt bytes really are in the store before the read, so the
      // result below is a statement about them and not about an empty store.
      expect(backing.getItem(STORAGE_KEY)).toBe(text);
      const store = createDataStore(() => backing);
      expect(store.data()).toEqual(NEW_DATA);
      expect(startsAMatch(store)).toBe('PLAYER_TURN');
    }
  });

  it('records the parse failure rather than swallowing it', () => {
    const store = createDataStore(() => createBacking('{'));
    expect(store.lastFailure()).toContain('parsing the saved document');
    // Storage itself was never refused: only the bytes in it were unusable.
    expect(store.persistent()).toBe(true);
  });

  it('opens on the defaults after a document that is not an object', () => {
    for (const text of ['null', '42', '"a string"', '[1, 2, 3]', 'true']) {
      const store = createDataStore(() => createBacking(text));
      expect(store.data()).toEqual(NEW_DATA);
      expect(startsAMatch(store)).toBe('PLAYER_TURN');
    }
  });

  it('starts on a mode whose stored numbers are all out of range', () => {
    const store = createDataStore(() =>
      createBacking(
        JSON.stringify({
          version: DOCUMENT_VERSION,
          progress: { ladderRung: 40 },
          settings: { mode: 'blitz', duration: 37, target: 4, difficulty: 'legend' },
        }),
      ),
    );
    expect(store.data().settings).toEqual(NEW_SETTINGS);
    // SPEC section 10's ladder is six rungs, so a stored 40 is clamped by the
    // door `core/modes.ts` already owns rather than starting a seventh rung.
    expect(LADDER_TOTAL).toBe(6);
    expect(store.read().ladderRung).toBe(6);
    expect(startsAMatch(store)).toBe('PLAYER_TURN');
  });
});

describe('PF-10 every out-of-range field falls back on its own, item I2', () => {
  it('answers for each setting against the values its section offers', () => {
    const settingsFrom = (settings: Record<string, unknown>): typeof NEW_SETTINGS =>
      normaliseData({ settings }).settings;

    // SPEC section 9: 60, 90 and 120 seconds, and 3, 5 or 7 goals.
    expect(settingsFrom({ duration: 90 }).duration).toBe(90);
    expect(settingsFrom({ duration: 37 }).duration).toBe(60);
    expect(settingsFrom({ duration: '90' }).duration).toBe(60);
    expect(settingsFrom({ target: 7 }).target).toBe(7);
    expect(settingsFrom({ target: 4 }).target).toBe(3);
    // SPEC section 8's three difficulties and section 9's four modes.
    expect(settingsFrom({ difficulty: 'ace' }).difficulty).toBe('ace');
    expect(settingsFrom({ difficulty: 'legend' }).difficulty).toBe('casual');
    expect(settingsFrom({ mode: 'hotseat' }).mode).toBe('hotseat');
    expect(settingsFrom({ mode: 'blitz' }).mode).toBe('quick');
    // SPEC section 11's aim guide is a flag and nothing that looks like one.
    expect(settingsFrom({ guide: false }).guide).toBe(false);
    expect(settingsFrom({ guide: 'on' }).guide).toBe(true);
    // A falsy value that is not a boolean, against a default of true: this is
    // the case that tells a type check apart from a coercion, which the line
    // above cannot, because both answers there are true.
    expect(NEW_SETTINGS.guide).toBe(true);
    expect(settingsFrom({ guide: 0 }).guide).toBe(true);
    // SPEC section 17's theme, and the reserved settings behind it.
    expect(settingsFrom({ theme: 'dark' }).theme).toBe('dark');
    expect(settingsFrom({ theme: 'neon' }).theme).toBe('system');
    expect(settingsFrom({ muted: true }).muted).toBe(true);
    expect(settingsFrom({ muted: 1 }).muted).toBe(false);
    expect(settingsFrom({ volume: 0.25 }).volume).toBe(0.25);
    expect(settingsFrom({ volume: 5 }).volume).toBe(1);
    expect(settingsFrom({ volume: -2 }).volume).toBe(0);
    expect(settingsFrom({ volume: 'loud' }).volume).toBe(1);
    expect(settingsFrom({ motion: 'always' }).motion).toBe('always');
    expect(settingsFrom({ motion: 'never' }).motion).toBe('system');
    expect(settingsFrom({ surfaceScale: 150 }).surfaceScale).toBe(150);
    expect(settingsFrom({ surfaceScale: 175 }).surfaceScale).toBe(100);
  });

  it('takes a whole settings block that is not an object back to the defaults', () => {
    for (const settings of [null, 'dark', 42, undefined]) {
      expect(normaliseData({ settings }).settings).toEqual(NEW_SETTINGS);
    }
    // The neighbours are untouched by a settings block that failed.
    const data = normaliseData({
      settings: 'dark',
      counters: { matchesPlayed: 4, goalsFor: 9, goalsAgainst: 5 },
    });
    expect(data.settings).toEqual(NEW_SETTINGS);
    expect(data.counters).toEqual({ matchesPlayed: 4, goalsFor: 9, goalsAgainst: 5 });
  });

  it('answers for every lifetime counter, whole and never negative', () => {
    const countersFrom = (counters: unknown): typeof NEW_COUNTERS =>
      normaliseData({ counters }).counters;
    expect(countersFrom({ matchesPlayed: 7, goalsFor: 19, goalsAgainst: 12 })).toEqual({
      matchesPlayed: 7,
      goalsFor: 19,
      goalsAgainst: 12,
    });
    expect(countersFrom({ matchesPlayed: -3 }).matchesPlayed).toBe(0);
    expect(countersFrom({ matchesPlayed: 4.7 }).matchesPlayed).toBe(4);
    expect(countersFrom({ goalsFor: Number.NaN }).goalsFor).toBe(0);
    expect(countersFrom({ goalsFor: Number.POSITIVE_INFINITY }).goalsFor).toBe(0);
    expect(countersFrom({ goalsAgainst: '12' }).goalsAgainst).toBe(0);
    expect(countersFrom('none')).toEqual(NEW_COUNTERS);
  });

  it('takes a half-written record as no record rather than half a record', () => {
    const recordsFrom = (records: unknown): typeof NEW_RECORDS =>
      normaliseData({ records }).records;
    expect(recordsFrom({ quick: { goalsFor: 4, goalsAgainst: 1 } }).quick).toEqual({
      goalsFor: 4,
      goalsAgainst: 1,
    });
    // A scoreline with one usable half would compare against a real one and
    // could win, so it is dropped whole.
    expect(recordsFrom({ quick: { goalsFor: 4 } }).quick).toBeNull();
    expect(recordsFrom({ quick: { goalsFor: Number.NaN, goalsAgainst: 1 } }).quick).toBeNull();
    expect(recordsFrom({ quick: { goalsFor: -1, goalsAgainst: 1 } }).quick).toBeNull();
    expect(recordsFrom({ quick: 'four one' }).quick).toBeNull();
    expect(recordsFrom('none')).toEqual(NEW_RECORDS);
    // A mode this build does not know is not a record either, and its
    // presence does not disturb the four that are.
    const mixed = recordsFrom({
      blitz: { goalsFor: 9, goalsAgainst: 0 },
      ladder: { goalsFor: 3, goalsAgainst: 2 },
    });
    expect(Object.keys(mixed).sort()).toEqual(['first-to', 'hotseat', 'ladder', 'quick']);
    expect(mixed.ladder).toEqual({ goalsFor: 3, goalsAgainst: 2 });
  });
});

describe('PF-10 defaults are overwritten on the next successful write, item I2', () => {
  it('replaces the corrupt bytes the first time anything is saved', () => {
    const backing = createBacking(CORRUPT);
    const store = createDataStore(() => backing);
    expect(store.data()).toEqual(NEW_DATA);

    store.write({ ladderRung: 3, howToDismissed: true, rotateHintDismissed: true, playedBefore: true });

    const text = backing.getItem(STORAGE_KEY) ?? '';
    expect(text).not.toBe(CORRUPT);
    const written = JSON.parse(text) as Record<string, unknown>;
    expect(written['version']).toBe(DOCUMENT_VERSION);

    // A fresh session over the same store reads what was written, which is
    // what "overwritten" has to mean for it to be worth anything.
    const reopened = createDataStore(() => backing);
    expect(reopened.read()).toEqual({
      ladderRung: 3,
      howToDismissed: true,
      rotateHintDismissed: true,
      playedBefore: true,
    });
    expect(reopened.lastFailure()).toBeNull();
  });

  it('leaves a document that IS valid exactly where it is', () => {
    // THE NEGATIVE CONTROL for every fallback above. A reader that answered
    // with the defaults unconditionally would pass every corruption test in
    // this file and fail this one.
    const stored = {
      ...NEW_DATA,
      progress: { ladderRung: 5, howToDismissed: true, rotateHintDismissed: true, playedBefore: true },
      settings: { ...NEW_SETTINGS, mode: 'first-to' as const, target: 7, theme: 'dark' as const },
      records: { ...NEW_RECORDS, 'first-to': { goalsFor: 7, goalsAgainst: 2 } },
      counters: { matchesPlayed: 11, goalsFor: 34, goalsAgainst: 19 },
    };
    const store = createDataStore(() => createBacking(serialiseData(stored)));
    expect(store.data()).toEqual(stored);
    expect(store.lastFailure()).toBeNull();
    expect(startsAMatch(store)).toBe('PLAYER_TURN');
  });
});
