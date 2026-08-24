import { describe, expect, it } from 'vitest';

import { RUNS, verdict } from '../../scripts/check-determinism.mjs';
import type { TreeComparison } from '../../scripts/output-fingerprint.mjs';

/**
 * The driver half of item A6.
 *
 * `output-fingerprint.test.ts` proves the comparison can say "different". This
 * file proves the two things around it that a green run never exercises: that
 * the two builds are genuinely run under different conditions, and that every
 * condition in the verdict is load-bearing.
 *
 * Both were reachable by a single edit that left every gate green, which is
 * the definition of an ungraded property.
 */

const IDENTICAL: TreeComparison = {
  identical: true,
  onlyInLeft: [],
  onlyInRight: [],
  differing: [],
};

const DIFFERENT: TreeComparison = {
  identical: false,
  onlyInLeft: [],
  onlyInRight: ['assets/stray.js'],
  differing: [],
};

const GREEN = {
  buildError: null,
  comparison: IDENTICAL,
  inputStable: true,
  emittedCount: 2,
};

describe('PF-0 determinism driver, item A6', () => {
  describe('the two builds are run under different conditions', () => {
    it('runs exactly twice', () => {
      expect(RUNS).toHaveLength(2);
    });

    it('varies every condition it claims to vary', () => {
      const [first, second] = RUNS;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first === undefined || second === undefined) {
        return;
      }

      // Two builds a second apart under identical conditions would report the
      // strongest possible PASS and would have caught none of the defects this
      // check exists for. Each pair below is one of those conditions.
      expect(first.zone, 'time zone').not.toBe(second.zone);
      expect(first.probe, 'VITE_ probe value').not.toBe(second.probe);
      expect(
        first.stamp.toISOString(),
        'the fake mtime stamped onto every input',
      ).not.toBe(second.stamp.toISOString());
      expect(first.outDir, 'output directory').not.toBe(second.outDir);
      expect(first.id).not.toBe(second.id);
    });

    it('states a real value for every condition', () => {
      for (const run of RUNS) {
        expect(run.zone.length).toBeGreaterThan(0);
        expect(run.probe.length).toBeGreaterThan(0);
        expect(run.outDir.length).toBeGreaterThan(0);
        expect(Number.isFinite(run.stamp.getTime())).toBe(true);
      }
    });
  });

  describe('the verdict, one branch at a time', () => {
    it('passes only when all four conditions hold', () => {
      expect(verdict(GREEN)).toBe(true);
    });

    it('fails when a build did not complete', () => {
      expect(verdict({ ...GREEN, buildError: 'vite exited 1' })).toBe(false);
    });

    it('fails when the two trees differ', () => {
      expect(verdict({ ...GREEN, comparison: DIFFERENT })).toBe(false);
    });

    it('fails when the input tree moved during the run', () => {
      // The check stamps mtimes and restores them. If it left the tree
      // changed, the two builds were not builds of the same source, and the
      // comparison above says nothing at all.
      expect(verdict({ ...GREEN, inputStable: false })).toBe(false);
    });

    it('fails when nothing was emitted', () => {
      // Two empty trees compare equal, so without this the weakest possible
      // build reports the strongest possible result.
      expect(verdict({ ...GREEN, emittedCount: 0 })).toBe(false);
    });
  });
});
