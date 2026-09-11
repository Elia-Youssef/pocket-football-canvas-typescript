#!/usr/bin/env node
/**
 * Validation by mutation: break every gate this part adds, one break at a time,
 * and require each break to be caught.
 *
 * BUILD-PLAN's per-part rule is that every automated gate a part adds gets an
 * entry here and that `npm run verify:mutations` reports every entry detected
 * before the part is done. It is a phase gate rather than a per-part gate
 * because it is slow, and it exists because a gate that has quietly stopped
 * failing is the defect class this document set was written to kill: it looks
 * exactly like a gate that is passing.
 *
 * Two detectors, both run as their own node binary rather than through npm, so
 * that a mutated package.json cannot change what the harness runs:
 *
 *   unit   the whole Vitest suite
 *   lint   ESLint over the tree, with the fixtures excluded the way the
 *          shipping script excludes them
 *
 * Every entry names the property it attacks, not the line it edits. If an entry
 * is ever reported as NOT DETECTED, the gate it names is decorative.
 *
 * The item column names whatever owns the property. Usually that is an
 * acceptance item; where the gate is a repository rule rather than a sheet
 * item, it is the GITHUB section that states it, so that `GH7` reads as
 * "section 7, the authorship of the repository record".
 *
 * Six safety properties, because a harness that edits live source files has
 * to be trustworthy before it is useful:
 *
 *   Staleness guard.  Each `find` must match its file EXACTLY once. A mutation
 *                     whose target has been refactored away would otherwise be
 *                     applied to nothing and reported as undetected, or worse,
 *                     applied twice.
 *   Restore always.   Originals are restored in a finally, and an added file is
 *                     refused if the path already exists and removed afterwards.
 *   Baseline first.   Both detectors must be green before anything is mutated.
 *                     Against a red tree every mutation looks detected.
 *   Port reclaimed.   The browser detector owns the preview port either side of
 *                     every run it makes. See the section below.
 *   Killed is not     A detector killed at its deadline never reached a verdict.
 *   detected.         Reading its non-zero exit as a detection would report a
 *                     gate as working on a run that measured nothing, so a kill
 *                     is an ERROR that stops the sweep with the entry named.
 *                     See `detectorOutcome` below.
 *   One tree.         Every entry is measured against the tree the sweep began
 *                     on. The whole tree is hashed at the baseline and again
 *                     after each entry; drift is restored from the baseline
 *                     bytes, recorded as an INCIDENT and the entry measured
 *                     again on the clean tree. See `treeDrift` below.
 *
 * WHY THE WHOLE TREE AND NOT THE FILE THE ENTRY EDITED. Restoring `entry.file`
 * proves that one file is back; it says nothing about the rest. Two tests in
 * this suite rewrite a LIVE shipped source and restore it in a `finally` that a
 * failed or killed write never reaches, and a stub left behind by one of them
 * makes the unit suite red for a reason that has nothing to do with any
 * mutation. From that moment every remaining entry reports "detected" while
 * measuring nothing at all, and the sweep ends with PASS. That happened three
 * times in one day on this machine, in the tool that replays these entries, and
 * a sweep of five hours with no such guard is a sweep whose verdict cannot be
 * read. Restore and re-run rather than stop, because the fault is the machine's
 * and one entry's worth of work is the right price to pay for it; two drifts on
 * the same entry are a machine that is not going to settle, and that stops.
 *
 * NO GIT, DELIBERATELY. The tree is hashed rather than asked about, for the
 * same reason every detector is run as its own node binary: a gate whose answer
 * depends on how the clone was made, on what a per-clone exclude file hides, or
 * on git being installed at all is a gate that decides different things on
 * different machines. On this one, every markdown file is excluded locally, so
 * a status walk would not have noticed a README rewritten under an entry.
 *
 * THE BROWSER DETECTOR REAPS ITS OWN PREVIEW SERVER. Its Playwright
 * configuration starts `vite preview` as a web server, which arrives as a
 * GRANDCHILD of this process: the detector is a node process and the preview is
 * a child of that. When a detector run is killed, on this platform the direct
 * child dies and the grandchild does not, and the orphan then holds the port
 * the next browser invocation needs. `strictPort` means that invocation cannot
 * start at all, and the entry it was measuring is reported against a detector
 * that never ran. Three orphans in a single part were measured that way. So the
 * port is reclaimed BEFORE every browser run and again in a `finally` AFTER it,
 * by process id read out of the platform's own socket listing rather than by
 * walking a parent chain that a dead parent has already broken. The two are not
 * redundant: the `finally` covers a detector this harness itself timed out, and
 * the before-run reclaim covers an orphan left by a run that was killed so hard
 * that no `finally` of ours could have run at all.
 *
 * THE RECLAIM SAYS WHEN IT COULD NOT LOOK. A socket listing that could not be
 * produced at all is not an empty one, and collapsing the two would report a
 * port free that nothing ever inspected; the reclaim answers `looked: false`
 * there and says so in the log. It also refuses by number the two process ids
 * that can never be a preview server, because a harness about to kill a process
 * TREE should decline the ones it can name in advance. What it does not do is
 * ask what the process is: anything holding this port stops the browser gate
 * from starting at all under `strictPort`, so anything holding it has to go,
 * and the log names every id it stopped.
 *
 * Import-inert: main() runs only when this file is the entry point, so a test
 * may import the entry lists, or the reclaim helpers, without editing anybody's
 * source.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const require = createRequire(import.meta.url);

function binaryFor(packageName, fallback) {
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry =
      typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[packageName];
    if (typeof entry === 'string') {
      return path.join(path.dirname(manifestPath), entry);
    }
  } catch (error) {
    console.log(`  note  falling back for ${packageName}: ${String(error)}`);
  }
  return path.join(PROJECT_ROOT, fallback);
}

/**
 * The deadline a detector is given, per detector and in milliseconds.
 *
 * It is a safety property rather than a tuning number, so it is sized per
 * detector rather than once for all three: one number cannot serve a suite that
 * answers in three seconds and a suite that answers in twelve minutes. Too
 * small and an honest run is killed and read as red, which is what happened at
 * PF-9 when the browser suite grew past a single shared ten minute deadline;
 * too large and a genuinely hung mutation stalls the gate instead of counting
 * as detected. Each one below is well past its own measured runtime and nowhere
 * near any other's.
 */
const MINUTES = 60 * 1000;

/**
 * The port `vite preview` serves the built bundle on, and therefore the port
 * the browser detector's own web server takes.
 *
 * RESTATED HERE AND THEN CHECKED, because this file is plain node and cannot
 * import the TypeScript configuration that owns the number. `configuredPort`
 * reads that configuration's own literal and `main` refuses to run if the two
 * have drifted apart, which is the same staleness discipline every `find`
 * below is held to: a reclaim aimed at the wrong port would free nothing and
 * say so in the same breath as reporting a detector that could not start.
 */
const PREVIEW_PORT = 4273;

/** Process ids no reclaim may ever touch: the idle process and the system one. */
const SYSTEM_PIDS = 4;

/** The port `vite.config.ts` itself declares, or null if it no longer says. */
function configuredPort() {
  try {
    const source = readFileSync(path.join(PROJECT_ROOT, 'vite.config.ts'), 'utf8');
    const found = /export const PREVIEW_PORT = (\d+);/.exec(source);
    return found === null ? null : Number(found[1]);
  } catch (error) {
    console.log(`  note  could not read the preview port: ${String(error)}`);
    return null;
  }
}

/** A synchronous wait, for a socket that outlives the process that held it. */
function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * The platform's own listing of listening sockets. A tool that exits non-zero
 * because nothing matched has still told us the answer, so its output is used
 * rather than its status.
 *
 * NO PROTOCOL FILTER ON WIN32, AND THAT IS THE WHOLE OF IT. `netstat -p tcp`
 * lists IPv4 only, and the preview server binds `localhost`, which resolves to
 * `[::1]` here: a reclaim built on the filtered listing finds nothing, reports
 * the port free, and leaves the orphan holding it. Measured against a live
 * preview while building this. The unfiltered listing carries both families
 * under the same `TCP` proto, and the UDP rows it also carries are refused by
 * the state column the parser requires.
 */
function socketListing(port) {
  const [command, args] =
    process.platform === 'win32'
      ? ['netstat', ['-ano']]
      : ['lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN']];
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // A tool that RAN and exited non-zero has still answered: lsof does that
    // whenever nothing matched. A tool that could not run at all has not, and
    // the two must not collapse into the same empty string, because "nobody is
    // listening" and "I could not look" would then be one answer and the
    // reclaim would report a port free that it never saw.
    if (error && error.status !== undefined && error.status !== null) {
      return String(error.stdout ?? '');
    }
    console.log(`  note  could not read the socket listing: ${String(error)}`);
    return null;
  }
}

/**
 * The process ids listening on `port`, parsed out of a socket listing. Kept
 * separate from the call that produces the listing so the parsing is a pure
 * function of text: the win32 rows are `TCP <local> <remote> LISTENING <pid>`
 * and lsof's are `COMMAND PID ...` already filtered to the port.
 */
export function parseListeners(listing, port, platform = process.platform) {
  const found = new Set();
  for (const line of String(listing).split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (platform === 'win32') {
      if (fields.length < 5 || fields[0] !== 'TCP' || fields[3] !== 'LISTENING') {
        continue;
      }
      if (!String(fields[1]).endsWith(`:${String(port)}`)) {
        continue;
      }
      const pid = Number(fields[4]);
      // 0 is the idle process and 4 is the system process. Neither can be a
      // preview server, and a harness that is about to kill a process tree
      // should refuse the two it can name in advance.
      if (Number.isInteger(pid) && pid > SYSTEM_PIDS) {
        found.add(pid);
      }
      continue;
    }
    if (fields.length < 2 || fields[1] === 'PID') {
      continue;
    }
    const pid = Number(fields[1]);
    if (Number.isInteger(pid) && pid > 0) {
      found.add(pid);
    }
  }
  return [...found].sort((left, right) => left - right);
}

/** Whoever is holding the preview port right now, or null if nobody looked. */
export function previewListeners(port = PREVIEW_PORT) {
  const listing = socketListing(port);
  return listing === null ? null : parseListeners(listing, port);
}

