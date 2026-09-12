import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BRANCH_PATTERN,
  CLOSES_PATTERN,
  checkBody,
  checkCommitRecord,
  checkSubject,
  isDependabotCommit,
  isDependabotPullRequest,
  isGameContextLine,
  isReservedBasename,
  isTextPath,
  parseCommitLog,
  requiresCloses,
  scanContent,
  scanPath,
  scanRecord,
  shallowRefusal,
  shallowState,
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

    it('allows generated bot metadata only with the explicit event-backed exception', () => {
      expect(isDependabotCommit(DEPENDENCY_COMMIT)).toBe(true);
      expect(checkCommitRecord(DEPENDENCY_COMMIT).length).toBeGreaterThan(0);
      expect(
        checkCommitRecord(DEPENDENCY_COMMIT, { allowDependabotGeneratedMetadata: true }),
      ).toEqual([]);
    });

    it('requires the GitHub-supplied pull request author before enabling the exception', () => {
      process.env['PULL_REQUEST_AUTHOR'] = 'someone-else';
      expect(isDependabotPullRequest()).toBe(false);
      process.env['PULL_REQUEST_AUTHOR'] = 'dependabot[bot]';
      expect(isDependabotPullRequest()).toBe(true);
      delete process.env['PULL_REQUEST_AUTHOR'];
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

    it('keeps the exception independent of branch names', () => {
      const branches = ['dependabot/github_actions/actions/checkout-7', 'main', 'pf-1-tokens'];
      for (const branch of branches) {
        process.env['REPOSITORY_BRANCH'] = branch;
        expect(
          checkCommitRecord(DEPENDENCY_COMMIT, { allowDependabotGeneratedMetadata: true }),
          branch,
        ).toEqual([]);
        expect(checkCommitRecord(HUMAN_CI_COMMIT).length, branch).toBe(1);
      }
      delete process.env['REPOSITORY_BRANCH'];
      expect(checkCommitRecord.length).toBe(1);
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
    const record = (message: string): string =>
      [
        'abcdef1234567890',
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
      expect(records[0]?.sha).toBe('abcdef12');
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
      expect(checkSubject(`PF-0: ${'x'.repeat(74)}`)).toEqual([]);
      expect(checkSubject(`PF-0: ${'x'.repeat(75)}`).length).toBeGreaterThan(0);
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
      // The refusal above is a pure function, so it says nothing about whether
      // the walk consults it. Read as source, because the only other way to ask
      // is to make a shallow clone, which is the probe rather than the test.
      const source = readFileSync(
        path.join(PROJECT_ROOT, 'scripts', 'check-repository-record.mjs'),
        'utf8',
      );
      const walk = source.indexOf('function checkCommits()');
      const flag = source.indexOf("git('rev-parse', '--is-shallow-repository')", walk);
      const log = source.indexOf('log = git(', walk);
      expect(walk, 'the commit walk exists').toBeGreaterThan(-1);
      expect(flag, 'the shallow flag is read inside it').toBeGreaterThan(walk);
      expect(flag, 'and before the log is read').toBeLessThan(log);
      expect(source).toContain('const { refusal } = shallowState(() =>');
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
