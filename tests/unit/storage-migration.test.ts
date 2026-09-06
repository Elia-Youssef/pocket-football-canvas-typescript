import { describe, expect, it } from 'vitest';

import { LADDER_TOTAL, NEW_PROGRESS } from '../../src/core/modes';
import {
  DOCUMENT_VERSION,
  FIRST_VERSION,
  NEW_COUNTERS,
  NEW_DATA,
  NEW_RECORDS,
  NEW_SETTINGS,
  STORAGE_KEY,
  bestOf,
  createDataStore,
  migrate,
  recordResult,
  serialiseData,
} from '../../src/core/storage';
import type { GameData, KeyValueStore } from '../../src/core/storage';

/**
 * Item I1, method T, evidence `unit/storage-migration`:
 *
 *   "Saved state is a single namespaced versioned document, and a version bump
 *    migrates losslessly where possible and discards cleanly where not."
 *
 * THE CRITERION IS THREE CLAIMS AND EACH IS GRADED SEPARATELY. That saved
 * state is ONE document under ONE namespaced key; that the version lives
 * inside it; and that a bump carries what it can and drops what it cannot.
 *
 * VERSION 1 IS THE PROGRESS-ONLY DOCUMENT: `ladderRung`, `howToDismissed` and
 * `playedBefore`, written flat, which is the shape `core/modes.ts`'s seam
 * round-trips. Version 2 is the shipped shape, with those three under
 * `progress` and SPEC section 16's settings, records and counters beside them,
 * and the lift between the two is the bump this criterion is about.
 *
 * NO SHIPPED BUILD EVER WROTE A VERSION 1 DOCUMENT, and the tests below say so
 * rather than implying otherwise: the seam held those three fields in memory
 * and storage arrives with version 2. What is graded here is therefore the
 * MACHINERY of a bump against the first shape it will ever be asked to carry,
 * which is the point at which it is cheap to get right and easy to prove.
 *
 * EVERY MIGRATED VALUE DIFFERS FROM THE NEW-PLAYER VALUE, on purpose. A
 * lossless-migration test whose expected values are the defaults passes
 * identically against a migration that discarded everything, which is the one
 * failure it exists to catch.
 *
 * THE DISCARD HALF IS GRADED IN BOTH DIRECTIONS. A document this build cannot
 * reach is dropped WHOLE, and the negative control is the same document at a
 * version it can reach, which must be read: a fallback that fires for every
 * document is not a refusal, it is a broken reader.
 */

/** A stand-in platform store that also says which keys it holds. */
interface Backing extends KeyValueStore {
  keys(): string[];
}

function createBacking(seed?: string): Backing {
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
    keys(): string[] {
      return [...held.keys()].sort();
    },
  };
}

/** The document text a version 1 build would have left behind. */
function versionOne(fields: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, ...fields });
}

/** A version 2 document, written the way this build writes one. */
function versionTwo(data: GameData): string {
  return serialiseData(data);
}

describe('PF-10 saved state is one namespaced versioned document, item I1', () => {
  it('names one key, namespaced by the game and carrying no version', () => {
    expect(STORAGE_KEY).toBe('pocket-football:save');
    expect(STORAGE_KEY.startsWith('pocket-football')).toBe(true);
    // The version is INSIDE the document, so the key cannot carry one: a
    // version in the key name means a reader has to guess which keys exist
    // before it can read any of them.
    expect(STORAGE_KEY).not.toContain(String(DOCUMENT_VERSION));
    expect(/\d/.test(STORAGE_KEY)).toBe(false);
  });

  it('holds a whole session of writes in exactly one key', () => {
    const backing = createBacking();
    const store = createDataStore(() => backing);
    expect(backing.keys()).toEqual([]);

    store.write({ ladderRung: 3, howToDismissed: true, playedBefore: true });
    expect(backing.keys()).toEqual([STORAGE_KEY]);

    store.save({
      ...store.data(),
      settings: { ...store.data().settings, theme: 'dark', difficulty: 'ace' },
    });
    store.save({
      ...store.data(),
      counters: { matchesPlayed: 9, goalsFor: 21, goalsAgainst: 8 },
    });
    expect(backing.keys()).toEqual([STORAGE_KEY]);

    store.clear();
    expect(backing.keys()).toEqual([]);
    store.write({ ladderRung: 2, howToDismissed: true, playedBefore: true });
    expect(backing.keys()).toEqual([STORAGE_KEY]);
  });

  it('writes the version inside the document, beside the data', () => {
    const backing = createBacking();
    const store = createDataStore(() => backing);
    store.write({ ladderRung: 5, howToDismissed: true, playedBefore: true });
    const text = backing.getItem(STORAGE_KEY);
    expect(text).not.toBeNull();
    const written = JSON.parse(text ?? '') as Record<string, unknown>;
    expect(written['version']).toBe(2);
    expect(written['version']).toBe(DOCUMENT_VERSION);
    expect(Object.keys(written).sort()).toEqual([
      'counters',
      'progress',
      'records',
      'settings',
      'version',
    ]);
  });
});