function stopTree(pid) {
  try {
    if (process.platform === 'win32') {
      // The tree, because the preview may itself have started a child.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (error) {
    console.log(`  note  could not stop process ${String(pid)}: ${String(error)}`);
    return false;
  }
}

/**
 * Free the preview port and say what it took. A socket outlives the process
 * that held it by a moment, so the port is re-read until it is genuinely free
 * or the budget runs out; a reclaim that could not free it says so rather than
 * letting the next run fail for a reason nobody wrote down.
 */
export function reapPreview(port = PREVIEW_PORT) {
  const holders = previewListeners(port);
  if (holders === null) {
    return { killed: [], free: false, looked: false };
  }
  if (holders.length === 0) {
    return { killed: [], free: true, looked: true };
  }
  for (const pid of holders) {
    stopTree(pid);
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const now = previewListeners(port);
    if (now !== null && now.length === 0) {
      return { killed: holders, free: true, looked: true };
    }
    pause(200);
  }
  return { killed: holders, free: false, looked: true };
}

const DETECTORS = {
  unit: {
    label: 'unit suite',
    // Three seconds measured over 604 tests, and every loop in it carries its
    // own budget.
    timeout: 10 * MINUTES,
    argv: () => [binaryFor('vitest', 'node_modules/vitest/vitest.mjs'), 'run'],
  },
  lint: {
    label: 'lint',
    timeout: 10 * MINUTES,
    argv: () => [
      binaryFor('eslint', 'node_modules/eslint/bin/eslint.js'),
      '.',
      '--ignore-pattern',
      'tests/lint/fixtures/',
    ],
  },
  // Added at PF-5, when the first gate arrived that neither of the two above
  // can see: the composition root's own wiring, which no unit test reaches
  // and no lint rule has an opinion about. The bundle is built HERE rather
  // than assumed, because a suite driven against a stale dist would record a
  // false negative, which is the defect class this harness exists to catch;
  // a build that a mutation breaks throws out of argv() and the entry is
  // correctly reported as detected. It is by far the slowest detector, three
  // engines and a build per entry, so an entry names it only where nothing
  // cheaper can witness the property.
  browser: {
    label: 'browser suite',
    // The one detector that starts a server, and therefore the one that has a
    // port to give back. See the preview-reap section in the header.
    owns: 'preview',
    // Thirty minutes against a suite measured between 12.1 and 14.0 minutes
    // across five full runs at four workers, which is where PF-9 left it at 234
    // tests on three engines. Playwright bounds every test it runs, so a suite
    // that has not answered inside twice its worst measured run is hung rather
    // than slow.
    timeout: 30 * MINUTES,
    // THE BUILD CARRIES ITS OWN DEADLINE, and it has to. `argv` runs the build
    // as an ARGUMENT to the call that carries the detector's deadline, so the
    // deadline is not in force yet while the build runs. A mutation that makes
    // the build spin would otherwise stall the whole gate with no output,
    // which is precisely what the refusal in `main` exists to prevent, for the
    // one detector that builds anything. Five minutes against a build measured
    // under a second.
    buildTimeout: 5 * MINUTES,
    argv: (whole) => {
      execFileSync(
        process.execPath,
        [binaryFor('vite', 'node_modules/vite/bin/vite.js'), 'build'],
        { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: DETECTORS.browser.buildTimeout },
      );
      // THE BASELINE RUNS THE WHOLE SUITE AND A MUTATION RUN DOES NOT, and the
      // two are asking different questions. The baseline asks whether this tree
      // is green everywhere, so it is all three engines. A mutation run asks
      // whether ANY test catches this edit, and every property that names this
      // detector is composition wiring that no engine holds an opinion about;
      // running one engine asks the same question in a third of the time. The
      // narrowing is safe in the only direction that matters: an edit that
      // some other engine alone would have caught is reported MISSED, which
      // reddens the gate, and it can never make an uncaught edit look caught.
      // Twenty three entries name this detector, so the difference is hours.
      const engine = whole
        ? []
        : ['--project=chromium', '--project=chromium-driven', '--no-deps'];
      return [
        binaryFor('@playwright/test', 'node_modules/@playwright/test/cli.js'),
        'test',
        ...engine,
        // Pinned at four from PF-9, for a measured reason and not a taste. At
        // the default worker count this machine runs about thirteen workers
        // and seventy browser processes at once, and the suite STARVES: tests
        // that pass alone in seconds time out at four minutes. A starved run
        // is worse here than anywhere else, because a detector that fails for
        // the wrong reason reports a mutation as detected when nothing caught
        // it. Four workers measured 12.8 minutes against 25.3 minutes starved.
        '--workers=4',
      ];
    },
  },
};

const PLUGIN = 'tools/eslint-plugin-core-boundary';
const PLUGIN2 = 'tools/eslint-plugin-pointer-events';

/**
 * One entry per protected property. Named after the property, so that a FAIL
 * line below reads as a statement about the project rather than about a diff.
 */
export const EDITS = [
  {
    item: 'M3',
    name: 'the import rule is switched on in the shipping config',
    file: 'eslint.config.js',
    find: "'core-boundary/no-forbidden-imports': 'error',",
    replace: "'core-boundary/no-forbidden-imports': 'off',",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the DOM rule is an error and not a warning',
    file: 'eslint.config.js',
    find: "'core-boundary/no-dom': 'error',",
    replace: "'core-boundary/no-dom': 'warn',",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the Math.random rule is switched on in the shipping config',
    file: 'eslint.config.js',
    find: "'core-boundary/no-math-random': 'error',",
    replace: "'core-boundary/no-math-random': 'off',",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the shipping lint excludes the fixtures and nothing else',
    file: 'package.json',
    find: '"eslint . --ignore-pattern tests/lint/fixtures/"',
    replace: '"eslint ."',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a violating line inside core cannot silence its own detection',
    file: 'eslint.config.js',
    find: 'linterOptions: { noInlineConfig: true },',
    replace: 'linterOptions: { noInlineConfig: false },',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the render segment is a forbidden import',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: "export const SURFACE_SEGMENTS = new Set(['render', 'ui']);",
    replace: "export const SURFACE_SEGMENTS = new Set(['ui']);",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the ui segment is a forbidden import',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: "export const SURFACE_SEGMENTS = new Set(['render', 'ui']);",
    replace: "export const SURFACE_SEGMENTS = new Set(['render']);",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the shared engine renderer has its own matcher',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: "export const ENGINE_RENDERER = '@js-games/engine/render';",
    replace: "export const ENGINE_RENDERER = '@js-games/engine/renderer';",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a specifier is matched per segment and not as a substring',
    file: `${PLUGIN}/lib/specifiers.js`,
    find: `  return specifierSegments(specifier).some((segment) =>
    SURFACE_SEGMENTS.has(segment.toLowerCase()),
  );`,
    replace: '  return /render|ui/i.test(specifier);',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'an undeclared name is not treated as a declaration',
    file: `${PLUGIN}/lib/scope.js`,
    find: `    scope = scope.upper;
  }
  return false;`,
    replace: `    scope = scope.upper;
  }
  return true;`,
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a name declared by configuration is still a platform reference',
    file: `${PLUGIN}/lib/scope.js`,
    find: 'if (variable.defs.length === 0) {',
    replace: 'if (variable.defs.length === -1) {',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the platform denylist is consulted by exact name',
    file: `${PLUGIN}/lib/platform-globals.js`,
    find: '  if (PLATFORM_GLOBALS.has(name)) {',
    replace: "  if (PLATFORM_GLOBALS.has(`${name}-never`)) {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'whole platform families are caught by prefix',
    file: `${PLUGIN}/lib/platform-globals.js`,
    find: '  /^HTML[A-Z]/,',
    replace: '  /^HTMLNEVER[A-Z]/,',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a DOM library reference is detected',
    file: `${PLUGIN}/lib/platform-globals.js`,
    find: String.raw`["']dom`,
    replace: String.raw`["']never`,
    detectedBy: 'unit',
  },
  {
    // There is deliberately no entry attacking the explicit type-position
    // visitor in no-dom, and the absence is a finding rather than an omission.
    // The parser in use resolves type references into the scope graph, so the
    // sweep below covers type positions as well and removing the visitor alone
    // changes no verdict. The visitor is kept as redundancy against a parser
    // that does not, and no single edit can isolate it. See the plugin README.
    item: 'M3',
    name: 'a platform name in a value position is refused',
    file: `${PLUGIN}/rules/no-dom.js`,
    find: `        for (const reference of globalReferences(sourceCode)) {
          check(reference.identifier);
        }`,
    replace: '        void globalReferences;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a named Math.random member is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "            parent.property.name === 'random'",
    replace: "            parent.property.name === 'randomise'",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a bracketed Math random member is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        if (key === 'random') {",
    replace: "        if (key === 'randomise') {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'destructuring random out of Math is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        if (id.type === 'ObjectPattern') {",
    replace: "        if (id.type === 'ArrayPattern') {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a destructured key named random is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        if (name === 'random') {",
    replace: "        if (name === 'randomise') {",
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'holding Math under another name is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "        context.report({ node: parent.id, messageId: 'mathAlias' });",
    replace: '        void parent;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'handing Math out of the module is refused',
    file: `${PLUGIN}/rules/no-math-random.js`,
    find: "      context.report({ node, messageId: 'mathCapture' });",
    replace: '      void node;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the core path scope is case-insensitive',
    file: `${PLUGIN}/lib/core-path.js`,
    find: "    .some((segment) => segment.toLowerCase() === 'core');",
    replace: "    .some((segment) => segment === 'core');",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'two builds are compared by their bytes',
    file: 'scripts/output-fingerprint.mjs',
    find: '    if (other.hash !== entry.hash || other.bytes !== entry.bytes) {',
    replace: '    if (other.absent !== entry.absent) {',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'a file missing from the second build is a difference',
    file: 'scripts/output-fingerprint.mjs',
    find: '      onlyInLeft.push(key);',
    replace: '      void key;',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'a file added by the second build is a difference',
    file: 'scripts/output-fingerprint.mjs',
    find: '      onlyInRight.push(key);',
    replace: '      void key;',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the identical verdict depends on the differences found',
    file: 'scripts/output-fingerprint.mjs',
    find: `  const identical =
    onlyInLeft.length === 0 && onlyInRight.length === 0 && differing.length === 0;`,
    replace: '  const identical = true;',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'every emitted file is hashed, with no extension filter',
    file: 'scripts/output-fingerprint.mjs',
    find: '      if (entry.isFile()) {',
    replace: "      if (entry.isFile() && !entry.name.endsWith('.html')) {",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the tree fingerprint covers every entry in the tree',
    file: 'scripts/output-fingerprint.mjs',
    find: '  for (const key of [...tree.keys()].sort()) {',
    replace: '  for (const key of [...tree.keys()].sort().slice(0, 0)) {',
    detectedBy: 'unit',
  },

  // The driver around the comparison. Two builds under identical conditions
  // would report the strongest possible PASS having tested nothing, and a
  // verdict that dropped a condition would do the same.
  {
    item: 'A6',
    name: 'the two builds run in different time zones',
    file: 'scripts/check-determinism.mjs',
    find: "    zone: 'Pacific/Kiritimati',",
    replace: "    zone: 'UTC',",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the two builds set a different VITE_ probe value',
    file: 'scripts/check-determinism.mjs',
    find: "    probe: 'second-probe-value',",
    replace: "    probe: 'first-probe-value',",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the two builds stamp different mtimes onto the inputs',
    file: 'scripts/check-determinism.mjs',
    find: "    stamp: new Date('2023-11-14T22:13:20Z'),",
    replace: "    stamp: new Date('2001-09-09T01:46:40Z'),",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the verdict requires the input tree to have stayed still',
    file: 'scripts/check-determinism.mjs',
    find: '    inputStable &&',
    replace: '    emittedCount >= 0 &&',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the verdict requires at least one emitted file',
    file: 'scripts/check-determinism.mjs',
    find: '    emittedCount > 0',
    replace: '    emittedCount >= 0',
    detectedBy: 'unit',
  },

  // The browser gate cannot be graded by running it: gutting a test makes it
  // pass. These three attack the assertions themselves, and the detector is
  // the inventory in tests/unit/browser-gate.test.ts.
  {
    item: 'A2',
    name: 'the off-origin check really compares two origins',
    file: 'tests/browser/scaffold.spec.ts',
    find: '      if (new URL(url).origin !== origin) {',
    replace: '      if (offOrigin.length < 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'A2',
    name: 'every configuration token is still forbidden in the output',
    file: 'tests/browser/scaffold.spec.ts',
    find: "    const forbidden = ['process.env', 'import.meta.env', 'VITE_'];",
    replace: '    const forbidden = [];',
    detectedBy: 'unit',
  },
  {
    item: 'A2',
    name: 'the compiled entry marker is still asserted',
    file: 'tests/browser/scaffold.spec.ts',
    find: "      'pocket-football',",
    replace: "      '',",
    detectedBy: 'unit',
  },
  {
    item: 'A2',
    name: 'an empty or single-file dist cannot satisfy the output check',
    file: 'tests/browser/scaffold.spec.ts',
    find: '    expect(files.length).toBeGreaterThan(1);',
    replace: '    expect(files.length).toBeGreaterThan(-1);',
    detectedBy: 'unit',
  },

  // The repository record gate. GITHUB section 7 rather than a sheet item.
  {
    item: 'GH7',
    name: 'the delivery record takes no gameplay carve-out',
    file: 'scripts/check-repository-record.mjs',
    find: '  return scanLines(text, () => false);',
    replace: '  return scanLines(text, isGameContextLine);',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the carve-out covers this game vocabulary and no delivery vocabulary',
    file: 'scripts/check-repository-record.mjs',
    find: String.raw`/\b(?:opponents?|difficulty|`,
    replace: String.raw`/\b(?:refactor|assisted|generated|opponents?|difficulty|`,
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the Closes waiver belongs to the commit and not to a branch',
    file: 'scripts/check-repository-record.mjs',
    find: "  return !subject.startsWith('deps:');",
    replace: '  return false;',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the dependency trailer waiver names the bot, not anybody signing off',
    file: 'scripts/check-repository-record.mjs',
    find: String.raw`const DEPENDENCY_TRAILER = /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/;`,
    replace: String.raw`const DEPENDENCY_TRAILER = /^Signed-off-by: /;`,
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'the dependency trailer waiver belongs to dependency updates only',
    file: 'scripts/check-repository-record.mjs',
    find: '    if (dependencyUpdate && DEPENDENCY_TRAILER.test(line)) {',
    replace: '    if (DEPENDENCY_TRAILER.test(line)) {',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'a control byte in a record value is flagged, not passed as ASCII',
    file: 'scripts/check-repository-record.mjs',
    find: '    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {',
    replace: '    if (code === 0x7f) {',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'a message keeps its text after an embedded field separator',
    file: 'scripts/check-repository-record.mjs',
    find: '      message: parts.slice(5).join(UNIT_SEPARATOR),',
    replace: '      message: parts[5],',
    detectedBy: 'unit',
  },
  {
    item: 'GH7',
    name: 'an unparseable record fragment is reported, never skipped',
    file: 'scripts/check-repository-record.mjs',
    find: '      fragments.push(commit);',
    replace: '      void commit;',
    detectedBy: 'unit',
  },

  // The token layer, item E1. Three sources have to agree, every quoted ratio
  // has to re-derive from the hexes, and the literal sweep has to be able to
  // see a literal. The last four attack the machinery the sweep is built from
  // rather than an assertion: gutting an assertion makes a suite PASS, so an
  // entry that did that would be reported as undetected and would be right.
  {
    item: 'E1',
    name: 'a stylesheet value must match the design contract',
    file: 'src/ui/tokens.css',
    find: '  --space-5: 24px;',
    replace: '  --space-5: 25px;',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the renderer record must match the design contract',
    file: 'src/render/tokens.ts',
    find: "    rail: '#C8CFCB',",
    replace: "    rail: '#C8CFCC',",
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a quoted ratio is re-derived and not trusted',
    file: 'tests/reference/design-contract.json',
    find: '"16.43"',
    replace: '"16.53"',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a measured pair is checked against its own threshold',
    file: 'tests/reference/design-contract.json',
    find: '["Entity ring on player fill", "--pf-line", "--team-player", "3.09", "3.09", "3"]',
    replace: '["Entity ring on player fill", "--pf-line", "--team-player", "3.09", "3.09", "5"]',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the corrected rail cell is re-derived and not trusted',
    file: 'tests/reference/design-contract.json',
    find: '["Rail on ground", "Daylight", "1.15", "3", "Rail on pitch, both variants"]',
    replace: '["Rail on ground", "Daylight", "1.16", "3", "Rail on pitch, both variants"]',
    detectedBy: 'unit',
  },

  // The two scoped cells, corrected 2026-08-29 from the two disclosures this
  // harness protected since PF-1: measured, quoted in section 5, and
  // deliberately below the threshold their named carrier meets. The pins are
  // on the derived value, on the ceiling, and on the rows being there at all.
  {
    item: 'E1',
    name: 'a filled arrow cell is re-derived and not trusted',
    file: 'tests/reference/design-contract.json',
    find: '["Aim arrow weak end on pitch", "--pf-line", "--pitch-stripe-a", "5.38", "3.71", "3"]',
    replace: '["Aim arrow weak end on pitch", "--pf-line", "--pitch-stripe-a", "5.38", "3.81", "3"]',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a quiet cell is measured against the real ceiling',
    file: 'tests/reference/design-contract.json',
    find: '["Aim arrow strong end on pitch", "Daylight", "1.59", "3", "The arrow outline, both variants"]',
    replace: '["Aim arrow strong end on pitch", "Daylight", "1.59", "1.5", "The arrow outline, both variants"]',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a scoped cell cannot be deleted',
    file: 'tests/reference/design-contract.json',
    find: '["Rail on ground", "Daylight", "1.15", "3", "Rail on pitch, both variants"], ',
    replace: '',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a stated threshold cannot be quietly lowered',
    file: 'tests/reference/design-contract.json',
    find: '["Rail on pitch", "--pf-rail", "--pitch-stripe-a", "3.67", "3.09", "3"]',
    replace: '["Rail on pitch", "--pf-rail", "--pitch-stripe-a", "3.67", "3.09", "1"]',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the pitch is redefined per theme',
    file: 'src/ui/tokens.css',
    find: `  --pitch-stripe-a: var(--pitch-stripe-a-floodlit);
  --pitch-stripe-b: var(--pitch-stripe-b-floodlit);
  --pf-rail: var(--pf-rail-floodlit);
}`,
    replace: `  --pitch-stripe-a: var(--pitch-stripe-a-daylight);
  --pitch-stripe-b: var(--pitch-stripe-b-daylight);
  --pf-rail: var(--pf-rail-daylight);
}`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'reduced motion resolves every duration to zero',
    file: 'src/ui/tokens.css',
    find: '    --dur-2: var(--dur-0);',
    replace: '    --dur-2: 140ms;',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep matches a colour literal',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`  /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(|(?<![\w-])color\s*\(/gi;`,
    replace: String.raw`  /#never[0-9A-Fa-f]{3,8}\b/gi;`,
    detectedBy: 'unit',
  },
  {
    // A CSS function name is case-insensitive. Without the flag, RGB() is a
    // colour to every browser and not a colour to the sweep.
    item: 'E1',
    name: 'the colour sweep is case-insensitive, as CSS is',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`color\s*\(/gi;`,
    replace: String.raw`color\s*\(/g;`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the bare colour function form is matched too',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`|(?<![\w-])color\s*\(/gi;`,
    replace: String.raw`/gi;`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep reads stylesheets as well as modules',
    file: 'tests/unit/tokens.test.ts',
    find: "  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css',",
    replace: "  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',",
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep matches a stylesheet dimension literal',
    file: 'tests/unit/tokens.test.ts',
    find: String.raw`const DIMENSION_LITERAL = /(?<![\w#-])\d*\.?\d+(?:px|rem|em|ms|s)\b/g;`,
    replace: String.raw`const DIMENSION_LITERAL = /(?<![\w#-])\d*\.?\d+(?:never)\b/g;`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the sweep descends into every directory under src',
    file: 'tests/unit/tokens.test.ts',
    find: `      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }`,
    replace: `      if (entry.isDirectory()) {
        continue;
      }`,
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'the token layer is the only thing the sweep excludes',
    file: 'tests/unit/tokens.test.ts',
    find: "const TOKEN_LAYER = ['src/ui/tokens.css', 'src/render/tokens.ts'];",
    replace: "const TOKEN_LAYER = ['src/ui/tokens.css', 'src/render/tokens.ts', 'src/main.ts'];",
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-2. The three time layers, damping, the stop threshold, containment,
  // the speed cap, the finiteness guard and the seeded stream.
  //
  // Every entry here attacks the property rather than the assertion. The
  // three time layers get one entry per layer plus one per constant,
  // because a layer that has been deleted and a layer whose constant has
  // drifted fail in different places and one of them is silent.
  // ---------------------------------------------------------------------

  {
    item: 'B1',
    name: 'a frame delta past the ceiling is clamped and the rest discarded',
    file: 'src/core/physics.ts',
    find: '        applied = DELTA_CEILING;',
    replace: '        applied = delta;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'a negative delta is no time at all',
    file: 'src/core/physics.ts',
    find: '      if (!Number.isFinite(delta) || delta <= 0) {',
    replace: '      if (!Number.isFinite(delta)) {',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'a delta that is not a number is no time at all',
    file: 'src/core/physics.ts',
    find: '      if (!Number.isFinite(delta) || delta <= 0) {',
    replace: '      if (delta <= 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'a gap past the resume threshold is dropped and never simulated',
    file: 'src/core/physics.ts',
    find: `        leftover = 0;
        resumed = true;`,
    replace: `        applied = delta;
        resumed = true;`,
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'time is consumed in slices no larger than the catch-up ceiling',
    file: 'src/core/physics.ts',
    find: '        let take = Math.min(pending, CATCH_UP_SLICE);',
    replace: '        let take = pending;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the accumulator carries its remainder into the next frame',
    file: 'src/core/physics.ts',
    find: '        leftover += take;',
    replace: '        leftover = take;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the fixed step is the one the whole time model is derived from',
    file: 'src/core/config.ts',
    find: 'export const FIXED_STEP = 1 / 120;',
    replace: 'export const FIXED_STEP = 1 / 90;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the delta ceiling is the value the standard states',
    file: 'src/core/config.ts',
    find: 'export const DELTA_CEILING = 0.25;',
    replace: 'export const DELTA_CEILING = 0.5;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the catch-up slice is the value the standard states',
    file: 'src/core/config.ts',
    find: 'export const CATCH_UP_SLICE = 1 / 60;',
    replace: 'export const CATCH_UP_SLICE = 1 / 30;',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the resume threshold is the value the standard states',
    file: 'src/core/config.ts',
    find: 'export const RESUME_GAP = 5;',
    replace: 'export const RESUME_GAP = 50;',
    detectedBy: 'unit',
  },

  {
    item: 'B2',
    name: 'damping is per second rather than once per step',
    file: 'src/core/physics.ts',
    find: '  const perStepDecay = decayFactor(FIXED_STEP);',
    replace: '  const perStepDecay = DAMPING;',
    detectedBy: 'unit',
  },
  {
    item: 'B2',
    name: 'a step damps at all',
    file: 'src/core/physics.ts',
    find: '      scale(body.velocity, perStepDecay);',
    replace: '      scale(body.velocity, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'B2',
    name: 'the damping constant is the one SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const DAMPING = 0.32;',
    replace: 'export const DAMPING = 0.33;',
    detectedBy: 'unit',
  },

  {
    item: 'B3',
    name: 'a body at or below the stop threshold is zeroed',
    file: 'src/core/physics.ts',
    find: `      if (atRest(body.velocity)) {
        zero(body.velocity);
      }`,
    replace: '      void atRest;',
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'the threshold reads at or below rather than below',
    file: 'src/core/physics.ts',
    find: '  return Math.hypot(velocity.x, velocity.y) <= STOP_SPEED;',
    replace: '  return Math.hypot(velocity.x, velocity.y) < STOP_SPEED;',
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'the stop threshold is the value SPEC section 6.2 states',
    file: 'src/core/config.ts',
    find: 'export const STOP_SPEED = 6;',
    replace: 'export const STOP_SPEED = 7;',
    detectedBy: 'unit',
  },

  {
    // RE-POINTED AT PF-3. The statement grew a second call, because item B6's
    // reflection reads the mask `contain` returns rather than reading the four
    // bounds a second time. The property this entry attacks is unchanged:
    // remove the statement and no body is contained by anything.
    item: 'B9',
    name: 'every body is contained by the field bound, every step',
    file: 'src/core/physics.ts',
    find: `    for (const body of bodies) {
      reflect(body, contain(body));
    }`,
    replace: '    void contain;',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'containment is measured at the body edge and not at its centre',
    file: 'src/core/physics.ts',
    find: '    at.x = FIELD_LEFT + body.radius;',
    replace: '    at.x = FIELD_LEFT;',
    detectedBy: 'unit',
  },
  {
    // RE-POINTED AT PF-4. The statement grew the goal-opening exemption in
    // front of it, item B7, and the property this entry attacks is unchanged:
    // read the bound against the centre rather than against the edge and every
    // body is half of itself outside the field.
    item: 'B9',
    name: 'the containment test reads the body edge against the bound',
    file: 'src/core/physics.ts',
    find: '  if (!throughTheOpening && at.x - body.radius < FIELD_LEFT) {',
    replace: '  if (!throughTheOpening && at.x < FIELD_LEFT) {',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'the field bound is where SPEC section 3 puts it',
    file: 'src/core/config.ts',
    find: 'export const FIELD_RIGHT = 1190;',
    replace: 'export const FIELD_RIGHT = 1195;',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'the contact disc is measured from both radii',
    file: 'src/core/config.ts',
    find: 'export const CIRCLE_RADIUS = 34;',
    replace: 'export const CIRCLE_RADIUS = 35;',
    detectedBy: 'unit',
  },

  {
    // The SECOND application of the cap, at DESIGN section 3's position 5, has
    // its own entry in the PF-3 block below. PF-2 recorded a deliberate absence
    // here, because nothing between the two applications could raise a speed
    // until item B4's elastic transfer existed; PF-3 built the transfer and the
    // absence became a live entry.
    item: 'B10',
    name: 'nothing is integrated over the global speed cap',
    file: 'src/core/physics.ts',
    find: `    for (const body of bodies) {
      limit(body.velocity, SPEED_CAP);
    }`,
    replace: '    void limit;',
    detectedBy: 'unit',
  },
  {
    item: 'B10',
    name: 'the speed cap is the value SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const SPEED_CAP = 1200;',
    replace: 'export const SPEED_CAP = 2400;',
    detectedBy: 'unit',
  },
  {
    item: 'B10',
    name: 'a velocity set from outside is capped on the way in',
    file: 'src/core/bodies.ts',
    find: `  set(body.velocity, x, y);
  limit(body.velocity, SPEED_CAP);`,
    replace: '  set(body.velocity, x, y);',
    detectedBy: 'unit',
  },
  {
    item: 'B10',
    name: 'a launch is capped on the way in',
    file: 'src/core/bodies.ts',
    find: `  fromAngle(body.velocity, radians, speed);
  limit(body.velocity, SPEED_CAP);`,
    replace: '  fromAngle(body.velocity, radians, speed);',
    detectedBy: 'unit',
  },

  {
    item: 'B11',
    name: 'a non-finite position is repaired rather than propagated',
    file: 'src/core/physics.ts',
    find: `    if (!isFiniteVec2(body.position)) {
      copy(body.position, safe);
      record(body.kind, 'position');
    }`,
    replace: '    void safe;',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'a non-finite velocity is repaired rather than propagated',
    file: 'src/core/physics.ts',
    find: `    if (!isFiniteVec2(body.velocity)) {
      zero(body.velocity);
      record(body.kind, 'velocity');
    }`,
    replace: '    void body;',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'the repair source is only ever a position that was finite',
    file: 'src/core/physics.ts',
    find: '      if (body !== undefined && safe !== undefined && isFiniteVec2(body.position)) {',
    replace: '      if (body !== undefined && safe !== undefined) {',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'the development policy raises after the repair',
    file: 'src/core/physics.ts',
    find: "    if (policy === 'throw') {",
    replace: "    if (policy === 'repair') {",
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'containment leaves a non-finite position for the guard to catch',
    file: 'src/core/physics.ts',
    find: `  if (!isFiniteVec2(at)) {
    return 0;
  }
`,
    replace: '',
    detectedBy: 'unit',
  },

  {
    // There is deliberately no entry attacking the generator's warm-up draws.
    // Nothing pins an absolute value out of the stream, on purpose: a test
    // that did would be a test of this generator rather than of the property
    // item B12 states, and it would have to be rewritten the day the
    // generator is replaced. Removing the warm-up changes every sequence and
    // no assertion, which is the correct outcome for a detail nobody depends
    // on rather than a gap.
    item: 'B12',
    name: 'a stream is derived from the seed and not from its path alone',
    file: 'src/core/rng.ts',
    find: 'const words = expand(`${seed}#${path}`);',
    replace: 'const words = expand(path);',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a split stream is a new stream and not the one it came from',
    file: 'src/core/rng.ts',
    find: "    split: (name) => createStream(seed, path === '' ? name : `${path}/${name}`),",
    replace: '    split: () => stream,',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a split stream is named by its whole path from the root',
    file: 'src/core/rng.ts',
    find: "path === '' ? name : `${path}/${name}`",
    replace: 'name',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-2, second pass. Gates the part added without an entry behind them,
  // and the exported surfaces PF-3 will build on before it can.
  // ---------------------------------------------------------------------

  {
    item: 'B3',
    name: 'a zeroed vector is positive zero in both components',
    file: 'src/core/vec2.ts',
    find: `  out.x = 0;
  out.y = 0;
  return out;`,
    replace: `  out.x = out.x * 0;
  out.y = out.y * 0;
  return out;`,
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'a stopped body is an equality and not an epsilon',
    file: 'src/core/bodies.ts',
    find: '  return body.velocity.x === 0 && body.velocity.y === 0;',
    replace: '  return Math.hypot(body.velocity.x, body.velocity.y) < 1e-9;',
    detectedBy: 'unit',
  },
  {
    item: 'B3',
    name: 'a kickoff clears every velocity',
    file: 'src/core/bodies.ts',
    find: '    zero(body.velocity);',
    replace: '    void body;',
    detectedBy: 'unit',
  },

  {
    item: 'B9',
    name: 'the wall mask sets a bit for every wall that clamped',
    file: 'src/core/physics.ts',
    find: '    walls |= WALL_TOP;',
    replace: '    walls |= 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B9',
    name: 'no two walls share a bit in the mask',
    file: 'src/core/physics.ts',
    find: 'export const WALL_RIGHT = 2;',
    replace: 'export const WALL_RIGHT = 1;',
    detectedBy: 'unit',
  },

  {
    item: 'B1',
    name: 'a reset drops the accumulator',
    file: 'src/core/physics.ts',
    find: `      leftover = 0;
    },`,
    replace: '    },',
    detectedBy: 'unit',
  },
  {
    item: 'B1',
    name: 'the readout counts what it says it counts',
    file: 'src/core/physics.ts',
    find: '      return { steps, frames, leftover, repairs: repaired, clamps, resumes };',
    replace: '      return { steps, frames, leftover, repairs: repaired, clamps: 0, resumes: 0 };',
    detectedBy: 'unit',
  },

  {
    item: 'B11',
    name: 'the repair list handed out is a copy of the one kept',
    file: 'src/core/physics.ts',
    find: '    const reported = found.slice();',
    replace: '    const reported = found;',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'a reset re-arms the repair source',
    file: 'src/core/physics.ts',
    find: '          set(safe, body.position.x, body.position.y);',
    replace: '          void safe;',
    detectedBy: 'unit',
  },

  {
    item: 'B12',
    name: 'splitting a stream does not advance the stream it came from',
    file: 'src/core/rng.ts',
    find: "    split: (name) => createStream(seed, path === '' ? name : `${path}/${name}`),",
    replace: `    split: (name) => {
      nextUint32();
      return createStream(seed, path === '' ? name : \`\${path}/\${name}\`);
    },`,
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'an integer draw rejects the biased tail rather than folding it',
    file: 'src/core/rng.ts',
    find: `      const ceiling = WORD - (WORD % span);
      for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt += 1) {
        const drawn = nextUint32();
        if (drawn < ceiling) {
          return low + (drawn % span);
        }
      }`,
    replace: '      return low + (nextUint32() % span);',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a span wider than one draw is refused',
    file: 'src/core/rng.ts',
    find: '        span > WORD',
    replace: '        span > WORD * 2',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'a float draw is divided by the whole draw space',
    file: 'src/core/rng.ts',
    find: '    nextFloat: () => nextUint32() / WORD,',
    replace: '    nextFloat: () => nextUint32() / (WORD - 1),',
    detectedBy: 'unit',
  },
  {
    item: 'B12',
    name: 'the seed expansion reads every character it is given',
    file: 'src/core/rng.ts',
    find: '  for (let at = 0; at < seed.length; at += 1) {',
    replace: '  for (let at = 0; at < seed.length - 1; at += 1) {',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-3. Elastic collisions, positional separation and wall reflection.
  //
  // SPEC section 6.3 is three rules that have to be applied in one order
  // and one number of times, so the entries below attack each rule, the
  // order and the count separately: a resolver missing its gate and a
  // resolver running one pass instead of four are different defects and
  // they fail in different places.
  // ---------------------------------------------------------------------

  {
    item: 'B4',
    name: 'a step resolves body pairs at all',
    file: 'src/core/physics.ts',
    find: '    resolveContacts(world);',
    replace: '    void resolveContacts;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the impulse is gated on the pair actually approaching',
    file: 'src/core/collisions.ts',
    find: `  if (!(approach < 0)) {
    return true;
  }`,
    replace: '  void approach;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the restitution in the impulse is the one SPEC section 6.1 states',
    file: 'src/core/collisions.ts',
    find: '  const impulse = (-(1 + CIRCLE_RESTITUTION) * approach) / (1 / a.mass + 1 / b.mass);',
    replace: '  const impulse = -approach / (1 / a.mass + 1 / b.mass);',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the circle restitution is the value SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const CIRCLE_RESTITUTION = 1;',
    replace: 'export const CIRCLE_RESTITUTION = 0.5;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the impulse is divided by the reduced mass and not by two',
    file: 'src/core/collisions.ts',
    find: '(1 / a.mass + 1 / b.mass);',
    replace: '2;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the impulse is applied along the contact normal alone',
    file: 'src/core/collisions.ts',
    find: '  addScaled(a.velocity, contactNormal, -(impulse / a.mass));',
    replace: '  addScaled(a.velocity, closingVelocity, -(impulse / a.mass));',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the two bodies are pushed in opposite directions',
    file: 'src/core/collisions.ts',
    find: '  addScaled(b.velocity, contactNormal, impulse / b.mass);',
    replace: '  addScaled(b.velocity, contactNormal, -(impulse / b.mass));',
    detectedBy: 'unit',
  },
  {
    // The two totality guards, which are the reason both readings in
    // `resolvePair` are written as refusals of a proven fact rather than as the
    // comparison SPEC section 6.3 states. Flipped to the plain form, a body
    // whose position is not a number reads as a contact against a healthy one
    // and four passes shove the healthy body 104 px, which the sanitiser does
    // not undo because it repairs only the body that was poisoned. That is item
    // B11's "caught rather than propagated" clause, so both entries live under
    // B11 rather than under the collision items.
    item: 'B11',
    name: 'a position that is not a number is not a contact',
    file: 'src/core/collisions.ts',
    find: '  if (!(distanceSquared(a.position, b.position) <= reach * reach)) {',
    replace: '  if (distanceSquared(a.position, b.position) > reach * reach) {',
    detectedBy: 'unit',
  },
  {
    item: 'B11',
    name: 'a relative velocity that is not a number is not an approach',
    file: 'src/core/collisions.ts',
    find: '  if (!(approach < 0)) {',
    replace: '  if (approach >= 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'a pair that is not touching answers that it is not',
    file: 'src/core/collisions.ts',
    find: '    return false;',
    replace: '    return true;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the touching test measures both radii',
    file: 'src/core/collisions.ts',
    find: '  const reach = a.radius + b.radius;',
    replace: '  const reach = a.radius;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the touching test measures both axes',
    file: 'src/core/vec2.ts',
    find: '  return dx * dx + dy * dy;',
    replace: '  return dx * dx;',
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'a difference of two vectors is a difference',
    file: 'src/core/vec2.ts',
    find: `  out.x -= other.x;
  out.y -= other.y;`,
    replace: `  out.x += other.x;
  out.y += other.y;`,
    detectedBy: 'unit',
  },
  {
    item: 'B4',
    name: 'the approach reading projects both components',
    file: 'src/core/vec2.ts',
    find: '  return one.x * other.x + one.y * other.y;',
    replace: '  return one.x * other.x;',
    detectedBy: 'unit',
  },
  {
    // The site item B10's criterion names, "a ball accelerated by an elastic
    // transfer", and the entry PF-2 recorded as a deliberate absence because
    // nothing could yet raise a speed between the two applications of the cap.
    item: 'B10',
    name: 'the cap is applied again after the elastic transfer',
    file: 'src/core/physics.ts',
    find: `      scale(body.velocity, perStepDecay);
      limit(body.velocity, SPEED_CAP);`,
    replace: '      scale(body.velocity, perStepDecay);',
    detectedBy: 'unit',
  },

  {
    item: 'B5',
    name: 'an overlapping pair is separated positionally',
    file: 'src/core/collisions.ts',
    find: `  if (penetration > 0) {
    const half = penetration / 2;
    addScaled(a.position, contactNormal, -half);
    addScaled(b.position, contactNormal, half);
  }`,
    replace: '  void penetration;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'each body moves half the penetration and not all of it',
    file: 'src/core/collisions.ts',
    find: '    const half = penetration / 2;',
    replace: '    const half = penetration;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the two bodies are separated in opposite directions',
    file: 'src/core/collisions.ts',
    find: '    addScaled(a.position, contactNormal, -half);',
    replace: '    addScaled(a.position, contactNormal, half);',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the penetration is measured from the reach and the distance',
    file: 'src/core/collisions.ts',
    find: '  const penetration = reach - between;',
    replace: '  const penetration = reach;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'coincident centres take the fixed normal SPEC section 6.3 names',
    file: 'src/core/collisions.ts',
    find: '  const between = normalise(contactNormal, 1, 0);',
    replace: '  const between = normalise(contactNormal, 0, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the fallback normal is the one the caller asked for',
    file: 'src/core/vec2.ts',
    find: `    out.x = fallbackX;
    out.y = fallbackY;`,
    replace: `    out.x = fallbackY;
    out.y = fallbackX;`,
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'a distance under the coincidence epsilon takes the fallback',
    file: 'src/core/vec2.ts',
    find: 'measured < COINCIDENT_EPSILON',
    replace: 'measured < 0',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the pairs are resolved four times per step',
    file: 'src/core/collisions.ts',
    find: '  for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {',
    replace: '  for (let pass = 0; pass < 1; pass += 1) {',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the pass count is the one SPEC section 6.3 states',
    file: 'src/core/config.ts',
    find: 'export const SOLVER_ITERATIONS = 4;',
    replace: 'export const SOLVER_ITERATIONS = 6;',
    detectedBy: 'unit',
  },
  {
    item: 'B5',
    name: 'the pairs are resolved in the fixed order the section states',
    file: 'src/core/collisions.ts',
    find: `    resolvePair(world.player, world.opponent);
    resolvePair(world.player, world.ball);`,
    replace: `    resolvePair(world.player, world.ball);
    resolvePair(world.player, world.opponent);`,
    detectedBy: 'unit',
  },

  {
    item: 'B6',
    name: 'a clamped body has its velocity reflected at all',
    file: 'src/core/physics.ts',
    find: '      reflect(body, contain(body));',
    replace: '      contain(body);',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the left wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_LEFT) !== 0 && moving.x < 0) {
    moving.x = -moving.x * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_LEFT;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the right wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_RIGHT) !== 0 && moving.x > 0) {
    moving.x = -moving.x * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_RIGHT;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the bottom wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_BOTTOM;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the top wall reflects',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_TOP) !== 0 && moving.y > 0) {
    moving.y = -moving.y * WALL_RESTITUTION;
  }`,
    replace: '  void WALL_TOP;',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the reflection reads the mask rather than the velocity alone',
    file: 'src/core/physics.ts',
    find: '  if ((walls & WALL_LEFT) !== 0 && moving.x < 0) {',
    replace: '  if (walls >= 0 && moving.x < 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'a body already leaving a wall is not turned back into it',
    file: 'src/core/physics.ts',
    find: '  if ((walls & WALL_RIGHT) !== 0 && moving.x > 0) {',
    replace: '  if ((walls & WALL_RIGHT) !== 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the reflection is scaled by the restitution',
    file: 'src/core/physics.ts',
    find: `  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y * WALL_RESTITUTION;`,
    replace: `  if ((walls & WALL_BOTTOM) !== 0 && moving.y < 0) {
    moving.y = -moving.y;`,
    detectedBy: 'unit',
  },
  {
    item: 'B6',
    name: 'the wall restitution is the value SPEC section 6.1 states',
    file: 'src/core/config.ts',
    find: 'export const WALL_RESTITUTION = 0.92;',
    replace: 'export const WALL_RESTITUTION = 0.9;',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-4. The goal opening, the goal test and the GOAL state.
  //
  // SPEC section 6.4 is one predicate doing two jobs and a two-part goal
  // condition on top of it, so the entries below attack each job, each
  // condition and each bound separately: a transparency that stopped
  // exempting the ball and a detection that started scoring half-in balls
  // are different defects, and only one of them is visible on the pitch.
  //
  // The GOAL state entries carry item B8's label because PF-4 is where the
  // machinery was built. The criteria that grade it are item D7 and item D6
  // at PF-7 and item J2 at PF-9, and the suites named there will inherit
  // these entries rather than write them again.
  // ---------------------------------------------------------------------

  {
    item: 'B7',
    name: 'the goal opening is a rule about which body it is',
    file: 'src/core/goals.ts',
    find: `  if (body.kind !== 'ball') {
    return false;
  }`,
    replace: '  void body;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the opening test measures the whole ball at the low post',
    file: 'src/core/goals.ts',
    find: '    at.y - body.radius >= GOAL_OPENING_LOW - slack &&',
    replace: '    at.y >= GOAL_OPENING_LOW - slack &&',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the opening test measures the whole ball at the high post',
    file: 'src/core/goals.ts',
    find: '    at.y + body.radius <= GOAL_OPENING_HIGH + slack',
    replace: '    at.y <= GOAL_OPENING_HIGH + slack',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the opening is where SPEC section 3 puts it',
    file: 'src/core/config.ts',
    find: 'export const GOAL_OPENING_LOW = 265;',
    replace: 'export const GOAL_OPENING_LOW = 255;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the hysteresis is applied to a ball that is already through',
    file: 'src/core/goals.ts',
    find: '  const slack = centrePastAGoalLine(body) ? GOAL_OPENING_HYSTERESIS : 0;',
    replace: '  const slack = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the hysteresis widens the opening rather than narrowing it',
    file: 'src/core/goals.ts',
    find: '  const slack = centrePastAGoalLine(body) ? GOAL_OPENING_HYSTERESIS : 0;',
    replace: '  const slack = centrePastAGoalLine(body) ? -GOAL_OPENING_HYSTERESIS : 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the hysteresis is the value SPEC section 6.4 states',
    file: 'src/core/config.ts',
    find: 'export const GOAL_OPENING_HYSTERESIS = 0.5;',
    replace: 'export const GOAL_OPENING_HYSTERESIS = 5;',
    detectedBy: 'unit',
  },
  {
    // The documented reading in `centrePastAGoalLine`. Read as the leading
    // edge touching the line, the widened bound applies on the way in too and
    // SPEC section 6.4's condition 2 stops being the binding one.
    item: 'B7',
    name: 'a ball on its way in is judged at the exact bound',
    file: 'src/core/goals.ts',
    find: '  return body.position.x < LEFT_GOAL_LINE || body.position.x > RIGHT_GOAL_LINE;',
    replace: `  return (
    body.position.x - body.radius < LEFT_GOAL_LINE ||
    body.position.x + body.radius > RIGHT_GOAL_LINE
  );`,
    detectedBy: 'unit',
  },
  {
    // The comparison the documented reading of "already through" turns on. At
    // or past the line rather than past it, and the slack meant for a ball that
    // has gone through arrives at the position where it is deciding whether to.
    item: 'B7',
    name: 'a centre exactly on the goal line is not through yet',
    file: 'src/core/goals.ts',
    find: '  return body.position.x < LEFT_GOAL_LINE || body.position.x > RIGHT_GOAL_LINE;',
    replace: '  return body.position.x <= LEFT_GOAL_LINE || body.position.x >= RIGHT_GOAL_LINE;',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the left goal end is transparent to a ball that fits',
    file: 'src/core/physics.ts',
    find: '  if (!throughTheOpening && at.x - body.radius < FIELD_LEFT) {',
    replace: '  if (at.x - body.radius < FIELD_LEFT) {',
    detectedBy: 'unit',
  },
  {
    item: 'B7',
    name: 'the right goal end is transparent to a ball that fits',
    file: 'src/core/physics.ts',
    find: '  if (!throughTheOpening && at.x + body.radius > FIELD_RIGHT) {',
    replace: '  if (at.x + body.radius > FIELD_RIGHT) {',
    detectedBy: 'unit',
  },
  {
    // The other half of transparency, which is the half that comes free: no
    // clamp means no wall bit means no reflection. This entry puts the bit
    // back while leaving the position alone, which is a ball that passes
    // through the mouth and is turned around inside the goal.
    item: 'B7',
    name: 'a ball passing through a goal end is not turned by it',
    file: 'src/core/physics.ts',
    find: `  if (!throughTheOpening && at.x + body.radius > FIELD_RIGHT) {
    at.x = FIELD_RIGHT - body.radius;
    walls |= WALL_RIGHT;
  }`,
    replace: `  if (at.x + body.radius > FIELD_RIGHT) {
    if (!throughTheOpening) {
      at.x = FIELD_RIGHT - body.radius;
    }
    walls |= WALL_RIGHT;
  }`,
    detectedBy: 'unit',
  },

  {
    item: 'B8',
    name: 'the right goal is measured at the trailing edge, not the centre',
    file: 'src/core/goals.ts',
    find: '  if (at.x - body.radius >= RIGHT_GOAL_LINE) {',
    replace: '  if (at.x >= RIGHT_GOAL_LINE) {',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the left goal is measured at the trailing edge, not the centre',
    file: 'src/core/goals.ts',
    find: '  if (at.x + body.radius <= LEFT_GOAL_LINE) {',
    replace: '  if (at.x <= LEFT_GOAL_LINE) {',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal needs the opening test as well as the line',
    file: 'src/core/goals.ts',
    find: `  if (!ballFitsOpening(body)) {
    return undefined;
  }
  return trailingEdgePast(body);`,
    replace: '  return trailingEdgePast(body);',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the step tests for a goal at all',
    file: 'src/core/physics.ts',
    find: '    scoring.observe(world, steps);',
    replace: '    void steps;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal awards exactly one point',
    file: 'src/core/goals.ts',
    find: '      scores[scorer] += 1;',
    replace: '      scores[scorer] += 2;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the mouth the ball entered names the side that attacks it',
    file: 'src/core/goals.ts',
    find: "const SCORER: Readonly<Record<GoalMouth, Side>> = { left: 'opponent', right: 'player' };",
    replace: "const SCORER: Readonly<Record<GoalMouth, Side>> = { left: 'player', right: 'opponent' };",
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal freezes the simulation where the ball lies',
    file: 'src/core/physics.ts',
    find: `    if (scoring.frozen()) {
      scoring.holdOneStep(world);
      steps += 1;
      return;
    }`,
    replace: '    void scoring;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a goal starts the hold, which is what keeps the award to one',
    file: 'src/core/goals.ts',
    find: '      hold = GOAL_HOLD_STEPS;',
    replace: '      hold = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the hold counts down rather than running forever',
    file: 'src/core/goals.ts',
    find: '      hold -= 1;',
    replace: '      hold -= 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the celebration hold is the duration SPEC section 6.4 states',
    file: 'src/core/config.ts',
    find: 'export const GOAL_HOLD = 1.2;',
    replace: 'export const GOAL_HOLD = 1.5;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the hold is that duration counted in fixed steps',
    file: 'src/core/goals.ts',
    find: 'export const GOAL_HOLD_STEPS = Math.round(GOAL_HOLD / FIXED_STEP);',
    replace: 'export const GOAL_HOLD_STEPS = Math.round(GOAL_HOLD);',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the hold ends by putting the world back to kickoff',
    file: 'src/core/goals.ts',
    find: '      kickoff(world);',
    replace: '      void world;',
    detectedBy: 'unit',
  },
  {
    // The reset's other half, every velocity cleared, is attacked by the entry
    // above under item B3, "a kickoff clears every velocity": PF-2 built that
    // reading and PF-4 gave it a second detector in unit/goal-detection.
    item: 'B8',
    name: 'the reset puts every body back where it starts',
    file: 'src/core/bodies.ts',
    find: '    set(body.position, start.x, start.y);',
    replace: '    void start;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the goal test answers with the goal it awarded',
    file: 'src/core/goals.ts',
    find: '      return goal;',
    replace: '      return undefined;',
    detectedBy: 'unit',
  },
  {
    // The two ways a caller ends a celebration early, which PF-7 and PF-9 both
    // need: putting the world back, and starting a new match. A hold that
    // outlived either would freeze the state that replaced it.
    item: 'B8',
    name: 'putting the world back to kickoff drops a running celebration',
    file: 'src/core/physics.ts',
    find: '      scoring.clearHold();',
    replace: '      void 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a new match drops a running celebration with the scores',
    file: 'src/core/goals.ts',
    find: `      goals = 0;
      hold = 0;`,
    replace: '      goals = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'the next turn belongs to the side that conceded',
    file: 'src/core/goals.ts',
    find: '      nextTurn = last === undefined ? nextTurn : last.conceded;',
    replace: '      nextTurn = last === undefined ? nextTurn : last.scorer;',
    detectedBy: 'unit',
  },
  {
    item: 'B8',
    name: 'a target reached ends the match instead of kicking off',
    file: 'src/core/goals.ts',
    find: `      if (target !== undefined && scores[scorer] >= target) {
        over = true;
      }`,
    replace: '      void target;',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-7. The match around the simulation: the turn-end conjunction, the
  // opponent's pre-launch wait, the goal hold routing and the restart.
  //
  // The conjunction gets one entry per half, because the halves prevent
  // different defects: a turn handed back while a body still moves, and a
  // turn handed back while the celebration is still running. The restart
  // order gets one entry for the protection the order provides rather than
  // for the textual order itself: within one synchronous restart, swapping
  // the two calls is state-identical and would be an undetectable entry, so
  // the entry drops the world reset entirely, which is the defect the order
  // exists to prevent and which tests/unit/goal-reset.test.ts watches for.
  // ---------------------------------------------------------------------

  {
    item: 'D1',
    name: 'a turn ends only when every body has stopped',
    file: 'src/core/match.ts',
    find: '      const turnOver = everyBodyStopped(sim.world) && !scoringNow.frozen;',
    replace: '      const turnOver = !scoringNow.frozen;',
    detectedBy: 'unit',
  },
  {
    item: 'D1',
    name: 'a turn at rest still waits for a running celebration to lift',
    file: 'src/core/match.ts',
    find: '      const turnOver = everyBodyStopped(sim.world) && !scoringNow.frozen;',
    replace: '      const turnOver = everyBodyStopped(sim.world);',
    detectedBy: 'unit',
  },
  {
    item: 'D1',
    name: 'a launch routes through MOVING with no special case',
    file: 'src/core/match.ts',
    find: "        state = { kind: 'MOVING', launchedBy: 'player' };",
    replace: "        state = { kind: 'PLAYER_TURN' };",
    detectedBy: 'unit',
  },
  {
    item: 'D2',
    name: 'the seam reads the whole delay from the config',
    file: 'src/core/match.ts',
    find: '      if (!opponentReady && opponentDelay >= OPPONENT_PRELAUNCH_DELAY) {',
    replace: '      if (!opponentReady && opponentDelay >= OPPONENT_PRELAUNCH_DELAY / 2) {',
    detectedBy: 'unit',
  },
  {
    item: 'D2',
    name: 'the wait accumulates the deltas it is driven with',
    file: 'src/core/match.ts',
    find: '      opponentDelay += elapsedOf(dt);',
    replace: '      opponentDelay = elapsedOf(dt);',
    detectedBy: 'unit',
  },
  {
    item: 'D6',
    name: 'the kickoff after a goal belongs to the side that conceded',
    file: 'src/core/match.ts',
    find: '        enterKickoff(state.goal.conceded);',
    replace: '        enterKickoff(state.goal.scorer);',
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'the match leaves GOAL when the freeze lifts, not while it runs',
    file: 'src/core/match.ts',
    find: '      } else if (!scoringNow.frozen) {',
    replace: '      } else {',
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'the goal reset preserves both scores',
    file: 'src/core/goals.ts',
    find: `      nextTurn = last === undefined ? nextTurn : last.conceded;
      kickoff(world);`,
    replace: `      nextTurn = last === undefined ? nextTurn : last.conceded;
      kickoff(world);
      scores.player = 0;
      scores.opponent = 0;`,
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'a goal does not restore the match clock',
    file: 'src/core/match.ts',
    find: '        enterKickoff(state.goal.conceded);',
    replace: '        remaining = options.duration;\n        enterKickoff(state.goal.conceded);',
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'the clock ticks through the celebration as well',
    file: 'src/core/match.ts',
    find:
      "    kind === 'PLAYER_TURN' || kind === 'OPPONENT_TURN' || kind === 'MOVING' || kind === 'GOAL'",
    replace: "    kind === 'PLAYER_TURN' || kind === 'OPPONENT_TURN' || kind === 'MOVING'",
    detectedBy: 'unit',
  },
  {
    item: 'D7',
    name: 'a new match puts the world back before the scoreboard is cleared',
    file: 'src/core/match.ts',
    find: `    sim.reset();
    scoring.reset();`,
    replace: '    scoring.reset();',
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-8. The opponent routine: the reachable cone, the difficulty
  // parameters and the power band, and the seam that answers them.
  //
  // The clamp gets one entry per stated property - the cone itself, the
  // solidity floor, the exact contact point - because a clamp that reads
  // the whole plane, a clamp without its floor and an aim with a safety
  // margin are three different defects that fail in different places. The
  // aim distance gets an entry in BOTH directions, past the contact point
  // and short of it, because the short one is the defect that shipped. The
  // difficulty entries attack the draws the table states rather than the
  // profile constants anybody can check by eye.
  //
  // RE-POINTED AND RETIRED at the 2026-09-08 aim fix, which rewrote the
  // lines three of these anchored on and removed the property a fourth
  // named. The three keep their mutation and their property exactly: the
  // cone test moved from `floor` to `bound`, the floor moved from the
  // Math.max onto the bound the transfer inverts to, and the aim moved to
  // the touching distance. The retired one, "the routine declines the
  // strike that drives the ball backwards", named a geometric decline SPEC
  // section 8 does not have: `defensiveBias` is THE probability of
  // substituting the block, so the decline was removed and its entry is
  // replaced one for one by "the block is substituted at the profile's
  // probability and no other", which attacks the rule that took its place.
  // ---------------------------------------------------------------------

  {
    item: 'D3',
    name: 'the clamp reads the reachable cone and not the whole plane',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  if (along >= bound) {',
    replace: '  if (true) {',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the floor holds the clamped side above a graze',
    file: 'src/core/ai.ts', // the opponent routine
    // The bare reachability bound of SPEC section 8.1 read as a cosine,
    // which admits a side whose speed transfer is a graze: the reading the
    // floor exists to refuse.
    find: '  return (TOUCHING * spread + MIN_STRIKE_SOLIDITY * Math.sqrt(inner)) / gap;',
    replace: '  return TOUCHING / gap;',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the launch aims at the contact point and not past it',
    file: 'src/core/ai.ts', // the opponent routine
    // SPEC section 8.1's own sentence: 2 px beyond the touching distance
    // turns a solid hit into a whiff.
    find: '  return { x: ball.x + side.x * TOUCHING, y: ball.y + side.y * TOUCHING };',
    replace:
      '  return { x: ball.x + side.x * (TOUCHING + 2), y: ball.y + side.y * (TOUCHING + 2) };',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the launch aims at the touching distance and not the ball surface',
    file: 'src/core/ai.ts', // the opponent routine
    // The other direction, and the defect that actually shipped: the aim
    // at the ball's own surface, 34 px inside the contact disc, which the
    // reachability test is not derived for and which leaves the ball 20 to
    // 25 degrees off the side the clamp chose.
    find: '  return { x: ball.x + side.x * TOUCHING, y: ball.y + side.y * TOUCHING };',
    replace:
      '  return { x: ball.x + side.x * BALL_RADIUS, y: ball.y + side.y * BALL_RADIUS };',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'a degenerate direction leaves on the stated fallback and not as NaN',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  if (!(length > 0) || !Number.isFinite(length)) {',
    replace: '  if (false) {',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'a gap the cone arithmetic cannot hold leaves by the stated door',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  if (!(gap >= TOUCHING) || !Number.isFinite(bound)) {',
    replace: '  if (!(gap >= TOUCHING)) {',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the seam answers with the planned strength and not a stub',
    file: 'src/core/ai.ts', // the opponent routine
    find: "  match.dispatch({ kind: 'launch', angle: plan.angle, power: plan.power });",
    replace: "  match.dispatch({ kind: 'launch', angle: plan.angle, power: 0 });",
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the angular error spans the range the table states',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const errorRad = (2 * rng.nextFloat() - 1) * spanRad;',
    replace: '  const errorRad = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the whiff roll is a real possibility and not a vestige',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const whiffed = rng.nextFloat() < profile.whiffChance;',
    replace: '  const whiffed = false;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'a whiff lays the aim off the ball by the stated offset',
    file: 'src/core/ai.ts', // the opponent routine
    find: '    const offset = WHIFF_OFFSET * TOUCHING;',
    replace: '    const offset = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the whiff offset is the stated multiple',
    file: 'src/core/ai.ts', // the opponent routine
    // A neighbouring value, because the entry above only proves the offset
    // is non-zero and SPEC section 8 states this one by value.
    find: 'export const WHIFF_OFFSET = 1.15;',
    replace: 'export const WHIFF_OFFSET = 1.16;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'a whiff clears the ball at short range',
    file: 'src/core/ai.ts', // the opponent routine
    // The replacement is the reading that shipped: the offset laid off the
    // ball centre as an aim POINT, whose launch line carries only
    // offset * gap / hypot(gap, offset) of it and grazes the ball below a
    // gap of 105.3 px. The gap sweep in tests/unit/ai-difficulty.test.ts
    // catches it at the short end.
    find: '    const clearance = Math.min(offset, reach);',
    replace:
      '    const clearance = (offset * reach) / Math.hypot(reach, offset);',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the block is substituted at the profile probability and no other',
    file: 'src/core/ai.ts', // the opponent routine
    // Replaces the entry the geometric decline used to carry. SPEC section
    // 8 gives 0.0, 0.15 and 0.30; an inflated roll gives Casual a block on
    // a quarter of its turns, which is the shape of the defect the audit
    // found and which the measured rate now refuses.
    find: '  const defensiveRoll = rng.nextFloat() < profile.defensiveBias;',
    replace: '  const defensiveRoll = rng.nextFloat() < profile.defensiveBias + 0.25;',
    detectedBy: 'unit',
  },
  {
    item: 'D5',
    name: 'the power draw follows the stated aggression transform',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const drawnPower = low + (high - low) * rng.nextFloat() ** (1 - profile.aggression);',
    replace: '  const drawnPower = low + (high - low) * rng.nextFloat();',
    detectedBy: 'unit',
  },
  {
    item: 'D5',
    name: 'a derived shot asks for the trip margin the routine promises',
    file: 'src/core/ai.ts', // the opponent routine
    find: 'const POWER_MARGIN = 1.4;',
    replace: 'const POWER_MARGIN = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'D5',
    name: 'the band of the profile bounds the drawn power',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  const [low, high] = profile.powerBand;',
    replace: '  const [low, high] = [0, 1];',
    detectedBy: 'unit',
  },
  // The reference implementation is a graded artifact of the same fix: it
  // is where item D3's expected sides, angles and departures come from, so
  // an entry proves it is measured against rather than merely imported, and
  // a second proves the scan that keeps it independent can still see an
  // import. Both edits are single edits to a file the suite reads, which is
  // the same shape as the design-contract fixture entries above.

  {
    item: 'D3',
    name: 'the expected geometry comes from the reference and not from the routine',
    file: 'tests/unit/reference/strike-geometry.ts', // the SPEC-first strike geometry
    find: 'export const TOUCHING = STRIKER_RADIUS + BALL_RADIUS;',
    replace: 'export const TOUCHING = BALL_RADIUS;',
    detectedBy: 'unit',
  },
  {
    // RE-POINTED inside the same change: the scan grew from a path check to a
    // specifier walk that also refuses the package alias and a helper next
    // door, so the line it anchors on was rewritten. Same mutation, same
    // property: a matcher that never matches.
    item: 'D3',
    name: 'the independence scan can still recognise an import of the game',
    file: 'tests/unit/reference-independence.test.ts', // the reference independence scan
    find: "  return !(specifier.startsWith('./') && !specifier.includes('..'));",
    replace: '  return false;',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the solidity is the transfer of the launch and not the approach cosine',
    file: 'src/core/ai.ts', // the opponent routine
    // The reading the routine carried before the aim was corrected, restored
    // in one edit: `along` IS dot(approach, side), the approach cosine, which
    // this function's own argument list already holds. At a gap of 200 the
    // cone boundary transfers 0.25 and its approach cosine is 0.48570, so the
    // two readings are distinct wherever the clamp is doing any work.
    find: '  return (reach - TOUCHING) / Math.sqrt(leg);',
    replace: '  return along;',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the clamp breaks its tie on the stated perpendicular',
    file: 'src/core/ai.ts', // the opponent routine
    // The other wall of the cone, which is equally close and equally
    // admissible: the choice has to be the stated one or a seeded match
    // stops replaying.
    find: '    { x: -approach.y, y: approach.x },',
    replace: '    { x: approach.y, y: -approach.x },',
    detectedBy: 'unit',
  },
  {
    item: 'D3',
    name: 'the degenerate ideal falls back to the approach and not to its reverse',
    file: 'src/core/ai.ts', // the opponent routine
    // A target coincident with the ball leaves no ideal side, and the stated
    // fallback is the approach, which sends the ball away from the striker.
    // The reverse is the direction that drives it back through the striker,
    // and it is finite, unit and clamps to the floor, so a case that reads
    // only those three properties cannot tell the two apart. The case in
    // tests/unit/ai-aim.test.ts reads the side by coordinates instead.
    find: '  const ideal = unitOr(ball.x - target.x, ball.y - target.y, approach);',
    replace:
      '  const ideal = unitOr(ball.x - target.x, ball.y - target.y, { x: -approach.x, y: -approach.y });',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'a rolled block refuses only the lane that would play the ball',
    file: 'src/core/ai.ts', // the opponent routine
    // The refusal is what separates the roll rate from the substitution
    // rate, and both are pinned; a refusal that never fires moves the
    // second onto the first.
    find: '  return Math.hypot(nearestX - ball.x, nearestY - ball.y) >= TOUCHING;',
    replace: '  return true;',
    detectedBy: 'unit',
  },
  {
    item: 'D4',
    name: 'the whiff passes on the side the error draw names',
    file: 'src/core/ai.ts', // the opponent routine
    find: '    const sign = errorRad < 0 ? -1 : 1;',
    replace: '    const sign = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the ladder rung that always overhits keeps doing so',
    file: 'src/core/ai.ts', // the opponent routine
    find: "  { name: 'Sparks', profile: { ...CASUAL, aggression: 1 } },",
    replace: "  { name: 'Sparks', profile: { ...CASUAL, aggression: 0.2 } },",
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the wild rung stays wilder than its base difficulty',
    file: 'src/core/ai.ts', // the opponent routine
    find:
      "  { name: 'Bolt', profile: { ...CASUAL, angularErrorDeg: 16, aggression: 0.75 } },",
    replace:
      "  { name: 'Bolt', profile: { ...CASUAL, angularErrorDeg: 12, aggression: 0.75 } },",
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the blocking rung actually aims to block',
    file: 'src/core/ai.ts', // the opponent routine
    find: "  { name: 'Anchor', profile: { ...PRO, defensiveBias: 0.85 } },",
    replace: "  { name: 'Anchor', profile: { ...PRO, defensiveBias: 0 } },",
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'wall candidates reach the routine that scores them',
    file: 'src/core/ai.ts', // the opponent routine
    find: '  if (profile.useWallShots) {',
    replace: '  if (false) {',
    detectedBy: 'unit',
  },
  {
    item: 'D8',
    name: 'the best candidate is the one the physics favours',
    file: 'src/core/ai.ts', // the opponent routine
    find: '      if (score > bestScore) {',
    replace: '      if (false) {',
    detectedBy: 'unit',
  },

  // PF-11, pitch and entity rendering. The armour behind these entries is
  // tests/unit/render-*.test.ts: a recorder context censuses the draw calls,
  // so every entry here either changes what is drawn, what it is drawn with,
  // or how often it is drawn, and the census pins all three.

  {
    // RE-POINTED at PF-12: the one transform grew SPEC section 14's shake as
    // two offset parameters, so the line this entry quotes was reworded. The
    // mutation is the same one, the y flip turned off, and the property it
    // protects is unchanged.
    item: 'E3',
    name: 'the one transform maps design space y up, flipped',
    file: 'src/render/surface.ts',
    find:
      'context.setTransform(scale, 0, 0, -scale, offsetX, LOGICAL_HEIGHT * scale + offsetY);',
    replace:
      'context.setTransform(scale, 0, 0, scale, offsetX, LOGICAL_HEIGHT * scale + offsetY);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'a collapsed host still gets a one-pixel backing store',
    file: 'src/render/surface.ts',
    find: 'const width = Math.max(1, Math.round(cssWidth * deviceRatio));',
    replace: 'const width = Math.round(cssWidth * deviceRatio);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the surface is hidden from the accessibility tree',
    file: 'src/render/surface.ts',
    find: "canvas.setAttribute('aria-hidden', 'true');",
    replace: "canvas.setAttribute('aria-hidden', 'false');",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the surface carries the stable selection marker',
    file: 'src/render/surface.ts',
    find: "canvas.dataset['pf'] = 'play-surface';",
    replace: "canvas.dataset['pf'] = 'surface';",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the stripe count comes from the spacing scale, and stays even',
    file: 'src/render/pitch.ts',
    find: 'const count = Math.ceil(FIELD_WIDTH / STRIPE_WIDTH);',
    replace: 'const count = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the vignette fades the stripes and then hands the alpha back',
    file: 'src/render/pitch.ts',
    find: 'context.globalAlpha = VIGNETTE_EDGE_ALPHA;',
    replace: 'context.globalAlpha = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the rail boundary is a hairline, the one the section measures',
    file: 'src/render/pitch.ts',
    find: 'context.lineWidth = BORDER.hair;',
    replace: 'context.lineWidth = BORDER.thick;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the end walls sit outside the field bounds',
    file: 'src/render/pitch.ts',
    find: 'const left = FIELD_LEFT - WALL_THICKNESS;',
    replace: 'const left = FIELD_LEFT;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the centre spot stays the small radius step',
    file: 'src/render/pitch.ts',
    find: 'context.arc(BALL_START_X, BALL_START_Y, RADIUS.sm, 0, TAU);',
    replace: 'context.arc(BALL_START_X, BALL_START_Y, CENTRE_CIRCLE_RADIUS, 0, TAU);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'each goal frame is tinted to the side that defends it',
    file: 'src/render/pitch.ts',
    find: 'context.fillStyle = index === 0 ? palette.teamPlayer : palette.teamOpponent;',
    replace: 'context.fillStyle = index === 0 ? palette.teamOpponent : palette.teamPlayer;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the static pitch is cached, not rebuilt every frame',
    file: 'src/render/pitch.ts',
    find: 'if (layer === null || !pitchLayerIsCurrent(layer, surface, palette)) {',
    replace: 'if (true) {',
    detectedBy: 'unit',
  },
  {
    // RE-POINTED at PF-12: the blit now carries the shake offset, so the call
    // this entry quotes takes two more arguments. Same mutation, same
    // property: leave the surface in device space and the whole scene after
    // the blit is drawn at backing-store coordinates.
    item: 'E3',
    name: 'the blit returns the surface to design space',
    file: 'src/render/pitch.ts',
    find: 'applySurfaceTransform(surface.context, surface.scale, shake.x, shake.y);',
    replace: 'surface.context.setTransform(1, 0, 0, 1, 0, 0);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'every circle carries its facing marker',
    file: 'src/render/entities.ts',
    find: '  drawMarker(context, body, facing, glyphColour);',
    replace: '  ;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the ball boundary ring draws at the border step, like the circles',
    file: 'src/render/entities.ts',
    find:
      '  context.strokeStyle = palette.line;\n' +
      '  context.lineWidth = BORDER.thick;\n' +
      '  context.beginPath();\n' +
      '  context.arc(x, y, body.radius, 0, TAU);\n' +
      '  context.stroke();\n' +
      '}',
    replace:
      '  context.strokeStyle = palette.line;\n' +
      '  context.lineWidth = BORDER.hair;\n' +
      '  context.beginPath();\n' +
      '  context.arc(x, y, body.radius, 0, TAU);\n' +
      '  context.stroke();\n' +
      '}',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the kickoff glyphs are the ones SPEC section 4 names',
    file: 'src/render/entities.ts',
    find: "export const DEFAULT_GLYPHS: Glyphs = { player: 'P', opponent: 'O' };",
    replace: "export const DEFAULT_GLYPHS: Glyphs = { player: 'X', opponent: 'X' };",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the glyph counter-flip is a real flip',
    file: 'src/render/entities.ts',
    find: 'context.scale(1, -1);',
    replace: 'context.scale(1, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the central panel of the ball is a real pentagon',
    file: 'src/render/entities.ts',
    find: 'const PANEL_RADIUS = 0.42;',
    replace: 'const PANEL_RADIUS = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the rim patches reach into the clip',
    file: 'src/render/entities.ts',
    find: 'const PATCH_RADIUS = 0.3;',
    replace: 'const PATCH_RADIUS = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the ball draws, and draws last in the entity pass',
    file: 'src/render/entities.ts',
    find: '  drawBall(context, palette, world.ball);',
    replace: '  ;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the shipping entry never imports the capture hooks',
    file: 'src/main.ts',
    find: "import { drawFrame } from './render/pitch';",
    replace: "import { drawFrame } from './render/pitch';\nimport '../render/capture';",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the capture module never joins the emitted bytes by chunk either',
    file: 'src/main.ts',
    find: 'mount(host);',
    replace: "mount(host);\nimport('./render/capture');",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the hooks register under the key the capture script reads',
    file: 'src/render/capture.ts',
    find: "export const CAPTURE_KEY = '__pfCapture';",
    replace: "export const CAPTURE_KEY = '__pfSomethingElse';",
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the density watch arms a live query and re-arms on every fire',
    file: 'src/render/surface.ts',
    find: 'query = win.matchMedia(`(resolution: ${String(ratio)}dppx)`);',
    replace: 'query = null;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'a layer is stale when the backing-store height moves too',
    file: 'src/render/pitch.ts',
    find: 'layer.canvas.height === surface.canvas.height',
    replace: 'layer.canvas.height === layer.canvas.height',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the capture hooks re-derive the scale on every redraw',
    file: 'src/render/capture.ts',
    find: '      surface.scale = scaleOf(seams.canvas);',
    replace: '      ;',
    detectedBy: 'unit',
  },
  {
    item: 'E3',
    name: 'the composition root asks the theme the stylesheet answers',
    file: 'src/main.ts',
    find: "const THEME_QUERY = '(prefers-color-scheme: dark)';",
    replace: "const THEME_QUERY = '(prefers-color-scheme: light)';",
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-13. The HUD and the panels as real DOM, and the gates the part
  // added: the MM:SS ceiling, the per-phase presence and reachability of
  // the pause control, the census of focusable controls per screen, the
  // derivation of every panel from the readout, and the scan that keeps a
  // pointer coordinate away from a chrome rectangle. The scan's own
  // entries are detected by the inventory that pins the matchers, the
  // positive controls and the empty exemption lists as source, because a
  // weakened scan over a clean tree still passes it.
  // ---------------------------------------------------------------------

  {
    item: 'M1',
    name: 'the clock face is the ceiling of the exact seconds',
    file: 'src/ui/components/clock.ts',
    find: '  return Math.ceil(remaining);',
    replace: '  return Math.round(remaining);',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the clock reads 00:00 only at exactly zero',
    file: 'src/ui/components/clock.ts',
    find: `  if (!(remaining > 0)) {
    return 0;
  }`,
    replace: `  if (remaining < 1) {
    return 0;
  }`,
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the turn indicator names the side and the state',
    file: 'src/ui/components/hud.ts',
    // RE-POINTED at PF-9: SPEC section 9's Hotseat names the player's own
    // side, so the return became a conditional. Same string, same break.
    find: "        ? 'YOUR TURN'",
    replace: "        ? 'YOUR GO'",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the pause control is reachable in exactly the four in-play states',
    file: 'src/ui/components/hud.ts',
    find: `  'MOVING',
  'GOAL',
];`,
    replace: `  'MOVING',
];`,
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'a refused pause is refused without needing a pointer',
    file: 'src/ui/components/hud.ts',
    find: "    if (pause.getAttribute('aria-disabled') === 'true') {",
    replace: "    if (pause.getAttribute('aria-disabled') === 'never') {",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'a panel opens when its wiring shows it',
    file: 'src/ui/components/panel.ts',
    find: '      root.hidden = false;',
    replace: '      root.hidden = true;',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the census freezes the named controls per screen',
    file: 'src/ui/components/pause-panel.ts',
    find: "  panel.addControl(button('Resume', options.onResume));",
    replace: "  panel.addControl(button('Continue', options.onResume));",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'panel visibility is derived from the readout on every sync',
    file: 'src/ui/layout.ts',
    // RE-POINTED at PF-9: the pause reading became a named predicate when the
    // stack moved to closing on the EDGE of the pause. The same predicate is
    // inverted, so the same derivation is broken.
    find: "    const paused = readout.state.kind === 'PAUSED';",
    replace: "    const paused = readout.state.kind !== 'PAUSED';",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the game-over panel words the result as the spec states it',
    file: 'src/ui/components/game-over-panel.ts',
    find: "    return 'You win!';",
    replace: "    return 'You lose!';",
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the pause stack closes with the pause, whatever dismissed it',
    file: 'src/ui/layout.ts',
    // RE-POINTED at PF-9: the same block, one level deeper inside the edge
    // test the menu's own overlay required. Same block, same break.
    find: `        if (settings.isOpen()) {
          settings.hide();
        }`,
    replace: '      void settings;',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the game-over panel hands focus to a stable anchor on the way out',
    file: 'src/ui/layout.ts',
    find: '        game.show(hud.pause);',
    replace: '        game.show();',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the coordinate matcher reads every way a pointer coordinate arrives',
    file: 'tests/unit/chrome-dom.test.ts',
    find: String.raw`const POINTER_COORDINATE = /\.(?:clientX|clientY|pageX|pageY|screenX|screenY|offsetX|offsetY)\b/;`,
    replace: String.raw`const POINTER_COORDINATE = /\.(?:clientY|pageX|pageY|screenX|screenY|offsetX|offsetY)\b/;`,
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'the scan is proved live by its positive controls',
    file: 'tests/unit/chrome-dom.test.ts',
    find: "  'const x = pointer.pageY;',\n",
    replace: '',
    detectedBy: 'unit',
  },
  {
    item: 'M1',
    name: 'an exemption from the scan can only be added by name, here',
    file: 'tests/unit/chrome-dom.test.ts',
    // RE-POINTED AT PF-5, which earned the list its first and only entry.
    // The property is unchanged: an exemption added anywhere but here, by
    // name, is caught by the inventory that pins both lists as source. The
    // mutation now adds a SECOND name to a list the inventory pins at one.
    find: `/** Checked exemptions: a path may hold a pattern only by name, here. */
const EXEMPT_COORDINATE: readonly string[] = ['render/input.ts'];`,
    replace: `/** Checked exemptions: a path may hold a pattern only by name, here. */
const EXEMPT_COORDINATE: readonly string[] = ['render/input.ts', 'render/surface.ts'];`,
    detectedBy: 'unit',
  },

  // ---------------------------------------------------------------------
  // PF-5. Pointer aiming: what a drag means, the mapping that gets it into
  // design space, the arrow that previews it, and the four states that
  // refuse it.
  //
  // The mapping gets one entry per term rather than one for the whole
  // expression, because a dropped scale, a dropped origin and a dropped
  // flip are three different defects and two of them are invisible at the
  // centre of the pitch, where the flip is its own mirror image.
  //
  // The five entries at the end name the browser suite, and they are the
  // only ones in this file that do. Each attacks the composition root's own
  // wiring, which no unit test reaches: whether the pointer input is
  // attached to the surface at all, whether the aim pass is drawn, whether
  // the launch intent carries the aim it previewed, and whether the match
  // is advanced with the frame's own delta. A unit detector cannot see any
  // of it, so an entry claiming one would be an entry that cannot fail.
  // ---------------------------------------------------------------------

  {
    item: 'C2',
    name: 'the aim is opposite the drag in both components',
    file: 'src/core/aiming.ts',
    find: 'aim: { angleRad: Math.atan2(-y, -x), power01: power01(dragged) },',
    replace: 'aim: { angleRad: Math.atan2(-y, x), power01: power01(dragged) },',
    detectedBy: 'unit',
  },
  {
    item: 'C2',
    name: 'a drag is measured as a distance and not as one component',
    file: 'src/core/aiming.ts',
    find: '  const dragged = Math.hypot(x, y);',
    replace: '  const dragged = Math.abs(x);',
    detectedBy: 'unit',
  },
  {
    item: 'C4',
    name: "the arrow's reach is clamped at the maximum drag",
    file: 'src/core/aiming.ts',
    find: '    reach: Math.min(dragged, MAX_DRAG),',
    replace: '    reach: dragged,',
    detectedBy: 'unit',
  },
  {
    item: 'C3',
    name: 'the minimum drag itself launches, and only below it cancels',
    file: 'src/core/aiming.ts',
    find: '    launchable: dragged >= MIN_DRAG,',
    replace: '    launchable: dragged > MIN_DRAG,',
    detectedBy: 'unit',
  },
  {
    item: 'C1',
    name: "aiming happens in the player's own turn and in no other state",
    file: 'src/core/aiming.ts',
    find: "  return state.kind === 'PLAYER_TURN' && everyBodyStopped(world);",
    replace: "  return state.kind !== 'MENU' && everyBodyStopped(world);",
    detectedBy: 'unit',
  },
  {
    item: 'C8',
    name: 'aiming is refused while any body is still moving',
    file: 'src/core/aiming.ts',
    find: "'PLAYER_TURN' && everyBodyStopped(world);",
    replace: "'PLAYER_TURN';",
    detectedBy: 'unit',
  },
  {
    item: 'C1',
    name: "a press is measured against the circle's own radius",
    file: 'src/core/aiming.ts',
    find: '  return dx * dx + dy * dy <= body.radius * body.radius;',
    replace: '  return dx * dx + dy * dy <= body.radius * body.radius * 4;',
    detectedBy: 'unit',
  },
  {
    item: 'C1',
    name: 'the press has to land on your own circle and not on a circle',
    file: 'src/core/aiming.ts',
    find: 'pressLandsOn(world.player, x, y)',
    replace: 'pressLandsOn(world.opponent, x, y)',
    detectedBy: 'unit',
  },

  {
    item: 'C3',
    name: 'the minimum drag is the value SPEC section 5 states',
    file: 'src/core/config.ts',
    find: 'export const MIN_DRAG = 30;',
    replace: 'export const MIN_DRAG = 40;',
    detectedBy: 'unit',
  },
  {
    item: 'C4',
    name: 'the maximum drag is the value SPEC section 5 states',
    file: 'src/core/config.ts',
    find: 'export const MAX_DRAG = 180;',
    replace: 'export const MAX_DRAG = 200;',
    detectedBy: 'unit',
  },

  {
    item: 'C5',
    name: 'a pointer is scaled from the rectangle into the logical width',
    file: 'src/render/input.ts',
    find: '    x: ((clientX - rect.left) * LOGICAL_WIDTH) / rect.width,',
    replace: '    x: clientX - rect.left,',
    detectedBy: 'unit',
  },
  {
    item: 'C5',
    name: 'the y axis is flipped into the design space',
    file: 'src/render/input.ts',
    find: '    y: LOGICAL_HEIGHT - ((clientY - rect.top) * LOGICAL_HEIGHT) / rect.height,',
    replace: '    y: ((clientY - rect.top) * LOGICAL_HEIGHT) / rect.height,',
    detectedBy: 'unit',
  },
  {
    item: 'C5',
    name: "the rectangle's own left edge carries the letterbox across",
    file: 'src/render/input.ts',
    find: '(clientX - rect.left)',
    replace: 'clientX',
    detectedBy: 'unit',
  },
  {
    item: 'C5',
    name: "the rectangle's own top edge carries the letterbox down",
    file: 'src/render/input.ts',
    find: '(clientY - rect.top)',
    replace: 'clientY',
    detectedBy: 'unit',
  },
  {
    item: 'C5',
    name: 'the rectangle is read per event and never cached across a scroll',
    file: 'src/render/input.ts',
    find: `  function rectNow(): SurfaceRect {
    const box = canvas.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }`,
    replace: `  let cachedRect: SurfaceRect | null = null;
  function rectNow(): SurfaceRect {
    if (cachedRect === null) {
      const box = canvas.getBoundingClientRect();
      cachedRect = { left: box.left, top: box.top, width: box.width, height: box.height };
    }
    return cachedRect;
  }`,
    detectedBy: 'unit',
  },
  {
    // The defect QUALITY-BAR section 7 names in as many words: the ratio put
    // back into a chain that is already in CSS pixels, so the arithmetic
    // divides by it twice. Nothing about the mapping's OUTPUT can refute a
    // read it does not make, so the gate here is the source scan that asserts
    // this file never asks the platform for the ratio, and this is what
    // requires that scan to be able to fail.
    item: 'C5',
    name: 'the device pixel ratio is kept out of the input mapping',
    file: 'src/render/input.ts',
    find: `  return {
    x: ((clientX - rect.left) * LOGICAL_WIDTH) / rect.width,`,
    replace: `  const ratio = window.devicePixelRatio;
  return {
    x: ((clientX - rect.left) * LOGICAL_WIDTH * ratio) / rect.width,`,
    detectedBy: 'unit',
  },
  {
    item: 'C8',
    name: 'the lock is asked once a frame, not only at the press and the release',
    file: 'src/render/input.ts',
    find: `      if (live !== null && !aimingAllowed(options.state(), options.world)) {
        endGesture();
      }`,
    replace: '      void endGesture;',
    detectedBy: 'unit',
  },
  {
    item: 'C1',
    name: 'a drag takes a pointer capture on pointerdown',
    file: 'src/render/input.ts',
    find: '    canvas.setPointerCapture(event.pointerId);',
    replace: '    void event;',
    detectedBy: 'unit',
  },
  {
    item: 'C1',
    name: 'touch-action is none for the duration of the capture only',
    file: 'src/render/input.ts',
    find: '    canvas.style.touchAction = TOUCH_DRAGGING;',
    replace: '    canvas.style.touchAction = TOUCH_IDLE;',
    detectedBy: 'unit',
  },
  {
    item: 'C8',
    name: 'a second pointer arriving mid-drag is not a second aim',
    file: 'src/render/input.ts',
    find: `    if (captured !== null) {
      return;
    }`,
    replace: '    void captured;',
    detectedBy: 'unit',
  },
  {
    item: 'C3',
    name: 'a release below the minimum drag launches nothing',
    file: 'src/render/input.ts',
    find: '    if (finished !== null && finished.launchable && allowed) {',
    replace: '    if (finished !== null && allowed) {',
    detectedBy: 'unit',
  },
  {
    item: 'C8',
    name: 'the lock is asked again at the release, not only at the press',
    file: 'src/render/input.ts',
    find: '    const allowed = aimingAllowed(options.state(), options.world);',
    replace: '    const allowed = true;',
    detectedBy: 'unit',
  },
  {
    item: 'C3',
    name: 'the mirrored phase names a sub-minimum aim apart from a launchable one',
    file: 'src/render/input.ts',
    find: '  return preview.launchable ? PHASE_AIMING : PHASE_BELOW_MINIMUM;',
    replace: '  return PHASE_AIMING;',
    detectedBy: 'unit',
  },

  {
    item: 'C7',
    name: 'the arrowhead is clamped by the shaft it sits on',
    file: 'src/render/arrow.ts',
    find: '  const headLength = Math.min(HEAD_LENGTH, shaftLength / 2);',
    replace: '  const headLength = HEAD_LENGTH;',
    detectedBy: 'unit',
  },
  {
    item: 'C7',
    name: 'the clamp is half the shaft rather than the whole of it',
    file: 'src/render/arrow.ts',
    find: 'Math.min(HEAD_LENGTH, shaftLength / 2)',
    replace: 'Math.min(HEAD_LENGTH, shaftLength)',
    detectedBy: 'unit',
  },
  {
    item: 'C2',
    name: 'the arrow starts at the circle centre',
    file: 'src/render/arrow.ts',
    find: '    at(0, half),',
    replace: '    at(-half, half),',
    detectedBy: 'unit',
  },
  {
    item: 'C4',
    name: 'the strength ramp runs from the boundary token to the accent',
    file: 'src/render/arrow.ts',
    find: '  return mixed(palette.line, palette.accent, amount);',
    replace: '  return mixed(palette.accent, palette.line, amount);',
    detectedBy: 'unit',
  },
  {
    item: 'C3',
    name: 'the sub-minimum signal is drawn outside the rim',
    file: 'src/render/arrow.ts',
    find: `  if (!preview.launchable) {
    drawBelowMinimumRing(context, palette, body);
  }`,
    replace: '  void drawBelowMinimumRing;',
    detectedBy: 'unit',
  },
  {
    item: 'C3',
    name: 'the sub-minimum arrow carries no fill, so the two read apart',
    file: 'src/render/arrow.ts',
    find: `  if (preview.launchable) {
    context.fillStyle = rampColour(palette, preview.aim.power01);
    context.fill();
  }`,
    replace: `  context.fillStyle = rampColour(palette, preview.aim.power01);
  context.fill();`,
    detectedBy: 'unit',
  },
  {
    item: 'C2',
    name: 'the arrow carries the boundary outline that is its contrast',
    file: 'src/render/arrow.ts',
    find: `  context.strokeStyle = palette.line;
  context.lineWidth = BORDER.thick;
  context.stroke();
}`,
    replace: `  context.stroke();
}`,
    detectedBy: 'unit',
  },

  {
    item: 'C1',
    name: 'the composition root attaches the pointer input to the play surface',
    file: 'src/main.ts',
    find: '    canvas: surface.canvas,',
    replace: "    canvas: document.createElement('canvas'),",
    detectedBy: 'browser',
  },
  {
    // RE-POINTED at PF-12: the aim pass moved from the composition root into
    // the frame composition, which is the handover the PF-5 close named. The
    // mutation and the property are unchanged: no arrow is drawn.
    item: 'C3',
    name: 'the frame composition draws the aim pass over the entities',
    file: 'src/render/pitch.ts',
    // RE-POINTED at PF-9: the arrow's body is the frame's named launcher now,
    // so the call reads differently. The pass is still removed entirely.
    find:
      '    drawAimArrow(surface.context, palette, options?.launcher ?? world.player, aim);',
    replace: '    void drawAimArrow;',
    detectedBy: 'browser',
  },
  {
    item: 'C6',
    name: 'the launch intent carries the direction the arrow previewed',
    file: 'src/main.ts',
    find: 'angle: aim.angleRad, power: aim.power01 });',
    replace: 'angle: 0, power: aim.power01 });',
    detectedBy: 'browser',
  },
  {
    item: 'C4',
    name: 'the launch intent carries the strength the arrow previewed',
    file: 'src/main.ts',
    find: 'power: aim.power01 });',
    replace: 'power: 1 });',
    detectedBy: 'browser',
  },
  {
    item: 'C8',
    name: "the composition root advances the match with the frame's own delta",
    file: 'src/main.ts',
    find: '    match.update(delta);',
    replace: '    match.update(0);',
    detectedBy: 'browser',
  },
  {
    // QUALITY-BAR section 7's other clause: no CSS transform, border or
    // padding on the canvas, because the rectangle the whole coordinate chain
    // is measured from would then be measuring something else. The rule is
    // kept by there being no such declaration anywhere, which is a property
    // of the absence of a line and is broken by adding one.
    item: 'C5',
    name: 'no chrome rule gives the play surface a box of its own',
    file: 'src/ui/components/chrome.css',
    // RE-POINTED at PF-14, protection identical. The anchor was `.pf-hud {`,
    // which the responsive arrangement made three matches: the base rule, the
    // sticky rule and the compact one. It is now the base rule's own opening
    // pair of lines, which is the same place in the file and inserts the same
    // rule ahead of it.
    find: `.pf-hud {
  display: flex;`,
    replace: `[data-pf='play-surface'] {
  border: var(--border-thin) solid var(--pf-text);
}

.pf-hud {
  display: flex;`,
    detectedBy: 'browser',
  },
  // ---------------------------------------------------------------------
  // PF-6. The two discrete aim models, the controls that carry them, and
  // the lint rule behind item C9.
  //
  // The rates get one entry per number AND one per shape, because a rate
  // whose constant has drifted and a rate whose integral has been replaced
  // by its top value fail in different places, and the second is silent at
  // every moment except the first second of a hold.
  //
  // The eight entries at the end name the browser suite. Each attacks the
  // composition root's own wiring or the shipped stylesheet, which no unit
  // test reaches: whether the surface is focusable at all, whether it is
  // given a name, whether the controls are mounted, whether the frame's own
  // elapsed time reaches the model, and whether the focus ring is drawn.
  // ---------------------------------------------------------------------

  {
    item: 'C9',
    name: 'the pointer-events rule is switched on in the shipping config',
    file: 'eslint.config.js',
    find: "      'pointer-events/no-mouse-or-touch-listeners': 'error',",
    replace: "      'pointer-events/no-mouse-or-touch-listeners': 'off',",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'the whole mouse family is a legacy event name',
    file: `${PLUGIN2}/index.js`,
    find: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "const LEGACY_EVENT = /^(?:mousenever[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'the whole touch family is a legacy event name',
    file: `${PLUGIN2}/index.js`,
    find: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touchnever[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'the double click is a mouse event with no touch equivalent',
    file: `${PLUGIN2}/index.js`,
    find: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|neverclick|auxclick)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'a handler property is the same listener written another way',
    file: `${PLUGIN2}/index.js`,
    find: "  /^on(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "  /^never(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'the HTML drag family is a second input path, and is refused',
    file: `${PLUGIN2}/index.js`,
    find: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|dragnever[a-z]*|drop|dblclick|auxclick)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'a drop listener is refused, and it is nobody prefix',
    file: `${PLUGIN2}/index.js`,
    find: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|dropnever|dblclick|auxclick)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'the auxiliary mouse button is refused like the double click',
    file: `${PLUGIN2}/index.js`,
    find: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclick)$/;",
    replace: "const LEGACY_EVENT = /^(?:mouse[a-z]*|touch[a-z]*|drag[a-z]*|drop|dblclick|auxclicknever)$/;",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'removing a listener is registering one somewhere',
    file: `${PLUGIN2}/index.js`,
    find: "const LISTENER_METHODS = new Set(['addEventListener', 'removeEventListener']);",
    replace: "const LISTENER_METHODS = new Set(['addEventListener']);",
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'a template with nothing interpolated is a string',
    file: `${PLUGIN2}/index.js`,
    find: `  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }`,
    replace: '  void node;',
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'a bracketed method name is the same method',
    file: `${PLUGIN2}/index.js`,
    find: `  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return null;
}

/**
 * A statically known event name, or null.`,
    replace: `  return null;
}

/**
 * A statically known event name, or null.`,
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'a handler property in an object literal is reported',
    file: `${PLUGIN2}/index.js`,
    find: `      Property: (node) => {
        reportHandler(node.key, nameOf(node.key));
      },`,
    replace: '      Property: () => undefined,',
    detectedBy: 'unit',
  },
  {
    item: 'C9',
    name: 'a handler property assigned on an element is reported',
    file: `${PLUGIN2}/index.js`,
    find: `      MemberExpression: (node) => {
        reportHandler(node.property, nameOf(node.property));
      },`,
    replace: '      MemberExpression: () => undefined,',
    detectedBy: 'unit',
  },

  {
    item: 'G5',
    name: 'the arrow tap is the step SPEC section 5.1 states',
    file: 'src/core/aiming.ts',
    find: 'export const ANGLE_TAP_DEGREES = 3;',
    replace: 'export const ANGLE_TAP_DEGREES = 4;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the fine tap is the step the modified row states',
    file: 'src/core/aiming.ts',
    find: 'export const ANGLE_FINE_TAP_DEGREES = 1;',
    replace: 'export const ANGLE_FINE_TAP_DEGREES = 3;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the ramp starts at the rate the table states',
    file: 'src/core/aiming.ts',
    find: 'export const ANGLE_HOLD_FROM_DEGREES = 60;',
    replace: 'export const ANGLE_HOLD_FROM_DEGREES = 90;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the ramp reaches the rate the table states',
    file: 'src/core/aiming.ts',
    find: 'export const ANGLE_HOLD_TO_DEGREES = 240;',
    replace: 'export const ANGLE_HOLD_TO_DEGREES = 200;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the fine hold is the constant rate the table states',
    file: 'src/core/aiming.ts',
    find: 'export const ANGLE_FINE_HOLD_DEGREES = 20;',
    replace: 'export const ANGLE_FINE_HOLD_DEGREES = 60;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a power tap is five points of the one power scale',
    file: 'src/core/aiming.ts',
    find: 'export const POWER_TAP = 0.05;',
    replace: 'export const POWER_TAP = 0.1;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a held power key pays out forty points a second',
    file: 'src/core/aiming.ts',
    find: 'export const POWER_HOLD_RATE = 0.4;',
    replace: 'export const POWER_HOLD_RATE = 0.8;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the hold delay is the 250 ms the table states',
    file: 'src/core/aiming.ts',
    find: 'export const HOLD_DELAY = 0.25;',
    replace: 'export const HOLD_DELAY = 0.5;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the ramp takes the one second the table states',
    file: 'src/core/aiming.ts',
    find: 'export const HOLD_RAMP = 1;',
    replace: 'export const HOLD_RAMP = 2;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a keyboard aim opens at sixty percent power',
    file: 'src/core/aiming.ts',
    find: 'export const OPENING_POWER = 0.6;',
    replace: 'export const OPENING_POWER = 0.5;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the delay is served before any rate is paid out',
    file: 'src/core/aiming.ts',
    find: `  const active = usable(held) - HOLD_DELAY;
  if (active <= 0) {
    return 0;
  }
  if (active >= HOLD_RAMP) {`,
    replace: `  const active = usable(held);
  if (active <= 0) {
    return 0;
  }
  if (active >= HOLD_RAMP) {`,
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the ramp is integrated rather than taken at its top rate',
    file: 'src/core/aiming.ts',
    find: `  return (
    ANGLE_HOLD_FROM_DEGREES * active +
    ((ANGLE_HOLD_TO_DEGREES - ANGLE_HOLD_FROM_DEGREES) * active * active) /
      (2 * HOLD_RAMP)
  );`,
    replace: '  return ANGLE_HOLD_TO_DEGREES * active;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the fine hold serves the same delay before it pays out',
    file: 'src/core/aiming.ts',
    find: '  return active <= 0 ? 0 : ANGLE_FINE_HOLD_DEGREES * active;',
    replace: '  return ANGLE_FINE_HOLD_DEGREES * active;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a held power key serves the same delay before it pays out',
    file: 'src/core/aiming.ts',
    find: '  return active <= 0 ? 0 : POWER_HOLD_RATE * active;',
    replace: '  return POWER_HOLD_RATE * active;',
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'a discrete reach starts at the minimum drag, not at nothing',
    file: 'src/core/aiming.ts',
    find: '  return MIN_DRAG + clampPower(power01Value) * (MAX_DRAG - MIN_DRAG);',
    replace: '  return clampPower(power01Value) * (MAX_DRAG - MIN_DRAG);',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'an angle turned past zero folds instead of going negative',
    file: 'src/core/aiming.ts',
    find: '  return value < 0 ? value + DEGREES_PER_TURN : value;',
    replace: '  return value;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a reading that rounds to a whole turn is the first direction',
    file: 'src/core/aiming.ts',
    find: '  return Math.round(radiansToDegrees(aim.angleRad)) % DEGREES_PER_TURN;',
    replace: '  return Math.round(radiansToDegrees(aim.angleRad));',
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'a tap aims TOWARD the point and never opposite it',
    file: 'src/core/aiming.ts',
    find: '  return Math.atan2(usable(toY) - usable(fromY), usable(toX) - usable(fromX));',
    replace: '  return Math.atan2(usable(fromY) - usable(toY), usable(fromX) - usable(toX));',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a keyboard aim opens pointing at the ball',
    file: 'src/core/aiming.ts',
    find: `      world.ball.position.x,
      world.ball.position.y,`,
    replace: `      world.opponent.position.x,
      world.opponent.position.y,`,
    detectedBy: 'unit',
  },

  {
    item: 'C11',
    name: 'a drag holding the pointer owns the aim against every held key',
    file: 'src/render/input.ts',
    find: '    if (live === null || captured !== null) {',
    replace: '    if (live === null) {',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a hold refuses a gap past the resume threshold outright',
    file: 'src/render/input.ts',
    find: '  if (delta > RESUME_GAP) {',
    replace: '  if (delta > RESUME_GAP * 1000) {',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a hold charges a hitch at the ceiling the simulation takes',
    file: 'src/render/input.ts',
    find: '  return Math.min(delta, DELTA_CEILING);',
    replace: '  return delta;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the Launch control enters aim mode the way Space does',
    file: 'src/render/input.ts',
    find: `      if (!beginDiscrete()) {
        return false;
      }
      return launchNow();`,
    replace: '      return launchNow();',
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'the tracks are written back over a refused move, every frame',
    file: 'src/ui/components/aim-controls.ts',
    find: `      angleSlider.value = String(shownDegrees);
      powerSlider.value = String(shownPercent);
      pump(elapsed);`,
    replace: '      pump(elapsed);',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the announcement returns to the no-aim state when an aim ends',
    file: 'src/ui/components/aim-controls.ts',
    find: '        queue(NO_AIM_TEXT);',
    replace: '        void NO_AIM_TEXT;',
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'the power track steps by one, so it can hold what the aim holds',
    file: 'src/ui/components/aim-controls.ts',
    find: `    // angle track beside it.
    1,`,
    replace: `    // angle track beside it.
    PERCENT_STEP,`,
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'a tap is a press that did not travel',
    file: 'src/render/input.ts',
    find: '    if (!(Math.hypot(at.x - tapX, at.y - tapY) < MIN_DRAG)) {',
    replace: '    if (!(Math.hypot(at.x - tapX, at.y - tapY) < MAX_DRAG)) {',
    detectedBy: 'unit',
  },
  {
    item: 'C12',
    name: 'the keys are bound to the play surface and never to the canvas',
    file: 'src/render/input.ts',
    find: "    surface.addEventListener('keydown', (event: KeyboardEvent) => {",
    replace: "    canvas.addEventListener('keydown', (event: KeyboardEvent) => {",
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the four arrows, Space and Enter never reach the page',
    file: 'src/render/input.ts',
    find: '      event.preventDefault();',
    replace: '      void event;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'Escape cancels the aim, and opens the pause with none to cancel',
    file: 'src/render/input.ts',
    find: "      if (event.key === 'Escape') {",
    replace: "      if (event.key === 'Never') {",
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the platform own key repeat is not a second tap',
    file: 'src/render/input.ts',
    find: '      if (event.repeat) {',
    replace: '      if (event.repeat && event.altKey) {',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a held key accumulates the frames it has been down',
    file: 'src/render/input.ts',
    find: '      angleHold.held += elapsed;',
    replace: '      angleHold.held = elapsed;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a sweep is the difference of two totals, not a running sum',
    file: 'src/render/input.ts',
    find: '        angleHold.base + angleHold.direction * (sweptBy(angleHold) - angleHold.from),',
    replace: '        aimDegreesNow + angleHold.direction * sweptBy(angleHold),',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'focusing the surface enters aim mode, and a press does not',
    file: 'src/render/input.ts',
    find: "      if (!surface.matches(':focus-visible')) {",
    replace: "      if (!surface.matches(':focus')) {",
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'leaving the surface ends the hold and never the aim',
    file: 'src/render/input.ts',
    find: `      angleHold = null;
      powerHold = null;
    });`,
    replace: `      endGesture();
    });`,
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'a drag launch is remembered as the next turn starting point',
    file: 'src/render/input.ts',
    find: `      remember(finished.aim);
      options.onLaunch(finished.aim);`,
    replace: `      options.onLaunch(finished.aim);`,
    detectedBy: 'unit',
  },

  {
    item: 'C11',
    name: 'the aim controls are refused outside the player own turn',
    file: 'src/ui/components/aim-controls.ts',
    find: "        control.setAttribute('aria-disabled', allowed ? 'false' : 'true');",
    replace: "        control.setAttribute('aria-disabled', 'false');",
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'a refused control ignores its own event',
    file: 'src/ui/components/aim-controls.ts',
    find: "  return control.getAttribute('aria-disabled') === 'true';",
    replace: "  return control.getAttribute('aria-disabled') === 'never';",
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'an angle stepper is worth the same as the matching key tap',
    file: 'src/ui/components/aim-controls.ts',
    find: 'const ANGLE_STEP = ANGLE_TAP_DEGREES;',
    replace: 'const ANGLE_STEP = ANGLE_TAP_DEGREES * 2;',
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'a power stepper is worth the same as the matching key tap',
    file: 'src/ui/components/aim-controls.ts',
    find: 'const PERCENT_STEP = POWER_TAP * PERCENT;',
    replace: 'const PERCENT_STEP = POWER_TAP;',
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'a control steps from the pair it last asked for',
    file: 'src/ui/components/aim-controls.ts',
    find: '    shownDegrees = normaliseDegrees(degrees);',
    replace: '    void degrees;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the announcement floor is the half second section 4 states',
    file: 'src/ui/components/aim-controls.ts',
    find: 'const ANNOUNCE_INTERVAL = 0.5;',
    replace: 'const ANNOUNCE_INTERVAL = 0.005;',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the announcement states power as a percentage',
    file: 'src/ui/components/aim-controls.ts',
    find: '          `Aim ${formatNumber(shownDegrees)} degrees, power ${formatNumber(',
    replace: '          `Aim ${formatNumber(shownDegrees)} degrees, reach ${formatNumber(',
    detectedBy: 'unit',
  },
  {
    item: 'G5',
    name: 'the aim readout is a polite live region',
    file: 'src/ui/components/aim-controls.ts',
    find: "  readout.setAttribute('aria-live', 'polite');",
    replace: "  readout.setAttribute('aria-live', 'off');",
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'the census freezes the named controls of the no-drag row',
    file: 'src/ui/components/aim-controls.ts',
    find: "  button(angleRow, 'aim-left', 'Aim left', 'pf-aim-step', () => {",
    replace: "  button(angleRow, 'aim-left', 'Left', 'pf-aim-step', () => {",
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'the two sliders are real range inputs',
    file: 'src/ui/components/aim-controls.ts',
    find: "    control.type = 'range';",
    replace: "    control.type = 'text';",
    detectedBy: 'unit',
  },
  {
    item: 'C11',
    name: 'the angle track stops one short of a whole turn',
    file: 'src/ui/components/aim-controls.ts',
    find: '    DEGREES_PER_TURN - 1,',
    replace: '    DEGREES_PER_TURN,',
    detectedBy: 'unit',
  },

  {
    item: 'C11',
    name: 'the composition root mounts the no-drag controls',
    file: 'src/main.ts',
    find: '  host.appendChild(controls.root);',
    replace: '  void controls;',
    detectedBy: 'browser',
  },
  {
    item: 'C12',
    name: 'the play surface is a focusable element',
    file: 'src/main.ts',
    find: "  frame.setAttribute('tabindex', '0');",
    replace: "  frame.setAttribute('tabindex', '-1');",
    detectedBy: 'browser',
  },
  {
    item: 'G5',
    name: 'the play surface carries an accessible name',
    file: 'src/main.ts',
    find: "  frame.setAttribute('aria-label', PLAY_SURFACE_LABEL);",
    replace: '  void PLAY_SURFACE_LABEL;',
    detectedBy: 'browser',
  },
  {
    item: 'G5',
    name: 'the input model is given the focusable frame to bind its keys to',
    file: 'src/main.ts',
    find: '    surface: frame,',
    replace: "    surface: document.createElement('div'),",
    detectedBy: 'browser',
  },
  {
    item: 'G5',
    name: 'the frame own elapsed time reaches the hold rates',
    file: 'src/main.ts',
    find: '    input.refresh(elapsed);',
    replace: '    input.refresh(0);',
    detectedBy: 'browser',
  },
  {
    item: 'C11',
    name: 'the controls are brought in line with the aim every frame',
    file: 'src/main.ts',
    find: '    controls.sync(elapsed, input.preview(), input.allowed());',
    replace: '    controls.sync(elapsed, null, input.allowed());',
    detectedBy: 'browser',
  },
  {
    item: 'G5',
    name: 'Escape with no aim raises the pause intent at the root',
    file: 'src/main.ts',
    find: "    match.dispatch({ kind: 'pause' });",
    replace: '    void match;',
    detectedBy: 'browser',
  },
  {
    item: 'C12',
    name: 'the focus indicator is drawn, and drawn as an outline',
    file: 'src/ui/components/chrome.css',
    find: '  outline: var(--focus-ring-width) var(--focus-ring-style) var(--focus-ring-color);',
    replace: '  outline-color: var(--focus-ring-color);',
    detectedBy: 'browser',
  },

  // ---------------------------------------------------------------------
  // PF-12. SPEC section 14's motion set, and the one function that removes
  // it. The entries fall into four groups.
  //
  //   E5, the constants. One per number in section 14's tunable block and
  //   one per number the section states about the shake, because a feel
  //   constant that has drifted looks exactly like a feel constant that has
  //   not, and only a literal in a test can tell them apart.
  //
  //   E5, the derivations. The trail's length, the two contact detections
  //   and the rate limiter are derived from the world rather than handed to
  //   the renderer, so each gate gets an entry that removes the thing the
  //   derivation rests on: the separation signature, the one-frame reach,
  //   the wall's normal reversal and the goal opening's transparency.
  //
  //   E6, the policy. Every lifetime resolves through `effectSeconds`, and
  //   the entries here replace one of those calls with the unconditional
  //   constant, which is the shape reduced motion has to remove. Two of
  //   them attack the trap directly by skipping work in one mode only: the
  //   detection and the burst's draws.
  //
  //   The composition. The clear, the blit, the two effects passes and the
  //   aim pass all live in `drawFrame` from this part, so the order and the
  //   shake's arrival are attacked there; the three that name the browser
  //   suite attack the composition root's own wiring, where no unit test
  //   can see whether the policy was ever read.
  // ---------------------------------------------------------------------

  {
    item: 'E5',
    name: 'the ball trail lasts the window SPEC section 14 states',
    file: 'src/render/effects.ts',
    find: '  ballTrail: 0.18,',
    replace: '  ballTrail: 0.5,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the impact flash lasts the window the section states',
    file: 'src/render/effects.ts',
    find: '  impactFlash: 0.12,',
    replace: '  impactFlash: 0.4,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the wall-segment flash lasts the window the section states',
    file: 'src/render/effects.ts',
    find: '  wallFlash: 0.15,',
    replace: '  wallFlash: 0.4,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake decays over the window the section states',
    file: 'src/render/effects.ts',
    find: '  screenShake: 0.2,',
    replace: '  screenShake: 0.5,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the celebration is the goal hold, not a second spelling of it',
    file: 'src/render/effects.ts',
    find: '  goalCelebration: GOAL_HOLD,',
    replace: '  goalCelebration: 0.3,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake scales with impact energy at the section\'s rate',
    file: 'src/render/effects.ts',
    find: 'export const SHAKE_ENERGY_SCALE = 0.004;',
    replace: 'export const SHAKE_ENERGY_SCALE = 0.04;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake caps at the section\'s share of the surface',
    file: 'src/render/effects.ts',
    find: 'export const SHAKE_HEIGHT_FRACTION = 0.015;',
    replace: 'export const SHAKE_HEIGHT_FRACTION = 0.15;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the cap is a ceiling and not a floor',
    file: 'src/render/effects.ts',
    find: '  return Math.min(cap, fromEnergy);',
    replace: '  return Math.max(cap, fromEnergy);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the cap is a fraction of the RENDERED height, not of the design space',
    file: 'src/render/effects.ts',
    find:
      '  const cap = Number.isFinite(renderedHeight)\n' +
      '    ? Math.max(0, renderedHeight) * SHAKE_HEIGHT_FRACTION\n' +
      '    : 0;',
    replace:
      '  const cap = Number.isFinite(renderedHeight)\n' +
      '    ? 720 * SHAKE_HEIGHT_FRACTION\n' +
      '    : 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the decay constant leaves a hundredth of the peak at the window',
    file: 'src/render/effects.ts',
    find: 'export const SHAKE_DECAY_PER_SECOND = 1e-10;',
    replace: 'export const SHAKE_DECAY_PER_SECOND = 1e-1;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake decays per second and never per frame',
    file: 'src/render/effects.ts',
    find: '        shakeEnergy *= SHAKE_DECAY_PER_SECOND ** seconds;',
    replace: '        shakeEnergy *= SHAKE_DECAY_PER_SECOND;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake oscillates on a period a frame can sample',
    file: 'src/render/effects.ts',
    find: 'const SHAKE_PERIOD_SECONDS = duration(2, false) / MILLISECONDS_PER_SECOND;',
    replace: 'const SHAKE_PERIOD_SECONDS = duration(1, false) / MILLISECONDS_PER_SECOND;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'only a collision harder than the weakest legal shot is a hard one',
    file: 'src/render/effects.ts',
    find: 'export const HARD_IMPACT_ENERGY = MIN_LAUNCH_SPEED;',
    replace: 'export const HARD_IMPACT_ENERGY = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'impact energy is the velocity CHANGE and not the speed',
    file: 'src/render/effects.ts',
    find: '  return Math.hypot(afterX - beforeX, afterY - beforeY);',
    replace: '  return Math.hypot(afterX, afterY);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'no more than three flashes reach one region in a second',
    file: 'src/render/effects.ts',
    find: 'export const FLASHES_PER_WINDOW = 3;',
    replace: 'export const FLASHES_PER_WINDOW = 99;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the limiter\'s window is the second the criterion states',
    file: 'src/render/effects.ts',
    find: 'export const FLASH_WINDOW_SECONDS = 1;',
    replace: 'export const FLASH_WINDOW_SECONDS = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the limiter counts in columns across the pitch',
    file: 'src/render/effects.ts',
    find: 'const REGION_COLUMNS = 8;',
    replace: 'const REGION_COLUMNS = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the limiter counts in rows up the pitch',
    file: 'src/render/effects.ts',
    find: 'const REGION_ROWS = 4;',
    replace: 'const REGION_ROWS = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the trail is the distance the ball actually covered',
    file: 'src/render/effects.ts',
    find: '    total += Math.hypot(to.x - from.x, to.y - from.y);',
    replace: '    total += 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a trail sample older than the window is dropped',
    file: 'src/render/effects.ts',
    find: '    expire(trail);',
    replace: '    ;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a pair that never separated never met',
    file: 'src/render/effects.ts',
    find:
      '  if (separating <= 0) {\n' +
      '    return null;\n' +
      '  }',
    replace:
      '  if (separating < -1e9) {\n' +
      '    return null;\n' +
      '  }',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a wall bounce turns the normal component round',
    file: 'src/render/effects.ts',
    find:
      '    before.vy > 0 &&\n' +
      '    moving.y <= 0 &&',
    replace:
      '    before.vy > 0 &&\n' +
      '    moving.y <= 1e9 &&',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a ball through a goal opening is not a bounce off the wall',
    file: 'src/render/effects.ts',
    find: '  const throughTheOpening = ballFitsOpening(body);',
    replace: '  const throughTheOpening = false;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the wall flash is one spacing step of the struck band',
    file: 'src/render/effects.ts',
    find: 'const WALL_SEGMENT_SPAN = SPACE[8];',
    replace: 'const WALL_SEGMENT_SPAN = SPACE[7];',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a goal celebrates once, and not once per frame of the hold',
    file: 'src/render/effects.ts',
    find: '    if (scoring.goals > seenGoals) {',
    replace: '    if (scoring.goals > 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the burst is made of the count the celebration states',
    file: 'src/render/effects.ts',
    find: 'const BURST_PARTICLES = 12;',
    replace: 'const BURST_PARTICLES = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the burst draws from its own stream, not the shake\'s',
    file: 'src/render/effects.ts',
    find: '  const burstStream: Rng = root.split(BURST_STREAM);',
    replace: '  const burstStream: Rng = shakeStream;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the frame that pulses is the mouth that was scored in',
    file: 'src/render/effects.ts',
    find: '    x: mouth === \'left\' ? FIELD_LEFT - GOAL_FRAME_DEPTH : FIELD_RIGHT,',
    replace: '    x: mouth === \'left\' ? FIELD_RIGHT : FIELD_LEFT - GOAL_FRAME_DEPTH,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the goal frame pulses under SC 2.3.1\'s three a second',
    file: 'src/render/effects.ts',
    find: 'const SLOW_PULSE_STEPS = 2;',
    replace: 'const SLOW_PULSE_STEPS = 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the arrow pulses at MAXIMUM strength and at no other',
    file: 'src/render/effects.ts',
    find: '  if (aim === null || period <= 0 || !aim.launchable || aim.aim.power01 < 1) {',
    replace: '  if (aim === null || period <= 0 || !aim.launchable || aim.aim.power01 < 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the trail opens at its own weight',
    file: 'src/render/effects.ts',
    find: 'const TRAIL_PEAK_ALPHA = 0.45;',
    replace: 'const TRAIL_PEAK_ALPHA = 0.9;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a flash opens at its own weight',
    file: 'src/render/effects.ts',
    find: 'const FLASH_PEAK_ALPHA = 0.7;',
    replace: 'const FLASH_PEAK_ALPHA = 0.35;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the celebration opens at its own weight',
    file: 'src/render/effects.ts',
    find: 'const CELEBRATION_PEAK_ALPHA = 0.8;',
    replace: 'const CELEBRATION_PEAK_ALPHA = 0.4;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the arrow pulse peaks at its own weight',
    file: 'src/render/effects.ts',
    find: 'const PULSE_PEAK_ALPHA = 0.55;',
    replace: 'const PULSE_PEAK_ALPHA = 0.9;',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'reduced motion resolves every game-feel lifetime to zero',
    file: 'src/render/effects.ts',
    find: '  return reducedMotion ? 0 : EFFECT_SECONDS[step];',
    replace: '  return EFFECT_SECONDS[step];',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the shake\'s window is resolved against the policy',
    file: 'src/render/effects.ts',
    find: '    shakeLife = effectSeconds(\'screenShake\', reducedMotion);',
    replace: '    shakeLife = EFFECT_SECONDS.screenShake;',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the trail\'s window is resolved against the policy',
    file: 'src/render/effects.ts',
    find: '        life: effectSeconds(\'ballTrail\', reducedMotion),',
    replace: '        life: EFFECT_SECONDS.ballTrail,',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the wall flash\'s window is resolved against the policy',
    file: 'src/render/effects.ts',
    find: '          life: effectSeconds(\'wallFlash\', reducedMotion),',
    replace: '          life: EFFECT_SECONDS.wallFlash,',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the impact flash\'s window is resolved against the policy',
    file: 'src/render/effects.ts',
    find: '          life: effectSeconds(\'impactFlash\', reducedMotion),',
    replace: '          life: EFFECT_SECONDS.impactFlash,',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the celebration\'s window is resolved against the policy',
    file: 'src/render/effects.ts',
    find: '    const life = effectSeconds(\'goalCelebration\', reducedMotion);',
    replace: '    const life = EFFECT_SECONDS.goalCelebration;',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the arrow pulse\'s period is resolved against the policy',
    file: 'src/render/effects.ts',
    find:
      '        (duration(4, reducedMotion) * SLOW_PULSE_STEPS) / MILLISECONDS_PER_SECOND;',
    replace:
      '        (duration(4, false) * SLOW_PULSE_STEPS) / MILLISECONDS_PER_SECOND;',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'a shake with no window left is over on the frame it started',
    file: 'src/render/effects.ts',
    find: '    if (now - shakeAt >= shakeLife) {',
    replace: '    if (shakeLife > 0 && now - shakeAt >= shakeLife) {',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the detection runs whatever the motion policy is',
    file: 'src/render/effects.ts',
    find: '      if (samples.length > 0 && seconds > 0 && !teleported) {',
    replace:
      '      if (samples.length > 0 && seconds > 0 && !teleported && !reducedMotion) {',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the burst takes the same draws whatever the motion policy is',
    file: 'src/render/effects.ts',
    find: '    for (let made = 0; made < BURST_PARTICLES; made += 1) {',
    replace: '    for (let made = 0; made < (life > 0 ? BURST_PARTICLES : 0); made += 1) {',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the frame is cleared over the whole backing store',
    file: 'src/render/pitch.ts',
    find: '  surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);',
    replace: '  surface.context.clearRect(0, 0, 1, 1);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the clear is taken before the shake offsets anything',
    file: 'src/render/pitch.ts',
    find:
      '  surface.context.setTransform(1, 0, 0, 1, 0, 0);\n' +
      '  surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);',
    replace:
      '  surface.context.setTransform(1, 0, 0, 1, shake.x, shake.y);\n' +
      '  surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the blit carries the shake',
    file: 'src/render/pitch.ts',
    find: '  surface.context.setTransform(1, 0, 0, 1, shake.x, shake.y);',
    replace: '  surface.context.setTransform(1, 0, 0, 1, 0, 0);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the design transform carries the shake too',
    file: 'src/render/pitch.ts',
    find: '  applySurfaceTransform(surface.context, surface.scale, shake.x, shake.y);',
    replace: '  applySurfaceTransform(surface.context, surface.scale);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the one transform takes the shake as an offset',
    file: 'src/render/surface.ts',
    find: '  context.setTransform(scale, 0, 0, -scale, offsetX, LOGICAL_HEIGHT * scale + offsetY);',
    replace: '  context.setTransform(scale, 0, 0, -scale, 0, LOGICAL_HEIGHT * scale);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake is asked about the height the surface renders at',
    file: 'src/render/pitch.ts',
    find: '  const offset = effects === undefined ? STILL : effects.shake(surface.cssHeight);',
    replace: '  const offset = effects === undefined ? STILL : effects.shake(720);',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the effects-behind pass runs before the entities',
    file: 'src/render/pitch.ts',
    find:
      '  if (effects !== undefined) {\n' +
      '    effects.drawBehind(surface.context, palette);\n' +
      '  }\n' +
      '  drawEntities(surface.context, palette, world, options?.facing, options?.glyphs);',
    replace:
      '  drawEntities(surface.context, palette, world, options?.facing, options?.glyphs);\n' +
      '  if (effects !== undefined) {\n' +
      '    effects.drawBehind(surface.context, palette);\n' +
      '  }',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the effects-in-front pass runs after the aim arrow',
    file: 'src/render/pitch.ts',
    // RE-POINTED at PF-9: SPEC section 11's guide pass landed between the
    // entities and the arrow, so the anchor is the last two passes alone. The
    // break is the same one: the two passes exchanged.
    find:
      '  if (aim !== undefined) {\n' +
      '    drawAimArrow(surface.context, palette, options?.launcher ?? world.player, aim);\n' +
      '  }\n' +
      '  if (effects !== undefined) {\n' +
      '    effects.drawInFront(surface.context, palette, world, aim ?? null);\n' +
      '  }',
    replace:
      '  if (effects !== undefined) {\n' +
      '    effects.drawInFront(surface.context, palette, world, aim ?? null);\n' +
      '  }\n' +
      '  if (aim !== undefined) {\n' +
      '    drawAimArrow(surface.context, palette, options?.launcher ?? world.player, aim);\n' +
      '  }',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a wall band is clipped to the wall the pitch actually drew',
    file: 'src/render/effects.ts',
    find:
      '    const from = Math.max(low, pieceLow);\n' +
      '    const to = Math.min(high, pieceHigh);',
    replace: '    const from = low;\n' + '    const to = high;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the opening is what splits the side wall into two drawn pieces',
    file: 'src/render/effects.ts',
    find:
      '    [FIELD_BOTTOM - WALL_THICKNESS, GOAL_OPENING_LOW],\n' +
      '    [GOAL_OPENING_HIGH, FIELD_TOP + WALL_THICKNESS],',
    replace:
      '    [FIELD_BOTTOM - WALL_THICKNESS, FIELD_TOP + WALL_THICKNESS],\n' +
      '    [GOAL_OPENING_HIGH, GOAL_OPENING_HIGH],',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a pair that never came within the radii never met',
    file: 'src/render/effects.ts',
    find:
      '    if (nearest > one.radius + other.radius + CONTACT_SLACK) {\n' +
      '      return null;\n' +
      '    }',
    replace: '    if (nearest > 1e9) {\n' + '      return null;\n' + '    }',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the closest approach is taken across the frame, not at its start',
    file: 'src/render/effects.ts',
    find: '      spanOf(seconds),',
    replace: '      0,',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a frame advances the world by up to one fixed step more than its delta',
    file: 'src/render/effects.ts',
    find: '  return seconds + FIXED_STEP;',
    replace: '  return seconds;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a body that was placed rather than moved derives nothing',
    file: 'src/render/effects.ts',
    find: '      if (moved > could) {',
    replace: '      if (moved > 1e9) {',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'a placement cuts the trail instead of streaking it across the pitch',
    file: 'src/render/effects.ts',
    find:
      '      if (teleported) {\n' +
      '        trail.length = 0;\n' +
      '      }',
    replace:
      '      if (teleported && false) {\n' +
      '        trail.length = 0;\n' +
      '      }',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the one-second period SC 2.3.1 states is closed at both ends',
    file: 'src/render/effects.ts',
    find: '    while (times.length > 0 && now - (times[0] ?? 0) > FLASH_WINDOW_SECONDS) {',
    replace: '    while (times.length > 0 && now - (times[0] ?? 0) >= FLASH_WINDOW_SECONDS) {',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the surface records the height it renders at, in CSS pixels',
    file: 'src/render/surface.ts',
    find: '  surface.cssHeight = cssHeightFor(cssWidth);',
    replace: '  surface.cssHeight = 0;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the device pixel ratio is recovered where the shake is applied',
    file: 'src/render/surface.ts',
    find: '  return surface.cssHeight > 0 ? surface.canvas.height / surface.cssHeight : 1;',
    replace: '  return 1;',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shake in CSS pixels is converted to the backing store once',
    file: 'src/render/pitch.ts',
    find: '  const shake: ShakeOffset = { x: offset.x * ratio, y: offset.y * ratio };',
    replace: '  const shake: ShakeOffset = { x: offset.x, y: offset.y };',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the hooks register under the key a capture script reads',
    file: 'src/render/effects.ts',
    find: 'export const MOTION_CAPTURE_KEY = \'__pfMotion\';',
    replace: 'export const MOTION_CAPTURE_KEY = \'__pfSomethingElse\';',
    detectedBy: 'unit',
  },
  {
    item: 'E5',
    name: 'the shipping entry never names the motion capture hooks',
    file: 'src/main.ts',
    find: 'import { createEffects } from \'./render/effects\';',
    replace:
      'import { createEffects, installMotionHooks } from \'./render/effects\';\n' +
      'void installMotionHooks;',
    detectedBy: 'unit',
  },
  {
    item: 'E6',
    name: 'the composition root reads the platform\'s own preference',
    file: 'src/main.ts',
    find: 'const MOTION_QUERY = \'(prefers-reduced-motion: reduce)\';',
    replace: 'const MOTION_QUERY = \'(prefers-reduced-motion: no-preference)\';',
    detectedBy: 'browser',
  },
  {
    item: 'E6',
    name: 'the policy the root read reaches the effects layer',
    file: 'src/main.ts',
    find: '      reducedMotion: reducedMotionInForce(),',
    replace: '      reducedMotion: false,',
    detectedBy: 'browser',
  },
  {
    item: 'E5',
    name: 'the frame\'s own elapsed seconds reach the effects layer',
    file: 'src/main.ts',
    find:
      '      scoring: match.readout().scoring,\n' +
      '      elapsed,',
    replace:
      '      scoring: match.readout().scoring,\n' +
      '      elapsed: 0,',
    detectedBy: 'browser',
  },
  // ------------------------------------------------------------------
  // PF-9. SPEC section 9's four modes, section 10's ladder, section 11's aim
  // guide, section 13's game over, section 2.2's hidden tab and section 19's
  // onboarding. The composition entries are `browser` only where nothing
  // cheaper can witness the property: the wiring at the root, which no unit
  // test reaches and no lint rule has an opinion about.
  // ------------------------------------------------------------------
  {
    item: 'J1',
    name: 'Quick Match offers the three durations the section states',
    file: 'src/core/modes.ts',
    find: 'export const QUICK_DURATIONS: readonly number[] = [60, 90, 120];',
    replace: 'export const QUICK_DURATIONS: readonly number[] = [60, 90];',
    detectedBy: 'unit',
  },
  {
    item: 'J1',
    name: 'a Quick Match is built with the clock the menu chose',
    file: 'src/core/modes.ts',
    find: '      configuration: { duration: choice.duration, first: OPENS_WITH },',
    replace: '      configuration: { duration: 60, first: OPENS_WITH },',
    detectedBy: 'unit',
  },
  {
    item: 'J1',
    name: 'the higher score is the winner and level is a draw',
    file: 'src/core/modes.ts',
    find: "  if (player > opponent) {\n    return 'player';\n  }",
    replace: "  if (player >= opponent) {\n    return 'player';\n  }",
    detectedBy: 'unit',
  },
  {
    item: 'J2',
    name: 'First to N offers the three targets the section states',
    file: 'src/core/modes.ts',
    find: 'export const FIRST_TO_TARGETS: readonly number[] = [3, 5, 7];',
    replace: 'export const FIRST_TO_TARGETS: readonly number[] = [3, 5];',
    detectedBy: 'unit',
  },
  {
    item: 'J2',
    name: 'a First to N is seeded by the target the menu chose',
    file: 'src/core/modes.ts',
    find: "      seed: `${MATCH_SEED}:first-to:${String(choice.target)}:${choice.difficulty}`,",
    replace: "      seed: `${MATCH_SEED}:first-to`,",
    detectedBy: 'unit',
  },
  {
    item: 'J2',
    name: 'the goal target rides the readout the HUD is derived from',
    file: 'src/core/match.ts',
    find: '      reading.target = configured.target;',
    replace: '      reading.target = undefined;',
    detectedBy: 'unit',
  },
  {
    item: 'J2',
    name: 'a mode configuration reaches the match it is meant for',
    file: 'src/core/match.ts',
    find: "    if (intent.kind === 'configure') {",
    replace: "    if (intent.kind === 'configure' && false) {",
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'the ladder plays the six opponents in the section order',
    file: 'src/core/modes.ts',
    find: '  const rung = LADDER[slot];',
    replace: '  const rung = LADDER[LADDER.length - 1 - slot];',
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'the rung difficulty is the column the section states',
    file: 'src/core/modes.ts',
    find: "export const LADDER_DIFFICULTY: readonly Difficulty[] = [\n  'casual',\n  'casual',\n  'pro',\n  'pro',\n  'ace',\n  'ace',\n];",
    replace: "export const LADDER_DIFFICULTY: readonly Difficulty[] = [\n  'casual',\n  'casual',\n  'casual',\n  'pro',\n  'ace',\n  'ace',\n];",
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'the ladder advances on a win',
    file: 'src/core/modes.ts',
    find: "  if (outcome === 'player') {\n    return 'advance';\n  }",
    replace: "  if (outcome === 'player') {\n    return 'replay';\n  }",
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'a loss puts the ladder back to the first opponent',
    file: 'src/core/modes.ts',
    find: "  if (step === 'restart') {\n    return 1;\n  }",
    replace: "  if (step === 'restart') {\n    return at;\n  }",
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'the top of the ladder has nowhere to advance to',
    file: 'src/core/modes.ts',
    find: '    return Math.min(at + 1, LADDER_TOTAL);',
    replace: '    return at + 1;',
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'a ladder rung is played to the target it is given',
    file: 'src/core/modes.ts',
    find: 'export const LADDER_TARGET = 3;',
    replace: 'export const LADDER_TARGET = 5;',
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'the progress store keeps what it is given',
    file: 'src/core/modes.ts',
    find: '      held = normaliseProgress(next);',
    replace: '      void next;',
    detectedBy: 'unit',
  },
  {
    item: 'J3',
    name: 'a stored rung outside the ladder is clamped into it',
    file: 'src/core/modes.ts',
    find: '        ? Math.min(Math.max(Math.trunc(rung), 1), LADDER_TOTAL)',
    replace: '        ? Math.trunc(rung)',
    detectedBy: 'unit',
  },
  {
    item: 'J4',
    name: 'Hotseat has no opponent profile for anything to answer with',
    file: 'src/core/modes.ts',
    find: '    profile: undefined,\n    opponentName: PLAYER_TWO,',
    replace: '    profile: CASUAL,\n    opponentName: PLAYER_TWO,',
    detectedBy: 'unit',
  },
  {
    item: 'J4',
    name: 'Hotseat names the side to act rather than calling it yours',
    file: 'src/core/modes.ts',
    find: '    playerName: PLAYER_ONE,',
    replace: '    playerName: undefined,',
    detectedBy: 'unit',
  },
  {
    item: 'J4',
    name: 'the turn indicator uses the name a mode gave the player side',
    file: 'src/ui/components/hud.ts',
    find: '        : `${playerName.toUpperCase()} IS AIMING`;',
    replace: "        : 'YOUR TURN';",
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the aim guide defaults on at Casual and off above it',
    file: 'src/core/modes.ts',
    find: "  return difficulty === 'casual';",
    replace: '  return true;',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the menu puts the guide back to the default of what was chosen',
    file: 'src/ui/components/mode-panel.ts',
    find: '    guide = guideOnByDefault(difficultyOf(current()));',
    replace: '    guide = guideOnByDefault(difficultyOf(current())) || guide;',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'a group the mode does not read is refused in place',
    file: 'src/ui/components/mode-panel.ts',
    find: "        input.setAttribute('aria-disabled', applies ? 'false' : 'true');",
    replace: "        input.setAttribute('aria-disabled', 'false');",
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the prediction is bounded by the circle own inset',
    file: 'src/core/guide.ts',
    find: '    minX: FIELD_LEFT + radius,',
    replace: '    minX: FIELD_LEFT,',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the prediction STOPS at the first ball contact',
    file: 'src/core/guide.ts',
    find: '    return { path: [{ x: start.x, y: start.y }, touch], contact: touch, bounce: undefined };',
    replace: '    return { path: [{ x: start.x, y: start.y }, touch, { x: 0, y: 0 }], contact: touch, bounce: undefined };',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the contact is the FIRST crossing and not the far one',
    file: 'src/core/guide.ts',
    find: '  const at = near >= 0 ? near : 0;',
    replace: '  const at = far >= 0 ? far : 0;',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the one bounce reflects the component the wall owns',
    file: 'src/core/guide.ts',
    find: "  const bouncedX = wall.wall === 'left' || wall.wall === 'right' ? -dirX : dirX;",
    replace: '  const bouncedX = dirX;',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'a direction that is not a number predicts nothing at all',
    file: 'src/core/guide.ts',
    find: '  if (!Number.isFinite(angleRad)) {\n    return NO_GUIDE;\n  }',
    replace: '  if (!Number.isFinite(angleRad) && false) {\n    return NO_GUIDE;\n  }',
    detectedBy: 'unit',
  },
  // This entry read UNDETECTED on PF-9's full sweep and the sweep was right:
  // `firstWall` carried a second refusal for the same case, so the guard above
  // could be disabled without changing one answer. Two refusals for one
  // property means one of them is decorative whichever way the mutation lands.
  // The dead branch is gone, `firstWall` answers a hit rather than perhaps-one,
  // and the pair below is the pair of refusals that survives, each with a case
  // of its own in `tests/unit/aim-guide.test.ts`.
  {
    item: 'J5',
    name: 'a starting point that is not a number predicts nothing at all',
    file: 'src/core/guide.ts',
    find: '  if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) {',
    replace: '  if (false && (!Number.isFinite(start.x) || !Number.isFinite(start.y))) {',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the dotted pattern carries across the bounce',
    file: 'src/render/guide.ts',
    find: '      const into = phase % GUIDE_PERIOD;',
    replace: '      const into = along % GUIDE_PERIOD;',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the contact is marked where the prediction puts it',
    file: 'src/render/guide.ts',
    find: '    context.arc(contact.x, contact.y, GUIDE_MARKER_RADIUS, 0, TAU);',
    replace: '    context.arc(0, 0, GUIDE_MARKER_RADIUS, 0, TAU);',
    detectedBy: 'unit',
  },
  {
    item: 'J5',
    name: 'the aim arrow starts at the circle the frame names as launching',
    file: 'src/render/pitch.ts',
    find: '    drawAimArrow(surface.context, palette, options?.launcher ?? world.player, aim);',
    replace: '    drawAimArrow(surface.context, palette, world.player, aim);',
    detectedBy: 'unit',
  },
  {
    item: 'J6',
    name: 'SPEC section 13 Change mode has an edge out of GAME_OVER',
    file: 'src/core/match.ts',
    find: "    if (state.kind === 'PAUSED' || state.kind === 'GAME_OVER') {",
    replace: "    if (state.kind === 'PAUSED') {",
    detectedBy: 'unit',
  },
  {
    item: 'J6',
    name: 'the next opponent is offered on a win and only on a win',
    file: 'src/ui/components/game-over-panel.ts',
    find: "        options.onNextOpponent !== undefined && step === 'advance' && !complete,",
    replace: '        options.onNextOpponent !== undefined,',
    detectedBy: 'unit',
  },
  {
    item: 'J6',
    name: 'the ladder restart is offered on a loss and at the top',
    file: 'src/ui/components/game-over-panel.ts',
    find: "        options.onRestartLadder !== undefined && (step === 'restart' || complete),",
    replace: '        options.onRestartLadder !== undefined,',
    detectedBy: 'unit',
  },
  {
    item: 'J6',
    name: 'a refused game-over action ignores a press',
    file: 'src/ui/components/game-over-panel.ts',
    find: "      if (button.getAttribute('aria-disabled') === 'true') {\n        return;\n      }",
    replace: "      if (button.getAttribute('aria-disabled') === 'true' && false) {\n        return;\n      }",
    detectedBy: 'unit',
  },
  {
    item: 'J8',
    name: 'the first-ever match holds the guide on for its first turns',
    file: 'src/core/modes.ts',
    find: '  if (firstEverMatch && turnsTaken < FIRST_MATCH_GUIDE_TURNS) {',
    replace: '  if (firstEverMatch && turnsTaken < 0) {',
    detectedBy: 'unit',
  },
  {
    item: 'J8',
    name: 'the first-ever guide runs for exactly the two turns stated',
    file: 'src/core/modes.ts',
    find: 'export const FIRST_MATCH_GUIDE_TURNS = 2;',
    replace: 'export const FIRST_MATCH_GUIDE_TURNS = 3;',
    detectedBy: 'unit',
  },
  {
    item: 'J1',
    name: 'the mode chosen at the menu is what the match is configured with',
    file: 'src/main.ts',
    find: "    match.dispatch({ kind: 'configure', configuration: setup.configuration });",
    replace: '    void setup.configuration;',
    detectedBy: 'browser',
  },
  {
    item: 'J4',
    name: 'the opponent driver answers its own seam at the root',
    file: 'src/main.ts',
    find: '      respond(match, profile, opponent);',
    replace: '      void respond;',
    detectedBy: 'browser',
  },
  {
    item: 'J7',
    name: 'a hidden tab raises the pause intent the chart answers',
    file: 'src/main.ts',
    find: '    if (document.hidden) {\n      pauseNow();\n    }',
    replace: '    if (document.hidden && false) {\n      pauseNow();\n    }',
    detectedBy: 'browser',
  },
  {
    item: 'J8',
    name: 'How to Play is shown on a first launch',
    file: 'src/main.ts',
    find: '    chrome.showHowToPlay();',
    replace: '    void chrome;',
    detectedBy: 'browser',
  },
  {
    item: 'J5',
    name: 'the guide the root decided on reaches the frame that draws it',
    file: 'src/main.ts',
    find: '      options.guide = predictGuide(acting, world.ball, preview.aim.angleRad);',
    replace: '      void predictGuide;',
    detectedBy: 'browser',
  },
  {
    // RE-POINTED at PF-10, with the protection unchanged. The whistle recorder
    // in the composition root grew SPEC section 16's best result and lifetime
    // counters beside the ladder rung it already wrote, and was renamed from
    // `recordLadder` to `recordMatch` in the same change; this entry still
    // removes the one call the frame driver makes to it, and item J3's ladder
    // specs still catch it. Was: find '    recordLadder();' with replace
    // '    void recordLadder;'.
    item: 'J3',
    name: 'the rung a result earned is recorded at the whistle',
    file: 'src/main.ts',
    find: '    recordMatch();',
    replace: '    void recordMatch;',
    detectedBy: 'browser',
  },

  // -------------------------------------------------------------------------
  // PF-10, SPEC section 16's saved state.
  //
  // Items I1, I2 and I3 are answered by the unit suite over `core/storage.ts`,
  // which is where every decision about a stored document lives. Items I4 and
  // I5 name the browser detector instead, and the reason is the one that
  // brought that detector into being: what they protect is composition wiring
  // no unit test reaches, which store the root holds, what a start and a
  // whistle write, and what the chrome does with a stored theme.
  // -------------------------------------------------------------------------
  {
    item: 'I1',
    name: 'the saved document lives under one key namespaced by the game',
    file: 'src/core/storage.ts',
    find: "export const STORAGE_KEY = 'pocket-football:save';",
    replace: "export const STORAGE_KEY = 'save';",
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'the version written is the version this build reads back',
    file: 'src/core/storage.ts',
    find: '  return JSON.stringify({ version: DOCUMENT_VERSION, ...data });',
    replace: '  return JSON.stringify({ version: DOCUMENT_VERSION + 1, ...data });',
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'a document from a version this build cannot reach is refused whole',
    file: 'src/core/storage.ts',
    find: '  if (version < FIRST_VERSION || version > DOCUMENT_VERSION) {',
    replace: '  if (version < FIRST_VERSION) {',
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'a version that is not a whole number names no shape at all',
    file: 'src/core/storage.ts',
    find: "  if (typeof version !== 'number' || !Number.isInteger(version)) {",
    replace: "  if (typeof version !== 'number') {",
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'a version one document is lifted rather than read as the current one',
    file: 'src/core/storage.ts',
    find: '  if (version === FIRST_VERSION) {',
    replace: '  if (version === DOCUMENT_VERSION) {',
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'the lift carries the ladder rung across the bump',
    file: 'src/core/storage.ts',
    find: "      ladderRung: document['ladderRung'],",
    replace: '      ladderRung: undefined,',
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'the lift carries the how-to-play flag across the bump',
    file: 'src/core/storage.ts',
    find: "      howToDismissed: document['howToDismissed'],",
    replace: '      howToDismissed: undefined,',
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'the lift carries the played-before flag across the bump',
    file: 'src/core/storage.ts',
    find: "      playedBefore: document['playedBefore'],",
    replace: '      playedBefore: undefined,',
    detectedBy: 'unit',
  },
  {
    // Aimed at the normalise door rather than at the lift, and the reason is a
    // finding: BOTH of them drop an unknown key, so no single edit to the lift
    // can be witnessed. The door is the layer that enforces it for every
    // document at every version, so that is where the entry sits.
    item: 'I1',
    name: 'a key the shape has no home for is dropped rather than carried',
    file: 'src/core/storage.ts',
    find: `  const document = raw as Record<string, unknown>;
  return {
    progress: normaliseProgress(document['progress']),`,
    replace: `  const document = raw as Record<string, unknown>;
  return {
    ...document,
    progress: normaliseProgress(document['progress']),`,
    detectedBy: 'unit',
  },
  {
    item: 'I1',
    name: 'a stored array is not a document',
    file: 'src/core/storage.ts',
    find: "  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {",
    replace: "  if (raw === null || typeof raw !== 'object') {",
    detectedBy: 'unit',
  },

  {
    item: 'I2',
    name: 'text that will not parse falls back instead of throwing',
    file: 'src/core/storage.ts',
    find: `      failure = describeFailure('parsing the saved document', error);
      return null;`,
    replace: '      throw error;',
    detectedBy: 'unit',
  },
  {
    item: 'I2',
    name: 'the progress of a valid document is read from where it is stored',
    file: 'src/core/storage.ts',
    find: "    progress: normaliseProgress(document['progress']),",
    replace: '    progress: normaliseProgress(document),',
    detectedBy: 'unit',
  },
  {
    item: 'I2',
    name: 'a stored setting is checked against the values its section offers',
    file: 'src/core/storage.ts',
    find: '    if (option === value) {',
    replace: '    if (option !== value) {',
    detectedBy: 'unit',
  },
  {
    item: 'I2',
    name: 'a lifetime counter is never carried back as a negative number',
    file: 'src/core/storage.ts',
    find: "  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {",
    replace: "  if (typeof value !== 'number' || !Number.isFinite(value)) {",
    detectedBy: 'unit',
  },
  {
    item: 'I2',
    name: 'a lifetime counter is a whole number of matches and goals',
    file: 'src/core/storage.ts',
    find: '  return Math.trunc(value);',
    replace: '  return value;',
    detectedBy: 'unit',
  },
  {
    item: 'I2',
    name: 'a stored volume out of range is clamped rather than taken',
    file: 'src/core/storage.ts',
    find: '  return Math.min(Math.max(value, 0), 1);',
    replace: '  return value;',
    detectedBy: 'unit',
  },
  {
    item: 'I2',
    name: 'a half-written best result is no result rather than half of one',
    file: 'src/core/storage.ts',
    find:
      "  if (typeof conceded !== 'number' || !Number.isFinite(conceded) || conceded < 0) {",
    replace: "  if (typeof conceded === 'string') {",
    detectedBy: 'unit',
  },

  {
    item: 'I3',
    name: 'the platform store is opened inside a try',
    file: 'src/core/storage.ts',
    find: `  try {
    backing = open();
  } catch (error) {
    failure = describeFailure('opening the platform store', error);
  }`,
    replace: '  backing = open();',
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a refused platform store is recorded and not swallowed',
    file: 'src/core/storage.ts',
    find: "    failure = describeFailure('opening the platform store', error);",
    replace: '    failure = null;',
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a store that refused to open reports itself as not persistent',
    file: 'src/core/storage.ts',
    find: '      return backing !== null;',
    replace: '      return true;',
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'the recorded failure names the error the platform threw',
    file: 'src/core/storage.ts',
    find:
      '  const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);',
    replace: "  const named = 'a platform failure';",
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a getItem that throws is caught rather than ending the session',
    file: 'src/core/storage.ts',
    find: `      failure = describeFailure('reading the saved document', error);
      return null;`,
    replace: '      throw error;',
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a setItem that throws is caught rather than interrupting the match',
    file: 'src/core/storage.ts',
    find: "      failure = describeFailure('writing the saved document', error);",
    replace: '      throw error;',
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a removeItem that throws is caught rather than ending the reset',
    file: 'src/core/storage.ts',
    find: "      failure = describeFailure('clearing the saved document', error);",
    replace: '      throw error;',
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'the in-memory value leads the store instead of following it',
    file: 'src/core/storage.ts',
    find: `    held = normaliseData(next);
    writeText(serialiseData(held));`,
    replace: `    writeText(serialiseData(normaliseData(next)));
    held = migrate(parseText(readText()));`,
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a reset puts the session back to the new-player data',
    file: 'src/core/storage.ts',
    find: `      held = NEW_DATA;
      if (!removeText()) {`,
    replace: '      if (!removeText()) {',
    detectedBy: 'unit',
  },
  {
    // The unit tests model the property access as a throwing `open`, so the
    // model is worth exactly what the shipped expression is: this entry breaks
    // the pin that ties the two together.
    item: 'I3',
    name: 'the composition root opens storage as one property access',
    file: 'src/main.ts',
    find: '  return window.localStorage;',
    replace: `  const store = window.localStorage;
  return store;`,
    detectedBy: 'unit',
  },

  {
    item: 'I4',
    name: 'an unarmed confirmation refuses the click a platform still delivers',
    file: 'src/ui/components/settings-panel.ts',
    find: `  confirmReset.addEventListener('click', () => {
    if (refused(confirmReset)) {
      return;
    }`,
    replace: "  confirmReset.addEventListener('click', () => {",
    detectedBy: 'browser',
  },
  {
    item: 'I4',
    name: 'a confirmed reset raises the reset the composition root answers',
    file: 'src/ui/components/settings-panel.ts',
    find: '    options.onReset();',
    replace: '    void options;',
    detectedBy: 'browser',
  },
  {
    item: 'I4',
    name: 'settings state where progress is stored',
    file: 'src/ui/components/settings-panel.ts',
    find: '  notice.textContent = STORAGE_NOTICE;',
    replace: "  notice.textContent = '';",
    detectedBy: 'browser',
  },
  {
    item: 'I4',
    name: 'a reset clears the stored document and not only the session',
    file: 'src/main.ts',
    find: '      store.clear();',
    replace: '      void store;',
    detectedBy: 'browser',
  },
  {
    item: 'I4',
    name: 'a reset puts the theme back to the one a new player gets',
    file: 'src/ui/layout.ts',
    find: `      applyTheme(NEW_THEME);
      settings.select(NEW_THEME);`,
    replace: '      settings.select(NEW_THEME);',
    detectedBy: 'browser',
  },
  {
    item: 'I4',
    name: 'the stored theme is applied to the document at mount',
    file: 'src/ui/layout.ts',
    find: `  applyTheme(theme);
  settings.select(theme);`,
    replace: '  settings.select(theme);',
    detectedBy: 'browser',
  },

  {
    item: 'I5',
    name: 'the menu opens on the mode the stored settings name',
    file: 'src/main.ts',
    find: '      initial: startingChoice,',
    replace: "      initial: { kind: 'quick', duration: 60, difficulty: 'casual' },",
    detectedBy: 'browser',
  },
  {
    item: 'I5',
    name: 'a start records the settings it was started with',
    file: 'src/main.ts',
    find: '      settings: settingsAfter(stored.settings, setup.choice, guideEnabled),',
    replace: '      settings: stored.settings,',
    detectedBy: 'browser',
  },
  {
    item: 'I5',
    name: 'the aim guide the menu opens with is the stored setting',
    file: 'src/main.ts',
    find: '  let guideEnabled = store.data().settings.guide;',
    replace: '  let guideEnabled = setup.guideDefault;',
    detectedBy: 'browser',
  },
  {
    item: 'I5',
    name: 'a theme change is written down as well as drawn',
    file: 'src/main.ts',
    find:
      '      store.save({ ...stored, settings: { ...stored.settings, theme: themeSetting() } });',
    replace: '      void stored;',
    detectedBy: 'browser',
  },
  {
    item: 'I5',
    name: 'the whistle records the best result and the lifetime counters',
    file: 'src/main.ts',
    find: `      recordResult(
        { ...stored, progress: advanced },
        setup.choice.kind,
        scoring.player,
        scoring.opponent,
      ),`,
    replace: '      { ...stored, progress: advanced },',
    detectedBy: 'browser',
  },
  {
    item: 'I5',
    name: 'nothing is recorded until the match is over',
    file: 'src/main.ts',
    find: "    if (recorded || match.readout().state.kind !== 'GAME_OVER') {",
    replace: '    if (recorded) {',
    detectedBy: 'browser',
  },

  {
    item: 'I2',
    name: 'a best result with an unusable goals scored is no result either',
    file: 'src/core/storage.ts',
    find: "  if (typeof scored !== 'number' || !Number.isFinite(scored) || scored < 0) {",
    replace: "  if (typeof scored === 'string') {",
    detectedBy: 'unit',
  },
  {
    item: 'I3',
    name: 'a refused remove falls back to writing the new-player document',
    file: 'src/core/storage.ts',
    find: `      if (!removeText()) {
        writeText(serialiseData(held));
      }`,
    replace: '      removeText();',
    detectedBy: 'unit',
  },
  {
    item: 'I4',
    name: 'a reset ends the claim the match in progress has on the document',
    file: 'src/main.ts',
    find: `      store.clear();
      recorded = true;`,
    replace: '      store.clear();',
    detectedBy: 'browser',
  },
  {
    item: 'I5',
    name: 'a first result in a mode is kept whatever it was',
    file: 'src/core/storage.ts',
    find: `  if (held === null) {
    return played;
  }`,
    replace: `  if (held === null) {
    return { goalsFor: 0, goalsAgainst: 0 };
  }`,
    detectedBy: 'unit',
  },
  {
    item: 'I5',
    name: 'the better goal margin is the one kept',
    file: 'src/core/storage.ts',
    find: '  if (playedMargin > heldMargin) {',
    replace: '  if (playedMargin < heldMargin) {',
    detectedBy: 'unit',
  },
  {
    item: 'I5',
    name: 'an equal margin is broken by the goals scored',
    file: 'src/core/storage.ts',
    find: '  if (playedMargin === heldMargin && played.goalsFor > held.goalsFor) {',
    replace: '  if (playedMargin === heldMargin && played.goalsFor < held.goalsFor) {',
    detectedBy: 'unit',
  },
  {
    item: 'I5',
    name: 'a result is recorded against the mode it was played in and no other',
    file: 'src/core/storage.ts',
    find: '      kind === mode ? bestOf(data.records[kind], played) : data.records[kind],',
    replace: '      bestOf(data.records[kind], played),',
    detectedBy: 'unit',
  },
  {
    item: 'I5',
    name: 'the lifetime counters take every match that finished',
    file: 'src/core/storage.ts',
    find: '      matchesPlayed: data.counters.matchesPlayed + 1,',
    replace: '      matchesPlayed: data.counters.matchesPlayed,',
    detectedBy: 'unit',
  },
  // ---------------------------------------------------------------------
  // PF-14. QUALITY-BAR section 5's four breakpoints, SPEC section 2.1's
  // letterbox and its hint, QUALITY-BAR section 4's play-surface size and the
  // safe-area insets. Items F1 to F7.
  //
  // BROWSER ENTRIES ARE THE LAST RESORT AND FOUR OF THEM EARN IT. All four
  // are a round trip through the stored document: a value written at the
  // moment the player changes it and read back on the next load. A source tie
  // would prove the line reads a certain way and nothing about whether the
  // document carries it, so the browser is the honest detector there.
  //
  // EVERYTHING ELSE IS TIED INSTEAD, including the composition root's own
  // wiring: tests/unit/responsive-chrome.test.ts reads src/main.ts as text and
  // holds the class names, the attribute names AND the values every ternary
  // chooses against the stylesheet that answers them. A tie is weaker evidence
  // than a behaviour test and it is not offered as a substitute for one: the
  // browser specs grade the behaviour regardless. What it buys is an entry
  // that costs three seconds rather than a build and a Playwright pass, which
  // is what the last-resort rule asks for.
  // ---------------------------------------------------------------------
  {
    item: 'F1',
    name: 'the wide breakpoint begins at the width the document gives it',
    file: 'src/ui/breakpoints.ts',
    find: 'export const WIDE_MIN_WIDTH = 1024;',
    replace: 'export const WIDE_MIN_WIDTH = 1023;',
    detectedBy: 'unit',
  },
  {
    item: 'F1',
    name: 'the medium breakpoint begins at the width the document gives it',
    file: 'src/ui/breakpoints.ts',
    find: 'export const MEDIUM_MIN_WIDTH = 768;',
    replace: 'export const MEDIUM_MIN_WIDTH = 767;',
    detectedBy: 'unit',
  },
  {
    item: 'F1',
    name: 'the breakpoints resolve by width before orientation',
    file: 'src/ui/breakpoints.ts',
    find: '  if (width >= WIDE_MIN_WIDTH) {',
    replace: '  if (width >= WIDE_MIN_WIDTH && height < width) {',
    detectedBy: 'unit',
  },
  {
    item: 'F1',
    name: 'a square viewport is portrait, as the platform reads it',
    file: 'src/ui/breakpoints.ts',
    find: "  return height >= width ? 'portrait' : 'compact';",
    replace: "  return height > width ? 'portrait' : 'compact';",
    detectedBy: 'unit',
  },
  {
    item: 'F1',
    name: 'the root asks for the breakpoint by width and then by height',
    file: 'src/main.ts',
    find: 'breakpointFor(window.innerWidth, window.innerHeight)',
    replace: 'breakpointFor(window.innerHeight, window.innerWidth)',
    detectedBy: 'unit',
  },
  {
    item: 'F1',
    name: 'the HUD wraps rather than overflowing a narrow viewport',
    file: 'src/ui/components/chrome.css',
    find: `.pf-hud {
  display: flex;
  flex-wrap: wrap;`,
    replace: `.pf-hud {
  display: flex;
  flex-wrap: nowrap;`,
    detectedBy: 'unit',
  },
  {
    item: 'F2',
    name: 'the aim row wraps rather than overflowing a narrow viewport',
    file: 'src/ui/components/chrome.css',
    find: `.pf-aim-row:not([hidden]) {
  display: flex;
  flex-wrap: wrap;`,
    replace: `.pf-aim-row:not([hidden]) {
  display: flex;
  flex-wrap: nowrap;`,
    detectedBy: 'unit',
  },
  {
    item: 'F7',
    name: 'the sticky threshold is the height the document gives it',
    file: 'src/ui/breakpoints.ts',
    find: 'export const STICKY_MIN_HEIGHT = 400;',
    replace: 'export const STICKY_MIN_HEIGHT = 360;',
    detectedBy: 'unit',
  },
  {
    item: 'F7',
    name: 'the bars stay stuck AT the threshold and unstick below it',
    file: 'src/ui/breakpoints.ts',
    find: '  return height >= STICKY_MIN_HEIGHT;',
    replace: '  return height > STICKY_MIN_HEIGHT;',
    detectedBy: 'unit',
  },
  {
    item: 'F7',
    name: 'the HUD sticks to the top while the bars are stuck',
    file: 'src/ui/components/chrome.css',
    find: `:root[data-pf-bars='sticky'] .pf-hud {
  position: sticky;`,
    replace: `:root[data-pf-bars='sticky'] .pf-hud {
  position: static;`,
    detectedBy: 'unit',
  },
  {
    item: 'F7',
    name: 'the aim bar sticks to the bottom and not to the top',
    file: 'src/ui/components/chrome.css',
    find: '  inset-block-end: 0;',
    replace: '  inset-block-start: 0;',
    detectedBy: 'unit',
  },
  {
    item: 'F7',
    name: 'the stage takes a viewport of its own once the bars unstick',
    file: 'src/ui/components/chrome.css',
    find: ":root[data-pf-bars='static'] .pf-stage {",
    replace: ":root[data-pf-bars='sticky'] .pf-stage {",
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the fit is the smaller of what the width and the height allow',
    file: 'src/render/surface.ts',
    find: '  const base = Math.min(availableWidth, byHeight);',
    replace: '  const base = availableWidth;',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the height s own limit is derived through the logical aspect',
    file: 'src/render/surface.ts',
    find: '  const byHeight = (availableHeight * LOGICAL_WIDTH) / LOGICAL_HEIGHT;',
    replace: '  const byHeight = (availableHeight * LOGICAL_HEIGHT) / LOGICAL_WIDTH;',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the fitted width is floored to a whole css pixel',
    file: 'src/render/surface.ts',
    find: '  const whole = Number.isFinite(base) ? Math.floor(base) : 0;',
    replace: '  const whole = Number.isFinite(base) ? base : 0;',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the size setting is the percent it names',
    file: 'src/render/surface.ts',
    find: '  return sizePercent / 100;',
    replace: '  return sizePercent / 200;',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the base is floored BEFORE the size factor is applied',
    file: 'src/render/surface.ts',
    find: '  return Math.max(1, whole) * surfaceFactor(sizePercent);',
    replace: '  return Math.max(1, Math.floor(base * surfaceFactor(sizePercent)));',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the overflow question is answered for the down axis',
    file: 'src/render/surface.ts',
    find: '    down: cssHeightFor(cssWidth) > availableHeight,',
    replace: '    down: false,',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the overflow question is answered for the across axis',
    file: 'src/render/surface.ts',
    find: '    across: cssWidth > availableWidth,',
    replace: '    across: false,',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the two axes are answered separately and not by one boolean',
    file: 'src/render/surface.ts',
    find: `    across: cssWidth > availableWidth,
    down: cssHeightFor(cssWidth) > availableHeight,`,
    replace: `    across: cssWidth > availableWidth || cssHeightFor(cssWidth) > availableHeight,
    down: cssWidth > availableWidth || cssHeightFor(cssWidth) > availableHeight,`,
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the frame anchors the across axis only where it overflows',
    file: 'src/main.ts',
    find: "    frame.dataset['pfFitX'] = over.across ? 'over' : 'fit';",
    replace: "    frame.dataset['pfFitX'] = over.across ? 'fit' : 'over';",
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the frame anchors the down axis only where it overflows',
    file: 'src/main.ts',
    find: "    frame.dataset['pfFitY'] = over.down ? 'over' : 'fit';",
    replace: "    frame.dataset['pfFitY'] = over.down ? 'fit' : 'over';",
    detectedBy: 'unit',
  },
  {
    item: 'F7',
    name: 'the bars are told to stick above the threshold and not below it',
    file: 'src/main.ts',
    find: "  root.dataset['pfBars'] = barsStick(window.innerHeight) ? 'sticky' : 'static';",
    replace: "  root.dataset['pfBars'] = barsStick(window.innerHeight) ? 'static' : 'sticky';",
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'a magnified frame follows the play, which no gesture can pan',
    file: 'src/main.ts',
    find: `    frame.scrollLeft = at.left;
    frame.scrollTop = at.top;`,
    replace: '    void at;',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the frame watches the launcher while an aim can be taken',
    file: 'src/main.ts',
    find: '    const watched = input.allowed() ? context.aimWorld.player : world.ball;',
    replace: '    const watched = world.ball;',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'a design point is centred in the frame through the one transform',
    file: 'src/render/surface.ts',
    find: '    left: designX * cssPerUnit - viewWidth / 2,',
    replace: '    left: designX * cssPerUnit,',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the follow scroll carries the y flip the draw transform carries',
    file: 'src/render/surface.ts',
    find: '    top: (LOGICAL_HEIGHT - designY) * cssPerUnit - viewHeight / 2,',
    replace: '    top: designY * cssPerUnit - viewHeight / 2,',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'a magnified across axis is anchored rather than centred',
    file: 'src/ui/components/chrome.css',
    find: `.pf-play-frame[data-pf-fit-x='over'] {
  justify-content: start;`,
    replace: `.pf-play-frame[data-pf-fit-x='over'] {
  justify-content: center;`,
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'a magnified down axis is anchored rather than centred',
    file: 'src/ui/components/chrome.css',
    find: `.pf-play-frame[data-pf-fit-y='over'] {
  align-content: start;`,
    replace: `.pf-play-frame[data-pf-fit-y='over'] {
  align-content: center;`,
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the play frame is what a magnified across axis overflows into',
    file: 'src/ui/components/chrome.css',
    find: '  overflow-x: auto;',
    replace: '  overflow-x: hidden;',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the play frame is what a magnified down axis overflows into',
    file: 'src/ui/components/chrome.css',
    find: `  align-content: start;
  overflow-y: auto;`,
    replace: `  align-content: start;
  overflow-y: hidden;`,
    detectedBy: 'unit',
  },
  {
    item: 'F1',
    name: 'a fitted surface is centred in both axes, so the bands are even',
    file: 'src/ui/components/chrome.css',
    find: `  justify-content: center;
  align-content: center;
  overflow: hidden;`,
    replace: `  justify-content: start;
  align-content: center;
  overflow: hidden;`,
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the size control offers every size the stored settings name',
    file: 'src/ui/components/settings-panel.ts',
    find: '  for (const percent of SURFACE_SCALES) {',
    replace: '  for (const percent of SURFACE_SCALES.slice(1)) {',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the size control is named by the percent it carries',
    file: 'src/ui/components/settings-panel.ts',
    find: "    radio.setAttribute('aria-label', `${String(percent)}%`);",
    replace: "    radio.setAttribute('aria-label', String(percent));",
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'only the radio that was checked raises a size change',
    file: 'src/ui/components/settings-panel.ts',
    find: `      if (radio.checked) {
        options.onSurfaceScaleChange(percent);
      }`,
    replace: '      options.onSurfaceScaleChange(percent);',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the size control opens on the stored value',
    file: 'src/ui/layout.ts',
    find: '  settings.selectSurfaceScale(options.initialSurfaceScale ?? NEW_SURFACE_SCALE);',
    replace: '  settings.selectSurfaceScale(NEW_SURFACE_SCALE);',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'a reset checks the size a new player gets',
    file: 'src/ui/layout.ts',
    find: '      settings.selectSurfaceScale(NEW_SURFACE_SCALE);',
    replace: '      settings.selectSurfaceScale(200);',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'a reset raises the size a new player gets, so the pitch follows',
    file: 'src/ui/layout.ts',
    find: '      options.onSurfaceScaleChange?.(NEW_SURFACE_SCALE);',
    replace: '      options.onSurfaceScaleChange?.(200);',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the hint is put away by its own control',
    file: 'src/ui/components/portrait-hint.ts',
    find: `    root.hidden = true;
    options.onDismiss();`,
    replace: '    options.onDismiss();',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the hint opens on the dismissal it was handed',
    file: 'src/ui/layout.ts',
    find: '  hint.setDismissed(options.hintDismissed ?? false);',
    replace: '  hint.setDismissed(false);',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the hint takes its own row between the HUD and the pitch',
    file: 'src/ui/layout.ts',
    find: `  host.insertBefore(hint.root, host.firstChild);
  host.insertBefore(hud.root, hint.root);`,
    replace: `  host.insertBefore(hud.root, host.firstChild);
  host.append(hint.root);`,
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the hint is shown at the portrait breakpoint and at no other',
    file: 'src/ui/components/chrome.css',
    find: ":root[data-pf-breakpoint='portrait'] .pf-portrait-hint:not([hidden]) {",
    replace: ":root[data-pf-breakpoint='compact'] .pf-portrait-hint:not([hidden]) {",
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'a reset brings the hint back',
    file: 'src/ui/layout.ts',
    find: '      hint.setDismissed(false);',
    replace: '      hint.isDismissed();',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'the progress record answers for the hint s dismissal',
    file: 'src/core/modes.ts',
    find: '    rotateHintDismissed: rotate === true,',
    replace: '    rotateHintDismissed: false,',
    detectedBy: 'unit',
  },
  {
    item: 'F3',
    name: 'a player who has never opened the game has dismissed nothing',
    file: 'src/core/modes.ts',
    find: `  howToDismissed: false,
  rotateHintDismissed: false,`,
    replace: `  howToDismissed: false,
  rotateHintDismissed: true,`,
    detectedBy: 'unit',
  },
  {
    item: 'F4',
    name: 'all four safe-area insets are read from the platform',
    file: 'src/ui/components/chrome.css',
    find: '  --pf-safe-top: env(safe-area-inset-top);',
    replace: '  --pf-safe-top: env(safe-area-inset-bottom);',
    detectedBy: 'unit',
  },
  {
    item: 'F4',
    name: 'the top bar adds the top inset, so no control sits under a notch',
    file: 'src/ui/components/chrome.css',
    find: '  padding-block: calc(var(--space-2) + var(--pf-safe-top)) var(--space-2);',
    replace: '  padding-block: var(--space-2);',
    detectedBy: 'unit',
  },
  {
    item: 'F4',
    name: 'the bottom bar adds the bottom inset, for the home indicator',
    file: 'src/ui/components/chrome.css',
    find: '  padding-block: var(--space-2) calc(var(--space-2) + var(--pf-safe-bottom));',
    replace: '  padding-block: var(--space-2);',
    detectedBy: 'unit',
  },
  {
    item: 'F4',
    name: 'the overlays add the insets as well as the bars',
    file: 'src/ui/components/chrome.css',
    find: `  padding-block: calc(var(--space-4) + var(--pf-safe-top))
    calc(var(--space-4) + var(--pf-safe-bottom));`,
    replace: '  padding-block: var(--space-4);',
    detectedBy: 'unit',
  },
  {
    // The cheap seam the directive asks for, rather than a browser run: the
    // unit suite ties this call as source, so both arguments are protected
    // without a build and a Playwright pass. The BEHAVIOUR is graded in
    // tests/browser/breakpoints.spec.ts and surface-scale.spec.ts either way.
    item: 'F3',
    name: 'the fit is given the height of the box it is fitted into',
    file: 'src/main.ts',
    find: '    const cssWidth = fitCssWidth(width, height, sizePercent);',
    replace: '    const cssWidth = fitCssWidth(width, height * 100, sizePercent);',
    detectedBy: 'unit',
  },
  {
    item: 'F6',
    name: 'the size setting reaches the fit',
    file: 'src/main.ts',
    find: '    const cssWidth = fitCssWidth(width, height, sizePercent);',
    replace: '    const cssWidth = fitCssWidth(width, height, 100);',
    detectedBy: 'unit',
  },
  {
    // BROWSER: a settings write is a composition-root decision about WHEN the
    // document is written, and SPEC section 16 allows exactly this moment.
    item: 'F6',
    name: 'a size change is written to the stored document',
    file: 'src/main.ts',
    find:
      '      store.save({ ...stored, settings: { ...stored.settings, surfaceScale: percent } });',
    replace: '      void stored;',
    detectedBy: 'browser',
  },
  {
    // BROWSER: the other half of the same handler, and a different property.
    // Without it the size is stored and not applied until the next resize.
    item: 'F6',
    name: 'a size change is applied to the pitch at the moment it is made',
    file: 'src/main.ts',
    find: '      play.setScale(percent);',
    replace: '      void percent;',
    detectedBy: 'browser',
  },
  {
    // BROWSER: the hint's dismissal reaches the stored document through the
    // progress seam. The unit layer sees the chrome raise it and the store
    // round-trip it; only a mounted root joins the two.
    item: 'F3',
    name: 'the hint s dismissal is written to the stored document',
    file: 'src/main.ts',
    find: '      progress.write({ ...progress.read(), rotateHintDismissed: true });',
    replace: '      progress.read();',
    detectedBy: 'browser',
  },
  {
    // BROWSER: and the read back, which is what makes the dismissal outlive
    // the session rather than the tab.
    item: 'F3',
    name: 'the hint opens on the dismissal the stored document holds',
    file: 'src/main.ts',
    find: '    hintDismissed: progress.read().rotateHintDismissed,',
    replace: '    hintDismissed: false,',
    detectedBy: 'browser',
  },

  // ==========================================================================
  // The workflow, the dependency policy, the determinism wiring, the boundary
  // by reach, and the harness's own verdict rule.
  //
  // GH6 is GITHUB section 6, the merge gate; GH12 is section 12, dependencies
  // and supply chain; QB13 is QUALITY-BAR section 13, which is where "a test
  // that cannot fail is not a test" is written and therefore where a harness
  // that reads a killed process as a detection is answerable. The rest carry
  // the acceptance item whose gate they strengthen.
  // ==========================================================================

  {
    // GITHUB 6: a required check that has not reported is a failure, never a
    // pass, and GITHUB 7's closure of the squash gap is the push-to-main run.
    // Unconditional cancellation left three commits on the default branch with
    // no completed run at all.
    // RE-POINTED: the exemption used to be written against the ref and is now
    // written against the event, because the group below carries the commit.
    // Same property, same detector, one line further down the file.
    item: 'GH6',
    name: 'a push to the default branch is never cancelled by a later push',
    file: '.github/workflows/ci.yml',
    find: "cancel-in-progress: ${{ github.event_name != 'push' }}",
    replace: 'cancel-in-progress: true',
    detectedBy: 'unit',
  },
  {
    // The other half, and the half `cancel-in-progress` cannot cover: inside a
    // shared group a QUEUED run is cancelled by the next arrival whatever the
    // flag says, so a burst of three pushes still loses the middle one.
    item: 'GH6',
    name: 'a push to the default branch runs in a group of its own',
    file: '.github/workflows/ci.yml',
    find:
      '  group: ${{ github.workflow }}-${{ github.ref }}-' +
      "${{ github.event_name == 'push' && github.sha || '' }}",
    replace: '  group: ${{ github.workflow }}-${{ github.ref }}',
    detectedBy: 'unit',
  },
  {
    // GITHUB 6: the two required checks judge one tree. With a ref override the
    // record gate read the pull request head while the gates job built the
    // merge result.
    item: 'GH6',
    name: 'both jobs check out the same tree',
    file: '.github/workflows/ci.yml',
    find: '          fetch-depth: 0',
    replace:
      '          fetch-depth: 0\n' +
      '          ref: ${{ github.event.pull_request.head.sha || github.ref }}',
    detectedBy: 'unit',
  },
  {
    // The browser phase is 94.0 percent of its job. Without its own budget a
    // slow suite is reported as a killed job, which reads as infrastructure.
    item: 'GH6',
    name: 'the browser phase carries its own budget inside the job cap',
    file: '.github/workflows/ci.yml',
    find: '        timeout-minutes: 25',
    replace: '        timeout-minutes: 30',
    detectedBy: 'unit',
  },

  {
    // QUALITY-BAR 13: the tests that load ESLint exceed the runner's default on
    // a cold module graph, so the unit gate goes red for a reason unrelated to
    // the code, and the harness reads that red as a detection.
    // LABELLED QB13 AND NOT C9. Both entries live in the pointer file, but
    // neither attacks anything item C9 states: C9 is "input is handled through
    // Pointer Events only", and what these two protect is a suite that can tell
    // a slow start from a broken gate, which is QUALITY-BAR section 13's
    // sentence. The label routes the entry to whoever owns the property.
    item: 'QB13',
    name: 'the pointer config test states its own cold-load budget',
    file: 'tests/unit/pointer-events.test.ts',
    find: '    { timeout: COLD_ESLINT_LOAD_MS },',
    replace: '    // budget removed',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'the cold-load budget is the measured figure and not the default',
    file: 'tests/unit/pointer-events.test.ts',
    find: 'const COLD_ESLINT_LOAD_MS = 30_000;',
    replace: 'const COLD_ESLINT_LOAD_MS = 5_000;',
    detectedBy: 'unit',
  },
  {
    // The other half of the same decision: two named exceptions are a
    // measurement, a raised default is a suite that stops noticing a hang.
    item: 'QB13',
    name: 'the suite-wide default budget is not loosened',
    file: 'vitest.config.ts',
    find: "    environment: 'node',",
    replace: "    environment: 'node',\n    testTimeout: 30_000,",
    detectedBy: 'unit',
  },

  {
    // A process killed at its deadline never reached a verdict. Reading its
    // non-zero exit as a detection reports a gate as working on a run that
    // measured nothing.
    // EVERY FIND BELOW SPANS TWO LINES ON PURPOSE. This file is its own
    // target, and a single-line anchor also matches the string literal that
    // states it, which the staleness guard correctly refuses as two matches.
    item: 'QB13',
    name: 'a detector killed by its own deadline is not a detection',
    file: 'scripts/mutation-check.mjs',
    find: '  const killed =\n    error.killed === true ||',
    replace: '  const killed =\n    false ||',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a detector killed from outside is not a detection either',
    file: 'scripts/mutation-check.mjs',
    find:
      '    error.killed === true ||\n' +
      '    (error.signal !== null && error.signal !== undefined);',
    replace: '    error.killed === true ||\n    false;',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a killed detector is the verdict that stops the sweep',
    file: 'scripts/mutation-check.mjs',
    find: "  if (outcome.killed) {\n    return 'error';",
    replace: "  if (false) {\n    return 'error';",
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a stopped sweep says so in its last line',
    file: 'scripts/mutation-check.mjs',
    find: '  if (stoppedAt !== null) {\n    return {',
    replace: '  if (false) {\n    return {',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'an undetected entry still fails the sweep',
    file: 'scripts/mutation-check.mjs',
    find: '  if (missed > 0) {\n    return {',
    replace: '  if (false) {\n    return {',
    detectedBy: 'unit',
  },

  {
    // Item A6. The RUNS table was pinned as four differing conditions and
    // nothing asserted the table reached the build, so each condition could be
    // pinned to the first row with verify:build PASS and the report still
    // printing the second row.
    item: 'A6',
    name: 'the time zone the build runs under comes from the run',
    file: 'scripts/check-determinism.mjs',
    find: '      TZ: run.zone,',
    replace: '      TZ: RUNS[0].zone,',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the VITE_ probe value comes from the run',
    file: 'scripts/check-determinism.mjs',
    find: '      VITE_DETERMINISM_PROBE: run.probe,',
    replace: '      VITE_DETERMINISM_PROBE: RUNS[0].probe,',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the output directory comes from the run',
    file: 'scripts/check-determinism.mjs',
    find: "    argv: [VITE, 'build', '--outDir', run.outDir, '--emptyOutDir'],",
    replace: "    argv: [VITE, 'build', '--outDir', RUNS[0].outDir, '--emptyOutDir'],",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the composed environment is what the child process is given',
    file: 'scripts/check-determinism.mjs',
    find:
      "  spawn(process.execPath, argv, { cwd: PROJECT_ROOT, stdio: 'pipe', env });",
    replace:
      "  spawn(process.execPath, argv, { cwd: PROJECT_ROOT, stdio: 'pipe', env: process.env });",
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'each run stamps the inputs with its own fake time',
    file: 'scripts/check-determinism.mjs',
    find: '      stamp(files, entry.stamp);',
    replace: '      stamp(files, runs[0].stamp);',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the same fake time is written to both timestamps',
    file: 'scripts/check-determinism.mjs',
    find: '    touch(file, when, when);',
    replace: '    touch(file, when, new Date(0));',
    detectedBy: 'unit',
  },
  {
    // The edit the script's own docstring says proves almost nothing: two
    // builds a second apart under identical conditions.
    item: 'A6',
    name: 'the loop runs every row of the table and not the first one twice',
    file: 'scripts/check-determinism.mjs',
    find: '    for (const entry of runs) {',
    replace: '    for (const entry of [runs[0], runs[0]]) {',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'the report table is built from what each build was given',
    file: 'scripts/check-determinism.mjs',
    find: '    ...conditionRows(records).map(row),',
    replace: '    ...conditionRows(RUNS).map(row),',
    detectedBy: 'unit',
  },
  {
    item: 'A6',
    name: 'each report row states the condition it names',
    file: 'scripts/check-determinism.mjs',
    find: "    ['TZ', ...cells((entry) => entry.zone)],",
    replace: "    ['TZ', ...cells((entry) => entry.probe)],",
    detectedBy: 'unit',
  },

  {
    // Item M3. A module one directory below src/core was subject to neither
    // the boundary rules' path scoping nor the source sweep.
    item: 'M3',
    name: 'the module walk descends into subdirectories',
    file: 'tools/eslint-plugin-core-boundary/lib/reach.js',
    find: '          stack.push(path.join(directory, entry.name));',
    replace: '          void entry;',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'a dependency that leaves the boundary is reported',
    file: 'tools/eslint-plugin-core-boundary/lib/reach.js',
    find: '      if (resolved === null || !isInside(root, resolved)) {',
    replace: '      if (false) {',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the sweep s own count is taken over a tree it walked into',
    file: 'tests/unit/determinism.test.ts',
    find: '      total += countTypeScriptUnder(path.join(directory, entry.name));',
    replace: '      total += 0;',
    detectedBy: 'unit',
  },
  {
    // Item M3, second clause. A denylist reports the names somebody
    // remembered; `type A = ChildNode` passed every gate this project has.
    item: 'M3',
    name: 'a DOM name nobody listed is still refused inside core',
    file: 'tools/eslint-plugin-core-boundary/lib/platform-globals.js',
    find: '  if (DOM_LIB_NAMES.has(name)) {',
    replace: '  if (false) {',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'the DOM name set is derived from the installed library files',
    file: 'tools/eslint-plugin-core-boundary/lib/platform-globals.js',
    find: "    return { names: dom, origin: path.join(libraries, 'lib.dom.d.ts') };",
    replace: '    return { names: new Set(), origin: null };',
    detectedBy: 'unit',
  },
  {
    // Without the subtraction the rule reports Math inside a module whose
    // whole job is arithmetic, and it is switched off within a week.
    item: 'M3',
    name: 'the language s own names are subtracted from the DOM set',
    file: 'tools/eslint-plugin-core-boundary/lib/platform-globals.js',
    find: '        dom.delete(name);',
    replace: '        dom.add(name);',
    detectedBy: 'unit',
  },
  {
    // Time is an input to the simulation. A core module reading the wall clock
    // has left the seeded, replayable model.
    item: 'M3',
    name: 'the wall clock is refused inside core',
    file: 'tools/eslint-plugin-core-boundary/lib/platform-globals.js',
    find: "  'Date',\n  // Scheduling by microtask",
    replace: "  'DateOfBirth',\n  // Scheduling by microtask",
    detectedBy: 'unit',
  },

  {
    // GITHUB 12: a dependency pull request merges when the gate is green and
    // never because it is only a version bump. A major grouped with two
    // patches makes "do not merge" the only correct answer.
    item: 'GH12',
    name: 'a major version opens its own pull request',
    file: '.github/dependabot.yml',
    find: '        update-types:\n          - minor\n          - patch',
    replace: '        update-types:\n          - minor',
    detectedBy: 'unit',
  },
  {
    item: 'GH12',
    name: 'an unsupported runtime refuses to install rather than warning',
    file: '.npmrc',
    find: 'engine-strict=true',
    replace: 'engine-strict=false',
    detectedBy: 'unit',
  },

  {
    // GITHUB 6: the record check owns every commit reachable from the
    // checked-out revision. On a shallow clone it reported a verdict on the
    // part of the history that happened to be present.
    item: 'GH7',
    name: 'a shallow repository is refused rather than judged',
    file: 'scripts/check-repository-record.mjs',
    find: "  if (String(output).trim() !== 'true') {",
    replace: '  if (true) {',
    detectedBy: 'unit',
  },
  {
    // RE-POINTED: the read moved behind `shallowState` so its failing path has
    // a home a test can drive. Same property, same detector, same line of the
    // walk.
    item: 'GH7',
    name: 'the commit walk consults the shallow flag before it reads the log',
    file: 'scripts/check-repository-record.mjs',
    find:
      '  const { refusal } = shallowState(() =>\n' +
      "    git('rev-parse', '--is-shallow-repository'),\n" +
      '  );',
    replace: '  const refusal = null;',
    detectedBy: 'unit',
  },
  {
    // A gate that cannot confirm it has the whole history refuses. Noting the
    // cause and walking on turned a repository that would not answer into the
    // same "ok, N commits checked" a clean history earns.
    item: 'GH7',
    name: 'a shallow check that could not run refuses instead of noting',
    file: 'scripts/check-repository-record.mjs',
    find:
      '      refusal:\n' +
      "        'this repository would not say whether it is shallow, so the commit ' +",
    replace: "      refusal:\n        null && 'a note rather than a refusal' +",
    detectedBy: 'unit',
  },

  {
    // The suite reaches five modules through declarations nothing verified, so
    // the declarations decided what every test believed about them.
    item: 'QB13',
    name: 'a declaration promising an export the module lacks is reported',
    file: 'scripts/output-fingerprint.d.mts',
    find: 'export declare function hashBytes(data: Uint8Array | string): string;',
    replace:
      'export declare function hashBytes(data: Uint8Array | string): string;\n' +
      'export declare const notActuallyExported: number;',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'an export the declaration forgot is reported too',
    file: 'tools/eslint-plugin-core-boundary/index.d.ts',
    find: 'export declare function isCorePath(filename: unknown): boolean;',
    replace: '// isCorePath is no longer declared',
    detectedBy: 'unit',
  },

  {
    // A single non-null assertion defeats strict, noUncheckedIndexedAccess and
    // exactOptionalPropertyTypes at the point it is written.
    item: 'QB13',
    name: 'the non-null assertion is refused in the shipped source',
    file: 'eslint.config.js',
    find: "    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },",
    replace: "    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },",
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'that rule is scoped to the shipped source and stated to be',
    file: 'eslint.config.js',
    find: "    files: ['src/**/*.{ts,tsx,mts,cts}'],",
    replace: "    files: ['**/*.{ts,tsx,mts,cts}'],",
    detectedBy: 'unit',
  },
  {
    // Item C9. The clean fixture is what makes a stated limit tested rather
    // than merely admitted, and it is only worth anything if the plain form of
    // the same line is caught.
    item: 'C9',
    name: 'the clean pointer fixture is swept and the plain handler is caught',
    file: 'tests/lint/fixtures/pointer/pointer-only.ts',
    find: 'surface[PROP] = handler;',
    replace: 'surface.onmousedown = handler;',
    detectedBy: 'unit',
  },

  // ==========================================================================
  // The gates the review found reporting green while doing nothing: a closure
  // walk that could not read the import form five core modules are written in,
  // a comment stripper no test could fail, a workflow whose load-bearing shape
  // was asserted nowhere, and this harness's own blindness to a tree that moved
  // under it.
  //
  // EVERY FIND AIMED AT THIS FILE SPANS TWO LINES, for the reason stated above
  // the killed-detector entries: a single-line anchor also matches the string
  // literal that states it, which the staleness guard correctly refuses.
  // ==========================================================================

  {
    // Item M3. `import {` on one line and the list on the next is the form
    // ai.ts, bodies.ts, goals.ts, guide.ts and physics.ts are written in, and a
    // pattern that stopped at the newline read none of their dependencies:
    // a wrapped import of an unseeded module passed lint, the closure walk and
    // the whole suite.
    item: 'M3',
    name: 'the closure walk reads a wrapped import list',
    file: 'tools/eslint-plugin-core-boundary/lib/reach.js',
    find: "[^;'\"]*?\\bfrom",
    replace: "[^;'\"\\n]*?\\bfrom",
    detectedBy: 'unit',
  },
  {
    // Item M3, the stripper's three branches. A commented-out import is not an
    // import; without this branch the walk reports an escape nobody wrote.
    item: 'M3',
    name: 'an import inside a line comment is not an import',
    file: 'tools/eslint-plugin-core-boundary/lib/reach.js',
    find: "    if (here === '/' && next === '/') {",
    replace: '    if (false) {',
    detectedBy: 'unit',
  },
  {
    item: 'M3',
    name: 'an import inside a block comment is not an import either',
    file: 'tools/eslint-plugin-core-boundary/lib/reach.js',
    find: "    if (here === '/' && next === '*') {",
    replace: '    if (false) {',
    detectedBy: 'unit',
  },
  {
    // The branch that keeps the other two honest: without the quote state, a
    // string that merely CONTAINS a comment opener starts a comment that eats
    // every import below it, and the walk reports a module with dependencies as
    // a module with none.
    item: 'M3',
    name: 'a comment opener inside a string opens no comment',
    file: 'tools/eslint-plugin-core-boundary/lib/reach.js',
    find: "    if (here === \"'\" || here === '\"' || here === '`') {",
    replace: '    if (false) {',
    detectedBy: 'unit',
  },

  {
    // GITHUB 6: the exemption is worth nothing without the trigger it serves.
    // Removed, there is no default-branch run to preserve at all and every
    // other assertion about cancellation still passes.
    item: 'GH6',
    name: 'the workflow runs on a push to the default branch',
    file: '.github/workflows/ci.yml',
    find: 'on:\n  push:\n    branches: [main]\n  pull_request:',
    replace: 'on:\n  pull_request:',
    detectedBy: 'unit',
  },
  {
    // One tree, one lockfile, one runtime. A policy job on one major and a
    // gates job on another is two answers to a question the manifest asks once.
    item: 'GH6',
    name: 'both jobs pin the same runtime',
    file: '.github/workflows/ci.yml',
    find: '          node-version: 20.19.0\n          cache: npm',
    replace: '          node-version: 22.13.0\n          cache: npm',
    detectedBy: 'unit',
  },
  {
    // And the pin is inside the range package.json declares, which under
    // engine-strict is the difference between an install and a refusal.
    item: 'GH6',
    name: 'the pinned runtime is one the manifest says it supports',
    file: '.github/workflows/ci.yml',
    find: '          node-version: 20.19.0\n\n      - name: Branches',
    replace: '          node-version: 18.20.8\n\n      - name: Branches',
    detectedBy: 'unit',
  },
  {
    // A job renamed here and not in the ruleset leaves `main` waiting on a
    // context nothing will ever report, which reads as pending, not as failed.
    item: 'GH6',
    name: 'the job names are the ruleset s required contexts, character for character',
    file: '.github/workflows/ci.yml',
    find: '    name: Pocket Football gates',
    replace: '    name: Pocket Football checks',
    detectedBy: 'unit',
  },
  {
    // The cheap check runs first so a banned name in the record fails before a
    // five minute install rather than after it.
    item: 'GH6',
    name: 'the gates job waits for the record check',
    file: '.github/workflows/ci.yml',
    find: '    needs: repository-policy',
    replace: '    # needs: repository-policy',
    detectedBy: 'unit',
  },
  {
    // Each step below can be deleted on its own and leave a workflow that is
    // still green and no longer decides anything.
    item: 'GH6',
    name: 'the record check is a step the merge waits on',
    file: '.github/workflows/ci.yml',
    find: '        run: node scripts/check-repository-record.mjs',
    replace: '        run: echo skipped',
    detectedBy: 'unit',
  },
  {
    item: 'GH6',
    name: 'the unit suite is a step the merge waits on',
    file: '.github/workflows/ci.yml',
    find: '      - name: Unit and headless tests\n        run: npm run test',
    replace: '      - name: Unit and headless tests\n        run: echo skipped',
    detectedBy: 'unit',
  },
  {
    item: 'GH6',
    name: 'the browser suite is a step the merge waits on',
    file: '.github/workflows/ci.yml',
    find: '        run: npm run test:browser',
    replace: '        run: echo skipped',
    detectedBy: 'unit',
  },
  {
    item: 'GH6',
    name: 'the deterministic build is a step the merge waits on',
    file: '.github/workflows/ci.yml',
    find: '        run: npm run verify:build',
    replace: '        run: echo skipped',
    detectedBy: 'unit',
  },

  {
    // GITHUB 12. Under engine-strict the declared range decides whether an
    // install happens at all, so a floor that over-promises is a refusal
    // waiting for a contributor: 27 of the lockfile's 117 ranges refuse Node
    // 22.0 to 22.12, 10 refuse 22.12, 31 refuse 21.x and 11 refuse 23.x, all of
    // which ">=20.19.0" declared supported.
    item: 'GH12',
    name: 'the declared runtime range is the one the lockfile supports',
    file: 'package.json',
    find: '"node": "^20.19.0 || ^22.13.0 || >=24"',
    replace: '"node": ">=20.19.0"',
    detectedBy: 'unit',
  },

  {
    // QUALITY-BAR 13, and the property every other entry in this file rests on:
    // a sweep's PASS means each entry was measured against the tree the sweep
    // started from. A stub left live by a test that rewrites a shipped source
    // makes the suite red for a reason no mutation caused, and from that moment
    // every remaining entry reports "detected" while measuring nothing.
    item: 'QB13',
    name: 'the tree walk descends into every directory it owns',
    file: 'scripts/mutation-check.mjs',
    find: '      if (entry.isDirectory()) {\n        stack.push(child);',
    replace: '      if (entry.isDirectory()) {\n        void child;',
    detectedBy: 'unit',
  },
  {
    // The other end of the same walk: build output, the dependency tree and the
    // measurement artifacts are rewritten by every detector, so watching them
    // would report drift on every entry and stop the first sweep that ran.
    item: 'QB13',
    name: 'the tree walk leaves the output every detector rewrites alone',
    file: 'scripts/mutation-check.mjs',
    find: "  'node_modules',\n  '.git',\n  'dist',",
    replace: "  'node_modules',\n  '.git',",
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'two listings that disagree are compared by content',
    file: 'scripts/mutation-check.mjs',
    find: '    if (was !== now) {\n      changes.push',
    replace: '    if (false) {\n      changes.push',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a path the baseline recorded goes back to the bytes it had',
    file: 'scripts/mutation-check.mjs',
    find: '    if (known.has(change.path)) {\n      restore.push(change.path);',
    replace: '    if (false) {\n      restore.push(change.path);',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'an entry the tree moved under is measured again, not believed',
    file: 'scripts/mutation-check.mjs',
    find: '  return { stop: null, rerun: true };\n}',
    replace: '  return { stop: null, rerun: false };\n}',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a second drift on the same entry stops the sweep',
    file: 'scripts/mutation-check.mjs',
    find: '  if (attempt > 1) {\n    return {',
    replace: '  if (false) {\n    return {',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a path the repair could not put back stops the sweep too',
    file: 'scripts/mutation-check.mjs',
    find: '  if (failed.length > 0) {\n    return {',
    replace: '  if (false) {\n    return {',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'the sweep compares the whole tree after every entry',
    file: 'scripts/mutation-check.mjs',
    find:
      '    const drift = treeDrift(baseline.listing, treeListing());\n' +
      '    const paths = drift.map((change) => change.path);',
    replace:
      '    const drift = [];\n' +
      '    const paths = drift.map((change) => change.path);',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'the baseline is the tree, recorded once, after the detectors are green',
    file: 'scripts/mutation-check.mjs',
    find:
      '  const baseline = { bytes: snapshotBytes(), listing: treeListing() };\n' +
      '  console.log(',
    replace:
      '  const baseline = { bytes: new Map(), listing: new Map() };\n' +
      '  console.log(',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'the summary prints every incident the sweep recorded',
    file: 'scripts/mutation-check.mjs',
    find: '  if (incidents.length > 0) {\n    trailer.push(',
    replace: '  if (false) {\n    trailer.push(',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'a sweep that ends on a different tree is refused, not passed',
    file: 'scripts/mutation-check.mjs',
    find: '  if (finalDrift.length > 0) {\n    return {',
    replace: '  if (false) {\n    return {',
    detectedBy: 'unit',
  },
  {
    item: 'QB13',
    name: 'the closing comparison is taken against the recorded baseline',
    file: 'scripts/mutation-check.mjs',
    find:
      '    finalDrift: treeDrift(baseline.listing, treeListing()).map(\n' +
      '      (change) => change.path,\n' +
      '    ),',
    replace: '    finalDrift: [],',
    detectedBy: 'unit',
  },
];

/**
 * Fresh violations dropped into the REAL src/core/, not into the fixtures. The
 * fixtures prove the rules reject a file that was written to be rejected; these
 * prove the shipping lint run reaches a file that was not, in more than one
 * module extension.
 */
export const ADDITIONS = [
  {
    item: 'M3',
    name: 'a new core module importing the render layer is rejected',
    file: 'src/core/mutation-render-import.ts',
    content: "import { drawPitch } from '../render/pitch';\n\nexport const used = drawPitch;\n",
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module importing the engine renderer is rejected',
    file: 'src/core/mutation-engine-renderer.mts',
    content:
      "import { createSurface } from '@js-games/engine/render';\n\nexport const used = createSurface;\n",
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module touching the DOM is rejected',
    file: 'src/core/mutation-dom-touch.ts',
    content: 'export const width = window.innerWidth;\n',
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module naming a canvas type is rejected',
    file: 'src/core/mutation-dom-type.mts',
    content: 'export const surface: HTMLCanvasElement | null = null;\n',
    detectedBy: 'lint',
  },
  {
    item: 'M3',
    name: 'a new core module calling Math.random is rejected',
    file: 'src/core/mutation-math-random.ts',
    content: 'export const roll = Math.random();\n',
    detectedBy: 'lint',
  },
  {
    // A third extension, because an extension the configuration does not match
    // is not a weaker rule, it is no rule: the file is never linted at all.
    item: 'M3',
    name: 'a new core module in a third extension is still linted',
    file: 'src/core/mutation-third-extension.jsx',
    content: 'export const roll = Math.random();\n',
    detectedBy: 'lint',
  },

  // Item E1. Fresh literals dropped into the real src/, one per shape the
  // sweep is claimed to catch, and the last of them into a directory that has
  // no code in it at all. That is the claim that matters most: every part
  // after this one is written under the rule rather than audited against it
  // afterwards. The recursion the sweep needs to reach them is pinned by its
  // own entry above, because an addition alone cannot tell a walk that stopped
  // at the top level from one that found nothing to complain about.
  {
    item: 'E1',
    name: 'a stray colour literal in the chrome is rejected',
    file: 'src/ui/mutation-colour-literal.css',
    content: '.mutation {\n  color: #FF0000;\n}\n',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a stray dimension literal in the chrome is rejected',
    file: 'src/ui/mutation-dimension-literal.css',
    content: '.mutation {\n  padding: 12px;\n}\n',
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a stray colour function in the renderer is rejected',
    file: 'src/render/mutation-colour-function.ts',
    content: "export const shadow = 'rgba(0, 0, 0, 0.5)';\n",
    detectedBy: 'unit',
  },
  {
    item: 'E1',
    name: 'a literal in a directory with no code yet is rejected',
    file: 'src/core/mutation-inherited-sweep.ts',
    content: "export const marker = '#123456';\n",
    detectedBy: 'unit',
  },
  // Item C9. Fresh mouse and touch listeners dropped into the REAL src/, one
  // per arm of the rule, because the criterion is about the SOURCE and not
  // about a fixture: the shipping lint has to reach a module nobody wrote to
  // be rejected. One is answered by the lint run the build uses and one by the
  // sweep the C9 test makes over src/, so neither gate can go quiet alone.
  {
    item: 'C9',
    name: 'a new source module with a mouse listener is rejected',
    file: 'src/render/mutation-mouse-listener.ts',
    content:
      'export function wire(target: HTMLElement): void {\n' +
      "  target.addEventListener('mousedown', () => undefined);\n" +
      '}\n',
    detectedBy: 'lint',
  },
  {
    item: 'C9',
    name: 'a new source module with a touch handler property is rejected',
    file: 'src/ui/mutation-touch-handler.ts',
    content:
      'export function wire(target: HTMLElement): void {\n' +
      '  target.ontouchstart = (): void => undefined;\n' +
      '}\n',
    detectedBy: 'unit',
  },
];

function occurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

/**
 * The deadline is a fourth safety property rather than a tuning number. A
 * mutation can leave the code in a state where a test loops forever rather than
 * failing, and a synchronous loop is not something a test runner's own timeout
 * can interrupt. Without a deadline here the whole gate hangs and reports
 * nothing; with one, the detector is killed, the run is not a pass, and the
 * entry is correctly reported as detected. Every loop in the suite carries its
 * own budget for the same reason; this is the backstop for the one that does
 * not. The number itself is each detector's own, declared beside it.
 */
function reclaim(detector, when) {
  if (detector.owns !== 'preview') {
    return;
  }
  const result = reapPreview();
  if (!result.looked) {
    console.log(
      `  note  could not tell whether port ${String(PREVIEW_PORT)} is free ${when}: ` +
        'the platform gave no socket listing, so a leftover preview would ' +
        'survive this reclaim unseen.',
    );
    return;
  }
  if (result.killed.length > 0) {
    console.log(
      `  note  stopped ${String(result.killed.length)} process(es) holding port ` +
        `${String(PREVIEW_PORT)} ${when}: ${result.killed.join(', ')}`,
    );
  }
  if (!result.free) {
    console.log(`  note  port ${String(PREVIEW_PORT)} is STILL held ${when}`);
  }
}

/**
 * WHAT ONE DETECTOR RUN ACTUALLY DID, as a pure function of what the child
 * process reported. Exported so all three answers are graded by the unit suite
 * rather than only the two a green sweep happens to take.
 *
 * A TEST THAT FAILED AND A PROCESS THAT WAS KILLED ARE OPPOSITE ANSWERS, and
 * this harness used to read both as "the mutation was detected" because both
 * arrive as a non-zero exit. The first is the whole point of the gate. The
 * second is a detector that never reached a verdict at all, and counting it as
 * a detection reports a gate as working on the strength of a run that measured
 * nothing. The shape is not hypothetical: two tests of this suite exceed the
 * unit runner's default budget on a cold module graph, and a suite that goes
 * red for a reason unrelated to the code would have been indistinguishable from
 * five hundred caught mutations.
 *
 * `execFileSync` sets `killed` and a `signal` when its own deadline fires, and
 * leaves `signal` set when anything else killed the child; a child that decided
 * its own exit carries a numeric `status` and no signal at all. So the signal is
 * the discriminator, and the deadline case is named by both fields.
 */
export function detectorOutcome(error, stdout = '', stderr = '') {
  if (error === null || error === undefined) {
    return { passed: true, killed: false, output: '' };
  }
  const killed =
    error.killed === true ||
    (error.signal !== null && error.signal !== undefined);
  return { passed: false, killed, output: `${stdout}${stderr}`.trim() };
}

/**
 * The verdict for one entry. `error` is not a severity label: it is the answer
 * that stops the sweep, because every entry after a killed detector would be
 * measured against a machine that has already shown it cannot finish a run.
 */
export function entryVerdict(outcome) {
  if (outcome.killed) {
    return 'error';
  }
  return outcome.passed ? 'missed' : 'detected';
}

/**
 * The last line of the log, which is the only line anybody reads, and its exit
 * status. A sweep that stopped is not a sweep that passed, and it is not a
 * sweep that found a missed entry either: it is a sweep with no verdict on the
 * entry it stopped at and none at all on the entries after it, and the summary
 * has to say so in those words.
 *
 * THE INCIDENT LIST AND THE CLOSING COMPARISON ARE PART OF THE VERDICT, not a
 * footnote under it. A sweep that repaired the tree three times measured three
 * entries twice and everything else once, which a reader has to be told; a
 * sweep that ends on a tree it did not start on has not finished, whatever its
 * entries reported, so that is a refusal and not a pass.
 */
export function sweepSummary({
  total,
  ran,
  missed,
  stoppedAt = null,
  stopReason = 'kill',
  incidents = [],
  finalDrift = [],
}) {
  const detected = ran - missed;
  const counted =
    `  ${String(ran)} of ${String(total)} entries run, ${String(detected)} detected, ` +
    `${String(missed)} missed`;
  // The trailer sits BETWEEN the count and the verdict, because the verdict is
  // the last line anybody reads and, when it is UNDETECTED, the names of the
  // undetected entries follow it immediately.
  const trailer = [];
  if (incidents.length > 0) {
    trailer.push(
      '',
      `${String(incidents.length)} tree drift incident(s), restored from the ` +
        'baseline snapshot:',
    );
    for (const incident of incidents) {
      trailer.push(`  ${incident.entry}: ${incident.paths.join(', ')}`);
    }
  }
  trailer.push(
    '',
    finalDrift.length > 0
      ? `TREE: this sweep did not finish on the tree it started on: ${finalDrift.join(', ')}`
      : '  tree: identical to the one this sweep started on',
  );
  if (stoppedAt !== null) {
    return {
      status: 1,
      lines: [
        counted,
        ...trailer,
        '',
        stopReason === 'drift'
          ? `STOPPED at "${stoppedAt}": the working tree moved under it and did not ` +
            'settle, so that mutation was measured against a tree this sweep did not ' +
            'start on, and no entry after it was measured at all. A tree that moved ' +
            'is not a detection.'
          : `STOPPED at "${stoppedAt}": its detector was killed at its deadline rather ` +
            'than reaching a verdict, so that mutation was neither caught nor shown ' +
            'to be uncaught, and no entry after it was measured. A killed detector ' +
            'is not a detection.',
      ],
    };
  }
  if (missed > 0) {
    return {
      status: 1,
      lines: [
        counted,
        ...trailer,
        '',
        'UNDETECTED, so the gate each one names is decorative:',
      ],
    };
  }
  if (finalDrift.length > 0) {
    return {
      status: 1,
      lines: [
        counted,
        ...trailer,
        '',
        'mutations: REFUSED. Every entry reported, but the tree moved under the ' +
          'sweep and was not put back, so what those entries were measured against ' +
          'is not the tree this repository has.',
      ],
    };
  }
  return {
    status: 0,
    lines: [counted, ...trailer, '', 'mutations: PASS, every entry detected'],
  };
}

function detectorPasses(name, whole = false) {
  const detector = DETECTORS[name];
  reclaim(detector, `before the ${detector.label}`);
  try {
    execFileSync(process.execPath, detector.argv(whole), {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      env: { ...process.env, CI: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: detector.timeout,
    });
    return detectorOutcome(null);
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout) : '';
    const stderr = error && error.stderr ? String(error.stderr) : '';
    return detectorOutcome(error, stdout, stderr);
  } finally {
    // A detector this harness timed out has left its preview behind, and the
    // next browser run cannot start while it holds the port.
    reclaim(detector, `after the ${detector.label}`);
  }
}

function runEdit(entry) {
  const absolute = path.join(PROJECT_ROOT, entry.file);
  const original = readFileSync(absolute, 'utf8');
  const hits = occurrences(original, entry.find);
  if (hits !== 1) {
    throw new Error(
      `mutation "${entry.name}" has gone stale: its target matches ${entry.file} ` +
        `${String(hits)} times, and a mutation must match exactly once. ` +
        'Re-point the entry at whatever replaced it, or delete the entry and ' +
        'the gate it was protecting together.',
    );
  }
  try {
    writeFileSync(absolute, original.replace(entry.find, entry.replace), 'utf8');
    return detectorPasses(entry.detectedBy);
  } finally {
    writeFileSync(absolute, original, 'utf8');
  }
}

function runAddition(entry) {
  const absolute = path.join(PROJECT_ROOT, entry.file);
  if (existsSync(absolute)) {
    throw new Error(
      `mutation "${entry.name}" would overwrite ${entry.file}, which exists. ` +
        'Pick a path that does not.',
    );
  }
  try {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.content, 'utf8');
    return detectorPasses(entry.detectedBy);
  } finally {
    rmSync(absolute, { force: true });
  }
}

/**
 * What this sweep is NOT responsible for putting back: build output, the
 * dependency tree, measurement artifacts and tool caches, all of which every
 * detector writes into by design.
 *
 * A DIRECTORY THAT BELONGS HERE AND IS MISSING FAILS LOUDLY rather than
 * silently: its files appear as drift on the first entry that runs a detector,
 * the sweep restores what it can, records an incident and says the paths out
 * loud. That is the right direction for a list nobody will remember to update.
 */
const SNAPSHOT_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
  '.determinism',
  'artifacts',
  '.vite',
  '.cache',
  '.eslintcache',
]);

