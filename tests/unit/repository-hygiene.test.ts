import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { filesUnder } from '../../scripts/mutation-check.mjs';
import { isTextPath } from '../../scripts/check-repository-record.mjs';

/**
 * What the repository says about itself, checked against what the repository is.
 *
 * WHY THIS EXISTS. Four statements in this tree were true when they were written
 * and were read by nothing afterwards: the ignore file's own heading said editor
 * state does not belong in it while four such entries sat underneath, a package
 * description pointed at a document a clean checkout never receives, the package
 * name was not the name of the repository it is published as, and the owner file
 * implied a gate the ruleset does not ask for. None of them is game behaviour and
 * none of them can be graded by running the game, which is what puts them in one
 * file. Each is a sentence the next reader has to trust, so each is a sentence
 * that can rot, and the rot is invisible: every gate in this repository stayed
 * green through all four.
 *
 * THE RULES BEHIND THEM, cited rather than restated. GITHUB section 8: the
 * repository `.gitignore` covers build output and dependency trees, and personal
 * editor and tool state belongs in `.git/info/exclude`, which is per clone and
 * never committed. GITHUB section 1 with the decision of 2026-09-07: Pocket
 * Football's published tree carries no markdown files. GITHUB section 5 and
 * section 9: required approvals are 0 while one person is building, and the
 * ruleset file is where that number is set.
 *
 * WHAT THIS FILE DOES NOT DO. It carries no list of product, vendor or model
 * names. GITHUB section 7 keeps that list in the enforcing scripts and nowhere
 * else, and `scripts/check-repository-record.mjs` already applies it to every
 * tracked file, this one and every file it reads included, so restating it here
 * would be a second copy to drift rather than a second gate.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

function read(relative: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 1. The ignore file carries no editor or operating-system state.
 * ------------------------------------------------------------------ */

interface LocalStatePattern {
  /** The ignore entry shape, `*` standing for any run of characters. */
  readonly pattern: string;
  /** A bare entry that must be refused, so no shape can stop matching quietly. */
  readonly bare: string;
  /**
   * The same name written with a path around it, which is the half a first
   * version of this scan missed: for one directory git accepts the bare name,
   * a leading `**` segment, a trailing `/**`, a parent directory in front of
   * it, and a file inside it. An anchored whole-entry comparison refuses the
   * first spelling and none of the rest.
   */
  readonly qualified: string;
  readonly reason: string;
}

/**
 * Personal editor, tool and operating-system state, by shape and with the
 * reason each shape is not this repository's business.
 *
 * The list is pinned here as source rather than derived from anything, because
 * the property is "these names are absent" and a list computed from the file it
 * judges would agree with whatever the file says. It is deliberately wider than
 * the four entries this vehicle removed: the four were what one machine's habits
 * put there, and the next machine's habits are a different four.
 */
