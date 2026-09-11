import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The shape of the gates that decide a merge: the workflow, the dependency
 * policy, the install policy, and the harness's own rule for reading a
 * detector. None of the four is game behaviour and none of them can be graded
 * by running the game, which is what puts them in one file.
 *
 * WHY SOURCE ASSERTIONS OVER YAML. No unit test can run a workflow, and the
 * properties below are exactly the kind that report green while doing nothing:
 * a concurrency rule that cancels the runs it exists to preserve, a second
 * checkout of a different tree, a step with no budget of its own inside a job
 * that has one. Each was true on this repository and each was invisible until
 * somebody read the run list. This file is the same answer
 * `browser-gate.test.ts` gives for the browser suite, and it carries the same
 * price: it reads text, a reflow breaks it, and the break is loud and one line
 * to fix. Every matcher below is applied to a string that must NOT match, so a
 * matcher that has stopped matching anything is caught here rather than in six
 * months.
 *
 * AND THE SHAPE UNDER THE PROPERTIES, because each of these can be deleted on
 * its own and leave the file green while the gate stops deciding anything: the
 * push trigger the cancellation rule exists to serve, the two Node pins and
 * whether the manifest says they are supported, the two job display names
 * against the ruleset's required contexts, the ordering edge between the jobs,
 * and the presence of every step a merge waits on.
 *
 * THE LAST GROUP IS NOT A SOURCE ASSERTION. The harness's verdict functions and
 * its tree guard are pure and are driven directly. They are here because they
 * answer the same question everything above does: whether a gate that reports a
 * verdict actually reached one.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

function read(relative: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
}

const WORKFLOW = read('.github/workflows/ci.yml');
const DEPENDABOT = read('.github/dependabot.yml');
const NPMRC = read('.npmrc');

/**
 * The harness, loaded through a computed URL.
 *
 * `scripts/mutation-check.mjs` is the one gate script with no hand-written
 * declaration file beside it, so a static import would not type check. The
 * shape below is asserted against the module's own export list in the first
 * test in this file, which is the same protection `declarations.test.ts` gives
 * the five modules that do have declarations.
 */
interface DetectorOutcome {
  passed: boolean;
  killed: boolean;
  output: string;
}

interface TreeChange {
  path: string;
  was: string | null;
  now: string | null;
}

interface Incident {
  entry: string;
  attempt: number;
  paths: string[];
  failed: string[];
  /** Whether the entry is measured again, which the incident line has to say. */
  rerun?: boolean;
}

interface Harness {
  detectorOutcome(
    error: unknown,
    stdout?: string,
    stderr?: string,
  ): DetectorOutcome;
  entryVerdict(outcome: DetectorOutcome): string;
  sweepSummary(input: {
    total: number;
    ran: number;
    missed: number;
    stoppedAt?: string | null;
    stopReason?: string;
    incidents?: Incident[];
    finalDrift?: string[];
  }): { status: number; lines: string[] };
  treeDrift(
    before: Map<string, string>,
    after: Map<string, string>,
  ): TreeChange[];
  restorePlan(
    drift: TreeChange[],
    known: Map<string, unknown>,
  ): { restore: string[]; remove: string[] };
  driftVerdict(input: {
    paths?: string[];
    failed?: string[];
    attempt?: number;
  }): { stop: string | null; rerun: boolean };
  incidentLines(incident: Incident): string[];
  filesUnder(root: string, skip?: Set<string>): string[];
  treeListing(root?: string, skip?: Set<string>): Map<string, string>;
}

const harness = (await import(
  new URL('../../scripts/mutation-check.mjs', import.meta.url).href
)) as Harness;

/**
 * The two required status check contexts, read from the ruleset rather than
 * repeated here. They are the reason the job display names below are not free
 * text: GitHub matches a required check by its context string, so a job renamed
 * on one side of this pair and not the other leaves `main` waiting forever on a
 * check nothing will ever report, which reads as pending rather than as failed.
 */
