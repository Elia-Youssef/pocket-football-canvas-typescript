import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BRANCH_PATTERN,
  CLOSES_PATTERN,
  SUBJECT_LIMIT,
  checkBody,
  checkBranch,
  checkCommits,
  checkCommitRecord,
  checkPullRequest,
  checkRepositoryIdentity,
  checkSubject,
  checkTracked,
  createGit,
  createReporter,
  isDependabotCommit,
  isDependabotPullRequest,
  isGameContextLine,
  isReservedBasename,
  isSyntheticMergeTip,
  isTextPath,
  parseCommitLog,
  requiresCloses,
  runRecordGate,
  scanContent,
  scanPath,
  scanRecord,
  shallowRefusal,
  shallowState,
  subjectWithoutPullRequestSuffix,
} from '../../scripts/check-repository-record.mjs';

/**
 * The repository record gate, GITHUB sections 2, 4 and 7.
 *
 * Every probe string below is decoded at runtime rather than written out, for
 * the same reason the gate stores its list encoded: this test is a tracked
 * file, the gate scans it, and a test that spelled out the names it detects
 * would fail the gate it is testing. That is not a workaround, it is the
 * property that lets the gate cover every file with no self-exemption.
 */

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

function fixtureGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

function withFixtureRepository(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'pocket-football-record-'));
  try {
    fixtureGit(root, ['init', '--initial-branch=main']);
    fixtureGit(root, ['config', 'user.name', 'Fixture']);
    fixtureGit(root, ['config', 'user.email', 'fixture@example.com']);
    writeFileSync(path.join(root, 'README.rst'), 'fixture record\n', 'utf8');
    fixtureGit(root, ['add', 'README.rst']);
    fixtureGit(root, [
      'commit',
      '-m',
      'fix: add the record fixture',
      '-m',
      'Because its history must be checked.\n\nCloses: None',
    ]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function probe(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

// A vendor name, an assistant product name, the two-letter short form, the
// two-word phrase for autonomous software helpers, the attribution trailer,
// the funding path collision, and one local-only filename.
const VENDOR = probe('YW50aHJvcGlj');
const PRODUCT = probe('Y29kZXg=');
const SHORT_FORM = probe('YWk=');
const HELPER_PHRASE = probe('YWkgYWdlbnQ=');
const TRAILER = probe('Q28tQXV0aG9yZWQtQnk6IHNvbWVvbmU=');
const FUNDING = probe('aHR0cHM6Ly9naXRodWIuY29tL3Nwb25zb3JzL2Fp');
const RESERVED_FILE = probe('Y2xhdWRlLm1k');
const USER_AGENT_PHRASE = probe('dXNlciBhZ2VudA==');

/**
 * Ten provenance sentences, every one of which carries a real game noun. Under
 * a carve-out that applied everywhere, all ten would land in the commit log
 * untouched. They are the acceptance test for the content/record split.
 */
const PROVENANCE_WITH_GAME_NOUNS = [
  'YWkgYXNzaXN0ZWQgcmVmYWN0b3Igb2YgcGxheWVyIG1vdmVtZW50',
  'Y28tYXV0aG9yZWQgd2l0aCBhaSBmb3IgdGhlIHBpdGNoIHJlbmRlcmVy',
  'YXJ0aWZpY2lhbCBpbnRlbGxpZ2VuY2UgaGVscGVkIHR1bmUgdGhlIGRpZmZpY3VsdHkgcHJvZmlsZXM=',
  'YWkgdG9vbGluZyBwcm9kdWNlZCB0aGlzIHBsYXllciBwcm9maWxl',
  'dGhpcyBzaW11bGF0aW9uIG1vZHVsZSB3YXMgZHJhZnRlZCB3aXRoIGFydGlmaWNpYWwgaW50ZWxsaWdlbmNl',
  'YWkgd3JvdGUgdGhlIGdvYWwgZGV0ZWN0aW9u',
  'YWkgcGFpciBzZXNzaW9uIG9uIHRoZSBsYWRkZXIgb3Bwb25lbnRz',
  'Z2VuZXJhdGVkIHdpdGggYWksIHJldmlld2VkIGZvciB0aGUgbWF0Y2ggY2xvY2s=',
  'YXJ0aWZpY2lhbCBpbnRlbGxpZ2VuY2UgZHJhZnRlZCB0aGUgYWltIGd1aWRl',
  'YWkgY2xlYW51cCBvZiB0aGUgZ29hbCBkZXRlY3Rpb24gc2ltdWxhdGlvbg==',
].map(probe);

// A legitimate future subject that the split deliberately costs us: it is
// reworded per GITHUB section 7, not exempted.
const REWORDABLE_SUBJECT = probe('UEYtODogdHVuZSB0aGUgYWkgZGlmZmljdWx0eSBwcm9maWxlcw==');
const GAME_PROSE = probe('dGhyZWUgYWkgb3Bwb25lbnRzLCBvbmUgcGVyIGRpZmZpY3VsdHk=');

describe('PF-0 repository record gate', () => {
  describe('the banned-name scan', () => {
    it('catches a vendor name, a product name and an attribution trailer', () => {
      expect(scanContent(`built with ${VENDOR}`)).toHaveLength(1);
      expect(scanContent(`see ${PRODUCT} for details`)).toHaveLength(1);
      expect(scanContent(TRAILER).length).toBeGreaterThan(0);
    });

    it('catches the two-word phrase for an autonomous software helper', () => {
      expect(scanContent(`an ${HELPER_PHRASE} did this`).length).toBeGreaterThan(0);
    });

    it('reports the line number a hit is on', () => {
      const hits = scanContent(`clean\nclean\nnamed ${VENDOR} here\n`);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.line).toBe(3);
    });

    it('leaves ordinary prose and identifiers alone', () => {
      for (const line of [
        'the pitch is 1280 by 720 logical pixels',
        'read clientX and clientY, never offsetX',
        'cursor: pointer on every interactive control',
        'navigator.userAgent is read by nothing here',
        'a hint that never gates play, per SC 1.3.4',
      ]) {
        expect(scanContent(line), line).toEqual([]);
        expect(scanRecord(line), line).toEqual([]);
      }
    });

    it('bans the two-word phrase while leaving the identifier alone', () => {
      // The identifier has no word boundary before the second word, so it
      // cannot match; the spaced phrase can and does.
      expect(scanContent(`a spoofed ${USER_AGENT_PHRASE}`).length).toBeGreaterThan(0);
      expect(scanContent('navigator.userAgent')).toEqual([]);
    });
  });

  describe('content position keeps the carve-out', () => {
    it('permits the short form on a line about the opponents', () => {
      expect(scanContent(GAME_PROSE)).toEqual([]);
      expect(scanContent(`the ${SHORT_FORM} aims at the reachable strike side`)).toEqual([]);
    });

    it('bans it on a line with no gameplay context', () => {
      expect(scanContent(`this file was reviewed by ${SHORT_FORM}`).length).toBeGreaterThan(0);
    });

    it('permits the npm funding path in the committed lockfile', () => {
      expect(scanContent(`"url": "${FUNDING}"`)).toEqual([]);
    });

    it('permits a path under the framework-free simulation directory', () => {
      // DESIGN section 1 puts this game's opponent module there by name.
      expect(scanPath(`src/core/${SHORT_FORM}.ts`)).toEqual([]);
      expect(scanPath(`docs/${SHORT_FORM}-notes.md`).length).toBeGreaterThan(0);
    });
  });

  describe('record position takes no carve-out at all', () => {
    it('refuses every provenance sentence, game noun or not', () => {
      for (const sentence of PROVENANCE_WITH_GAME_NOUNS) {
        // Content position lets each of these through, by design: that is what
        // makes them the right test. The record must not.
        expect(scanContent(sentence), `content: ${sentence}`).toEqual([]);
        expect(scanRecord(sentence).length, `record: ${sentence}`).toBeGreaterThan(0);
      }
      expect(PROVENANCE_WITH_GAME_NOUNS).toHaveLength(10);
    });

    it('refuses a subject that names the technique, so it gets reworded', () => {
      expect(scanContent(REWORDABLE_SUBJECT)).toEqual([]);
      expect(scanRecord(REWORDABLE_SUBJECT).length).toBeGreaterThan(0);
    });

    it('refuses game prose in the record, which is where the split bites', () => {
      expect(scanRecord(GAME_PROSE).length).toBeGreaterThan(0);
    });

    it('applies to a whole commit, including its identity', () => {
      const dirty = PROVENANCE_WITH_GAME_NOUNS[0] ?? '';
      expect(
        checkCommitRecord({
          author: 'Someone <someone@example.com>',
          committer: 'Someone <someone@example.com>',
          message: `PF-2: integrate at a fixed step\n\n${dirty}\n\nCloses: B1`,
        }).length,
      ).toBeGreaterThan(0);
      expect(
        checkCommitRecord({
          author: `${dirty} <someone@example.com>`,
          committer: 'Someone <someone@example.com>',
          message: 'PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1',
        }).length,
      ).toBeGreaterThan(0);
    });

    it('still passes an ordinary commit', () => {
      expect(
        checkCommitRecord({
          author: 'Someone <someone@example.com>',
          committer: 'Someone <someone@example.com>',
          message:
            'PF-0: scaffold the project and its CI gates\n\nBecause the boundary has to exist first.\n\nCloses: A1, A2, A6, M3',
        }),
      ).toEqual([]);
    });
  });

  describe('the carve-out is exactly this wide and no wider', () => {
    it('counts this game vocabulary as context', () => {
      for (const word of ['opponent', 'difficulty', 'pitch', 'ball', 'goal', 'aim']) {
        expect(isGameContextLine(`a line about the ${word}`), word).toBe(true);
      }
    });

    it('counts delivery vocabulary as nothing of the sort', () => {
      // Widening the list with words like these is how a carve-out for the
      // game's subject matter quietly becomes a carve-out for provenance.
      for (const word of [
        'refactor',
        'assisted',
        'generated',
        'authored',
        'produced',
        'drafted',
        'tooling',
        'review',
      ]) {
        expect(isGameContextLine(`a line about being ${word}`), word).toBe(false);
      }
    });
  });

  describe('the dependency waiver is a property of the commit', () => {
    const DEPENDENCY_COMMIT = {
      author: 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
      committer: 'GitHub <noreply@github.com>',
      // The real message shape, sign-off included: dependabot appends it to
      // every commit it creates, so a model without it tests a commit that
      // will never exist.
      message:
        `deps: Bump actions/checkout from 7.0.1 to 7.0.2\n\n${PRODUCT}\n\n` +
        'Signed-off-by: dependabot[bot] <support@github.com>',
    };
    const HUMAN_CI_COMMIT = {
      author: 'Someone <someone@example.com>',
      committer: 'Someone <someone@example.com>',
      message: 'ci: pin every action to a commit sha\n\nA floating tag is not accepted.',
    };

    it('waives the Closes line for a deps subject and never for a ci subject', () => {
      expect(requiresCloses('deps: bump vite from 8.2.2 to 8.2.3')).toBe(false);
      expect(requiresCloses('ci: pin every action to a commit sha')).toBe(true);
      expect(requiresCloses('PF-1: add the design tokens')).toBe(true);
      expect(requiresCloses('docs: record the reorder')).toBe(true);
    });

    it('recognises generated bot metadata from the commit signature alone', () => {
      expect(isDependabotCommit(DEPENDENCY_COMMIT)).toBe(true);
      expect(checkCommitRecord(DEPENDENCY_COMMIT)).toEqual([]);
      expect(
        isDependabotCommit({
          ...DEPENDENCY_COMMIT,
          message: DEPENDENCY_COMMIT.message.replace('Signed-off-by:', 'Reviewed-by:'),
        }),
      ).toBe(false);
    });

    it('requires the GitHub-supplied pull request author before enabling the exception', () => {
      process.env['PULL_REQUEST_AUTHOR'] = 'someone-else';
      expect(isDependabotPullRequest()).toBe(false);
      process.env['PULL_REQUEST_AUTHOR'] = 'dependabot[bot]';
      expect(isDependabotPullRequest()).toBe(true);
      delete process.env['PULL_REQUEST_AUTHOR'];
    });

    it('still scans a bot pull request title and body', () => {
      const lines: string[] = [];
      const reporter = createReporter((line: string) => lines.push(line));
      checkPullRequest({
        environment: {
          PULL_REQUEST_AUTHOR: 'dependabot[bot]',
          PULL_REQUEST_TITLE: 'deps: Bump ' + PRODUCT,
          PULL_REQUEST_BODY: 'release notes name ' + PRODUCT,
        },
        reporter,
      });
      expect(reporter.failures).toHaveLength(2);
      expect(reporter.failures[0]).toContain('pull request title contains');
      expect(reporter.failures[1]).toContain('pull request body contains');
      expect(lines.some((line) => line.includes('2 supplied values checked'))).toBe(true);
    });

    it('refuses the dependency sign-off on anything that is not a dependency update', () => {
      expect(
        checkCommitRecord({
          author: 'Someone <someone@example.com>',
          committer: 'Someone <someone@example.com>',
          message:
            'PF-2: integrate at a fixed step\n\nWhy.\n\n' +
            'Signed-off-by: dependabot[bot] <support@github.com>\n\nCloses: B1',
        }).length,
      ).toBe(1);
    });

    it('fails a human ci commit with no Closes line', () => {
      expect(checkCommitRecord(HUMAN_CI_COMMIT).length).toBe(1);
    });

    it('keeps the history exception independent of branch and PR environment names', () => {
      const branches = ['dependabot/github_actions/actions/checkout-7', 'main', 'pf-1-tokens'];
      for (const branch of branches) {
        process.env['REPOSITORY_BRANCH'] = branch;
        process.env['PULL_REQUEST_AUTHOR'] = 'someone-else';
        expect(checkCommitRecord(DEPENDENCY_COMMIT), branch).toEqual([]);
        expect(checkCommitRecord(HUMAN_CI_COMMIT).length, branch).toBe(1);
      }
      delete process.env['REPOSITORY_BRANCH'];
      delete process.env['PULL_REQUEST_AUTHOR'];
      expect(checkCommitRecord.length).toBe(1);
    });
  });

  describe('GitHub-generated squash records', () => {
    const GENERATED_SQUASH = {
      author: 'Elia Y <78515123+Elia-Youssef@users.noreply.github.com>',
      committer: 'GitHub <noreply@github.com>',
      message:
        'fix: align clock with accepted frame time (#28)\n\n' +
        '* fix: align clock with accepted frame time\n\n' +
        'Because countdown and simulation time have to agree.\n\n' +
        'Closes: None\n\n' +
        '* fix: drive game clock through accepted frames\n\n' +
        'Because a resume gap is not visible match time.\n\n' +
        'Closes: None',
    };

    it('checks every embedded commit when GitHub preserves a squash body', () => {
      expect(checkCommitRecord(GENERATED_SQUASH)).toEqual([]);
    });

    it('rejects a malformed embedded record instead of waiving the wrapper', () => {
      const malformed = {
        ...GENERATED_SQUASH,
        message: GENERATED_SQUASH.message.replace('Closes: None\n\n* fix: drive', 'Closes: none\n\n* fix: drive'),
      };
      expect(checkCommitRecord(malformed)).toContain(
        'squashed component 1 message has a malformed Closes: line: "Closes: none"',
      );
    });

    it('does not infer the generated shape from a GitHub committer alone', () => {
      const lookalike = { ...GENERATED_SQUASH, author: 'Someone <someone@example.com>' };
      expect(
        checkCommitRecord(lookalike).some((problem) => problem.includes('contains 2 Closes: lines')),
      ).toBe(true);
    });

    it('reserves component markers for the generated shape that can parse them', () => {
      const manual = {
        author: 'Someone <someone@example.com>',
        committer: 'Someone <someone@example.com>',
        message: 'fix: reserve generated markers\n\nBecause components need a clear boundary.\n\n* detail\n\nCloses: None',
      };
      expect(checkCommitRecord(manual)).toContain(
        'message uses a squash component marker, which is reserved for GitHub-generated records',
      );
    });
  });

  describe('control bytes cannot hide record text from the walk', () => {
    const FIELD = String.fromCharCode(0x1e);
    const RECORD = String.fromCharCode(0x1d);

    it('flags the log separators and NUL inside a message', () => {
      for (const byte of [FIELD, RECORD, String.fromCharCode(0)]) {
        const problems = checkCommitRecord({
          author: 'Someone <someone@example.com>',
          committer: 'Someone <someone@example.com>',
          message: `PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1${byte}hidden text`,
        });
        expect(
          problems.some((problem) => problem.includes('control byte')),
          `0x${(byte.codePointAt(0) ?? 0).toString(16)}`,
        ).toBe(true);
      }
    });

    it('flags a control byte in an identity as well', () => {
      expect(
        checkCommitRecord({
          author: `Someone${FIELD} <someone@example.com>`,
          committer: 'Someone <someone@example.com>',
          message: 'PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1',
        }).some((problem) => problem.includes('control byte')),
      ).toBe(true);
    });

    it('rejects non-ASCII record values by code point', () => {
      const zeroWidth = String.fromCodePoint(0x200b);
      const problems = checkCommitRecord({
        author: 'Someone <someone@example.com>',
        committer: 'Someone <someone@example.com>',
        message: 'PF-2: integrate' + zeroWidth + ' at a fixed step\n\nWhy.\n\nCloses: B1',
      });
      expect(problems).toContain('message is not ASCII');
    });

    it('leaves tab, LF and CR alone, which real messages carry', () => {
      expect(
        checkCommitRecord({
          author: 'Someone <someone@example.com>',
          committer: 'Someone <someone@example.com>',
          message: 'PF-2: integrate at a fixed step\n\nWhy:\n\tindented.\r\n\nCloses: B1',
        }),
      ).toEqual([]);
    });
  });

  describe('the commit walk parses its own format defensively', () => {
    const FIELD = String.fromCharCode(0x1e);
    const RECORD = String.fromCharCode(0x1d);
    const record = (message: string, parents = '1111111 2222222'): string =>
      [
        'abcdef1234567890',
        parents,
        'Someone',
        'someone@example.com',
        'Someone',
        'someone@example.com',
        message,
      ].join(FIELD) + RECORD;

    it('parses an ordinary record whole', () => {
      const { records, fragments } = parseCommitLog(
        record('PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1'),
      );
      expect(fragments).toEqual([]);
      expect(records).toHaveLength(1);
      expect(records[0]?.sha).toBe('abcdef1234567890');
      expect(records[0]?.parents).toBe('1111111 2222222');
      expect(records[0]?.message).toBe('PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1');
    });

    it('keeps text after an embedded field separator instead of dropping it', () => {
      const { records } = parseCommitLog(
        record(`PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1${FIELD}hidden`),
      );
      expect(records[0]?.message).toContain('hidden');
      // And the record check then flags the byte the message carries.
      expect(
        checkCommitRecord({
          author: records[0]?.author ?? '',
          committer: records[0]?.committer ?? '',
          message: records[0]?.message ?? '',
        }).some((problem) => problem.includes('control byte')),
      ).toBe(true);
    });

    it('reports an embedded record separator as a fragment, never a silent skip', () => {
      const { records, fragments } = parseCommitLog(
        record(`PF-2: integrate at a fixed step\n\nWhy.\n\nCloses: B1${RECORD}hidden after the split`),
      );
      expect(records).toHaveLength(1);
      expect(fragments).toHaveLength(1);
      expect(fragments[0]).toContain('hidden after the split');
    });
  });

  describe('reserved names and text detection', () => {
    it('recognises local-only configuration by basename, case-insensitively', () => {
      expect(isReservedBasename(RESERVED_FILE)).toBe(true);
      expect(isReservedBasename(RESERVED_FILE.toUpperCase())).toBe(true);
      expect(isReservedBasename('package.json')).toBe(false);
      expect(isReservedBasename('README.md')).toBe(false);
    });

    it('treats source, dotfiles and extensionless files as text', () => {
      for (const file of [
        'src/main.ts',
        'eslint.config.js',
        'package.json',
        '.npmrc',
        '.github/CODEOWNERS',
        'README.md',
      ]) {
        expect(isTextPath(file), file).toBe(true);
      }
      expect(isTextPath('reference/layout-reference.png')).toBe(false);
    });

    it('treats unfamiliar text extensions as text and known binary ones as binary', () => {
      for (const file of ['notes.rst', 'snapshot.snap', 'table.tsv', 'guide.markdown']) {
        expect(isTextPath(file), file).toBe(true);
      }
      expect(isTextPath('capture.webm')).toBe(false);
    });
  });

  describe('the merge walk exempts only GitHub synthetic merge tips', () => {
    const synthetic = {
      sha: 'a'.repeat(40),
      parents: 'b'.repeat(40) + ' ' + 'c'.repeat(40),
      author: 'Contributor <contributor@example.com>',
      committer: 'GitHub <noreply@github.com>',
      message: 'Merge ' + 'c'.repeat(40) + ' into ' + 'b'.repeat(40),
    };

    it('keeps historical and lookalike merges inside the record scan', () => {
      expect(isSyntheticMergeTip(synthetic, synthetic.sha)).toBe(true);
      expect(isSyntheticMergeTip(synthetic, 'f'.repeat(40))).toBe(false);
      expect(
        isSyntheticMergeTip({ ...synthetic, committer: 'Someone <someone@example.com>' }, synthetic.sha),
      ).toBe(false);
      expect(isSyntheticMergeTip({ ...synthetic, parents: 'b'.repeat(40) }, synthetic.sha)).toBe(false);
      expect(isSyntheticMergeTip({ ...synthetic, message: 'fix: merge records' }, synthetic.sha)).toBe(
        false,
      );
      expect(
        isSyntheticMergeTip(
          { ...synthetic, message: 'Merge ' + 'd'.repeat(40) + ' into ' + 'b'.repeat(40) },
          synthetic.sha,
        ),
      ).toBe(false);
    });

    it('feeds an ordinary historical merge through the commit record check', () => {
      const field = String.fromCharCode(0x1e);
      const record = [
        'f'.repeat(40),
        '1'.repeat(40) + ' ' + '2'.repeat(40),
        'Someone',
        'someone@example.com',
        'Someone',
        'someone@example.com',
        'Merge branch side',
      ].join(field) + String.fromCharCode(0x1d);
      const calls: string[][] = [];
      const runGit = (...args: string[]): string => {
        calls.push(args);
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
          return 'false\n';
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'f'.repeat(40) + '\n';
        }
        return record;
      };
      const reporter = createReporter(() => undefined);
      expect(checkCommits({ runGit, reporter })).toBe(1);
      expect(reporter.failures.some((failure) => failure.includes('subject'))).toBe(true);
      const log = calls.find((args) => args[0] === 'log') ?? [];
      expect(log).not.toContain('--no-merges');
    });
  });

  describe('branch names, GITHUB section 2', () => {
    it('accepts every documented shape', () => {
      for (const branch of [
        'main',
        'pf-0-scaffold-and-ci-gates',
        'pf-14-responsive-and-letterboxed-portrait',
        'eng-1-extract-loop',
        'fix-reachable-cone-clamp',
        'docs-github-rules',
        'ci-record-gate',
        'dependabot/npm_and_yarn/vite-8.2.3',
        'dependabot/github_actions/actions/checkout-7',
      ]) {
        expect(BRANCH_PATTERN.test(branch), branch).toBe(true);
      }
    });

    it('rejects a personal, uppercase or unshaped branch', () => {
      for (const branch of [
        'PF-0-scaffold',
        'pf-scaffold',
        'elia/pf-0',
        'feature/pf-0-scaffold',
        'pf-0-Scaffold',
        'wip',
        'dependabot/cargo/serde-1',
      ]) {
        expect(BRANCH_PATTERN.test(branch), branch).toBe(false);
      }
    });
  });

  describe('commit subjects, GITHUB section 4', () => {
    it('accepts the documented form', () => {
      for (const subject of [
        'PF-0: scaffold the project and its CI gates',
        'ENG-1: extract the shared loop',
        'fix: clamp the reachable strike side',
        'docs: record the reorder',
        'ci: pin every action to a commit sha',
        'deps: bump vite to 8.2.3',
      ]) {
        expect(checkSubject(subject), subject).toEqual([]);
      }
    });

    it('rejects the wrong area, capital, full stop or length', () => {
      expect(checkSubject('BJ-1: add tokens').length).toBeGreaterThan(0);
      expect(checkSubject('PF-0: Scaffold the project').length).toBeGreaterThan(0);
      expect(checkSubject('PF-0: scaffold the project.').length).toBeGreaterThan(0);
      expect(checkSubject('scaffold the project').length).toBeGreaterThan(0);
      expect(SUBJECT_LIMIT).toBe(72);
      const atLimit = 'PF-0: ' + 'x'.repeat(66);
      expect(atLimit).toHaveLength(72);
      expect(checkSubject(atLimit)).toEqual([]);
      expect(checkSubject(atLimit + ' (#24)')).toEqual([]);
      expect(subjectWithoutPullRequestSuffix(atLimit + ' (#24)')).toBe(atLimit);
      expect(checkSubject(atLimit + 'x (#24)').length).toBeGreaterThan(0);
      // Built from a code point so this file stays ASCII, which is the same
      // house rule the check is enforcing.
      const nonAscii = `PF-0: caf${String.fromCharCode(0xe9)} au lait`;
      expect(checkSubject(nonAscii).length).toBeGreaterThan(0);
    });
  });

  describe('commit bodies', () => {
    it('accepts exactly one well-formed Closes line', () => {
      expect(checkBody(['because.', '', 'Closes: A1, A2, A6, M3'], { requireCloses: true })).toEqual([]);
      expect(checkBody(['because.', '', 'Closes: None'], { requireCloses: true })).toEqual([]);
      // The sheet carries A3a, so a lowercase suffix has to be admissible.
      expect(checkBody(['because.', '', 'Closes: A3, A3a, A4'], { requireCloses: true })).toEqual([]);
    });

    it('rejects none, two, or a malformed list', () => {
      expect(checkBody(['because.'], { requireCloses: true }).length).toBe(1);
      expect(
        checkBody(['because.', '', 'Closes: A1', 'Closes: A2'], { requireCloses: true }).length,
      ).toBe(1);
      expect(checkBody(['Closes: a1'], { requireCloses: true }).length).toBe(1);
      expect(checkBody(['Closes: A1,A2'], { requireCloses: true }).length).toBe(1);
    });

    it('finds indented structured lines after trimming and reports them malformed', () => {
      const closes = checkBody(['because.', '', ' Closes: A1'], { requireCloses: true });
      expect(closes).toHaveLength(1);
      expect(closes[0]).toContain('malformed Closes');
      expect(
        checkBody(
          ['because.', '', ' Signed-off-by: dependabot[bot] <support@github.com>'],
          { requireCloses: false, dependencyUpdate: true },
        ),
      ).toHaveLength(1);
    });

    it('waives exactly the dependency sign-off, and only on a dependency update', () => {
      const SIGNOFF = 'Signed-off-by: dependabot[bot] <support@github.com>';
      // The one narrow waiver: the bot's own sign-off, on a dependency body.
      expect(
        checkBody(['bumps vite.', '', SIGNOFF], { requireCloses: false, dependencyUpdate: true }),
      ).toEqual([]);
      // The same line outside a dependency update is a trailer like any other.
      expect(checkBody(['bumps vite.', '', SIGNOFF], { requireCloses: false }).length).toBe(1);
      // A dependency update waives no other trailer.
      expect(
        checkBody(['bumps vite.', '', TRAILER], { requireCloses: false, dependencyUpdate: true })
          .length,
      ).toBe(1);
      // Nor a sign-off by anyone who is not the dependency bot.
      expect(
        checkBody(['bumps vite.', '', 'Signed-off-by: Someone <someone@example.com>'], {
          requireCloses: false,
          dependencyUpdate: true,
        }).length,
      ).toBe(1);
      expect(checkBody(['bumps vite.'], { requireCloses: false })).toEqual([]);
    });

    it('pins the Closes pattern itself', () => {
      expect(CLOSES_PATTERN.test('Closes: M3')).toBe(true);
      expect(CLOSES_PATTERN.test('Closes: none')).toBe(false);
    });
  });

  describe('the walk refuses a history it can only see part of', () => {
    it('refuses a shallow repository by name', () => {
      const refusal = shallowRefusal('true\n');
      expect(refusal).not.toBeNull();
      // By name, not by silence. The verdict a truncated walk reaches looks
      // exactly like the verdict a clean history reaches, so the refusal has
      // to say which of the two this is and what to do about it.
      expect(refusal).toContain('shallow');
      expect(refusal).toContain('unshallow');
    });

    it('refuses a history it could not even ask about', () => {
      // THE ERROR PATH IS A VERDICT, NOT A NOTE. It used to print the cause and
      // then walk whatever was present, so a repository that would not answer
      // the question got the same "ok, N commits checked" a clean full history
      // gets. On a real --depth 1 clone with the query made to throw, that was
      // "1 commits checked" and PASS.
      const thrown = shallowState(() => {
        throw new Error('fatal: not a git repository\nsecond line');
      });
      expect(thrown.refusal).not.toBeNull();
      expect(thrown.refusal, 'says what it could not confirm').toContain(
        'whole history',
      );
      expect(thrown.refusal, 'and names the cause').toContain(
        'fatal: not a git repository',
      );
      // One line of the cause, because a stack trace in a gate's output is how
      // the line that matters stops being read.
      expect(thrown.refusal).not.toContain('second line');

      // The two answers a working reader gives, so the wrapper is not just a
      // catch block: shallow refuses, full says nothing.
      expect(shallowState(() => 'true\n').refusal).toContain('unshallow');
      expect(shallowState(() => 'false\n').refusal).toBeNull();
    });

    it('reads the shallow flag before it walks anything', () => {
      const calls: string[][] = [];
      const runGit = (...args: string[]): string => {
        calls.push(args);
        if (args[0] === 'rev-parse') {
          return 'true\n';
        }
        throw new Error('the history must not be read after a shallow refusal');
      };
      const reporter = createReporter(() => undefined);
      expect(checkCommits({ runGit, reporter })).toBe(0);
      expect(calls).toEqual([['rev-parse', '--is-shallow-repository']]);
      expect(reporter.failures).toHaveLength(1);
    });

    it('says nothing about a full one', () => {
      // The control. Every real run takes this branch, so a refusal that fired
      // on the wrong answer would be found by the gate refusing itself, and one
      // that fires on nothing would be found by nobody.
      expect(shallowRefusal('false\n')).toBeNull();
      expect(shallowRefusal('false')).toBeNull();
      expect(shallowRefusal('')).toBeNull();
    });
  });

  describe('the exported orchestration steps run against a fixture repository', () => {
    it('checks identity, branch, tracked files, commits and pull request metadata together', () => {
      withFixtureRepository((root) => {
        const lines: string[] = [];
        const reporter = createReporter((line: string) => lines.push(line));
        const runGit = createGit(root);
        expect(checkRepositoryIdentity({ root, runGit, reporter })).toBe(true);
        checkBranch('main', reporter);
        expect(checkTracked({ root, runGit, reporter })).toBe(1);
        expect(checkCommits({ runGit, reporter })).toBe(1);
        checkPullRequest({
          environment: {
            PULL_REQUEST_TITLE: 'fix: exercise the record fixture',
            PULL_REQUEST_BODY: 'Because every step needs a fixture.\n\nCloses: None',
          },
          reporter,
        });
        expect(reporter.failures).toEqual([]);

        const result = runRecordGate({
          root,
          runGit,
          environment: { REPOSITORY_BRANCH: 'main' },
          write: (line: string) => lines.push(line),
        });
        expect(result).toMatchObject({ status: 0, tracked: 1, commits: 1, branch: 'main' });
        expect(lines.some((line) => line.includes('every commit reachable'))).toBe(true);
      });
    });

    it('scans an unfamiliar text extension, skips NUL bytes and rejects non-ASCII text', () => {
      withFixtureRepository((root) => {
        writeFileSync(path.join(root, 'evidence.rst'), 'named ' + VENDOR + '\n', 'utf8');
        writeFileSync(path.join(root, 'opaque.data'), Buffer.from([0, 1, 2]));
        writeFileSync(
          path.join(root, 'accent.markdown'),
          'accent ' + String.fromCodePoint(0x200b) + '\n',
          'utf8',
        );
        fixtureGit(root, ['add', 'evidence.rst', 'opaque.data', 'accent.markdown']);
        const reporter = createReporter(() => undefined);
        checkTracked({ root, runGit: createGit(root), reporter });
        expect(reporter.failures).toHaveLength(2);
        expect(reporter.failures[0]).toContain('accent.markdown is not ASCII');
        expect(reporter.failures[1]).toContain('evidence.rst:1');
      });
    });

    it('refuses an actual shallow clone with one failure before walking it', () => {
      withFixtureRepository((root) => {
        const shallow = mkdtempSync(path.join(tmpdir(), 'pocket-football-shallow-'));
        rmSync(shallow, { recursive: true, force: true });
        try {
          fixtureGit(root, ['clone', '--depth', '1', pathToFileURL(root).href, shallow]);
          const reporter = createReporter(() => undefined);
          expect(checkCommits({ runGit: createGit(shallow), reporter })).toBe(0);
          expect(reporter.failures).toHaveLength(1);
          expect(reporter.failures[0]).toContain('repository is shallow');
        } finally {
          rmSync(shallow, { recursive: true, force: true });
        }
      });
    });
  });

  describe('the tree this gate will be run against', () => {
    it('carries no banned name in any authored file or path', () => {
      const skip = new Set([
        'node_modules', 'dist', 'coverage', 'playwright-report', 'test-results',
        'blob-report', '.determinism', '.git', 'artifacts',
      ]);
      const offences: string[] = [];
      const stack = [PROJECT_ROOT];
      let scanned = 0;

      while (stack.length > 0) {
        const directory = stack.pop();
        if (directory === undefined) {
          break;
        }
        for (const item of readdirSync(directory, { withFileTypes: true })) {
          if (skip.has(item.name)) {
            continue;
          }
          const absolute = path.join(directory, item.name);
          const relative = path
            .relative(PROJECT_ROOT, absolute)
            .split(path.sep)
            .join('/');
          for (const hit of scanPath(relative)) {
            offences.push(`path ${relative}: ${hit.text} (${hit.reason})`);
          }
          if (item.isDirectory()) {
            stack.push(absolute);
            continue;
          }
          if (!item.isFile() || !isTextPath(relative)) {
            continue;
          }
          scanned += 1;
          for (const hit of scanContent(readFileSync(absolute, 'utf8'))) {
            offences.push(
              `${relative}:${String(hit.line)}: ${hit.text} (${hit.reason})`,
            );
          }
        }
      }

      // This is the gate turned on itself, before there is a repository to run
      // it in. The list of names lives in the script it scans, so a hole here
      // would be a hole everywhere.
      expect(offences).toEqual([]);
      expect(scanned).toBeGreaterThan(20);
    });
  });
});
