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

function build(run) {
  const outDir = path.join(PROJECT_ROOT, run.outDir);
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [VITE, 'build', '--outDir', run.outDir, '--emptyOutDir'],
    {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      env: {
        ...process.env,
        TZ: run.zone,
        VITE_DETERMINISM_PROBE: run.probe,
      },
    },
  );
  return outDir;
}

function stampAll(files, when) {
  for (const file of files) {
    utimesSync(file, when, when);
  }
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

  const emitted = [];
  let buildError = null;
  try {
    for (const run of RUNS) {
      stampAll(files, run.stamp);
      emitted.push(readTree(build(run)));
    }
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error);
  } finally {
    // Restoring is not optional. A check that inspects the tree must not be
    // what changes it, and the fingerprint comparison below proves it was not.
    for (const original of originals) {
      utimesSync(original.file, original.atime, original.mtime);
    }
    rmSync(WORKDIR, { recursive: true, force: true });
  }

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
    row(['Condition', 'Build A', 'Build B']),
    row(['---', '---', '---']),
    row([
      'Every input file mtime',
      RUNS[0].stamp.toISOString(),
      RUNS[1].stamp.toISOString(),
    ]),
    row(['TZ', RUNS[0].zone, RUNS[1].zone]),
    row(['VITE_DETERMINISM_PROBE', RUNS[0].probe, RUNS[1].probe]),
    row(['Output directory', RUNS[0].outDir, RUNS[1].outDir]),
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
