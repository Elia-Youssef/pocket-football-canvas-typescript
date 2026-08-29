#!/usr/bin/env node
/**
 * The repository record gate for this project, enforcing GITHUB sections 2, 4
 * and 7 on everything that would be pushed.
 *
 * Section 7 is the rule this file mostly exists for: nothing pushed here names
 * a product, vendor or model that writes code or prose on someone's behalf, and
 * nothing pushed attributes the work to one. Not a file, a filename, a
 * directory name, a commit message, a commit identity, a branch name, a pull
 * request title or a pull request body. These are client-facing products, the
 * repository is part of what is delivered, and provenance chatter in the record
 * answers a question nobody asked and cannot be taken back once pushed.
 *
 * TWO SCAN POSITIONS, AND THEY ARE NOT THE SAME CHECK. Tracked file text and
 * tracked paths are CONTENT: the game describes itself there, so the two
 * contextual entries carry a carve-out for this game's own vocabulary. Commit
 * messages, commit identities, branch names and pull request text are the
 * RECORD: nothing there describes the game, so no carve-out applies and a game
 * noun buys no exemption. See scanContent and scanRecord below.
 *
 * WHY THE LIST BELOW IS BASE64 AND NOT PLAIN TEXT. This script is a tracked
 * file, so it is scanned by its own content check on every run. A list of
 * banned names written out in full would match itself, and the gate would fail
 * the moment it was added. Storing each pattern encoded, and decoding it into
 * memory at startup, is what lets the check cover every tracked file with no
 * self-exemption at all. There is deliberately no skip-this-file rule here:
 * an exemption is a hole, and this one would be the largest hole available.
 *
 * Node builtins only, no dependencies, so it runs before `npm ci` and cannot be
 * skipped for want of an install.
 *
 *   node scripts/check-repository-record.mjs
 *
 * Environment it reads when CI supplies it: REPOSITORY_BRANCH,
 * PULL_REQUEST_TITLE, PULL_REQUEST_BODY. Without them it reads the current
 * branch from git and checks the history alone.
 *
 * Exits 0 when everything passes, 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

function decode(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

// Names that carry attribution outright. Each is bounded to the shape that
// actually names something, so that ordinary technical prose passes: the whole
// point of a precise gate is that nobody has a reason to switch it off.
const ENCODED = [
  ['XGJjbGF1ZGVcYg==', 'assistant product name'],
  ['XGJhbnRocm9waWNcYg==', 'vendor name'],
  ['XGJjaGF0XHM/Z3B0XGI=', 'assistant product name'],
  ['XGJvcGVuXHM/YWlcYg==', 'vendor name'],
  ['XGJncHQtP1swLTlvXQ==', 'model family'],
  ['XGJjb3BpbG90cz9cYg==', 'assistant product name'],
  ['XGJjb2RleFxi', 'assistant product name'],
  ['XGJjb2RlaXVtXGI=', 'assistant product name'],
  ['XGJ3aW5kc3VyZlxi', 'assistant product name'],
  ['XGJ0YWJuaW5lXGI=', 'assistant product name'],
  ['XGJjb2Rld2hpc3BlcmVyXGI=', 'assistant product name'],
  ['XGJnZW1pbmlcYg==', 'model family'],
  ['XGJkZWVwc2Vla1xi', 'vendor name'],
  ['XGJtaXN0cmFsXGI=', 'vendor name'],
  ['XGJsbGFtYVxi', 'model family'],
  ['XGJvbGxhbWFcYg==', 'tool name'],
  ['XGJncm9rXGI=', 'assistant product name'],
  ['XGJwZXJwbGV4aXR5XGI=', 'vendor name'],
  ['Y3Vyc29yXC4oPzpzb3xjb218c2h8ZGlyZWN0b3J5KQ==', 'editor product name'],
  ['XGJjdXJzb3IgKD86aWRlfGVkaXRvcnxjb21wb3NlcnxydWxlcylcYg==', 'editor product name'],
  ['XC5jdXJzb3JydWxlc1xi', 'editor configuration file'],
  ['XGJsbG1zP1xi', 'assistant reference'],
  ['XGJsYXJnZSBsYW5ndWFnZSBtb2RlbHM/XGI=', 'assistant reference'],
  ['XGJhZ2VudGljXGI=', 'assistant reference'],
  ['XGJzdWItP2FnZW50cz9cYg==', 'assistant reference'],
  ['XGJhZ2VudHM/XGI=', 'assistant reference'],
  ['XGJ2aWJlWy0gXWNvZA==', 'authorship claim'],
  ['XGJjby1hdXRob3JlZC1ieVxi', 'attribution trailer'],
  [
    'XGIoPzpnZW5lcmF0ZWR8d3JpdHRlbnxhdXRob3JlZHxwcm9kdWNlZCkgYnkgKD86YW4/ICk/YWlcYg==',
    'authorship claim',
  ],
];

// The two-letter short form and its expansion, which are the only entries with
// a legitimate collision in this repository. SPEC section 1 and section 8
// describe three opponents by that name and always will; a delivery record
// naming a tool never sits on a line about opponents, difficulty or a match.
const ENCODED_CONTEXTUAL = [
  ['XGJhaVxi', 'assistant reference'],
  ['XGJhcnRpZmljaWFsIGludGVsbGlnZW5jZVxi', 'assistant reference'],
];

// One further collision, from outside this repository entirely: an npm funding
// URL whose sponsor handle is those two letters. It appears in the committed
// lockfile, twice, and rewording somebody else's package metadata is not an
// option. A line carrying that exact path is permitted.
const ENCODED_ALLOWANCE = 'L3Nwb25zb3JzL2Fp';

// Local-only instruction files. GITHUB section 8: those paths existing in a
// working tree is fine and expected, and any one of them being TRACKED is a
// failure that names the file. They belong in .git/info/exclude, which is per
// clone and never committed.
const ENCODED_RESERVED = [
  'Y2xhdWRlLm1k',
  'LmNsYXVkZQ==',
  'YWdlbnRzLm1k',
  'YWdlbnQubWQ=',
  'LmFnZW50cw==',
  'Y29kZXgubWQ=',
  'LmNvZGV4',
  'Z2VtaW5pLm1k',
  'LmN1cnNvcg==',
  'LmN1cnNvcnJ1bGVz',
  'LmN1cnNvcmlnbm9yZQ==',
  'LndpbmRzdXJmcnVsZXM=',
  'LmFpZGVyLmNvbmYueW1s',
  'LmFpZGVyLmNoYXQuaGlzdG9yeS5tZA==',
  'LmFpZGVyLmlucHV0Lmhpc3Rvcnk=',
  'LmNvbnRpbnVl',
  'LmNvZGVpdW0=',
  'LmNsaW5lcnVsZXM=',
  'LnJvbw==',
  'LnJvb21vZGVz',
  'Y29waWxvdC1pbnN0cnVjdGlvbnMubWQ=',
];

const BANNED = [
  ...ENCODED.map(([pattern, reason]) => ({
    pattern: new RegExp(decode(pattern), 'i'),
    reason,
    contextual: false,
  })),
  ...ENCODED_CONTEXTUAL.map(([pattern, reason]) => ({
    pattern: new RegExp(decode(pattern), 'i'),
    reason,
    contextual: true,
  })),
];

const RESERVED = new Set(ENCODED_RESERVED.map(decode));
const ALLOWANCE = new RegExp(decode(ENCODED_ALLOWANCE), 'i');

// Vocabulary that only appears in this game's own prose. Narrow on purpose:
// wide enough that a sentence about the three opponents, a difficulty profile
// or a strike reads normally, and narrow enough that a delivery note about who
// or what produced a change does not qualify.
const GAME_CONTEXT =
  /\b(?:opponents?|difficulty|casual|pro|ace|ladder|hotseat|match(?:es)?|pitch|ball|goals?|strikers?|strike|aim(?:ing)?|cone|whiff|profiles?|defensive|aggression|gameplay|players?|simulation|angular)\b/i;

export const BRANCH_PATTERN =
  /^(?:main|(?:pf|eng)-[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*|(?:fix|docs|ci)-[a-z0-9]+(?:-[a-z0-9]+)*|dependabot\/(?:npm_and_yarn|github_actions)\/[a-z0-9][a-z0-9._/-]*)$/;

export const SUBJECT_PATTERN = /^(?:PF-[0-9]+|ENG-[0-9]+|fix|docs|ci|deps): [a-z0-9]/;

export const CLOSES_PATTERN =
  /^Closes: (?:None|[A-Z][A-Z0-9-]*[a-z]?(?:, [A-Z][A-Z0-9-]*[a-z]?)*)$/;

// Any `<word>-by:` line is a trailer, and this repository takes none of them,
// with exactly one waiver: dependabot appends its own sign-off to every commit
// it creates, and that message is generated outside this repository the same
// way its missing `Closes:` line is. The waiver is as narrow as the collision:
// a dependency update only, this exact line only, so a person cannot ride it
// by writing a sign-off into a dependency subject, and every other trailer
// stays banned everywhere. GITHUB section 4 allows exactly one structured
// line in a body, `Closes:`.
const TRAILER_PATTERN = /^[A-Za-z][A-Za-z-]*-by:\s/i;
const DEPENDENCY_TRAILER = /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/;

const TEXT_EXTENSIONS = new Set([
  '.md', '.csv', '.py', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts',
  '.jsx', '.json', '.yml', '.yaml', '.html', '.css', '.txt', '.sh', '.xml',
  '.svg', '.toml', '.ini',
]);

const failures = [];

function fail(message) {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
}

function ok(message) {
  console.log(`  ok    ${message}`);
}

/**
 * Compatibility normalisation before every scan. Without it a name written
 * with full-width or ligature characters would read as something else to a
 * regular expression and as the banned word to a person.
 */
