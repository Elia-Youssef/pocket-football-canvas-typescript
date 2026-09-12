import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  RUNS,
  build,
  buildInvocation,
  conditionRows,
  performRuns,
  stampAll,
  verdict,
} from '../../scripts/check-determinism.mjs';
import type {
  DeterminismRecord,
  DeterminismRun,
} from '../../scripts/check-determinism.mjs';
import type { Tree, TreeComparison } from '../../scripts/output-fingerprint.mjs';

/**
 * The driver half of item A6.
 *
 * `output-fingerprint.test.ts` proves the comparison can say "different". This
 * file proves the three things around it that a green run never exercises: that
 * the two builds are genuinely run under different conditions, that every
 * condition in the verdict is load-bearing, and THAT EACH CONDITION REACHED THE
 * BUILD.
 *
 * The third was the gap. The `RUNS` table was pinned as four differing values
 * and nothing asserted the table was used, so the run loop, `TZ`, the VITE_
 * probe and the output directory could each be pinned to the first row with
 * `verify:build` reporting PASS and the evidence artifact still printing the
 * second row. That makes the report false rather than weak, which is worse. So
 * the composer, the stamping and the report's rows are each driven here with a
 * run set this file invents, where a hard-coded module constant cannot pass.
 *
 * All of it was reachable by a single edit that left every gate green, which is
 * the definition of an ungraded property.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const DRIVER = path.join(PROJECT_ROOT, 'scripts', 'check-determinism.mjs');

/**
 * A run set that shares no value with `RUNS`. That is the whole point: every
 * assertion below fails if the code reads the module's own table instead of
 * what it was handed.
 */
const FAKE_ONE: DeterminismRun = {
  id: 'P',
  outDir: '.determinism/unit-probe-one',
  zone: 'Antarctica/Troll',
  probe: 'probe-value-one',
  stamp: new Date('1994-02-11T03:04:05Z'),
};

const FAKE_TWO: DeterminismRun = {
  id: 'Q',
  outDir: '.determinism/unit-probe-two',
  zone: 'Asia/Kathmandu',
  probe: 'probe-value-two',
  stamp: new Date('2016-07-19T20:21:22Z'),
};

