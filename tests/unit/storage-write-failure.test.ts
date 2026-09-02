import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createMatch } from '../../src/core/match';
import { setupFor } from '../../src/core/modes';
import {
  NEW_DATA,
  STORAGE_KEY,
  choiceOf,
  createDataStore,
  recordResult,
  serialiseData,
} from '../../src/core/storage';
import type { GameData, KeyValueStore } from '../../src/core/storage';

/**
 * Item I3, method T, evidence `unit/storage-write-failure`:
 *
 *   "A storage write that throws does not interrupt the match, and a
 *    SecurityError thrown on window.localStorage property access at startup
 *    falls back to an in-memory store without preventing the game from
 *    starting."
 *
 * TWO FAILURES, AND THEY FAIL IN DIFFERENT PLACES. A throwing `setItem` is
 * the one everybody guards; the property access is the one QUALITY-BAR
 * section 8 calls the more dangerous and the most easily missed, because it
 * throws BEFORE any method exists to guard. Both are graded here.
 *
 * THE PROPERTY ACCESS IS MODELLED AS A THROWING `open`, AND THE MODEL IS
 * PINNED TO THE SHIPPED EXPRESSION. `core/storage.ts` calls `open()` inside
 * its own try; the composition root's `open` is the single expression
 * `return window.localStorage;`, so a throw out of that call IS a throw on the
 * property access. The last test in this file reads `src/main.ts` and asserts
 * that is still what it says, because a model that has drifted from the
 * shipped expression grades nothing.
 *
 * "DOES NOT INTERRUPT THE MATCH" IS DRIVEN. The match is stepped across the
 * failing write, in the same order the composition root does it, and the
 * states either side of the write are asserted; a store that let an exception
 * out would end the run instead of failing an assertion, which is the loudest
 * form this failure can take.
 *
 * THE NEGATIVE CONTROL IS A STORE THAT WORKS. Every assertion about a
 * swallowed failure would hold just as well for a store that never wrote
 * anything at all, so the working store is driven through the same path and
 * its bytes are read out of the backing.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const COMPOSITION_ROOT = path.join(PROJECT_ROOT, 'src', 'main.ts');

/** What a partitioned or cookie-blocked context throws, by name. */
function securityError(): Error {
  const error = new Error('The operation is insecure.');
  error.name = 'SecurityError';
  return error;
}

