import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CELEBRATION_LIMIT,
  EMERGENT_KINDS,
  FLASH_LIMIT,
  REPORT_PATH,
  WINDOW_SECONDS,
  regionMaxima,
  regionsTouched,
  reportText,
  workloadRows,
  rollingMaximum,
  verdict,
} from '../../scripts/flash-rate.mjs';
import type { Measurement, Onset, Workload } from '../../scripts/flash-rate.mjs';
import { FLASHES_PER_WINDOW, FLASH_WINDOW_SECONDS } from '../../src/render/effects';

/**
 * Item G8's measurement, graded here rather than by running it.
 *
 * WHAT THE A ITEM ACTUALLY IS. The limiter is `src/render/effects.ts`'s and
 * `render-effects.test.ts` grades it; what G8 adds is a MEASUREMENT of the
 * shipped one across a soak and a scripted worst case, compared against a
 * literal threshold and run in CI. A measurement can be wrong in two ways that
 * a green run looks exactly like: it can read the wrong thing, and it can read
 * nothing at all. Both are graded below, over the script's own pure functions.
 *
 * THE THRESHOLD IS COMPARED, NOT SHARED. The script states 3 as a literal of its
 * own and the effects layer states its own `FLASHES_PER_WINDOW`; this file is
 * where the two meet. A gate that imported its threshold from the module it
 * grades would agree with that module whatever it became.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

function onset(run: number, region: number, at: number): Onset {
  return { run, region, at };
}

function workload(name: string, over: Partial<Workload> = {}): Workload {
  return {
    name,
    frames: 1000,
    seconds: 16.6,
    events: 40,
    refusals: 5,
    onsets: [onset(0, 3, 0), onset(0, 3, 0.4), onset(0, 7, 0.5)],
    celebrations: [],
    ...over,
  };
}

function measurement(workloads: Workload[]): Measurement {
  return {
    at: Date.UTC(2026, 8, 15),
    limiter: { perWindow: FLASHES_PER_WINDOW, window: FLASH_WINDOW_SECONDS },
    workloads,
    refused: workloads.reduce((total, entry) => total + entry.refusals, 0),
  };
}

describe('PF-15 the flash-rate measurement, item G8', () => {
  it('states the same threshold the effects layer enforces', () => {
    // QUALITY-BAR section 4, SC 2.3.1, on both sides of the comparison.
    expect(FLASH_LIMIT).toBe(3);
    expect(WINDOW_SECONDS).toBe(1);
    expect(FLASHES_PER_WINDOW).toBe(FLASH_LIMIT);
    expect(FLASH_WINDOW_SECONDS).toBe(WINDOW_SECONDS);
    // And the two kinds of onset it tells apart, which is the distinction
    // QUALITY-BAR section 4 draws between emergent and authored flashes.
    expect([...EMERGENT_KINDS].sort()).toEqual(['impact', 'wall']);
    expect(CELEBRATION_LIMIT).toBe(1);
    // ACCEPTANCE section 5 homes a `report/` artifact under artifacts/reports/.
    expect(REPORT_PATH).toBe('artifacts/reports/flash-rate.md');
  });

  it('counts the most onsets in any ROLLING second, not in a bucket', () => {
    // The difference the criterion turns on. Four onsets at 0.9, 1.0, 1.1 and
    // 1.2 fall in two different per-second buckets and are all inside one
    // rolling second; a bucket count reads 3 and passes, this reads 4.
    expect(rollingMaximum([0.9, 1.0, 1.1, 1.2])).toBe(4);
    expect(rollingMaximum([0, 0.5, 1, 1.5, 2])).toBe(3);
    // The window is CLOSED, the same reading the limiter prunes with: onsets
    // exactly a second apart are both inside "any one second period".
    expect(rollingMaximum([0, 1])).toBe(2);
    expect(rollingMaximum([0, 1.0001])).toBe(1);
    // Order is not assumed, because a log is appended to by several passes in
    // one frame and two of them can carry the same stamp.
    expect(rollingMaximum([1.2, 0.9, 1.1, 1.0])).toBe(4);
    expect(rollingMaximum([])).toBe(0);
    expect(rollingMaximum([5])).toBe(1);
  });

  it('keeps the seconds of one run out of the seconds of another', () => {
    // MEASURED, AND IT CHANGED THE ANSWER. Each driven match builds its own
    // effects layer whose clock starts at zero, so a flash five seconds into
    // one match and a flash five seconds into the next carry times a tenth of a
    // second apart on paper. Grouping by region alone read four in a second on
    // a soak whose every match was inside the limit.
    const across = [
      onset(0, 5, 5.0),
      onset(0, 5, 5.1),
      onset(0, 5, 5.2),
      onset(1, 5, 5.3),
      onset(1, 5, 5.4),
    ];
    expect(Math.max(...regionMaxima(across).values())).toBe(3);
    // The same five onsets in ONE run really are five in a second.
    const together = across.map((entry) => onset(0, entry.region, entry.at));
    expect(Math.max(...regionMaxima(together).values())).toBe(5);
    // And the region count is still a count of REGIONS, which the run key would
    // otherwise inflate to one per run and region.
    expect(regionsTouched(across)).toBe(1);
    expect(regionsTouched([onset(0, 1, 0), onset(1, 2, 0), onset(1, 2, 1)])).toBe(2);
  });

  it('separates the regions the grid divides the pitch into', () => {
    const spread = [onset(0, 1, 0), onset(0, 1, 0.1), onset(0, 2, 0.2), onset(0, 2, 0.3)];
    expect([...regionMaxima(spread).values()].sort()).toEqual([2, 2]);
    expect(regionsTouched(spread)).toBe(2);
  });

  it('passes a run inside the limit, and says what it measured', () => {
    const decision = verdict(measurement([workload('soak'), workload('worst case')]));
    expect(decision.status).toBe(0);
    expect(decision.problems).toEqual([]);
    expect(decision.worst).toBe(2);
    expect(decision.lines).toHaveLength(2);
    for (const line of decision.lines) {
      expect(line).toContain('frames');
      expect(line).toContain('simulated seconds');
      expect(line).toContain('worst rolling second');
    }
  });

  it('fails a run that drew a fourth flash in one region in one second', () => {
    // THE CONTROL FOR THE THRESHOLD. Four onsets, one region, one run, inside a
    // second: the gate has to refuse it, or it is not a gate.
    const busy = workload('soak', {
      onsets: [onset(0, 4, 0), onset(0, 4, 0.2), onset(0, 4, 0.4), onset(0, 4, 0.6)],
    });
    const decision = verdict(measurement([busy]));
    expect(decision.status).toBe(1);
    expect(decision.worst).toBe(4);
    expect(decision.problems.join('\n')).toContain('4 flashes in one region in one second');
  });

  it('fails a run that measured nothing at all, which is the house trap', () => {
    // A perf gate that passed at zero rounds played is on the record in the
    // briefing notes. Each of these is a fact about the RUN, and each of them
    // on its own turns a pass into a failure.
    const empty = [
      ['drove no frames at all', workload('soak', { frames: 0, seconds: 0 })],
      ['derived no flashes to measure', workload('soak', { events: 0, onsets: [] })],
    ] as const;
    for (const [reason, entry] of empty) {
      const decision = verdict(measurement([entry]));
      expect(decision.status, reason).toBe(1);
      expect(decision.problems.join('\n'), reason).toContain(reason);
    }
    // And a run where the limiter refused nothing tested nothing: the scripted
    // worst case exists precisely to make it refuse.
    const quiet = verdict(measurement([workload('soak', { refusals: 0 })]));
    expect(quiet.status).toBe(1);
    expect(quiet.problems.join('\n')).toContain('the limiter refused nothing');
    // As does one that never left a single region, so the grid went untested.
    // MEASURED PER WORKLOAD AND NOT OVER THE SUM: a total across two workloads
    // is at least two whenever both ran, so a summed guard could not fire on any
    // real measurement. The cornered workload below sits BESIDE a healthy one,
    // which is the shape the script actually builds.
    const cornered = verdict(
      measurement([
        workload('soak', { onsets: [onset(0, 9, 0), onset(0, 9, 0.5)] }),
        workload('worst case'),
      ]),
    );
    expect(cornered.status).toBe(1);
    expect(cornered.problems.join('\n')).toContain('soak left every flash in one region');
    // And the healthy workload beside it is not accused of the same thing.
    expect(cornered.problems.join('\n')).not.toContain('worst case left every flash');
  });

  it('bounds the authored celebration on its own rather than on the limiter', () => {
    // SPEC section 14's goal celebration is authored rather than emergent, so
    // the per-region limiter does not govern it; SPEC section 6.4's 1.2 second
    // hold is what bounds it, and this is where that bound is checked.
    const party = workload('soak', {
      celebrations: [onset(0, 2, 0), onset(0, 2, 0.5)],
    });
    const decision = verdict(measurement([party]));
    expect(decision.status).toBe(1);
    expect(decision.problems.join('\n')).toContain('goal celebrations in one region');
    // One per second is the bound, and one is what a 1.2 second hold allows.
    const legal = workload('soak', { celebrations: [onset(0, 2, 0), onset(0, 2, 1.3)] });
    expect(verdict(measurement([legal])).status).toBe(0);
    // A celebration never moves the gate's own number, which is the emergent one.
    expect(verdict(measurement([legal])).worst).toBe(2);
    // BUT THE COMBINED NUMBER IS STILL TAKEN AND STILL SHOWN. Splitting the two
    // populations is a reading of the criterion, and a reading that also stopped
    // measuring would be a reading nobody can check. The default workload puts
    // two emergent onsets in region 3 within half a second; a celebration in the
    // same region inside that second makes the combined reading three.
    const shared = workload('soak', { celebrations: [onset(0, 3, 0.2)] });
    expect(verdict(measurement([shared])).lines.join('\n')).toContain('both kinds together 3');
    expect(
      workloadRows(shared).find(([label]) => label === 'worst rolling second, both kinds')?.[1],
    ).toBe('3');
    // And it is a reading of the same rolling window, not a sum of two maxima:
    // a celebration in a DIFFERENT region leaves the combined maximum at two.
    const apart = workload('soak', { celebrations: [onset(0, 9, 0.2)] });
    expect(verdict(measurement([apart])).lines.join('\n')).toContain('both kinds together 2');
  });

  it('fails a run whose two populations TOGETHER pass the limit', () => {
    // THE GATEKEEPER'S RULING OF 2026-09-18, and the control for it. QUALITY-BAR
    // section 4's first sentence has "nothing" for its subject; the sentence
    // after it assigns the per-region limiter to the flashes a simulation makes
    // and does not scope the rule above it. So three emergent flashes and a
    // celebration in one region in one second is four, and the gate refuses it
    // even though neither population passes its own bound.
    // The fourth onset is in another region so the grid guard is not what
    // fails this: what fails it is the four in region six.
    const mixed = workload('soak', {
      onsets: [onset(0, 6, 0), onset(0, 6, 0.2), onset(0, 6, 0.4), onset(0, 9, 0.8)],
      celebrations: [onset(0, 6, 0.6)],
    });
    const decision = verdict(measurement([mixed]));
    expect(decision.status).toBe(1);
    expect(decision.problems.join('\n')).toContain(
      '4 flashes of both kinds in one region in one second',
    );
    // Neither population is over on its own, which is what makes this the
    // combined reading and not a second copy of the two above.
    expect(decision.problems.join('\n')).not.toContain('4 flashes in one region');
    expect(decision.problems.join('\n')).not.toContain('goal celebrations in one region');
    // And the same four spread across two regions is not a breach of anything.
    const apart = workload('soak', {
      onsets: [onset(0, 6, 0), onset(0, 6, 0.2), onset(0, 6, 0.4), onset(0, 9, 0.8)],
      celebrations: [onset(0, 7, 0.6)],
    });
    expect(verdict(measurement([apart])).status).toBe(0);
  });

  it('writes a report a reader can check the run from', () => {
    const decision = verdict(measurement([workload('soak'), workload('worst case')]));
    const text = reportText(measurement([workload('soak'), workload('worst case')]), decision);
    expect(text).toContain('# Flash rate, item G8');
    expect(text).toContain('Verdict: PASS');
    expect(text).toContain('worst rolling second');
    expect(text).toContain(`limit of ${String(FLASH_LIMIT)}`);
    // The limiter it measured, read back rather than assumed.
    expect(text).toContain(`Limiter in force: ${String(FLASHES_PER_WINDOW)} per`);
    // Both workloads, each as its own table of readings, so the report is the
    // evidence rather than a verdict a reader has to take. The rows are short
    // because the workspace document gate wraps prose at 110 columns and this
    // file is markdown like any other; the console keeps the one-line form.
    expect(text).toContain('### soak');
    expect(text).toContain('### worst case');
    expect(text).toContain('| simulated seconds | 16.60 |');
    expect(text).toContain('| frames driven | 1000 |');
    expect(text).toContain('| worst rolling second, emergent | 2 |');
    for (const line of text.split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(110);
    }
    // And a failing run says why, in the file as well as on the console.
    const burst = [onset(0, 4, 0), onset(0, 4, 0.1), onset(0, 4, 0.2), onset(0, 4, 0.3)];
    const bad = verdict(measurement([workload('soak', { onsets: burst })]));
    const failing = reportText(measurement([workload('soak')]), bad);
    expect(failing).toContain('Verdict: FAIL');
    expect(failing).toContain('Problems:');
  });

  it('runs in CI, as a step of the gates job', () => {
    // An A item is measured IN CI or it is measured by whoever remembers. The
    // workflow shape is graded in `workflow-shape.test.ts`; this is the tie
    // between the script's own name and the command that runs it.
    const workflow = readFileSync(
      path.join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    expect(workflow).toContain('node scripts/flash-rate.mjs');
    expect(workflow).toContain('- name: Flash rate, item G8');
    // AND THE ARTIFACT SURVIVES THE RUN. `artifacts/` is git-ignored, so a
    // measurement whose report existed only in the runner's working directory
    // would leave item G8's named evidence unreadable the moment the job ended.
    // Uploaded on `always()`, because a failing measurement is the one a reader
    // most needs the numbers from.
    expect(workflow).toContain('- name: Upload the flash-rate report');
    expect(workflow).toContain(`path: ${REPORT_PATH}`);
    expect(workflow).toContain('name: flash-rate-report');
  });
});