const LOCAL_STATE: readonly LocalStatePattern[] = [
  {
    pattern: '.idea',
    bare: '.idea/',
    qualified: '**/.idea/',
    reason: "a code editor's per-project state directory",
  },
  {
    pattern: '.vscode',
    bare: '.vscode/',
    qualified: '.vscode/settings.json',
    reason: "a code editor's per-workspace state directory",
  },
  {
    pattern: '.vs',
    bare: '.vs/',
    qualified: 'src/.vs/',
    reason: "a code editor's per-solution state directory",
  },
  {
    pattern: '.fleet',
    bare: '.fleet',
    qualified: '**/.fleet',
    reason: "a code editor's per-project state directory",
  },
  {
    pattern: '.zed',
    bare: '.zed',
    qualified: '.zed/**',
    reason: "a code editor's per-project state directory",
  },
  {
    pattern: '.history',
    bare: '.history/',
    qualified: '**/.history/',
    reason: "a code editor's local file-history directory",
  },
  {
    pattern: '.direnv',
    bare: '.direnv',
    qualified: 'tools/.direnv/',
    reason: "a per-machine shell environment tool's state directory",
  },
  {
    pattern: '*.swp',
    bare: '.notes.swp',
    qualified: 'src/core/.notes.swp',
    reason: "a terminal editor's swap file",
  },
  {
    pattern: '*.swo',
    bare: '.notes.swo',
    qualified: '**/.notes.swo',
    reason: "a terminal editor's second swap file",
  },
  {
    pattern: '*~',
    bare: 'notes.ts~',
    qualified: 'src/notes.ts~',
    reason: "a text editor's backup copy",
  },
  {
    pattern: '.DS_Store',
    bare: '.DS_Store',
    qualified: '**/.DS_Store',
    reason: "a desktop shell's per-directory metadata file",
  },
  {
    pattern: '._*',
    bare: '._notes.ts',
    qualified: 'tests/._notes.ts',
    reason: 'a resource fork written beside a file on a foreign filesystem',
  },
  {
    pattern: '.Spotlight-V100',
    bare: '.Spotlight-V100',
    qualified: '/.Spotlight-V100/',
    reason: "an operating system's per-volume index directory",
  },
  {
    pattern: '.Trashes',
    bare: '.Trashes',
    qualified: '**/.Trashes',
    reason: "an operating system's per-volume deleted-items directory",
  },
  {
    pattern: '$RECYCLE.BIN',
    bare: '$RECYCLE.BIN/',
    qualified: '/$RECYCLE.BIN/**',
    reason: "an operating system's per-volume deleted-items directory",
  },
  {
    pattern: 'Thumbs.db',
    bare: 'Thumbs.db',
    qualified: '**/Thumbs.db',
    reason: "a desktop shell's thumbnail cache",
  },
  {
    pattern: 'ehthumbs.db',
    bare: 'ehthumbs.db',
    qualified: 'src/ehthumbs.db',
    reason: "a desktop shell's second thumbnail cache",
  },
  {
    pattern: 'Desktop.ini',
    bare: 'Desktop.ini',
    qualified: '**/Desktop.ini',
    reason: "a desktop shell's per-folder settings file",
  },
];

interface RequiredEntry {
  /** The entry as the file states it, normalised the way `ignoreEntries` does. */
  readonly entry: string;
  readonly reason: string;
}

/**
 * The entries GITHUB section 8 puts in this file, each with what it keeps out.
 *
 * This is the other half of the refusal above, and it is not decoration: the
 * refusal passes on a file emptied of everything, and two of the blocks here
 * were removable without a single test noticing. The environment entries in
 * particular are the only thing in a public repository standing between a file
 * created by habit and a commit.
 */
const REQUIRED: readonly RequiredEntry[] = [
  { entry: 'node_modules', reason: 'the dependency tree' },
  { entry: 'dist', reason: 'the built bundle' },
  { entry: 'coverage', reason: "the unit suite's coverage output" },
  { entry: 'playwright-report', reason: "the browser suite's report" },
  { entry: 'test-results', reason: "the browser suite's failure artifacts" },
  { entry: 'artifacts/reports', reason: 'the evidence the build gate writes' },
  { entry: '*.log', reason: 'the logs the section names' },
  { entry: '.env', reason: 'a local environment file created by habit' },
  { entry: '.env.*', reason: 'the same file with its environment in the name' },
];

/**
 * The entries an ignore file states, comments and blank lines removed.
 *
 * Normalised the way git reads them: a leading `!` is a re-inclusion of the same
 * name, a leading `/` anchors it at the root, and a trailing `/` says directory.
 * None of the three changes which name is being ignored, which is the whole of
 * what this file asks about.
 */
export function ignoreEntries(text: string): string[] {
  const entries: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    entries.push(trimmed.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, ''));
  }
  return entries;
}

function matches(pattern: string, name: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'i').test(name);
}

/**
 * The names an entry is about, which is every path segment it states.
 *
 * A `**` segment is not a name: it is git's "at any depth", so it is dropped
 * rather than compared, and an empty segment from a leading or doubled slash
 * goes with it. What is left is asked one segment at a time, because an entry
 * naming a directory names it wherever in the path it sits and an entry naming
 * a file inside one names the directory too.
 */
function pathSegments(entry: string): string[] {
  return entry.split('/').filter((segment) => segment !== '' && segment !== '**');
}

/**
 * Does this segment name the shape, or a copy of it?
 *
 * The second half is the copy an operating system or an editor leaves behind
 * with the name kept and something appended (`Thumbs.db.bak`). It is the same
 * artifact and it is the same answer, and without it an entry for the copy
 * reads as an ordinary file name.
 */
