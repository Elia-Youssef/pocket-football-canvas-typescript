#!/usr/bin/env node
/**
 * Item A6, method T, evidence `build-report`:
 *
 *   "The build is deterministic: two builds from an identical source tree
 *    produce byte-identical output, compared by hash over every emitted file."
 *
 * Two builds of the same tree under deliberately different conditions, hashed
 * file for file. QUALITY-BAR section 14 says why it is graded at all: a prior
 * packaging script stamped file mtimes into its archive and produced a
 * different hash on every run of an unchanged tree, so a delivery fingerprint
 * meant nothing.
 *
 * The two runs are adversarial rather than merely repeated. Running the same
 * command twice a second apart proves almost nothing, because the conditions
 * that leak into a bundle are exactly the ones that do not change between two
 * quick runs. So between them this varies:
 *
 *   Source mtimes.   Every input file is stamped with a different fake time
 *                    before each build. This is the recorded defect, reproduced.
 *   Time zone.       A formatter reading the host zone would differ.
 *   A VITE_ variable. Vite inlines a VITE_-prefixed value wherever it is
 *                    referenced, so identical output is positive evidence that
 *                    nothing references one. That is item A2's no-build-time-
 *                    secrets clause, measured rather than asserted.
 *   Output path.     A build that wrote its own directory name into the bundle
 *                    would be caught.
 *
 * Every mtime is recorded first and restored in a finally, so a check that
 * inspects the tree cannot be what changes it. The check confirms that too: it
 * fingerprints the input tree before and after and fails if they differ.
 *
 * Exit status is the verdict, and artifacts/reports/build.md is the evidence.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareTrees,
  hashBytes,
  readTree,
  treeFingerprint,
} from './output-fingerprint.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const WORKDIR = path.join(PROJECT_ROOT, '.determinism');
const REPORT = path.join(PROJECT_ROOT, 'artifacts', 'reports', 'build.md');
const VITE = path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

// Generated, vendored and reported trees are not inputs to the build.
const NOT_INPUT = new Set([
  '.determinism',
  '.git',
  'artifacts',
  'blob-report',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/**
 * The two runs, exported so the unit suite can assert they are actually
 * different from each other. Two builds under identical conditions prove
 * almost nothing and would still report PASS, so the distinctness of these
 * fields is itself a property worth pinning.
 */
export const RUNS = [
  {
    id: 'A',
    outDir: '.determinism/first',
    zone: 'UTC',
    probe: 'first-probe-value',
    stamp: new Date('2001-09-09T01:46:40Z'),
  },
  {
    id: 'B',
    outDir: '.determinism/second',
    zone: 'Pacific/Kiritimati',
    probe: 'second-probe-value',
    stamp: new Date('2023-11-14T22:13:20Z'),
  },
];

/** Every file that feeds the build, as absolute paths. */
function inputFiles() {
  const found = [];
  const stack = [PROJECT_ROOT];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (NOT_INPUT.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        found.push(absolute);
      }
    }
  }
  found.sort();
  return found;
}

/** The input tree's content fingerprint, with no timestamps in it. */
function fingerprintOf(files) {
  const tree = new Map();
  for (const file of files) {
    const bytes = readFileSync(file);
    const key = path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
    tree.set(key, { bytes: bytes.length, hash: hashBytes(bytes) });
  }
  return treeFingerprint(tree);
}

/**
 * The child process one run asks for: its argument vector and its environment,
 * composed FROM THE RUN IT IS GIVEN and from nothing else.
 *
 * SEPARATED AND EXPORTED BECAUSE THE WIRING IS THE PROPERTY. The `RUNS` table
 * above was already pinned by the unit suite as four conditions that differ
 * between the two builds. Nothing asserted that the table reached the build, so
 * `TZ`, the VITE_ probe and the output directory could each be pinned to the
 * first row with `verify:build` still reporting PASS, and the report went on
 * printing the second row's values because it read the table rather than what
 * the builds received. Composing here, and recording what was composed, is what
 * makes the difference visible.
 */