function normalise(text) {
  return text.normalize('NFKC');
}

/** True when a line carries this game's own vocabulary or the funding path. */
export function isGameContextLine(line) {
  return GAME_CONTEXT.test(line) || ALLOWANCE.test(line);
}

/**
 * The same question for a path. A `core/` segment counts, because DESIGN
 * section 1 puts this game's opponent module at `src/core/ai.ts` and a delivery
 * note has never lived in the framework-free simulation directory.
 */
export function isGameContextPath(relative) {
  const segments = relative.split(/[\\/]/);
  if (segments.some((segment) => segment.toLowerCase() === 'core')) {
    return true;
  }
  return GAME_CONTEXT.test(segments.join(' '));
}

function scanLines(text, permits) {
  const found = [];
  normalise(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const permitted = permits(line);
      for (const entry of BANNED) {
        if (entry.contextual && permitted) {
          continue;
        }
        const match = entry.pattern.exec(line);
        if (match !== null) {
          found.push({ line: index + 1, text: match[0], reason: entry.reason });
        }
      }
    });
  return found;
}

/**
 * CONTENT position: the text of a tracked file. The contextual carve-out
 * applies here, because this is where the game's own vocabulary lives. SPEC
 * section 1 and section 8 describe three opponents by a name that is also a
 * banned short form, and a gate that fired on the game's own subject matter
 * would be switched off within a week.
 */