function segmentNames(pattern: string, segment: string): boolean {
  return matches(pattern, segment) || matches(`${pattern}.*`, segment);
}

/** Every entry that is one machine's state rather than this repository's output. */
export function localStateRefusals(text: string): string[] {
  const refusals: string[] = [];
  for (const entry of ignoreEntries(text)) {
    const segments = pathSegments(entry);
    for (const shape of LOCAL_STATE) {
      if (segments.some((segment) => segmentNames(shape.pattern, segment))) {
        refusals.push(`${entry} names ${shape.reason}`);
      }
    }
  }
  return refusals;
}

describe('the ignore file covers output, and nothing about a machine', () => {
  it('states no editor, tool or operating-system entry', () => {
    expect(localStateRefusals(read('.gitignore'))).toEqual([]);
  });

  it('still covers the output it is for', () => {
    // Non-vacuity from the other side: a file emptied of everything would pass
    // the refusal above, and would also stop being an ignore file. Every block
    // the house rule names is stated here, so a block deleted whole is as loud
    // as a block that was never written.
    const entries = ignoreEntries(read('.gitignore'));
    expect(entries.length).toBeGreaterThan(10);
    for (const required of REQUIRED) {
      expect(entries, `${required.entry}: ${required.reason}`).toContain(
        required.entry,
      );
    }
  });

  it('refuses each shape it names, bare and path-qualified', () => {
    // The planted control, two per shape, because a shape that has stopped
    // matching anything is exactly as green as one that never matched, and
    // because matching the bare spelling alone is what this scan did first.
    for (const shape of LOCAL_STATE) {
      for (const sample of [shape.bare, shape.qualified]) {
        const refusals = localStateRefusals(`# a heading\n${sample}\n`);
        // Exactly one: a sample that matched two shapes would make the pair of
        // reasons below meaningless, and a shape that matched nothing is the
        // failure this control exists for.
        expect(refusals, `${shape.pattern}: ${sample}`).toHaveLength(1);
        expect(refusals[0], `${shape.pattern}: ${sample}`).toContain(shape.reason);
      }
    }
  });

  it('refuses the block that was removed, in both spellings', () => {
    // The four the audit named, together, as they stood in this file.
    const removed = '# Editor and operating system metadata\n.idea/\n.vscode/\n.DS_Store\nThumbs.db\n';
    expect(localStateRefusals(removed)).toHaveLength(4);
    // And the same block written the way an anchored whole-entry comparison
    // let through: three names at any depth and one backup copy. This is the
    // spelling that put the block back with every test still green.
    const qualified =
      '# Editor and operating system metadata\n**/.vscode/\n**/.idea/\n**/.DS_Store\nThumbs.db.bak\n';
    expect(localStateRefusals(qualified)).toHaveLength(4);
  });

  it('refuses one name however git lets it be written', () => {
    // Every spelling git accepts for the same directory, against one shape, so
    // that the reading is pinned rather than sampled by the list above.
    for (const spelling of [
      '.vscode',
      '.vscode/',
      '/.vscode/',
      '!.vscode/',
      '**/.vscode/',
      '.vscode/**',
      'src/.vscode/',
      '.vscode/settings.json',
    ]) {
      expect(localStateRefusals(`${spelling}\n`), spelling).toHaveLength(1);
    }
    // The six spellings that escaped the first version of this scan, and the
    // six it already refused, named one by one so that the reading is a list
    // and not a description of one.
    for (const spelling of [
      '**/.vscode/',
      '**/.idea/',
      '**/.DS_Store',
      '.idea/**',
      'src/.idea/',
      '.vscode/settings.json',
      '.vscode/',
      '!.vscode/',
      '/.vscode/',
      '.VSCODE/',
      'thumbs.DB',
      '$RECYCLE.BIN/',
    ]) {
      expect(localStateRefusals(`${spelling}\n`), spelling).toHaveLength(1);
    }
    // And the other direction, which is what keeps the reading from being
    // "anything with a path in it": the file states two path-qualified entries
    // of its own, and a scan that refused a directory for where it sits would
    // be switched off the day it first fired.
    for (const kept of ['artifacts/reports/', 'src/render/', 'tests/**/*.snap']) {
      expect(localStateRefusals(`${kept}\n`), kept).toEqual([]);
    }
  });

  it('reads a comment as a comment and a name as a name', () => {
    // The matcher's own failure mode: a scan that read whole lines would refuse
    // the heading that explains the rule, and one that read nothing would
    // report a clean file forever.
    expect(ignoreEntries('# .vscode/ belongs in the per-clone exclude file\n')).toEqual(
      [],
    );
    expect(ignoreEntries('!/.vscode/\n')).toEqual(['.vscode']);
    expect(localStateRefusals('# .vscode/ is not an entry\n')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. No file points at a document a clean checkout never receives.
 * ------------------------------------------------------------------ */

/** The extension, written once, for the reason the list below gives. */
const MARKDOWN = '.md';

interface MarkdownMention {
  /** The path the mention sits in. */
  readonly file: string;
  /** The referenced path with the extension taken off. */
  readonly stem: string;
  readonly reason: string;
}

/**
 * The deliberate markdown mentions, each named with why it is not a dangling
 * reference to a file this repository does not have.
 *
 * Three kinds only. A workspace document cited as the source of a rule, which is
 * a citation and not a path in this repository, the way a comment cites a SPEC
 * section. A file the tooling itself creates at run time under a directory the
 * ignore file names. And a literal that a test or the harness needs in order to
 * drive the very check it is part of.
 *
 * THE EXTENSION IS NOT WRITTEN IN THE ENTRIES, and that is not a flourish. An
 * allow-list that spelled each reference out in full would be a file carrying
 * fifteen markdown references of its own, every one of them excused by being in
 * the list, and this file would become the one place in the repository where a
 * dangling reference could sit unseen. Written as stems, the only mentions this
 * file carries are the two in its own planted control below, which are listed
 * like everything else.
 */
const DELIBERATE: readonly MarkdownMention[] = [
  {
    file: 'packages/engine/src/render/index.ts',
    stem: 'STACK',
    reason:
      'a workspace document cited as the authority for the extraction order, ' +
      'the way a comment cites a SPEC section; it is not a path in this tree',
  },
  {
    file: 'packages/engine/src/render/index.ts',
    stem: 'BUILD-PLAN',
    reason:
      'a workspace document cited for the 2026-08-24 reorder, a citation and ' +
      'not a path in this tree',
  },
  {
    file: 'scripts/check-determinism.mjs',
    stem: 'artifacts/reports/build',
    reason:
      'the evidence file the determinism gate writes itself, under the ' +
      'directory the ignore file names; present after a run, never tracked',
  },
  {
    file: 'scripts/check-determinism.mjs',
    stem: 'build',
    reason: 'the same written file, named as a path segment where it is joined',
  },
  {
    file: 'scripts/mutation-check.mjs',
    stem: 'README',
    reason:
      'the harness entry that puts the reworded description back, which is ' +
      'what proves this scan can fail; the mutation lands on the package file',
  },
  {
    file: 'tests/browser/scaffold.spec.ts',
    stem: 'docs/review-checklists/build',
    reason: 'a workspace review checklist cited as the source of the four tests',
  },
  {
    file: 'tests/unit/reference-independence.test.ts',
    stem: 'SPEC',
    reason:
      'the workspace specification, cited as what the second implementation ' +
      'is written from',
  },
  {
    file: 'tests/unit/reference/strike-geometry.ts',
    stem: 'SPEC',
    reason: 'the same citation, in the module the independence scan grades',
  },
  {
    file: 'tests/unit/render-effects.test.ts',
    stem: 'notes',
    reason:
      'a file the test writes into its own temporary fixture directory, to ' +
      'prove the module walk ignores what is not a module',
  },
  {
    file: 'tests/unit/repository-hygiene.test.ts',
    stem: 'README',
    reason: "this scan's own planted control and the reason lines beside it",
  },
  {
    file: 'tests/unit/repository-hygiene.test.ts',
    stem: 'docs/STACK',
    reason: "this scan's own control for a reference that carries a path",
  },
  {
    file: 'tests/unit/repository-record.test.ts',
    stem: 'notes',
    reason: 'a synthetic path handed to the record gate path scanner as input',
  },
  {
    file: 'tests/unit/repository-record.test.ts',
    stem: 'README',
    reason:
      'a control value for the reserved-basename check, which has to be asked ' +
      'about a name that is not reserved',
  },
  {
    file: 'tests/unit/tokens.test.ts',
    stem: 'RADIUS',
    reason:
      'the medium radius token read as a property, not a file: the scale ' +
      "member's name collides with the extension",
  },
  {
    file: 'tests/unit/workflow-shape.test.ts',
    stem: 'README',
    reason:
      'a path in the synthetic listings the tree-drift guard is driven with, ' +
      'chosen because a vanished file is the case it has to report',
  },
];

/**
 * Every markdown path a text references.
 *
 * The shape is a name, optionally a path, ending in the extension: the two
 * things it deliberately does not see are a bare mention with no extension,
 * which is prose rather than a path, and a glob such as the per-clone exclude
 * rule, because a `*` cannot begin a name.
 */
export function markdownReferences(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.md\b/g)].map(
    (match) => match[0],
  );
}

/** The files this scan reads: every text file the tree carries, markdown aside. */
function scannedPaths(): string[] {
  return filesUnder(PROJECT_ROOT).filter(
    (relative) => isTextPath(relative) && !relative.endsWith('.md'),
  );
}

describe('no file points at a document a clean checkout does not receive', () => {
  it('reads the tree it claims to read', () => {
    // Non-vacuity first: a walk that returned nothing would report no dangling
    // reference in any of the files below, which is the answer this whole
    // section is trying not to give.
    const scanned = scannedPaths();
    expect(scanned.length).toBeGreaterThan(150);
    for (const required of [
      'packages/engine/package.json',
      'scripts/check-determinism.mjs',
      'tests/unit/repository-hygiene.test.ts',
    ]) {
      expect(scanned, required).toContain(required);
    }
    // Markdown itself is out of the scan for a reason worth stating rather than
    // asserting, since the filter above is what puts it out: the published tree
    // carries none, so a markdown file in a working tree is a local copy that is
    // not part of the repository record and cannot be referenced by anything
    // that is.
    //
    // What IS asserted is the other end of the walk. Build output is rewritten
    // by every detector and a scan that reached into it would be refusing
    // strings this repository did not write, which is how a scan like this one
    // gets switched off.
    for (const skipped of ['node_modules/', 'dist/', '.git/', 'test-results/']) {
      expect(
        scanned.filter((relative) => relative.startsWith(skipped)),
        skipped,
      ).toEqual([]);
    }
  });

  it('carries no markdown reference that is not one of the named ones', () => {
    const unexplained: string[] = [];
    for (const relative of scannedPaths()) {
      for (const reference of markdownReferences(read(relative))) {
        const known = DELIBERATE.some(
          (mention) =>
            mention.file === relative &&
            `${mention.stem}${MARKDOWN}` === reference,
        );
        if (!known) {
          unexplained.push(`${relative}: ${reference}`);
        }
      }
    }
    expect(unexplained).toEqual([]);
  });

  it('keeps the allow-list to mentions that are actually there', () => {
    // A list that only ever grows is a list nobody reads. An entry whose mention
    // has gone is a line excusing nothing, and it would silently excuse the same
    // text if it came back somewhere else in the file.
    const unused = DELIBERATE.filter(
      (mention) =>
        !markdownReferences(read(mention.file)).includes(
          `${mention.stem}${MARKDOWN}`,
        ),
    ).map((mention) => `${mention.file}: ${mention.stem}`);
    expect(unused).toEqual([]);
    // And the count, so that a list quietly shortened by one is as loud as a
    // list quietly lengthened by one.
    expect(DELIBERATE).toHaveLength(15);
    for (const mention of DELIBERATE) {
      expect(mention.reason.length, `${mention.file}: ${mention.stem}`)
        .toBeGreaterThan(20);
    }
  });

  it('would report the description this vehicle reworded', () => {
    // The planted control, and it is the exact string that was in the tree:
    // the engine package pointed at a document the published tree has never
    // carried, which is audit rows tooling-F14 and trace-F16.
    expect(
      markdownReferences('Placeholder for the shared engine package. See README.md.'),
    ).toEqual(['README.md']);
    expect(markdownReferences('see docs/STACK.md section 5')).toEqual([
      'docs/STACK.md',
    ]);
    // And the two shapes it must not report, so the matcher cannot be widened
    // into something that has to be switched off.
    expect(markdownReferences('a *.md line in the per-clone exclude file')).toEqual(
      [],
    );
    expect(markdownReferences('the README explains the gates')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The package is named after the repository it is published as.
 * ------------------------------------------------------------------ */

/**
 * The repository this package is published as, as a literal.
 *
 * Pinned rather than derived: the remote is not readable from a unit test and
 * would not be the authority if it were, since the question is whether the
 * manifest agrees with the name a reader sees on the clone they took.
 */
const REPOSITORY_NAME = 'pocket-football-canvas-typescript';

/** The name fields a rename has to move together, or `npm ci` refuses the tree. */
export function packageNames(manifest: string, lockfile: string): string[] {
  const declared = (JSON.parse(manifest) as { name?: string }).name ?? '';
  const lock = JSON.parse(lockfile) as {
    name?: string;
    packages?: Record<string, { name?: string }>;
  };
  return [declared, lock.name ?? '', lock.packages?.['']?.name ?? ''];
}

describe('the package is named after the repository it is published as', () => {
  it('states the repository name in all three fields', () => {
    expect(packageNames(read('package.json'), read('package-lock.json'))).toEqual([
      REPOSITORY_NAME,
      REPOSITORY_NAME,
      REPOSITORY_NAME,
    ]);
  });

  it('would see a field left behind', () => {
    // The negative control. The lockfile carries the name twice and npm refuses
    // an install when either copy disagrees with the manifest, so a rename that
    // moved one field and not the other is the failure this pins.
    expect(
      packageNames(
        '{"name":"pocket-football-canvas-typescript"}',
        '{"name":"pocket-football-canvas-engine","packages":{"":{"name":"pocket-football-canvas-typescript"}}}',
      ),
    ).toEqual([
      'pocket-football-canvas-typescript',
      'pocket-football-canvas-engine',
      'pocket-football-canvas-typescript',
    ]);
    expect(packageNames('{}', '{"packages":{}}')).toEqual(['', '', '']);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The owner file's recorded reason stays true.
 * ------------------------------------------------------------------ */

interface PullRequestRule {
  type: string;
  parameters?: {
    required_approving_review_count?: number;
    require_code_owner_review?: boolean;
  };
}

/**
 * Does the ruleset ask for a review at all?
 *
 * `.github/CODEOWNERS` states in a comment that it gates nothing, and names
 * these two fields as the reason. That comment is the recorded decision audit
 * row tooling-F18 asked for, and a recorded decision that quietly stops being
 * true is worse than no comment, so the two values are read from the ruleset
 * file rather than repeated.
 */
export function ruleSetAsksForReview(rule: PullRequestRule | undefined): boolean {
  const parameters = rule?.parameters;
  return (
    (parameters?.required_approving_review_count ?? 0) > 0 ||
    parameters?.require_code_owner_review === true
  );
}

/** The one value a pattern states, or null if it states none or more than one. */
function soleValue<T>(
  text: string,
  pattern: RegExp,
  parse: (value: string) => T,
): T | null {
  const found = [...text.matchAll(pattern)].map((match) => match[1] ?? '');
  return found.length === 1 && found[0] !== undefined ? parse(found[0]) : null;
}

/**
 * The two numbers the owner file's comment states, read out of the comment.
 *
 * Searching the comment for the two field names says only that the words are
 * there: a comment rewritten to claim one approval and a code owner review
 * contains them just as well, and it would then be a recorded decision that is
 * false while every gate stays green. So the values are parsed and compared,
 * and the grammar the comment has to keep is `<field> to <value>`.
 */
export function recordedReview(comment: string): {
  count: number | null;
  codeOwner: boolean | null;
} {
  return {
    count: soleValue(
      comment,
      /required_approving_review_count\s+to\s+(\d+)/g,
      (value) => Number(value),
    ),
    codeOwner: soleValue(
      comment,
      /require_code_owner_review\s+to\s+(true|false)/g,
      (value) => value === 'true',
    ),
  };
}

/** Every way the recorded reason and the file it cites can disagree. */
export function recordedReasonDisagreements(
  comment: string,
  rule: PullRequestRule | undefined,
): string[] {
  const recorded = recordedReview(comment);
  const problems: string[] = [];
  const count = rule?.parameters?.required_approving_review_count ?? 0;
  const codeOwner = rule?.parameters?.require_code_owner_review === true;
  if (recorded.count === null) {
    problems.push('the comment states no required_approving_review_count value');
  } else if (recorded.count !== count) {
    problems.push(
      `the comment says required_approving_review_count is ${String(recorded.count)}, ` +
        `the ruleset sets ${String(count)}`,
    );
  }
  if (recorded.codeOwner === null) {
    problems.push('the comment states no require_code_owner_review value');
  } else if (recorded.codeOwner !== codeOwner) {
    problems.push(
      `the comment says require_code_owner_review is ${String(recorded.codeOwner)}, ` +
        `the ruleset sets ${String(codeOwner)}`,
    );
  }
  return problems;
}

function pullRequestRule(): PullRequestRule | undefined {
  const ruleset = JSON.parse(read('.github/rulesets/protect-main.json')) as {
    rules: PullRequestRule[];
  };
  return ruleset.rules.find((entry) => entry.type === 'pull_request');
}

describe('the owner file says what the ruleset does', () => {
  it('names an owner and says it gates nothing today', () => {
    const codeowners = read('.github/CODEOWNERS');
    expect(codeowners).toContain('* @Elia-Youssef');
    expect(codeowners).toContain('required_approving_review_count');
    expect(codeowners).toContain('require_code_owner_review');
    expect(codeowners).toContain('.github/rulesets/protect-main.json');
  });

  it('agrees with the ruleset, which is where the numbers are set', () => {
    const rule = pullRequestRule();
    expect(rule, 'the ruleset states a pull request rule').toBeDefined();
    expect(rule?.parameters?.required_approving_review_count).toBe(0);
    expect(rule?.parameters?.require_code_owner_review).toBe(false);
    expect(ruleSetAsksForReview(rule)).toBe(false);
    // The recorded reason read, not searched: both values come out of the
    // comment and are compared with the ones the ruleset sets.
    expect(recordedReview(read('.github/CODEOWNERS'))).toEqual({
      count: 0,
      codeOwner: false,
    });
    expect(recordedReasonDisagreements(read('.github/CODEOWNERS'), rule)).toEqual([]);
  });

  it('would see the comment claim a review the ruleset does not ask for', () => {
    // The negative control for the direction the first version of this test
    // could not see: the ruleset unchanged, the comment rewritten. Both fields
    // separately, because either one alone makes the recorded reason false.
    const rule = pullRequestRule();
    const claimed = read('.github/CODEOWNERS')
      .replace('required_approving_review_count to 0', 'required_approving_review_count to 1')
      .replace('require_code_owner_review to false', 'require_code_owner_review to true');
    expect(recordedReasonDisagreements(claimed, rule)).toEqual([
      'the comment says required_approving_review_count is 1, the ruleset sets 0',
      'the comment says require_code_owner_review is true, the ruleset sets false',
    ]);
    // And the reading failing rather than disagreeing: a comment that states
    // neither value must not pass as agreement with whatever the ruleset says.
    expect(recordedReasonDisagreements('# an owner file with no reason\n', rule)).toEqual([
      'the comment states no required_approving_review_count value',
      'the comment states no require_code_owner_review value',
    ]);
    // Two statements of the same field are no statement at all: which one the
    // reader is meant to believe is exactly what a second one destroys.
    expect(
      recordedReview(
        'required_approving_review_count to 0 and required_approving_review_count to 1',
      ).count,
    ).toBeNull();
  });

  it('would see either number start asking for a review', () => {
    // The negative control, one per field, because either one on its own makes
    // the comment in the owner file false.
    expect(
      ruleSetAsksForReview({
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          require_code_owner_review: false,
        },
      }),
    ).toBe(true);
    expect(
      ruleSetAsksForReview({
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          require_code_owner_review: true,
        },
      }),
    ).toBe(true);
    expect(ruleSetAsksForReview(undefined)).toBe(false);
  });
});