interface Ruleset {
  rules: {
    type: string;
    parameters?: { required_status_checks?: { context: string }[] };
  }[];
}

function requiredContexts(): string[] {
  const ruleset = JSON.parse(read('.github/rulesets/protect-main.json')) as Ruleset;
  const checks = ruleset.rules.find(
    (rule) => rule.type === 'required_status_checks',
  );
  return (checks?.parameters?.required_status_checks ?? []).map(
    (check) => check.context,
  );
}

/** Every job display name the workflow declares, in file order. */
function jobNames(source: string): string[] {
  return [...source.matchAll(/^ {4}name: (.+)$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  );
}

/**
 * Does `version` satisfy `range`? Enough of a range evaluator for the two forms
 * this repository declares, written here rather than pulled in: the property is
 * that the pinned runtime is one the manifest says it supports, and a
 * dependency that decided that question would be one more thing to trust.
 */
function triple(text: string): [number, number, number] {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());
  return [
    Number(match?.[1] ?? '0'),
    Number(match?.[2] ?? '0'),
    Number(match?.[3] ?? '0'),
  ];
}

export function satisfiesRange(version: string, range: string): boolean {
  const [major, minor, patch] = triple(version);
  function atLeast(target: [number, number, number]): boolean {
    if (major !== target[0]) {
      return major > target[0];
    }
    if (minor !== target[1]) {
      return minor > target[1];
    }
    return patch >= target[2];
  }
  return range.split('||').some((clause) => {
    const text = clause.trim();
    if (text.startsWith('^')) {
      const target = triple(text.slice(1));
      return major === target[0] && atLeast(target);
    }
    if (text.startsWith('>=')) {
      return atLeast(triple(text.slice(2)));
    }
    return false;
  });
}