describe('PF-10 a version bump migrates losslessly where it can, item I1', () => {
  it('carries every version 1 field across, and none of them is a default', () => {
    // Each of the three differs from the new-player value, so a migration that
    // dropped the lot would fail here rather than agreeing by coincidence.
    expect(NEW_PROGRESS).toEqual({
      ladderRung: 1,
      howToDismissed: false,
      playedBefore: false,
    });
    const data = migrate(
      JSON.parse(
        versionOne({ ladderRung: 4, howToDismissed: true, playedBefore: true }),
      ) as unknown,
    );
    expect(data.progress).toEqual({
      ladderRung: 4,
      howToDismissed: true,
      playedBefore: true,
    });
  });

  it('supplies the fields version 2 added, at their new-player values', () => {
    const data = migrate({ version: FIRST_VERSION, ladderRung: 6, playedBefore: true });
    expect(data.settings).toEqual(NEW_SETTINGS);
    expect(data.records).toEqual(NEW_RECORDS);
    expect(data.counters).toEqual(NEW_COUNTERS);
    expect(data.progress.ladderRung).toBe(6);
  });

  it('reaches the whole ladder through the lift, top rung included', () => {
    expect(LADDER_TOTAL).toBe(6);
    for (const rung of [1, 2, 3, 4, 5, 6]) {
      expect(migrate({ version: 1, ladderRung: rung }).progress.ladderRung).toBe(rung);
    }
  });

  it('leaves a migrated document stored at the current version', () => {
    const backing = createBacking(
      versionOne({ ladderRung: 3, howToDismissed: true, playedBefore: true }),
    );
    const store = createDataStore(() => backing);
    expect(store.read().ladderRung).toBe(3);
    // The migration is written down at the first write, so the next session
    // reads a version 2 document rather than migrating the same bytes again.
    store.save(store.data());
    const written = JSON.parse(backing.getItem(STORAGE_KEY) ?? '') as Record<string, unknown>;
    expect(written['version']).toBe(2);
    expect(written['ladderRung']).toBeUndefined();
    const reopened = createDataStore(() => backing);
    expect(reopened.read().ladderRung).toBe(3);
  });
});