/** Every file under `root` this sweep owns, relative, forward slashed, sorted. */
export function filesUnder(root, skip = SNAPSHOT_SKIP) {
  const found = [];
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.pop();
    const absolute = relative === '' ? root : path.join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (skip.has(entry.name)) {
        continue;
      }
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        found.push(child);
      }
    }
  }
  found.sort();
  return found;
}

/** The tree as a listing of path to content digest. */
export function treeListing(root = PROJECT_ROOT, skip = SNAPSHOT_SKIP) {
  const listing = new Map();
  for (const relative of filesUnder(root, skip)) {
    listing.set(
      relative,
      createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex'),
    );
  }
  return listing;
}

/** The same files, as bytes, so a drifted one can be put back exactly. */
function snapshotBytes(root = PROJECT_ROOT, skip = SNAPSHOT_SKIP) {
  const bytes = new Map();
  for (const relative of filesUnder(root, skip)) {
    bytes.set(relative, readFileSync(path.join(root, relative)));
  }
  return bytes;
}

/**
 * Every path two listings disagree about, named in the direction it moved.
 *
 * Pure, because the decision is the whole of the property and the two listings
 * are the whole of the input: `was` null is a file that appeared, `now` null is
 * one that vanished, and two different digests are one that was rewritten.
 */