export function scanContent(text) {
  return scanLines(text, isGameContextLine);
}

/**
 * RECORD position: a commit message, a commit identity, a branch name, a pull
 * request title or body. NO carve-out applies here, and the asymmetry is the
 * whole point.
 *
 * The carve-out exists so that the game may describe itself. The delivery
 * record does not describe the game, it describes who or what produced the
 * change, which is exactly the sentence GITHUB section 7 exists to keep out.
 * Allowing a game noun to buy an exemption here would mean "assisted refactor
 * of player movement" landing in the log forever, and provenance chatter is
 * more likely to mention a module than to avoid mentioning one.
 *
 * The consequence is deliberate and is a rewording, not a hole: a legitimate
 * future subject such as one about tuning the opponents' difficulty profiles is
 * reworded to name the module rather than the technique. GITHUB section 7 says
 * a genuine collision is reworded, and a subject line has room to be.
 */
export function scanRecord(text) {
  return scanLines(text, () => false);
}

/** Every banned name in a path, read as its segments. */
export function scanPath(relative) {
  const permitted = isGameContextPath(relative);
  const asWords = normalise(relative).split(/[\\/]/).join(' ');
  const found = [];
  for (const entry of BANNED) {
    if (entry.contextual && permitted) {
      continue;
    }
    const match = entry.pattern.exec(asWords);
    if (match !== null) {
      found.push({ text: match[0], reason: entry.reason });
    }
  }
  return found;
}

export function isReservedBasename(name) {
  return RESERVED.has(name.toLowerCase());
}

/** Text by extension, plus dotfiles and extensionless files such as CODEOWNERS. */
export function isTextPath(relative) {
  const base = path.basename(relative);
  const extension = path.extname(base).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }
  return extension === '' || base.startsWith('.');
}