describe('PF-10 a version bump discards cleanly where it cannot, item I1', () => {
  it('drops every version 1 key that version 2 has no home for', () => {
    const data = migrate({
      version: 1,
      ladderRung: 2,
      howToDismissed: true,
      playedBefore: true,
      lastOpponent: 'Cinder',
      streak: 11,
    });
    // The migrated document is exactly this build's shape: a key the lift did
    // not name is not carried under any spelling.
    expect(Object.keys(data).sort()).toEqual([
      'counters',
      'progress',
      'records',
      'settings',
    ]);
    expect(Object.keys(data.progress).sort()).toEqual([
      'howToDismissed',
      'ladderRung',
      'playedBefore',
    ]);
    expect(JSON.stringify(data)).not.toContain('Cinder');
    expect(JSON.stringify(data)).not.toContain('streak');
  });

  it('drops a key the current shape has no home for either', () => {
    // The same claim one version up, and it is graded separately because the
    // lift and the normalise door BOTH drop an unknown key: an assertion made
    // only against a version 1 document cannot tell which of them did it.
    const data = migrate({
      version: DOCUMENT_VERSION,
      progress: { ladderRung: 3, howToDismissed: true, playedBefore: true },
      lastOpponent: 'Cinder',
      streak: 11,
    });
    expect(Object.keys(data).sort()).toEqual([
      'counters',
      'progress',
      'records',
      'settings',
    ]);
    expect(data.progress.ladderRung).toBe(3);
    expect(JSON.stringify(data)).not.toContain('Cinder');
    expect(JSON.stringify(data)).not.toContain('streak');
  });

  it('drops the one value that cannot cross and carries the ones that can', () => {
    const data = migrate({
      version: 1,
      ladderRung: 'three',
      howToDismissed: true,
      playedBefore: true,
    });
    // The unusable field falls back to the new-player value rather than
    // crossing as a string, and its neighbours are untouched by its failure.
    expect(data.progress.ladderRung).toBe(1);
    expect(data.progress.howToDismissed).toBe(true);
    expect(data.progress.playedBefore).toBe(true);
  });

  it('refuses a document from the future whole, rather than half reading it', () => {
    const future = {
      version: DOCUMENT_VERSION + 1,
      progress: { ladderRung: 5, howToDismissed: true, playedBefore: true },
      settings: { ...NEW_SETTINGS, theme: 'dark', difficulty: 'ace' },
      counters: { matchesPlayed: 12, goalsFor: 40, goalsAgainst: 11 },
    };
    expect(migrate(future)).toEqual(NEW_DATA);
    // THE NEGATIVE CONTROL. The same fields at a version this build can reach
    // ARE read, so the refusal above is a statement about the version and not
    // a reader that falls back on everything.
    const reachable = migrate({ ...future, version: DOCUMENT_VERSION });
    expect(reachable.progress.ladderRung).toBe(5);
    expect(reachable.settings.theme).toBe('dark');
    expect(reachable.settings.difficulty).toBe('ace');
    expect(reachable.counters.matchesPlayed).toBe(12);
  });

  it('refuses every version that names no shape at all', () => {
    const progress = { ladderRung: 5, howToDismissed: true, playedBefore: true };
    expect(migrate({ progress })).toEqual(NEW_DATA);
    expect(migrate({ version: 0, progress })).toEqual(NEW_DATA);
    expect(migrate({ version: -1, progress })).toEqual(NEW_DATA);
    expect(migrate({ version: 1.5, progress })).toEqual(NEW_DATA);
    expect(migrate({ version: '2', progress })).toEqual(NEW_DATA);
    expect(migrate({ version: Number.NaN, progress })).toEqual(NEW_DATA);
    expect(migrate({ version: null, progress })).toEqual(NEW_DATA);
    // And the same fields at a reachable version are read, which is what makes
    // the six refusals above statements about the version.
    expect(migrate({ version: DOCUMENT_VERSION, progress }).progress.ladderRung).toBe(5);
  });

  it('refuses anything that is not a document', () => {
    expect(migrate(null)).toEqual(NEW_DATA);
    expect(migrate(undefined)).toEqual(NEW_DATA);
    expect(migrate('a string')).toEqual(NEW_DATA);
    expect(migrate(42)).toEqual(NEW_DATA);
    expect(migrate([{ version: 2 }])).toEqual(NEW_DATA);
    // An array is not a document even when it carries the fields of one. This
    // is the case the `typeof` test alone cannot answer, because an array IS
    // an object, and it is why the guard names arrays explicitly.
    const dressed = Object.assign([], {
      version: DOCUMENT_VERSION,
      progress: { ladderRung: 5, howToDismissed: true, playedBefore: true },
    });
    expect(migrate(dressed)).toEqual(NEW_DATA);
  });

  it('round trips its own bytes, so a written document is a readable one', () => {
    const written: GameData = {
      progress: { ladderRung: 4, howToDismissed: true, playedBefore: true },
      settings: { ...NEW_SETTINGS, mode: 'first-to', target: 7, difficulty: 'pro' },
      records: { ...NEW_RECORDS, ladder: { goalsFor: 3, goalsAgainst: 1 } },
      counters: { matchesPlayed: 5, goalsFor: 14, goalsAgainst: 6 },
    };
    expect(migrate(JSON.parse(versionTwo(written)) as unknown)).toEqual(written);
  });
});

/**
 * The best result per mode, which is a DOCUMENTED READING of SPEC section 16
 * rather than something the section defines, and is therefore this part's to
 * pin. It lives in this file because it is a property of the stored document,
 * and this is the file that owns the document; item I5's browser spec grades
 * that a best result SURVIVES a reload, and nothing there can grade that it is
 * the best one, because a browser test that played two matches in one mode
 * would be grading the opponent as much as the store.
 *
 * EVERY EXPECTED VALUE IS A LITERAL SCORELINE. Driving them from `bestOf`
 * itself, or from a margin computed the same way the module computes it, would
 * pass for whatever the rule became.
 */