export function buildInvocation(run) {
  return {
    outDir: path.join(PROJECT_ROOT, run.outDir),
    argv: [VITE, 'build', '--outDir', run.outDir, '--emptyOutDir'],
    env: {
      ...process.env,
      TZ: run.zone,
      VITE_DETERMINISM_PROBE: run.probe,
    },
  };
}

/**
 * One build. `spawn` is a parameter so the unit suite can assert that what
 * `buildInvocation` composed is what the child is actually given; a composer
 * nobody passes to the process is the same defect one layer down.
 */
export function build(run, spawn = execFileSync) {
  const { outDir, argv, env } = buildInvocation(run);
  rmSync(outDir, { recursive: true, force: true });
  spawn(process.execPath, argv, { cwd: PROJECT_ROOT, stdio: 'pipe', env });
  return outDir;
}

/**
 * Stamp every input with one fake time. `touch` is a parameter for the same
 * reason `spawn` is: the property worth grading is that this is called once per
 * run WITH THAT RUN'S stamp, and a real filesystem cannot answer that question
 * without changing the tree the check is measuring.
 */
export function stampAll(files, when, touch = utimesSync) {
  for (const file of files) {
    touch(file, when, when);
  }
  return files.length;
}

/**
 * The two builds, and the record of what each one was actually given.
 *
 * `records` is the report's only source. A row built from `RUNS` states what
 * the table intends; a row built from here states what the build received, and
 * the two stop agreeing the moment a condition is unwired. The loop is over the
 * `runs` argument rather than over the module constant so that a test can drive
 * it with a run set of its own and see which stamp each iteration was handed.
 */
export function performRuns({
  files,
  runs,
  stamp = stampAll,
  run: runBuild = build,
  read = readTree,
}) {
  const emitted = [];
  const records = [];
  let buildError = null;
  try {
    for (const entry of runs) {
      stamp(files, entry.stamp);
      const invocation = buildInvocation(entry);
      records.push({
        id: entry.id,
        stamp: entry.stamp,
        zone: invocation.env['TZ'],
        probe: invocation.env['VITE_DETERMINISM_PROBE'],
        outDir: invocation.argv[invocation.argv.indexOf('--outDir') + 1],
      });
      emitted.push(read(runBuild(entry)));
    }
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error);
  }
  return { emitted, records, buildError };
}

/**
 * The "what was varied" table, built from what each build was given.
 *
 * Exported so the report's own source can be graded without running two builds:
 * feed it a record set and the cells are the record set's values or they are
 * not. This is the half of item A6's evidence artifact that was false rather
 * than merely weak, because a table naming conditions the build never saw is
 * worse than no table.
 */
export function conditionRows(records) {
  const cells = (pick) => records.map(pick);
  return [
    ['Condition', ...records.map((entry) => `Build ${entry.id}`)],
    ['---', ...records.map(() => '---')],
    ['Every input file mtime', ...cells((entry) => entry.stamp.toISOString())],
    ['TZ', ...cells((entry) => entry.zone)],
    ['VITE_DETERMINISM_PROBE', ...cells((entry) => entry.probe)],
    ['Output directory', ...cells((entry) => entry.outDir)],
  ];
}

/**
 * The verdict, as a total function of the four things that decide it, exported
 * so every branch of it is unit tested rather than only the one a green run
 * takes.
 *
 * Three of the four conditions are the ones a shortcut would drop, and each of
 * them makes "the two trees matched" mean nothing on its own:
 *
 *   inputStable    the check stamps and restores mtimes, so if it left the tree
 *                  changed, the two builds were not of the same source.
 *   emittedCount   two empty trees compare equal. A build that emitted nothing
 *                  would otherwise report the strongest possible PASS.
 *   buildError     a run that never finished emitted whatever the previous one
 *                  left behind, or nothing at all.
 */
export function verdict({ buildError, comparison, inputStable, emittedCount }) {
  return (
    buildError === null &&
    comparison.identical &&
    inputStable &&
    emittedCount > 0
  );
}

function report(lines) {
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
}

function row(cells) {
  return `| ${cells.join(' | ')} |`;
}