const FAKE: readonly DeterminismRun[] = [FAKE_ONE, FAKE_TWO];

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

  describe('every condition reaches the build it was written for', () => {
    it('composes the argument vector and the environment from the run given', () => {
      const invocation = buildInvocation(FAKE_TWO);

      expect(invocation.env['TZ'], 'TZ comes from the run').toBe(FAKE_TWO.zone);
      expect(
        invocation.env['VITE_DETERMINISM_PROBE'],
        'the VITE_ probe comes from the run',
      ).toBe(FAKE_TWO.probe);

      const outDirAt = invocation.argv.indexOf('--outDir');
      expect(outDirAt, '--outDir is passed').toBeGreaterThan(-1);
      expect(invocation.argv[outDirAt + 1], 'the output path comes from the run').toBe(
        FAKE_TWO.outDir,
      );
      expect(invocation.outDir.endsWith(FAKE_TWO.outDir.split('/').join(path.sep))).toBe(
        true,
      );

      // The negative half, and the one that catches a pinned row: none of the
      // shipping table's values may appear when the run given is not from it.
      const shipped = RUNS[0];
      expect(shipped).toBeDefined();
      if (shipped === undefined) {
        return;
      }
      expect(invocation.env['TZ']).not.toBe(shipped.zone);
      expect(invocation.env['VITE_DETERMINISM_PROBE']).not.toBe(shipped.probe);
      expect(invocation.argv).not.toContain(shipped.outDir);
    });

    it('hands the composed invocation to the child process', () => {
      // A composer nothing passes to the process is the same defect one layer
      // down, so the spawn is captured rather than assumed.
      const calls: { file: string; argv: string[]; options: Record<string, unknown> }[] =
        [];
      const outDir = build(FAKE_ONE, (file, argv, options) => {
        calls.push({ file, argv, options });
        return undefined;
      });

      expect(calls).toHaveLength(1);
      const only = calls[0];
      expect(only).toBeDefined();
      if (only === undefined) {
        return;
      }
      const expected = buildInvocation(FAKE_ONE);
      expect(only.argv).toEqual(expected.argv);
      const env = only.options['env'] as Record<string, string | undefined>;
      expect(env['TZ']).toBe(FAKE_ONE.zone);
      expect(env['VITE_DETERMINISM_PROBE']).toBe(FAKE_ONE.probe);
      expect(outDir).toBe(expected.outDir);
    });

    it('stamps every input file with the time it was handed', () => {
      const touched: { file: string; when: Date }[] = [];
      const count = stampAll(['one.ts', 'two.ts', 'three.ts'], FAKE_TWO.stamp, (
        file,
        atime,
        mtime,
      ) => {
        expect(atime).toBe(mtime);
        touched.push({ file, when: mtime });
      });

      expect(count).toBe(3);
      expect(touched.map((entry) => entry.file)).toEqual([
        'one.ts',
        'two.ts',
        'three.ts',
      ]);
      for (const entry of touched) {
        expect(entry.when.toISOString()).toBe(FAKE_TWO.stamp.toISOString());
      }
    });

    it('stamps once per run, with that run s own stamp, and records what it gave', () => {
      const stamps: string[] = [];
      const built: string[] = [];
      const outcome = performRuns({
        files: ['only.ts'],
        runs: FAKE,
        stamp: (files, when) => {
          expect(files).toEqual(['only.ts']);
          stamps.push(when.toISOString());
          return files.length;
        },
        run: (entry) => {
          built.push(entry.id);
          return entry.outDir;
        },
        read: () => new Map() as Tree,
      });

      // Once per run and in order, so a loop pinned to the first row shows up
      // as the same stamp twice rather than as two different ones.
      expect(stamps).toEqual([
        FAKE_ONE.stamp.toISOString(),
        FAKE_TWO.stamp.toISOString(),
      ]);
      expect(built).toEqual(['P', 'Q']);
      expect(outcome.buildError).toBeNull();
      expect(outcome.emitted).toHaveLength(2);

      expect(outcome.records.map((entry) => entry.id)).toEqual(['P', 'Q']);
      expect(outcome.records.map((entry) => entry.zone)).toEqual([
        FAKE_ONE.zone,
        FAKE_TWO.zone,
      ]);
      expect(outcome.records.map((entry) => entry.probe)).toEqual([
        FAKE_ONE.probe,
        FAKE_TWO.probe,
      ]);
      expect(outcome.records.map((entry) => entry.outDir)).toEqual([
        FAKE_ONE.outDir,
        FAKE_TWO.outDir,
      ]);
    });

    it('reports a build that did not complete rather than throwing', () => {
      const outcome = performRuns({
        files: [],
        runs: FAKE,
        stamp: () => 0,
        run: () => {
          throw new Error('vite exited 1');
        },
        read: () => new Map() as Tree,
      });
      expect(outcome.buildError).toBe('vite exited 1');
      expect(outcome.emitted).toHaveLength(0);
    });
  });

  describe('the report states what the builds were given', () => {
    const records: DeterminismRecord[] = [
      {
        id: 'P',
        stamp: FAKE_ONE.stamp,
        zone: FAKE_ONE.zone,
        probe: FAKE_ONE.probe,
        outDir: FAKE_ONE.outDir,
      },
      {
        id: 'Q',
        stamp: FAKE_TWO.stamp,
        zone: FAKE_TWO.zone,
        probe: FAKE_TWO.probe,
        outDir: FAKE_TWO.outDir,
      },
    ];

    it('builds every cell from the recorded values', () => {
      expect(conditionRows(records)).toEqual([
        ['Condition', 'Build P', 'Build Q'],
        ['---', '---', '---'],
        [
          'Every input file mtime',
          '1994-02-11T03:04:05.000Z',
          '2016-07-19T20:21:22.000Z',
        ],
        ['TZ', 'Antarctica/Troll', 'Asia/Kathmandu'],
        ['VITE_DETERMINISM_PROBE', 'probe-value-one', 'probe-value-two'],
        ['Output directory', '.determinism/unit-probe-one', '.determinism/unit-probe-two'],
      ]);
    });

    it('keeps the driver reading the record and not the table', () => {
      // READ AS SOURCE, DELIBERATELY. Which variable the report is built from
      // is the one property no run of a green tree can distinguish: on a tree
      // where every condition IS wired, the table and the record hold the same
      // values, so swapping them changes no byte of any output. The brittleness
      // is the price, and the failure is one line to read.
      const source = readFileSync(DRIVER, 'utf8');
      expect(source).toContain('...conditionRows(records).map(row)');
      expect(
        /RUNS\[/.test(source),
        'the report must not index the table for a value',
      ).toBe(false);
      expect(
        source.split('runs: RUNS').length - 1,
        'the shipping table is handed to the run loop exactly once',
      ).toBe(1);
    });
  });
});