export function isAscii(value) {
  // By code point rather than by a character-class range: a regular expression
  // spelling out the control characters is itself a lint error, and the house
  // style this enforces is the reason the check exists at all.
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * The first control character a record value carries, beyond tab, LF and CR.
 *
 * `isAscii` cannot see these: every one sits below 0x7f. They matter because
 * the commit walk parses `git log` output on two separator bytes, so a message
 * carrying either would split or truncate its own record, and DEL and the rest
 * of C0 have no business in a delivery record either. By code point rather
 * than a character class, for the same lint reason as `isAscii`.
 */
export function findControlByte(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return code;
    }
  }
  return null;
}

/** GITHUB section 4, applied to a commit subject or a pull request title. */
export function checkSubject(subject) {
  const problems = [];
  if (!isAscii(subject)) {
    problems.push('is not ASCII');
  }
  if (subject.length > 72) {
    problems.push(`is ${String(subject.length)} characters, the ceiling is 72`);
  }
  if (subject.endsWith('.')) {
    problems.push('ends in a full stop');
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    problems.push(
      'must read "<area>: <lowercase imperative summary>", where area is ' +
        'PF-n, ENG-n, fix, docs, ci or deps',
    );
  }
  return problems;
}

/**
 * Whether a commit owes a `Closes:` line, decided from the COMMIT and from
 * nothing else.
 *
 * GITHUB section 4 exempts dependency-update commits, because their messages
 * are generated outside this repository. Deriving that exemption from the
 * branch the check happens to run from makes it temporary: the commit passes
 * on its own branch and then fails the whole-history walk forever once it is
 * squash-merged, on a branch that is no longer a dependency branch. A commit
 * that once passed has to keep passing, so the subject decides, and both
 * ecosystems in .github/dependabot.yml are configured to write `deps:` for the
 * same reason. An actions bump is a dependency update.
 */
export function requiresCloses(subject) {
  return !subject.startsWith('deps:');
}

/** GITHUB section 4, applied to a whole message or a pull request body. */
export function checkBody(lines, { requireCloses, dependencyUpdate = false }) {
  const problems = [];
  const closes = lines.filter((line) => line.startsWith('Closes:'));
  if (closes.length === 0 && requireCloses) {
    problems.push('must contain exactly one Closes: line');
  } else if (closes.length > 1) {
    problems.push(`contains ${String(closes.length)} Closes: lines, the rule is one`);
  } else if (closes.length === 1 && !CLOSES_PATTERN.test(closes[0])) {
    problems.push(`has an invalid Closes: line: ${JSON.stringify(closes[0])}`);
  }
  for (const line of lines) {
    if (!TRAILER_PATTERN.test(line)) {
      continue;
    }
    if (dependencyUpdate && DEPENDENCY_TRAILER.test(line)) {
      continue;
    }
    problems.push(`carries a trailer, which this repository takes none of: ${JSON.stringify(line)}`);
  }
  return problems;
}

/**
 * Everything GITHUB sections 4 and 7 say about one commit, decided from that
 * commit alone.
 *
 * There is deliberately no branch parameter. A verdict on a commit that could
 * change with the branch the check runs from is a verdict that expires: the
 * same object is judged once on a feature branch and again, forever, on main.
 * The `Closes:` waiver is the case that made this concrete, and taking the
 * branch out of the signature is what makes the property structural rather
 * than remembered.
 */