function main() {
  if (!existsSync(VITE)) {
    console.error('vite is not installed; run npm ci first');
    return 1;
  }

  const files = inputFiles();
  const before = fingerprintOf(files);
  const originals = files.map((file) => {
    const stats = statSync(file);
    return { file, atime: stats.atime, mtime: stats.mtime };
  });

  let outcome;
  try {
    outcome = performRuns({ files, runs: RUNS });
  } finally {
    // Restoring is not optional. A check that inspects the tree must not be
    // what changes it, and the fingerprint comparison below proves it was not.
    for (const original of originals) {
      utimesSync(original.file, original.atime, original.mtime);
    }
    rmSync(WORKDIR, { recursive: true, force: true });
  }
  const { emitted, records, buildError } = outcome;

  const after = fingerprintOf(files);
  const inputStable = before === after;
  const first = emitted[0] ?? new Map();
  const second = emitted[1] ?? new Map();
  const comparison = compareTrees(first, second);
  const emittedCount = first.size;
  const passed = verdict({ buildError, comparison, inputStable, emittedCount });

  const lines = [
    '# Build determinism report',
    '',
    '> Acceptance item `A6`, method T, evidence `build-report`. Written by',
    '> `scripts/check-determinism.mjs` and rewritten by every run of `npm run verify:build`.',
    '> This path is ignored by git: it is a measurement, not a source file.',
    '',
    `**Verdict: ${passed ? 'PASS' : 'FAIL'}**`,
    '',
    '## What was varied between the two builds',
    '',
    '> Every cell below is what the build was GIVEN, recorded per run as it was',
    '> composed, and not what the table in the script says it intends. A row',
    '> naming a condition the build never saw would be a false artifact rather',
    '> than a weak one.',
    '',
    ...conditionRows(records).map(row),
    '',
    'Identical bytes under a differing `VITE_` variable is what carries the no-build-time-secrets clause',
    'of item `A2`: Vite inlines such a value wherever it is referenced, so byte equality means nothing',
    'references one.',
    '',
    '## Checks',
    '',
    row(['#', 'Check', 'Result']),
    row(['---', '---', '---']),
    row(['1', 'At least one file emitted', `${String(emittedCount)} files`]),
    row([
      '2',
      'Same set of files in both builds',
      comparison.onlyInLeft.length === 0 && comparison.onlyInRight.length === 0
        ? 'yes'
        : 'NO',
    ]),
    row([
      '3',
      'Every emitted file byte-identical',
      comparison.differing.length === 0 ? 'yes' : 'NO',
    ]),
    row([
      '4',
      'Input tree unchanged by the two runs',
      inputStable ? 'yes' : 'NO',
    ]),
    row(['5', 'Input files fingerprinted', String(files.length)]),
    '',
    '## Emitted files',
    '',
    row(['File', 'Bytes', 'sha256']),
    row(['---', '---', '---']),
    ...[...first.keys()]
      .sort()
      .map((key) => row([`\`${key}\``, String(first.get(key).bytes), `\`${first.get(key).hash}\``])),
  ];

  if (!passed) {
    lines.push('', '## Differences', '');
    for (const key of comparison.onlyInLeft) {
      lines.push(`- \`${key}\` was emitted by build A only.`);
    }
    for (const key of comparison.onlyInRight) {
      lines.push(`- \`${key}\` was emitted by build B only.`);
    }
    for (const entry of comparison.differing) {
      lines.push(
        `- \`${entry.path}\` differs: A is ${String(entry.left.bytes)} bytes, \`${entry.left.hash}\`;` +
          ` B is ${String(entry.right.bytes)} bytes, \`${entry.right.hash}\`.`,
      );
    }
    if (!inputStable) {
      lines.push('- The input tree changed during the run, so the comparison above proves nothing.');
    }
    if (emittedCount === 0) {
      lines.push('- Nothing was emitted, so two empty trees compared equal for the wrong reason.');
    }
    if (buildError !== null) {
      lines.push(`- A build did not complete: ${buildError.split('\n')[0]}`);
    }
  }

  report(lines);

  if (passed) {
    console.log(
      `determinism: PASS, ${String(emittedCount)} emitted files byte-identical across two builds`,
    );
    return 0;
  }
  console.error('determinism: FAIL, see artifacts/reports/build.md');
  return 1;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