export function treeDrift(before, after) {
  const changes = [];
  for (const relative of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(relative) ?? null;
    const now = after.get(relative) ?? null;
    if (was !== now) {
      changes.push({ path: relative, was, now });
    }
  }
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return changes;
}

/**
 * How each drifted path goes back: a path the baseline recorded is rewritten
 * with the bytes it had, and a path the baseline never saw is one that appeared
 * during the sweep and is removed.
 */
export function restorePlan(drift, known) {
  const restore = [];
  const remove = [];
  for (const change of drift) {
    if (known.has(change.path)) {
      restore.push(change.path);
    } else {
      remove.push(change.path);
    }
  }
  return { restore, remove };
}

/**
 * What a sweep does about a tree that moved under one entry: nothing, repair
 * and measure the entry again, or stop.
 *
 * `stop` is the same answer a killed detector earns and for the same reason:
 * the entry reached no trustworthy verdict, and neither would any entry after
 * it. `failed` is the list of paths the repair could not put back, which is the
 * case where carrying on would measure every remaining entry against a tree
 * nobody can describe.
 */
export function driftVerdict({ paths = [], failed = [], attempt = 1 }) {
  if (paths.length === 0) {
    return { stop: null, rerun: false };
  }
  if (failed.length > 0) {
    return {
      stop:
        'the working tree changed under this entry and could not be put back: ' +
        `${failed.join(', ')}. Every entry after it would be measured against a ` +
        'tree this sweep cannot describe.',
      rerun: false,
    };
  }
  if (attempt > 1) {
    return {
      stop:
        'the working tree changed under this entry twice, so the drift is not a ' +
        'transient and re-running it again would measure the same nothing.',
      rerun: false,
    };
  }
  return { stop: null, rerun: true };
}