export function checkCommitRecord({ author, committer, message }) {
  const problems = [];
  for (const [label, value] of [
    ['author', author],
    ['committer', committer],
    ['message', message],
  ]) {
    for (const hit of scanRecord(value)) {
      problems.push(`${label} contains ${JSON.stringify(hit.text)} (${hit.reason})`);
    }
    const control = findControlByte(value);
    if (control !== null) {
      problems.push(
        `${label} carries control byte 0x${control.toString(16).padStart(2, '0')}, ` +
          'which can split or truncate a record scan',
      );
    }
  }

  const lines = message.replace(/\n+$/, '').split('\n');
  const subject = lines[0] ?? '';
  for (const problem of checkSubject(subject)) {
    problems.push(`subject ${problem}`);
  }
  if (lines.length > 1 && lines[1] !== '') {
    problems.push('needs a blank line after its subject');
  }
  const dependency = !requiresCloses(subject);
  for (const problem of checkBody(lines.slice(2), {
    requireCloses: !dependency,
    dependencyUpdate: dependency,
  })) {
    problems.push(`message ${problem}`);
  }
  return problems;
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function checkBranch(branch) {
  console.log('== 1. branch name ==');
  if (branch === '') {
    ok('no branch reported, branch check skipped');
    return;
  }
  for (const hit of scanRecord(branch)) {
    fail(`branch name contains ${JSON.stringify(hit.text)} (${hit.reason})`);
  }
  if (!BRANCH_PATTERN.test(branch)) {
    fail(
      `branch name ${JSON.stringify(branch)} is not an allowed shape: main, ` +
        'pf-n-slug, eng-n-slug, fix-slug, docs-slug, ci-slug or dependabot/...',
    );
  }
  ok(`branch ${JSON.stringify(branch)} checked`);
}

function checkTracked() {
  console.log('== 2. tracked files: names, paths and content ==');
  let listing;
  try {
    listing = git('ls-files', '-z');
  } catch (error) {
    fail(`cannot list tracked files: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return 0;
  }
  const tracked = listing.split('\0').filter((entry) => entry !== '');
  let scanned = 0;

  for (const relative of tracked) {
    const base = path.basename(relative);
    if (isReservedBasename(base)) {
      fail(`${relative} is local-only configuration and must never be committed`);
    }
    for (const segment of relative.split('/')) {
      if (isReservedBasename(segment)) {
        fail(`${relative} sits under a local-only path and must never be committed`);
      }
    }
    for (const hit of scanPath(relative)) {
      fail(`path ${relative} contains ${JSON.stringify(hit.text)} (${hit.reason})`);
    }
    if (!isTextPath(relative)) {
      continue;
    }
    let raw;
    try {
      raw = readFileSync(path.join(PROJECT_ROOT, relative));
    } catch (error) {
      // A tracked path with nothing behind it. Named, because a raw ENOENT
      // stack from a gate reads as the gate being broken rather than as the
      // working tree being incomplete.
      fail(
        `${relative} is tracked but missing from the working tree, so its ` +
          `content cannot be checked: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
      continue;
    }
    if (
      !TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()) &&
      raw.subarray(0, 4096).includes(0)
    ) {
      continue;
    }
    scanned += 1;
    for (const hit of scanContent(raw.toString('utf8'))) {
      fail(
        `${relative}:${String(hit.line)} contains ${JSON.stringify(hit.text)} (${hit.reason})`,
      );
    }
  }
  ok(`${String(tracked.length)} tracked paths, ${String(scanned)} of them scanned as text`);
  return tracked.length;
}

const UNIT_SEPARATOR = '\x1e';
const RECORD_SEPARATOR = '\x1d';

/**
 * The `git log` walk output, parsed into records and orphan fragments.
 *
 * Exported for the suite: the parsing itself is load-bearing. A message
 * carrying one of the separator bytes would split or truncate its own record,
 * and a parser that dropped the tail or skipped the fragment silently is
 * exactly where hidden record text would escape the walk. So the message is
 * rejoined rather than destructured, and anything that does not parse is
 * returned for the caller to fail on, never swallowed.
 */
export function parseCommitLog(log) {
  const records = [];
  const fragments = [];
  for (const commit of log.split(RECORD_SEPARATOR).filter((entry) => entry.trim() !== '')) {
    const parts = commit.replace(/^\n/, '').split(UNIT_SEPARATOR);
    if (parts.length < 6) {
      fragments.push(commit);
      continue;
    }
    const [full, authorName, authorEmail, committerName, committerEmail] = parts;
    records.push({
      sha: full.slice(0, 8),
      author: `${authorName} <${authorEmail}>`,
      committer: `${committerName} <${committerEmail}>`,
      // Rejoined, not destructured: a unit byte inside the message splits it
      // into extra fields, and taking only the sixth would silently drop
      // everything after the byte from every scan downstream.
      message: parts.slice(5).join(UNIT_SEPARATOR),
    });
  }
  return { records, fragments };
}