describe('the workflow keeps every commit on the default branch a completed run', () => {
  it('gives a push a concurrency group of its own, per commit', () => {
    // The exact text, because the value is the whole property. Two forms have
    // now been wrong here. The unconditional `cancel-in-progress: true`
    // cancelled three of four pushes to the default branch in one day. An
    // expression that only turned cancellation OFF there was not enough
    // either: inside one group a run that arrives while another is in progress
    // becomes pending, and the next arrival cancels the pending one whatever
    // the flag says, so the middle commit of a burst of three still ends with
    // no conclusion. Keying the group on the commit is what leaves nothing for
    // a default-branch run to contend with.
    expect(WORKFLOW).toContain(
      "group: ${{ github.workflow }}-${{ github.ref }}-" +
        "${{ github.event_name == 'push' && github.sha || '' }}",
    );
    expect(WORKFLOW).toContain("cancel-in-progress: ${{ github.event_name != 'push' }}");

    // The controls, one per form that was wrong, each applied to a string that
    // DOES match so a matcher that has stopped matching is caught here.
    const SHARED = /^\s*group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*$/m;
    expect(SHARED.test(WORKFLOW)).toBe(false);
    expect(SHARED.test('  group: ${{ github.workflow }}-${{ github.ref }}\n')).toBe(true);
    expect(/cancel-in-progress:\s*true/.test(WORKFLOW)).toBe(false);
    expect(/cancel-in-progress:\s*true/.test('  cancel-in-progress: true\n')).toBe(true);

    // And a pull request still supersedes itself: the group it lands in is the
    // shared one, because the commit half of the expression is empty off a
    // push, and cancellation is on for every event that is not a push.
    expect(WORKFLOW).toContain("github.event_name == 'push' && github.sha || ''");
  });

  it('runs on a push to the default branch at all', () => {
    // The trigger the exemption above exists to serve. Without it the whole
    // property is theatre: there is no default-branch run to preserve, GITHUB
    // section 7's squash gap stays open, and every assertion in this file about
    // cancellation still passes.
    expect(/^on:\n {2}push:\n {4}branches: \[main\]$/m.test(WORKFLOW)).toBe(true);
    // The control, on a workflow that triggers on pull requests alone.
    expect(
      /^on:\n {2}push:\n {4}branches: \[main\]$/m.test('on:\n  pull_request:\n'),
    ).toBe(false);
  });

  it('names its two jobs exactly what the ruleset requires', () => {
    const contexts = requiredContexts();
    expect(contexts, 'the ruleset lists its required checks').toEqual([
      'Repository policy',
      'Pocket Football gates',
    ]);
    // Character for character, and in no particular order: a job renamed here
    // without the ruleset leaves `main` protected by a context nothing reports.
    expect([...jobNames(WORKFLOW)].sort()).toEqual([...contexts].sort());
    // The control: the reader finds job names rather than the workflow's own.
    expect(jobNames(WORKFLOW)).toHaveLength(2);
    expect(jobNames('name: CI\njobs:\n  a:\n    name: One\n  b:\n    name: Two\n')).toEqual(
      ['One', 'Two'],
    );
  });

  it('makes the gates job wait for the policy job', () => {
    // The cheap check runs first on purpose: a banned name in the record fails
    // before a five minute install rather than after it. Dropped, both jobs
    // start together and the ordering the comment claims is fiction.
    expect(/^ {4}needs: repository-policy$/m.test(WORKFLOW)).toBe(true);
    expect(/^ {4}needs: repository-policy$/m.test('    needs: something-else\n')).toBe(
      false,
    );
  });

  it('still runs every gate the merge is supposed to depend on', () => {
    // Each of these can be deleted on its own and leave a green workflow that
    // no longer decides anything. The run command is matched to end of line,
    // because `npm run test` is a prefix of `npm run test:browser` and a
    // careless matcher reads the browser step as the unit one.
    for (const [step, command] of [
      ['Branches, commits, identities and file content', 'node scripts/check-repository-record.mjs'],
      ['Type check', 'npm run typecheck'],
      ['Lint, including the core boundary', 'npm run lint'],
      ['Unit and headless tests', 'npm run test'],
      ['Browser tests', 'npm run test:browser'],
      ['Deterministic build', 'npm run verify:build'],
    ] as const) {
      expect(WORKFLOW, step).toContain(`- name: ${step}`);
      const runs = new RegExp(`^\\s*run: ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
      expect(runs.test(WORKFLOW), `${step} runs ${command}`).toBe(true);
      // The control, per step: the matcher is one that can miss.
      expect(runs.test('      - name: Elsewhere\n        run: npm run something\n')).toBe(
        false,
      );
    }
  });

  it('pins one runtime in both jobs, and one the manifest supports', () => {
    const pins = [...WORKFLOW.matchAll(/^\s*node-version: (\S+)$/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(pins, 'both jobs pin a Node version').toHaveLength(2);
    // ONE runtime, not two. The two jobs judge one tree and install from one
    // lockfile; a policy job on one major and a gates job on another is two
    // answers to the question the manifest asks once.
    expect(new Set(pins).size, `pins: ${pins.join(', ')}`).toBe(1);

    const declared = (
      JSON.parse(read('package.json')) as { engines?: { node?: string } }
    ).engines?.node;
    expect(declared).toBeDefined();
    for (const pin of pins) {
      expect(
        satisfiesRange(pin, declared ?? ''),
        `${pin} against engines.node ${declared ?? ''}`,
      ).toBe(true);
    }
    // The evaluator, on answers known by hand, so a checker that said yes to
    // everything could not carry the assertion above.
    expect(satisfiesRange('18.20.0', declared ?? '')).toBe(false);
    expect(satisfiesRange('22.0.0', declared ?? '')).toBe(false);
    expect(satisfiesRange('20.19.0', declared ?? '')).toBe(true);
  });

  it('checks out one tree in both jobs', () => {
    // A `ref:` override on the policy job made it judge the pull request head
    // while the gates job built the merge result, so the two required checks
    // could report on two different trees.
    expect(/^\s*ref:/m.test(WORKFLOW)).toBe(false);
    expect(/^\s*ref:/m.test('        with:\n          ref: abc\n')).toBe(true);
    // And the full ancestry is still fetched, which is what the record walk
    // needs and what the gate now refuses to run without.
    expect(WORKFLOW).toContain('fetch-depth: 0');
  });

  it('gives the browser phase its own budget inside the job cap', () => {
    const step = /- name: Browser tests\n\s*timeout-minutes: (\d+)\n/.exec(WORKFLOW);
    expect(step, 'the browser step declares a timeout').not.toBeNull();
    expect(Number(step?.[1])).toBe(25);

    // The job cap stays where it is, and stays above the step: a step budget
    // equal to the job's would report the same killed job it was added to
    // prevent.
    const job = /timeout-minutes: 30/.exec(WORKFLOW);
    expect(job, 'the gates job keeps its 30 minute cap').not.toBeNull();
    expect(Number(step?.[1])).toBeLessThan(30);
  });
});

describe('a dependency update arrives in a shape that can be merged', () => {
  it('keeps majors out of the grouped pull request', () => {
    // Without this the group carries `patterns: ['*']` and nothing else, so a
    // major that raises the runtime floor above the pinned one rides in with
    // two ordinary patches and its gate reports green.
    const group = /toolchain:\n(?:.*\n)*?\s*update-types:\n\s*- minor\n\s*- patch\n/.exec(
      DEPENDABOT,
    );
    expect(group, 'the toolchain group is limited to minor and patch').not.toBeNull();
    expect(DEPENDABOT).toContain("- '*'");
    // The compiler exception stays exactly as it was: a major there is a
    // migration and is taken on its own.
    expect(DEPENDABOT).toContain('- dependency-name: typescript');
    expect(DEPENDABOT).toContain("update-types: ['version-update:semver-major']");
  });

  it('refuses to install on a runtime the toolchain does not support', () => {
    expect(/^engine-strict=true$/m.test(NPMRC)).toBe(true);
    expect(/^engine-strict=true$/m.test('save-exact=true\n')).toBe(false);

    // THE DECLARED RANGE IS THE ONE THE LOCKFILE SUPPORTS, and under
    // engine-strict that sentence has teeth: what package.json says is now the
    // difference between an install and a refusal. Evaluating all 117
    // engines.node ranges in the committed lockfile leaves nothing unsatisfied
    // on 20.19.0, 22.13.0 and 24.12.0, and 28, 31, 27, 10 and 11 unsatisfied on
    // 20.18.0, 21.7.3, 22.0.0, 22.12.0 and 23.11.0. A bare floor of ">=20.19.0"
    // therefore promised four windows it could not honour, and a contributor
    // inside one of them met a hard refusal from a file that said their runtime
    // was supported.
    const manifest = JSON.parse(read('package.json')) as {
      engines?: { node?: string };
    };
    expect(manifest.engines?.node).toBe('^20.19.0 || ^22.13.0 || >=24');
  });
});

describe('the harness can tell a failed assertion from a killed process', () => {
  it('exposes the three functions this file drives', () => {
    for (const name of ['detectorOutcome', 'entryVerdict', 'sweepSummary'] as const) {
      expect(typeof harness[name], name).toBe('function');
    }
  });

  it('reads no error as a pass', () => {
    expect(harness.detectorOutcome(null)).toEqual({
      passed: true,
      killed: false,
      output: '',
    });
  });

  it('reads a non-zero exit as a failure, which is a detection', () => {
    const outcome = harness.detectorOutcome({ status: 1, signal: null }, 'out', 'err');
    expect(outcome.passed).toBe(false);
    expect(outcome.killed).toBe(false);
    expect(outcome.output).toBe('outerr');
  });

  it('reads a deadline kill as neither', () => {
    // The one that mattered. Both of these arrive as a non-zero exit and used
    // to be recorded as "the mutation was detected", which reports a gate as
    // working on the strength of a run that never finished.
    expect(
      harness.detectorOutcome({ killed: true, signal: 'SIGTERM' }, '', ''),
    ).toMatchObject({ passed: false, killed: true });
    // Each half of the test on its own, so neither clause can be removed while
    // the other carries the case: the runner sets both fields, a kill from
    // outside sets only the signal, and a platform that reports only the flag
    // is still a kill.
    expect(
      harness.detectorOutcome({ killed: true, signal: null }, '', ''),
    ).toMatchObject({ passed: false, killed: true });
    expect(harness.detectorOutcome({ signal: 'SIGKILL' }, '', '')).toMatchObject({
      passed: false,
      killed: true,
    });
  });

  it('turns the three outcomes into the three verdicts', () => {
    expect(
      harness.entryVerdict({ passed: false, killed: false, output: '' }),
    ).toBe('detected');
    expect(harness.entryVerdict({ passed: true, killed: false, output: '' })).toBe(
      'missed',
    );
    expect(harness.entryVerdict({ passed: false, killed: true, output: '' })).toBe(
      'error',
    );
  });

  it('exposes the tree guard this file drives too', () => {
    for (const name of [
      'treeDrift',
      'restorePlan',
      'driftVerdict',
      'incidentLines',
      'filesUnder',
      'treeListing',
    ] as const) {
      expect(typeof harness[name], name).toBe('function');
    }
  });

  it('names every path two listings disagree about, and the direction', () => {
    const before = new Map([
      ['src/core/config.ts', 'aaa'],
      ['src/render/effects.ts', 'bbb'],
      ['README.md', 'ccc'],
    ]);
    const after = new Map([
      ['src/core/config.ts', 'aaa'],
      ['src/render/effects.ts', 'STUB'],
      ['src/core/probe.ts', 'ddd'],
    ]);
    expect(harness.treeDrift(before, after)).toEqual([
      { path: 'README.md', was: 'ccc', now: null },
      { path: 'src/core/probe.ts', was: null, now: 'ddd' },
      { path: 'src/render/effects.ts', was: 'bbb', now: 'STUB' },
    ]);
    // Clean is empty, which is the answer 616 of 617 entries get and the one a
    // guard that compared nothing would also give.
    expect(harness.treeDrift(before, before)).toEqual([]);
  });

  it('puts a recorded path back and takes an unrecorded one away', () => {
    const drift = harness.treeDrift(
      new Map([['kept.ts', 'one']]),
      new Map([
        ['kept.ts', 'two'],
        ['appeared.ts', 'three'],
      ]),
    );
    expect(harness.restorePlan(drift, new Map([['kept.ts', 'bytes']]))).toEqual({
      restore: ['kept.ts'],
      remove: ['appeared.ts'],
    });
  });

  it('repairs a drift once, and stops on the second or on a path it cannot fix', () => {
    // Clean: nothing happened, nothing to do, and the entry keeps its verdict.
    expect(harness.driftVerdict({ paths: [], failed: [], attempt: 1 })).toEqual({
      stop: null,
      rerun: false,
    });

    // Drifted and restorable: the verdict just taken is void, because the tree
    // it was taken against is not the tree the sweep started on. Repair and
    // measure the entry again rather than stop, because a five hour sweep
    // should not end on one transient write failure.
    expect(harness.driftVerdict({ paths: ['src/render/capture.ts'], attempt: 1 })).toEqual(
      { stop: null, rerun: true },
    );

    // The second drift on the same entry is a machine that is not settling.
    const twice = harness.driftVerdict({ paths: ['src/render/capture.ts'], attempt: 2 });
    expect(twice.rerun).toBe(false);
    expect(twice.stop).toContain('twice');

    // And a path the repair could not put back is the case where carrying on
    // measures every remaining entry against a tree nobody can describe.
    const unrestorable = harness.driftVerdict({
      paths: ['src/render/capture.ts'],
      failed: ['src/render/capture.ts'],
      attempt: 1,
    });
    expect(unrestorable.rerun).toBe(false);
    expect(unrestorable.stop).toContain('could not be put back');
    expect(unrestorable.stop).toContain('src/render/capture.ts');
  });

  it('says which entry the tree moved under, and what became of the paths', () => {
    const restored = harness.incidentLines({
      entry: 'the entry that was running',
      attempt: 1,
      paths: ['src/render/capture.ts'],
      failed: [],
    }).join('\n');
    expect(restored).toContain('INCIDENT');
    expect(restored).toContain('the entry that was running');
    expect(restored).toContain('src/render/capture.ts');
    expect(restored).toContain('measured');

    const lost = harness.incidentLines({
      entry: 'the entry that was running',
      attempt: 2,
      paths: ['src/render/capture.ts'],
      failed: ['src/render/capture.ts'],
    }).join('\n');
    expect(lost).toContain('NOT RESTORED');
    expect(lost).not.toContain('measured');

    // And the incident that was repaired but is the last attempt: it says the
    // sweep stops rather than promising a measurement that will not happen.
    const settled = harness.incidentLines({
      entry: 'the entry that was running',
      attempt: 2,
      paths: ['src/render/capture.ts'],
      failed: [],
      rerun: false,
    }).join('\n');
    expect(settled).toContain('twice');
    expect(settled).toContain('stops here');
    expect(settled).not.toContain('measured again');
  });

  it('walks the tree it owns and skips the output it does not', () => {
    // The listing is the guard's whole input, so a walk that stopped reading
    // would report a clean tree forever. Two facts about the real one: it
    // reaches the files a mutation edits, and it does not reach the build
    // output every detector rewrites.
    const listing = harness.treeListing();
    expect(listing.size).toBeGreaterThan(150);
    expect([...listing.keys()]).toContain('src/core/physics.ts');
    expect([...listing.keys()]).toContain('scripts/mutation-check.mjs');
    for (const skipped of ['node_modules', 'dist/', '.git/', 'test-results']) {
      expect(
        [...listing.keys()].filter((name) => name.startsWith(skipped)),
        skipped,
      ).toEqual([]);
    }
    // Hashed, not stat-ed: the same file read twice is the same digest, and the
    // digest is what makes a rewritten file visible at all.
    expect(harness.treeDrift(listing, harness.treeListing())).toEqual([]);
  });

  it('wires the guard into the sweep, and not only into this file', () => {
    // READ AS SOURCE, for the same reason the record gate's shallow-flag order
    // is: the four functions above are pure and say nothing about whether the
    // sweep calls them. The only other way to ask is to run a five hour sweep
    // with a fault injected into it, which is the probe rather than the test.
    const source = read('scripts/mutation-check.mjs');
    // The file is its own mutation target, so every string below is read out
    // of the FUNCTION that has to carry it rather than out of the whole file:
    // an entry's own `find` literal would otherwise answer for the code it was
    // written to break.
    const measure = source.indexOf('function measureEntry(');
    const sweep = source.indexOf('export function main(');
    expect(measure, 'the per-entry guard exists').toBeGreaterThan(-1);
    expect(sweep, 'the sweep exists').toBeGreaterThan(measure);
    const guard = source.slice(measure, sweep);
    const main = source.slice(sweep);

    // One: the tree is recorded, once, after the baseline detectors are green,
    // so whatever those runs wrote is part of the tree entries are judged
    // against rather than the first entry's drift.
    expect(main).toContain(
      'const baseline = { bytes: snapshotBytes(), listing: treeListing() };',
    );

    // Two: the comparison happens inside the per-entry guard, AFTER the
    // mutation ran and its file was restored.
    expect(guard).toContain('treeDrift(baseline.listing, treeListing())');
    expect(
      guard.indexOf('treeDrift('),
      'the tree is compared after the entry has run',
    ).toBeGreaterThan(guard.indexOf('runAddition(entry)'));

    // Three: the sweep runs entries through the guard rather than around it,
    // and the closing comparison reaches the summary.
    expect(main).toContain('measureEntry(entry, baseline, incidents)');
    expect(main).toContain(
      'finalDrift: treeDrift(baseline.listing, treeListing()).map(',
    );

    // The control: these are matchers that can miss.
    expect('const drift = [];').not.toContain('treeDrift(');
  });

  it('says in the summary that a stopped sweep is not a passed one', () => {
    const clean = harness.sweepSummary({ total: 3, ran: 3, missed: 0 });
    expect(clean.status).toBe(0);
    expect(clean.lines.join('\n')).toContain('every entry detected');

    const uncaught = harness.sweepSummary({ total: 3, ran: 3, missed: 1 });
    expect(uncaught.status).toBe(1);
    expect(uncaught.lines.join('\n')).toContain('decorative');

    const stopped = harness.sweepSummary({
      total: 3,
      ran: 1,
      missed: 0,
      stoppedAt: 'the entry that hung',
    });
    expect(stopped.status).toBe(1);
    const said = stopped.lines.join('\n');
    // Named, counted and explained: which entry, how far it got, and why the
    // remaining entries have no verdict at all.
    expect(said).toContain('the entry that hung');
    expect(said).toContain('1 of 3 entries run');
    expect(said).toContain('killed detector is not a detection');
    expect(said).not.toContain('every entry detected');
  });

  it('prints the incidents and the closing tree comparison in the summary', () => {
    // A sweep that repaired the tree three times measured three entries twice
    // and everything else once. A reader who is told "PASS" and nothing else
    // has been told the smaller half of what happened.
    const repaired = harness.sweepSummary({
      total: 3,
      ran: 3,
      missed: 0,
      incidents: [
        {
          entry: 'an entry a stub landed under',
          attempt: 1,
          paths: ['src/render/capture.ts'],
          failed: [],
        },
      ],
    });
    const said = repaired.lines.join('\n');
    expect(repaired.status).toBe(0);
    expect(said).toContain('1 tree drift incident');
    expect(said).toContain('an entry a stub landed under');
    expect(said).toContain('src/render/capture.ts');
    expect(said).toContain('tree: identical to the one this sweep started on');

    // A clean sweep says the tree is identical, so the line is a statement
    // rather than a silence, and its absence is visible.
    expect(
      harness.sweepSummary({ total: 3, ran: 3, missed: 0 }).lines.join('\n'),
    ).toContain('identical to the one this sweep started on');

    // And a sweep that finished on a different tree has not finished, whatever
    // its entries reported.
    const moved = harness.sweepSummary({
      total: 3,
      ran: 3,
      missed: 0,
      finalDrift: ['src/render/effects.ts'],
    });
    expect(moved.status).toBe(1);
    expect(moved.lines.join('\n')).toContain('REFUSED');
    expect(moved.lines.join('\n')).toContain('src/render/effects.ts');
    expect(moved.lines.join('\n')).not.toContain('every entry detected');
  });

  it('says which of the two reasons stopped the sweep', () => {
    const drifted = harness.sweepSummary({
      total: 3,
      ran: 1,
      missed: 0,
      stoppedAt: 'the entry the tree moved under',
      stopReason: 'drift',
    });
    expect(drifted.status).toBe(1);
    const said = drifted.lines.join('\n');
    expect(said).toContain('the entry the tree moved under');
    expect(said).toContain('A tree that moved is not a detection');
    // Not the other reason: the two are different failures and a summary that
    // told a reader the detector had hung would send them to the wrong place.
    expect(said).not.toContain('killed at its deadline');
  });
});