/** What one incident says: which entry, which paths, and what became of them. */
export function incidentLines({ entry, attempt, paths, failed, rerun = true }) {
  const lines = [
    `  INCIDENT the working tree changed under "${entry}" (attempt ${String(attempt)}): ` +
      paths.join(', '),
  ];
  if (failed.length > 0) {
    lines.push(`        NOT RESTORED: ${failed.join(', ')}`);
  } else if (rerun) {
    lines.push(
      '        restored from the baseline snapshot, and the entry is measured ' +
        'again on the clean tree',
    );
  } else {
    lines.push(
      '        restored from the baseline snapshot, but the tree has now moved ' +
        'under this entry twice and the sweep stops here',
    );
  }
  return lines;
}

/**
 * The repair. Every path is attempted and every failure is said out loud; what
 * is RETURNED is the re-measured drift rather than a count of exceptions,
 * because a write that threw and a write that silently wrote the wrong thing
 * are the same problem and only the second listing can tell.
 */
function applyRestore(plan, baseline) {
  for (const relative of plan.restore) {
    const absolute = path.join(PROJECT_ROOT, relative);
    try {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, baseline.bytes.get(relative));
    } catch (error) {
      console.log(`  note  could not restore ${relative}: ${String(error)}`);
    }
  }
  for (const relative of plan.remove) {
    try {
      rmSync(path.join(PROJECT_ROOT, relative), { force: true });
    } catch (error) {
      console.log(`  note  could not remove ${relative}: ${String(error)}`);
    }
  }
  return treeDrift(baseline.listing, treeListing()).map((change) => change.path);
}