describe('PF-10 the best result per mode is a documented reading', () => {
  it('takes the first result in a mode whatever it was, defeat included', () => {
    expect(bestOf(null, { goalsFor: 3, goalsAgainst: 1 })).toEqual({
      goalsFor: 3,
      goalsAgainst: 1,
    });
    expect(bestOf(null, { goalsFor: 0, goalsAgainst: 3 })).toEqual({
      goalsFor: 0,
      goalsAgainst: 3,
    });
  });

  it('keeps the better goal margin, and refuses the worse one', () => {
    const held = { goalsFor: 3, goalsAgainst: 1 };
    // 4-1 is a margin of three against a margin of two.
    expect(bestOf(held, { goalsFor: 4, goalsAgainst: 1 })).toEqual({
      goalsFor: 4,
      goalsAgainst: 1,
    });
    // 3-2 is a margin of one, so the held 3-1 stands.
    expect(bestOf(held, { goalsFor: 3, goalsAgainst: 2 })).toEqual(held);
    // A defeat improved on is still an improvement: -2 beats -3.
    expect(bestOf({ goalsFor: 0, goalsAgainst: 3 }, { goalsFor: 1, goalsAgainst: 3 })).toEqual(
      { goalsFor: 1, goalsAgainst: 3 },
    );
  });

  it('breaks an equal margin on the goals scored, both ways round', () => {
    const held = { goalsFor: 3, goalsAgainst: 1 };
    // 4-2 is the same margin of two with more goals in it.
    expect(bestOf(held, { goalsFor: 4, goalsAgainst: 2 })).toEqual({
      goalsFor: 4,
      goalsAgainst: 2,
    });
    // And the other way: the same margin with fewer goals does not displace it.
    expect(bestOf({ goalsFor: 4, goalsAgainst: 2 }, held)).toEqual({
      goalsFor: 4,
      goalsAgainst: 2,
    });
    // An identical scoreline changes nothing, so a replayed result is not a
    // new record.
    expect(bestOf(held, { goalsFor: 3, goalsAgainst: 1 })).toEqual(held);
  });

  it('records a result against the mode it was played in, and no other', () => {
    const after = recordResult(NEW_DATA, 'ladder', 3, 1);
    expect(after.records.ladder).toEqual({ goalsFor: 3, goalsAgainst: 1 });
    expect(after.records.quick).toBeNull();
    expect(after.records['first-to']).toBeNull();
    expect(after.records.hotseat).toBeNull();
  });

  it('counts every match in the lifetime totals, best or worst', () => {
    let data = recordResult(NEW_DATA, 'quick', 4, 1);
    expect(data.counters).toEqual({ matchesPlayed: 1, goalsFor: 4, goalsAgainst: 1 });
    // A worse result leaves the record alone and still counts.
    data = recordResult(data, 'quick', 0, 2);
    expect(data.records.quick).toEqual({ goalsFor: 4, goalsAgainst: 1 });
    expect(data.counters).toEqual({ matchesPlayed: 2, goalsFor: 4, goalsAgainst: 3 });
    // And a better one replaces it, while the totals keep accumulating.
    data = recordResult(data, 'quick', 5, 1);
    expect(data.records.quick).toEqual({ goalsFor: 5, goalsAgainst: 1 });
    expect(data.counters).toEqual({ matchesPlayed: 3, goalsFor: 9, goalsAgainst: 4 });
  });

  it('records nothing a scoreboard cannot produce', () => {
    const data = recordResult(NEW_DATA, 'hotseat', -2, 3.7);
    expect(data.records.hotseat).toEqual({ goalsFor: 0, goalsAgainst: 3 });
    expect(data.counters).toEqual({ matchesPlayed: 1, goalsFor: 0, goalsAgainst: 3 });
  });
});

describe('PF-10 the stored document round trips, item I1', () => {
  it('survives a write and a read with every field intact', () => {
    const written: GameData = {
      progress: { ladderRung: 4, howToDismissed: true, playedBefore: true },
      settings: { ...NEW_SETTINGS, mode: 'first-to', target: 7, difficulty: 'pro' },
      records: { ...NEW_RECORDS, ladder: { goalsFor: 3, goalsAgainst: 1 } },
      counters: { matchesPlayed: 5, goalsFor: 14, goalsAgainst: 6 },
    };
    expect(migrate(JSON.parse(versionTwo(written)) as unknown)).toEqual(written);
  });
});