function quotaError(): Error {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

interface Backing extends KeyValueStore {
  text(): string | null;
  writes(): number;
}

/** A store that works, or one that refuses the operations named in `options`. */
function createBacking(
  options: { throwOnWrite?: boolean; throwOnRemove?: boolean; seed?: string } = {},
): Backing {
  let held: string | null = options.seed ?? null;
  let writes = 0;
  return {
    getItem(key: string): string | null {
      return key === STORAGE_KEY ? held : null;
    },
    setItem(key: string, value: string): void {
      writes += 1;
      if (options.throwOnWrite === true) {
        throw quotaError();
      }
      if (key === STORAGE_KEY) {
        held = value;
      }
    },
    removeItem(key: string): void {
      if (options.throwOnRemove === true) {
        throw securityError();
      }
      if (key === STORAGE_KEY) {
        held = null;
      }
    },
    text(): string | null {
      return held;
    },
    writes(): number {
      return writes;
    },
  };
}

/** The match the stored settings name, built the way the root builds it. */
function matchFor(data: GameData): ReturnType<typeof createMatch> {
  const setup = setupFor(choiceOf(data.settings, data.progress.ladderRung));
  const match = createMatch({ onNonFinite: 'repair' });
  match.dispatch({ kind: 'configure', configuration: setup.configuration });
  match.dispatch({ kind: 'start' });
  return match;
}

describe('PF-10 a SecurityError on property access cannot stop the game, item I3', () => {
  it('falls back to an in-memory store and still starts a match', () => {
    const store = createDataStore(() => {
      throw securityError();
    });
    expect(store.persistent()).toBe(false);
    expect(store.data()).toEqual(NEW_DATA);

    const match = matchFor(store.data());
    for (let step = 0; step < 30; step += 1) {
      match.update(1 / 120);
    }
    expect(match.readout().state.kind).toBe('PLAYER_TURN');
  });

  it('names the refusal rather than swallowing it', () => {
    const store = createDataStore(() => {
      throw securityError();
    });
    const failure = store.lastFailure() ?? '';
    expect(failure).toContain('opening the platform store');
    expect(failure).toContain('SecurityError');
  });

  it('keeps every value for the session, which is what in-memory means', () => {
    const store = createDataStore(() => {
      throw securityError();
    });
    store.write({ ladderRung: 4, howToDismissed: true, playedBefore: true });
    expect(store.read()).toEqual({
      ladderRung: 4,
      howToDismissed: true,
      playedBefore: true,
    });
    store.save(recordResult(store.data(), 'ladder', 3, 1));
    expect(store.data().records.ladder).toEqual({ goalsFor: 3, goalsAgainst: 1 });
    expect(store.data().counters).toEqual({
      matchesPlayed: 1,
      goalsFor: 3,
      goalsAgainst: 1,
    });
    // And the ladder rung the session earned is still the rung it reads back.
    expect(store.read().ladderRung).toBe(4);
    store.clear();
    expect(store.data()).toEqual(NEW_DATA);
  });

  it('answers the same way when the platform has no store to offer at all', () => {
    const store = createDataStore(() => null);
    expect(store.persistent()).toBe(false);
    expect(store.lastFailure()).toBeNull();
    store.write({ ladderRung: 2, howToDismissed: true, playedBefore: true });
    expect(store.read().ladderRung).toBe(2);
    expect(matchFor(store.data()).readout().state.kind).toBe('PLAYER_TURN');
  });

  it('survives a throw that is not an Error at all', () => {
    const store = createDataStore(() => {
      // Some engines throw a bare string from this property.
      throw 'SecurityError: the operation is insecure';
    });
    expect(store.persistent()).toBe(false);
    expect(store.lastFailure() ?? '').toContain('SecurityError');
    expect(store.data()).toEqual(NEW_DATA);
  });

  it('survives a getItem that throws after the property access succeeded', () => {
    const store = createDataStore(() => ({
      getItem(): string | null {
        throw securityError();
      },
      setItem(): void {
        return undefined;
      },
      removeItem(): void {
        return undefined;
      },
    }));
    expect(store.data()).toEqual(NEW_DATA);
    expect(store.lastFailure() ?? '').toContain('reading the saved document');
    expect(matchFor(store.data()).readout().state.kind).toBe('PLAYER_TURN');
  });
});

describe('PF-10 a write that throws does not interrupt the match, item I3', () => {
  it('plays through the whistle write with every setItem throwing', () => {
    const backing = createBacking({ throwOnWrite: true });
    const store = createDataStore(() => backing);
    const match = matchFor(store.data());
    for (let step = 0; step < 30; step += 1) {
      match.update(1 / 120);
    }
    expect(match.readout().state.kind).toBe('PLAYER_TURN');

    // The write the composition root takes at a start, and the one it takes
    // at the whistle. Both throw inside the store and neither throws out.
    store.save({
      ...store.data(),
      progress: { ...store.data().progress, playedBefore: true },
    });
    store.save(recordResult(store.data(), 'quick', 2, 1));

    // The match is untouched by either: the same state, still advancing.
    for (let step = 0; step < 30; step += 1) {
      match.update(1 / 120);
    }
    expect(match.readout().state.kind).toBe('PLAYER_TURN');
    expect(backing.writes()).toBe(2);
    expect(backing.text()).toBeNull();
  });

  it('keeps the in-memory value authoritative when the write is refused', () => {
    const store = createDataStore(() => createBacking({ throwOnWrite: true }));
    store.write({ ladderRung: 5, howToDismissed: true, playedBefore: true });
    // Only the carry across sessions degrades. Within the session the value
    // the game wrote is the value the game reads.
    expect(store.read().ladderRung).toBe(5);
    expect(store.data().progress.playedBefore).toBe(true);
    expect(store.persistent()).toBe(true);
    expect(store.lastFailure() ?? '').toContain('writing the saved document');
    expect(store.lastFailure() ?? '').toContain('QuotaExceededError');
  });

  it('writes the new-player document when the platform refuses to remove it', () => {
    // A platform that refuses one operation has not necessarily refused the
    // other, and the player has just asked for everything to go. The document
    // that could not be deleted is overwritten instead, so the NEXT session
    // reads a player who has nothing rather than the one just erased.
    const backing = createBacking({ throwOnRemove: true });
    const store = createDataStore(() => backing);
    store.write({ ladderRung: 6, howToDismissed: true, playedBefore: true });
    expect(backing.text()).not.toBeNull();

    store.clear();
    expect(store.data()).toEqual(NEW_DATA);
    expect(store.lastFailure() ?? '').toContain('clearing the saved document');
    // The bytes are still there, and they are the new player's.
    expect(backing.text()).not.toBeNull();
    const reopened = createDataStore(() => backing);
    expect(reopened.data()).toEqual(NEW_DATA);
    expect(reopened.read().ladderRung).toBe(1);
  });

  it('still resets the session when neither the remove nor the write lands', () => {
    // Both refused is all the platform has left to refuse. The session is
    // cleared, the refusal is on the record, and nothing throws out.
    const store = createDataStore(() =>
      createBacking({ throwOnRemove: true, throwOnWrite: true }),
    );
    store.write({ ladderRung: 6, howToDismissed: true, playedBefore: true });
    store.clear();
    expect(store.data()).toEqual(NEW_DATA);
    expect(store.lastFailure() ?? '').toContain('writing the saved document');
  });

  it('writes for real when nothing throws, which is the control for all of it', () => {
    // THE NEGATIVE CONTROL. Every assertion above about a swallowed failure
    // would hold identically for a store that never wrote anything, so the
    // working store is driven through the same calls and its bytes are read.
    const backing = createBacking();
    const store = createDataStore(() => backing);
    store.write({ ladderRung: 5, howToDismissed: true, playedBefore: true });
    expect(backing.writes()).toBe(1);
    expect(backing.text()).toBe(serialiseData(store.data()));

    store.save(recordResult(store.data(), 'quick', 4, 0));
    expect(backing.writes()).toBe(2);
    const reopened = createDataStore(() => backing);
    expect(reopened.data().records.quick).toEqual({ goalsFor: 4, goalsAgainst: 0 });
    expect(reopened.read().ladderRung).toBe(5);
    expect(reopened.lastFailure()).toBeNull();

    store.clear();
    expect(backing.text()).toBeNull();
  });
});

describe('PF-10 the probe models the shipped property access, item I3', () => {
  it('finds the composition root opening storage as one property access', () => {
    const source = readFileSync(COMPOSITION_ROOT, 'utf8');
    // The whole body of the root's `open` is the property read, so a throw out
    // of the call the store makes is a throw on the property access itself.
    expect(source).toContain(
      ['function openStorage(): KeyValueStore {', '  return window.localStorage;', '}'].join(
        '\n',
      ),
    );
    // And it is handed to the store rather than called first and passed as a
    // value, which would move the throw outside the try that catches it.
    expect(source).toContain('createDataStore(openStorage)');
  });
});