/**
 * One entry, measured against the tree the sweep began on.
 *
 * The loop runs at most twice: once, and once more after a repaired drift.
 * `driftVerdict` owns the decision; everything here is the doing of it.
 */
function measureEntry(entry, baseline, incidents) {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = entry.kind === 'edit' ? runEdit(entry) : runAddition(entry);
    const drift = treeDrift(baseline.listing, treeListing());
    const paths = drift.map((change) => change.path);
    const failed =
      paths.length === 0 ? [] : applyRestore(restorePlan(drift, baseline.bytes), baseline);
    const verdict = driftVerdict({ paths, failed, attempt });
    if (paths.length > 0) {
      const incident = { entry: entry.name, attempt, paths, failed, rerun: verdict.rerun };
      incidents.push(incident);
      for (const line of incidentLines(incident)) {
        console.log(line);
      }
    }
    if (verdict.stop !== null) {
      return { outcome, stop: verdict.stop };
    }
    if (!verdict.rerun) {
      return { outcome, stop: null };
    }
  }
}

export function main() {
  // The deadlines, checked before they are relied on. There is deliberately NO
  // entry attacking a detector's timeout: the only way to witness a missing one
  // is to run a mutation that hangs and wait for the gate not to end, so the
  // property is unisolatable by construction and an entry for it could never
  // fail. This refusal is what stands in its place, and it costs nothing.
  for (const [name, detector] of Object.entries(DETECTORS)) {
    if (!Number.isFinite(detector.timeout) || detector.timeout <= 0) {
      console.log(
        `  FAIL  the ${name} detector declares no usable deadline, so a hung ` +
          'mutation would stall this gate instead of counting as detected.',
      );
      return 1;
    }
    // A detector that builds before it runs has a second thing to bound, and
    // it is outside the deadline above by construction.
    if (
      detector.buildTimeout !== undefined &&
      (!Number.isFinite(detector.buildTimeout) || detector.buildTimeout <= 0)
    ) {
      console.log(
        `  FAIL  the ${name} detector builds with no usable deadline, so a ` +
          'mutation that hangs the build would stall this gate.',
      );
      return 1;
    }
  }

  // The reclaim's own staleness guard. A number that has drifted apart from
  // the configuration would free nothing, and the browser detector would then
  // fail to start for a reason no line of output explained.
  const declared = configuredPort();
  if (declared !== PREVIEW_PORT) {
    console.log(
      `  FAIL  this harness reclaims port ${String(PREVIEW_PORT)} but vite.config.ts ` +
        `declares ${String(declared)}, so a leftover preview would never be stopped.`,
    );
    return 1;
  }

  console.log('== baseline ==');
  for (const name of Object.keys(DETECTORS)) {
    const result = detectorPasses(name, true);
    if (!result.passed) {
      const why = result.killed
        ? 'was killed at its deadline before any mutation, so it never reached a verdict'
        : 'is red before any mutation';
      console.log(`  FAIL  ${DETECTORS[name].label} ${why}`);
      console.log(result.output.split('\n').slice(-25).join('\n'));
      console.log(
        '\nrefusing to report: against a red tree every mutation looks detected.',
      );
      return 1;
    }
    console.log(`  ok    ${DETECTORS[name].label} green`);
  }

  // The tree every entry below is measured against, recorded AFTER the baseline
  // runs so that whatever those runs wrote is part of it.
  const baseline = { bytes: snapshotBytes(), listing: treeListing() };
  console.log(`  ok    working tree recorded, ${String(baseline.bytes.size)} files`);

  const entries = [
    ...EDITS.map((entry) => ({ ...entry, kind: 'edit' })),
    ...ADDITIONS.map((entry) => ({ ...entry, kind: 'addition' })),
  ];

  console.log('\n== mutations ==');
  const missed = [];
  const counts = new Map();
  const incidents = [];
  let ran = 0;
  let stoppedAt = null;
  let stopReason = 'kill';
  for (const entry of entries) {
    const measured = measureEntry(entry, baseline, incidents);
    if (measured.stop !== null) {
      console.log(`  ERROR ${entry.item}  ${entry.name.padEnd(58)} ${measured.stop}`);
      stoppedAt = entry;
      stopReason = 'drift';
      break;
    }
    const outcome = measured.outcome;
    const verdict = entryVerdict(outcome);
    if (verdict === 'error') {
      // The sweep stops here rather than carrying on. Every entry after a
      // detector that could not finish would be measured against a machine
      // that has just shown it cannot finish a run, and each of those would be
      // recorded as caught.
      console.log(
        `  ERROR ${entry.item}  ${entry.name.padEnd(58)} ` +
          `${DETECTORS[entry.detectedBy].label} killed at its deadline`,
      );
      console.log(outcome.output.split('\n').slice(-25).join('\n'));
      stoppedAt = entry;
      break;
    }
    // Counted here and not at the top of the loop: the per-item tally under the
    // summary is a tally of what was MEASURED, and an entry the sweep stopped
    // at reached no verdict at all.
    counts.set(entry.item, (counts.get(entry.item) ?? 0) + 1);
    ran += 1;
    const detected = verdict === 'detected';
    const by = detected
      ? `detected by ${DETECTORS[entry.detectedBy].label}`
      : 'NOT DETECTED';
    console.log(
      `  ${detected ? 'PASS' : 'FAIL'}  ${entry.item}  ${entry.name.padEnd(58)} ${by}`,
    );
    if (!detected) {
      missed.push(entry);
    }
  }

  console.log('\n== summary ==');
  for (const [item, total] of [...counts].sort()) {
    console.log(`  ${item}: ${String(total)} entries`);
  }
  const summary = sweepSummary({
    total: entries.length,
    ran,
    missed: missed.length,
    stoppedAt: stoppedAt === null ? null : stoppedAt.name,
    stopReason,
    incidents,
    finalDrift: treeDrift(baseline.listing, treeListing()).map(
      (change) => change.path,
    ),
  });
  for (const line of summary.lines) {
    console.log(line);
  }
  for (const entry of missed) {
    console.log(`  ${entry.item}  ${entry.name}`);
  }
  return summary.status;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
