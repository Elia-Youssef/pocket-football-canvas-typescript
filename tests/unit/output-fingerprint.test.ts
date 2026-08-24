import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareTrees,
  hashBytes,
  readTree,
  treeFingerprint,
} from '../../scripts/output-fingerprint.mjs';

/**
 * The comparison behind item A6, with its negative controls.
 *
 * A6 is a T item whose whole verdict comes from `compareTrees` saying "these
 * two trees are the same". If that function cannot say "different", the gate
 * reports a deterministic build forever, including on the day it stops being
 * one. So the four controls below are the actual deliverable: a flipped byte,
 * an extra file, a rename with identical bytes, and the one difference that
 * must NOT fail, which is the mtime that QUALITY-BAR section 14 names as the
 * defect this check exists for.
 */

let root = '';

function tree(name: string, files: Record<string, string>): string {
  const directory = path.join(root, name);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(directory, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }
  return directory;
}

const BUNDLE = {
  'index.html': '<!doctype html><title>Pocket Football</title>\n',
  'assets/index-abc123.js': 'export const GAME_ID = "pocket-football";\n',
  'assets/nested/deep.txt': 'a file no extension filter would look at\n',
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pf-fingerprint-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('PF-0 build fingerprint, item A6', () => {
  it('hashes a tree by path and content, and finds two identical trees identical', () => {
    const left = readTree(tree('left', BUNDLE));
    const right = readTree(tree('right', BUNDLE));

    expect([...left.keys()].sort()).toEqual([
      'assets/index-abc123.js',
      'assets/nested/deep.txt',
      'index.html',
    ]);
    expect(compareTrees(left, right).identical).toBe(true);
    expect(treeFingerprint(left)).toBe(treeFingerprint(right));
  });

  it('walks nested directories and drops no file', () => {
    // The mutation harness breaks this by teaching the walk to skip a file.
    // A build output the check never looks at can differ unnoticed forever.
    const walked = readTree(tree('all', BUNDLE));
    expect(walked.size).toBe(Object.keys(BUNDLE).length);
    for (const key of Object.keys(BUNDLE)) {
      expect(walked.has(key), `${key} was not hashed`).toBe(true);
    }
  });

  it('fails on a single flipped byte', () => {
    const left = readTree(tree('left', BUNDLE));
    const right = readTree(
      tree('right', {
        ...BUNDLE,
        'assets/index-abc123.js': 'export const GAME_ID = "pocket-footbalL";\n',
      }),
    );

    const result = compareTrees(left, right);
    expect(result.identical).toBe(false);
    expect(result.differing.map((entry) => entry.path)).toEqual([
      'assets/index-abc123.js',
    ]);
    expect(treeFingerprint(left)).not.toBe(treeFingerprint(right));
  });

  it('fails on an extra file, in either direction', () => {
    const left = readTree(tree('left', BUNDLE));
    const right = readTree(
      tree('right', { ...BUNDLE, 'assets/stray.js': 'export const stray = 1;\n' }),
    );

    const forward = compareTrees(left, right);
    expect(forward.identical).toBe(false);
    expect(forward.onlyInRight).toEqual(['assets/stray.js']);
    expect(forward.onlyInLeft).toEqual([]);

    const backward = compareTrees(right, left);
    expect(backward.identical).toBe(false);
    expect(backward.onlyInLeft).toEqual(['assets/stray.js']);
  });

  it('fails on a rename that keeps the bytes', () => {
    const left = readTree(tree('left', BUNDLE));
    const renamed: Record<string, string> = {
      'index.html': BUNDLE['index.html'],
      'assets/index-zzz999.js': BUNDLE['assets/index-abc123.js'],
      'assets/nested/deep.txt': BUNDLE['assets/nested/deep.txt'],
    };
    const right = readTree(tree('right', renamed));

    const result = compareTrees(left, right);
    expect(result.identical).toBe(false);
    expect(result.onlyInLeft).toEqual(['assets/index-abc123.js']);
    expect(result.onlyInRight).toEqual(['assets/index-zzz999.js']);
  });

  it('passes when only the modification times differ', () => {
    // The recorded defect, reproduced: a fingerprint that included the mtime
    // would report a different hash on every run of an unchanged tree, and the
    // gate would be noise within a week. QUALITY-BAR section 14.
    const leftDirectory = tree('left', BUNDLE);
    const rightDirectory = tree('right', BUNDLE);
    const past = new Date('1999-12-31T23:59:59Z');
    const future = new Date('2031-01-01T00:00:01Z');
    for (const relative of Object.keys(BUNDLE)) {
      utimesSync(path.join(leftDirectory, relative), past, past);
      utimesSync(path.join(rightDirectory, relative), future, future);
    }

    const result = compareTrees(readTree(leftDirectory), readTree(rightDirectory));
    expect(result.identical).toBe(true);
  });

  it('hashes bytes with sha256', () => {
    expect(hashBytes('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hashBytes('pocket-football')).toBe(hashBytes('pocket-football'));
    expect(hashBytes('pocket-football')).not.toBe(hashBytes('pocket-footbalL'));
  });
});