function checkCommits() {
  console.log('== 3. every commit in the history ==');
  let log;
  try {
    log = git(
      'log',
      '--all',
      '--no-merges',
      `--format=${['%H', '%an', '%ae', '%cn', '%ce', '%B'].join(UNIT_SEPARATOR)}${RECORD_SEPARATOR}`,
    );
  } catch (error) {
    ok(`no commits to read yet (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
    return 0;
  }

  const { records, fragments } = parseCommitLog(log);
  for (const fragment of fragments) {
    fail(
      `commit record fragment ${JSON.stringify(fragment.slice(0, 40))} does not parse; ` +
        'a separator control byte inside a commit message is the only source of one',
    );
  }
  for (const { sha, author, committer, message } of records) {
    for (const problem of checkCommitRecord({ author, committer, message })) {
      fail(`commit ${sha} ${problem}`);
    }
  }
  ok(`${String(records.length)} commits checked across every ref`);
  return records.length;
}

function checkPullRequest(branch) {
  console.log('== 4. pull request title and body ==');
  const title = process.env['PULL_REQUEST_TITLE'] ?? '';
  const body = process.env['PULL_REQUEST_BODY'] ?? '';
  let checked = 0;

  if (title !== '') {
    checked += 1;
    for (const hit of scanRecord(title)) {
      fail(`pull request title contains ${JSON.stringify(hit.text)} (${hit.reason})`);
    }
    for (const problem of checkSubject(title)) {
      fail(`pull request title ${problem}`);
    }
    const titleControl = findControlByte(title);
    if (titleControl !== null) {
      fail(`pull request title carries control byte 0x${titleControl.toString(16).padStart(2, '0')}`);
    }
  }
  if (body !== '') {
    checked += 1;
    for (const hit of scanRecord(body)) {
      fail(`pull request body contains ${JSON.stringify(hit.text)} (${hit.reason})`);
    }
    if (!isAscii(body)) {
      fail('pull request body is not ASCII');
    }
    const bodyControl = findControlByte(body);
    if (bodyControl !== null) {
      fail(`pull request body carries control byte 0x${bodyControl.toString(16).padStart(2, '0')}`);
    }
    // A pull request body IS branch-scoped, unlike a commit: it is generated
    // by whoever opened the branch, it is read once while that branch is open,
    // and it is never re-judged afterwards. So the waiver here cannot expire
    // the way the commit waiver could.
    for (const problem of checkBody(body.split(/\r?\n/), {
      requireCloses: !branch.startsWith('dependabot/'),
      dependencyUpdate: branch.startsWith('dependabot/'),
    })) {
      fail(`pull request body ${problem}`);
    }
  }
  ok(`${String(checked)} supplied values checked`);
}

/** Case-folded on Windows, where two spellings of a path are one directory. */
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Refuse to judge somebody else's repository.
 *
 * Run from a directory that is not yet a repository of its own, git walks
 * upwards and answers about whatever encloses it. The check would then read an
 * unrelated history, an unrelated file list and an unrelated branch name, and
 * report a verdict about a project nobody asked about. Failing by name is the
 * only honest answer, and it is also the message that tells a first-time
 * contributor what is actually wrong.
 */
function checkRepositoryIdentity() {
  console.log('== 0. the repository under test ==');
  let toplevel;
  try {
    toplevel = git('rev-parse', '--show-toplevel').trim();
  } catch (error) {
    fail(
      'there is no git repository at this project root, so the branch, the ' +
        `history and the tracked file list cannot be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
    return false;
  }
  if (!samePath(toplevel, PROJECT_ROOT)) {
    fail(
      `this project is not its own repository: git reports ${toplevel} as the ` +
        `repository root, and this check only judges ${PROJECT_ROOT}. Run it ` +
        'from a clone of this project, or initialise one here first.',
    );
    return false;
  }
  ok(`repository root is this project, ${toplevel}`);
  return true;
}

export function main() {
  if (!checkRepositoryIdentity()) {
    console.log(`\n${String(failures.length)} FAILURE(S)`);
    return 1;
  }

  let branch = process.env['REPOSITORY_BRANCH'] ?? '';
  if (branch === '') {
    try {
      branch = git('branch', '--show-current').trim();
    } catch (error) {
      console.log(
        `  note  no branch available: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
  }

  checkBranch(branch);
  const tracked = checkTracked();
  const commits = checkCommits();
  checkPullRequest(branch);

  console.log('');
  if (failures.length > 0) {
    console.log(`${String(failures.length)} FAILURE(S)`);
    return 1;
  }
  console.log(
    `record: PASS, ${String(tracked)} tracked files and ${String(commits)} commits clean` +
      `${branch === '' ? '' : `, on branch ${branch}`}`,
  );
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
